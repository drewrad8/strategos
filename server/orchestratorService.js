/**
 * Voice Orchestrator Service
 *
 * Provides an LLM-based abstraction layer between user voice commands
 * and Claude Code workers. Interprets natural language and executes
 * appropriate actions.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getWorkers,
  spawnWorker,
  killWorker,
  sendInput,
  getWorkerOutput
} from './workerManager.js';
import { generateSummary } from './summaryService.js';
import { scanProjects } from './projectScanner.js';
import { sanitizeErrorMessage } from './errorUtils.js';
import { CONTROL_CHAR_RE_G, MAX_LABEL_LENGTH, MAX_TASK_LENGTH } from './validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Validate OLLAMA_URL — must be localhost/127.0.0.1 with http(s) protocol to prevent SSRF
const _rawOllamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_URL = (() => {
  try {
    const u = new URL(_rawOllamaUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      console.warn(`[Orchestrator] OLLAMA_URL protocol "${u.protocol}" rejected — only http/https allowed`);
      return 'http://localhost:11434';
    }
    if (!['localhost', '127.0.0.1', '::1'].includes(u.hostname)) {
      console.warn(`[Orchestrator] OLLAMA_URL hostname "${u.hostname}" is not localhost — rejecting (SSRF prevention)`);
      return 'http://localhost:11434';
    }
    const port = parseInt(u.port || '11434', 10);
    if (port < 1024 || port > 65535) {
      console.warn(`[Orchestrator] OLLAMA_URL port ${port} rejected — must be 1024-65535 (prevents targeting system services)`);
      return 'http://localhost:11434';
    }
    return _rawOllamaUrl;
  } catch { return 'http://localhost:11434'; }
})();
// Validate model name: alphanumeric, hyphens, colons, dots (e.g. "qwen3:8b", "llama3.1:70b-instruct")
const _rawOrchestratorModel = process.env.ORCHESTRATOR_MODEL || 'qwen3:8b';
const ORCHESTRATOR_MODEL = /^[a-zA-Z0-9._:-]+$/.test(_rawOrchestratorModel) ? _rawOrchestratorModel : (() => {
  console.warn(`[Orchestrator] Invalid ORCHESTRATOR_MODEL format: "${_rawOrchestratorModel}", using default`);
  return 'qwen3:8b';
})();

// Conversation history for context
const conversationHistory = [];
const MAX_HISTORY = 20;

// Persistence for conversation history
const HISTORY_FILE = path.join(__dirname, '.tmp', 'conversation-history.json');
const HISTORY_SAVE_DEBOUNCE_MS = 5000;
let _historySaveTimer = null;

// Load persisted history on startup
try {
  const data = await fs.readFile(HISTORY_FILE, 'utf-8');
  const parsed = JSON.parse(data);
  if (Array.isArray(parsed)) {
    // Validate each entry has expected shape
    for (const entry of parsed.slice(-MAX_HISTORY)) {
      if (entry && typeof entry.role === 'string' && typeof entry.content === 'string') {
        conversationHistory.push(entry);
      }
    }
    if (conversationHistory.length > 0) {
      console.log(`[Orchestrator] Loaded ${conversationHistory.length} conversation history entries`);
    }
  }
} catch {
  // File doesn't exist or is invalid — start fresh
}

function _scheduleHistorySave() {
  if (_historySaveTimer) return; // Already scheduled
  _historySaveTimer = setTimeout(async () => {
    _historySaveTimer = null;
    try {
      const tmpFile = HISTORY_FILE + '.tmp';
      await fs.writeFile(tmpFile, JSON.stringify(conversationHistory, null, 2));
      await fs.rename(tmpFile, HISTORY_FILE);
    } catch (err) {
      console.warn(`[Orchestrator] Failed to persist conversation history: ${err.message}`);
    }
  }, HISTORY_SAVE_DEBOUNCE_MS);
  if (_historySaveTimer.unref) _historySaveTimer.unref();
}

// Minimum confidence to execute destructive actions (kill, send_input)
const MIN_DESTRUCTIVE_CONFIDENCE = 0.5;

/**
 * Escape user-controlled text before embedding in LLM prompt.
 * Prevents prompt injection via closing quotes or XML-like tags.
 */
function escapeForPrompt(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Call Ollama for orchestration decisions
 */
async function callOllama(prompt, options = {}) {
  const { model = ORCHESTRATOR_MODEL, maxTokens = 800 } = options;

  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          num_predict: maxTokens,
          temperature: 0.4,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    // Size-limit the response to prevent memory exhaustion from a broken/malicious Ollama
    const MAX_RESPONSE_SIZE = 100 * 1024; // 100KB
    const text = await response.text();
    if (text.length > MAX_RESPONSE_SIZE) {
      throw new Error(`Ollama response too large: ${text.length} bytes`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Ollama returned invalid JSON (${text.length} bytes)`);
    }
    if (!data || typeof data.response !== 'string') {
      throw new Error('Ollama returned unexpected response shape');
    }
    return data.response;
  } finally {
    clearTimeout(fetchTimeout);
  }
}

/**
 * Extract JSON from LLM response
 */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const jsonStart = text.indexOf('{');
  if (jsonStart === -1) return null;

  let jsonStr = text.slice(jsonStart);
  const lastBrace = jsonStr.lastIndexOf('}');
  if (lastBrace !== -1) {
    jsonStr = jsonStr.slice(0, lastBrace + 1);
  }

  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * Get system context for the orchestrator
 */
async function getSystemContext(theaRoot) {
  const workers = getWorkers();
  const projects = scanProjects(theaRoot);

  // Get summaries for active workers
  const workerSummaries = await Promise.all(
    workers.map(async (w) => {
      try {
        const output = getWorkerOutput(w.id);
        const summary = await generateSummary(w.id, output);
        return {
          id: w.id,
          label: w.label,
          project: w.project,
          status: summary.status,
          task: summary.task,
          summary: summary.summary
        };
      } catch {
        return {
          id: w.id,
          label: w.label,
          project: w.project,
          status: 'unknown'
        };
      }
    })
  );

  return {
    workers: workerSummaries,
    projects: projects.map(p => ({ name: p.name, path: p.path })),
    timestamp: new Date().toISOString()
  };
}

/**
 * Process a voice/text command from the user
 */
export async function processVoiceCommand(userMessage, theaRoot, io) {
  // Add to conversation history
  conversationHistory.push({ role: 'user', content: userMessage, timestamp: Date.now() });
  if (conversationHistory.length > MAX_HISTORY) {
    conversationHistory.shift();
  }
  _scheduleHistorySave();

  // Get current system state
  const context = await getSystemContext(theaRoot);

  // Build recent conversation for context (escape all entries to prevent injection via history)
  const recentConversation = conversationHistory
    .slice(-6)
    .map(m => `${m.role}: ${escapeForPrompt(m.content)}`)
    .join('\n');

  const prompt = `You are the Strategos Voice Orchestrator. You interpret user voice commands and decide what action to take with Claude Code workers.

CURRENT STATE:
Workers: ${JSON.stringify(context.workers, null, 2)}
Projects: ${context.projects.map(p => p.name).join(', ')}

RECENT CONVERSATION:
${recentConversation}

USER COMMAND: "${escapeForPrompt(userMessage)}"

AVAILABLE ACTIONS:
1. "status" - Report on worker status (no parameters needed)
2. "send_input" - Send a message to a specific worker
   params: { workerId: string, message: string }
3. "spawn_worker" - Start a new Claude worker on a project
   params: { project: string, task: string }
4. "kill_worker" - Stop a worker
   params: { workerId: string }
5. "approve" - Approve a pending action (sends "1" or "yes" to worker)
   params: { workerId: string }
6. "reject" - Reject a pending action (sends "Escape" to worker)
   params: { workerId: string }
7. "chat" - Just respond conversationally (no action needed)
   params: {}

RESPONSE FORMAT (JSON only):
{
  "action": "one of the actions above",
  "params": { action-specific params },
  "spoken": "What to say back to the user (conversational, concise)",
  "confidence": 0.0-1.0
}

CRITICAL RULES (MUST FOLLOW):
1. APPROVAL DETECTION: If user says ANY of: "yes", "approve", "go ahead", "do it", "proceed", "okay", "ok", "sure", "yep", "yeah", "approve that", "yes please"
   → MUST use "approve" action (not "chat")
2. REJECTION DETECTION: If user says ANY of: "no", "cancel", "stop", "reject", "nevermind", "abort", "don't"
   → MUST use "reject" action (not "chat")
3. If workers have status "waiting_input", they need approval or rejection
4. If unclear which worker when multiple exist, ask for clarification with "chat"
5. Keep spoken responses brief (1-2 sentences max)
6. Match workers by label, project name, or partial ID
7. workerId in params can be null if only one worker or most recent should be targeted`;

  try {
    const response = await callOllama(prompt, { maxTokens: 500 });
    const decision = extractJson(response);

    if (!decision) {
      const fallback = {
        action: 'chat',
        params: {},
        spoken: "I didn't quite understand that. Could you try again?",
        confidence: 0
      };
      conversationHistory.push({ role: 'assistant', content: fallback.spoken, timestamp: Date.now() });
      _scheduleHistorySave();
      return { success: true, ...fallback };
    }

    // Gate destructive actions on confidence threshold
    const destructiveActions = ['kill_worker', 'send_input', 'spawn_worker'];
    if (destructiveActions.includes(decision.action) &&
        (typeof decision.confidence !== 'number' || decision.confidence < MIN_DESTRUCTIVE_CONFIDENCE)) {
      const lowConfResult = {
        success: true,
        action: 'chat',
        spoken: decision.spoken || "I'm not confident I understood that correctly. Could you rephrase?",
        confidence: decision.confidence || 0
      };
      conversationHistory.push({ role: 'assistant', content: lowConfResult.spoken, timestamp: Date.now() });
      _scheduleHistorySave();
      return lowConfResult;
    }

    // Execute the action
    const result = await executeAction(decision, theaRoot, io);

    // Add assistant response to history (cap at 500 chars to bound memory)
    const spokenText = (result.spoken || decision.spoken || '').slice(0, 500);
    conversationHistory.push({
      role: 'assistant',
      content: spokenText,
      timestamp: Date.now()
    });
    _scheduleHistorySave();

    return result;
  } catch (error) {
    console.error('[Orchestrator] Error:', error.message);
    return {
      success: false,
      action: 'error',
      spoken: "Sorry, I encountered an error processing your request.",
      error: sanitizeErrorMessage(error)
    };
  }
}

/**
 * Execute the decided action
 */
async function executeAction(decision, theaRoot, io) {
  const { action, params, spoken, confidence } = decision;

  try {
    switch (action) {
      case 'status': {
        const workers = getWorkers();
        if (workers.length === 0) {
          return {
            success: true,
            action,
            spoken: spoken || "No workers are currently running. Would you like me to start one?",
            data: { workers: [] }
          };
        }
        return {
          success: true,
          action,
          spoken,
          data: { workerCount: workers.length }
        };
      }

      case 'send_input': {
        const { workerId, message } = params || {};
        if (!message || typeof message !== 'string') {
          return { success: false, action, spoken: "I need a message to send. What should I tell the worker?" };
        }
        // Cap LLM-generated message size (defense-in-depth)
        const safeSendMessage = message.slice(0, MAX_TASK_LENGTH);
        const worker = findWorker(workerId);
        if (!worker) {
          return {
            success: false,
            action,
            spoken: `I couldn't find a worker matching "${workerId}". Which worker did you mean?`
          };
        }
        await sendInput(worker.id, safeSendMessage);
        return {
          success: true,
          action,
          spoken: spoken || `Message sent to ${worker.label || worker.id}.`,
          data: { workerId: worker.id }
        };
      }

      case 'spawn_worker': {
        const { project, task } = params || {};
        if (!project || typeof project !== 'string') {
          return { success: false, action, spoken: "Which project should I start the worker on?" };
        }
        // Find project by name
        const projects = scanProjects(theaRoot);
        const projectLower = project.toLowerCase();
        // Exact match first, then substring fallback
        const found = projects.find(p => p.name.toLowerCase() === projectLower)
          || projects.find(p => p.name.toLowerCase().includes(projectLower));

        if (!found) {
          return {
            success: false,
            action,
            spoken: `I couldn't find a project matching "${project}". Available projects are: ${projects.map(p => p.name).join(', ')}`
          };
        }

        // Sanitize LLM-generated label (bypass route-layer validation)
        let spawnLabel = null;
        if (params.label && typeof params.label === 'string') {
          spawnLabel = params.label.replace(CONTROL_CHAR_RE_G, '').slice(0, MAX_LABEL_LENGTH) || null;
        }
        const worker = await spawnWorker(found.path, spawnLabel, io, { autoAccept: true, ralphMode: true });

        // If a task was specified, send it as initial input (capped)
        if (task && typeof task === 'string') {
          const safeTask = task.slice(0, MAX_TASK_LENGTH);
          // Give Claude a moment to start up
          setTimeout(() => sendInput(worker.id, safeTask).catch(e => console.warn('[Orchestrator] Failed to send initial task:', e.message)), 2000);
        }

        return {
          success: true,
          action,
          spoken: spoken || `Started a new worker on ${found.name}.${task ? ` I'll send it your task: "${task}"` : ''}`,
          data: { workerId: worker.id, project: found.name }
        };
      }

      case 'kill_worker': {
        const { workerId } = params || {};
        const worker = findWorker(workerId);
        if (!worker) {
          return {
            success: false,
            action,
            spoken: `I couldn't find a worker matching "${workerId}".`
          };
        }
        try {
          await killWorker(worker.id, io);
        } catch (killError) {
          // GENERAL-tier workers throw when killed without force flag
          if (killError.message?.includes('force flag')) {
            return {
              success: false,
              action,
              spoken: `That worker is protected. ${worker.label || worker.id} is a GENERAL-tier worker and requires manual confirmation or the force flag to stop.`,
              data: { workerId: worker.id, reason: 'protected_tier' }
            };
          }
          throw killError;
        }
        return {
          success: true,
          action,
          spoken: spoken || `Stopped worker ${worker.label || worker.id}.`,
          data: { workerId: worker.id }
        };
      }

      case 'approve': {
        const { workerId } = params || {};
        const worker = workerId ? findWorker(workerId) : getActiveWorker();
        if (!worker) {
          return {
            success: false,
            action,
            spoken: "I'm not sure which worker to approve. Could you specify?"
          };
        }
        // Send "1" to select "Yes" option
        await sendInput(worker.id, '1');
        return {
          success: true,
          action,
          spoken: spoken || `Approved the action for ${worker.label || worker.id}.`,
          data: { workerId: worker.id }
        };
      }

      case 'reject': {
        const { workerId } = params || {};
        const worker = workerId ? findWorker(workerId) : getActiveWorker();
        if (!worker) {
          return {
            success: false,
            action,
            spoken: "I'm not sure which worker to reject. Could you specify?"
          };
        }
        // Send Escape key
        await sendInput(worker.id, '\x1b');
        return {
          success: true,
          action,
          spoken: spoken || `Cancelled the action for ${worker.label || worker.id}.`,
          data: { workerId: worker.id }
        };
      }

      case 'chat':
      default:
        return {
          success: true,
          action: 'chat',
          spoken: spoken || "I'm here to help manage your Claude workers. What would you like to do?",
          data: {}
        };
    }
  } catch (error) {
    console.error(`[Orchestrator] Action ${action} failed:`, error.message);
    return {
      success: false,
      action,
      spoken: 'Sorry, that action failed. Please try again.',
      error: 'Action failed'
    };
  }
}

/**
 * Find a worker by ID, label, or project name
 */
function findWorker(query) {
  if (!query || typeof query !== 'string') return null;

  const workers = getWorkers();
  const queryLower = query.toLowerCase();

  return workers.find(w =>
    w.id === query ||
    w.id.startsWith(query) ||
    (w.label && w.label.toLowerCase().includes(queryLower)) ||
    (w.project && w.project.toLowerCase().includes(queryLower))
  );
}

/**
 * Get the most recently active worker (for implicit commands)
 */
function getActiveWorker() {
  const workers = getWorkers();
  if (workers.length === 0) return null;
  if (workers.length === 1) return workers[0];

  // Return the most recently created worker (spread to avoid mutating the source array)
  return [...workers].sort((a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt)
  )[0];
}

/**
 * Get conversation history
 */
export function getConversationHistory() {
  return [...conversationHistory];
}

/**
 * Clear conversation history
 */
export function clearConversationHistory() {
  conversationHistory.length = 0;
  // Remove persisted file
  fs.unlink(HISTORY_FILE).catch(() => {});
}
