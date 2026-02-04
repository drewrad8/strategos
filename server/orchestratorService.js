/**
 * Voice Orchestrator Service
 *
 * Provides an LLM-based abstraction layer between user voice commands
 * and Claude Code workers. Interprets natural language and executes
 * appropriate actions.
 */

import {
  getWorkers,
  getWorker,
  spawnWorker,
  killWorker,
  sendInput,
  getWorkerOutput
} from './workerManager.js';
import { generateSummary } from './summaryService.js';
import { scanProjects } from './projectScanner.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const ORCHESTRATOR_MODEL = process.env.ORCHESTRATOR_MODEL || 'qwen3:8b';

// Conversation history for context
const conversationHistory = [];
const MAX_HISTORY = 20;

/**
 * Call Ollama for orchestration decisions
 */
async function callOllama(prompt, options = {}) {
  const { model = ORCHESTRATOR_MODEL, maxTokens = 800 } = options;

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
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status}`);
  }

  const data = await response.json();
  return data.response;
}

/**
 * Extract JSON from LLM response
 */
function extractJson(text) {
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

  // Get current system state
  const context = await getSystemContext(theaRoot);

  // Build recent conversation for context
  const recentConversation = conversationHistory
    .slice(-6)
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  const prompt = `You are the Strategos Voice Orchestrator. You interpret user voice commands and decide what action to take with Claude Code workers.

CURRENT STATE:
Workers: ${JSON.stringify(context.workers, null, 2)}
Projects: ${context.projects.map(p => p.name).join(', ')}

RECENT CONVERSATION:
${recentConversation}

USER COMMAND: "${userMessage}"

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
      return { success: true, ...fallback };
    }

    // Execute the action
    const result = await executeAction(decision, theaRoot, io);

    // Add assistant response to history
    conversationHistory.push({
      role: 'assistant',
      content: result.spoken || decision.spoken,
      timestamp: Date.now()
    });

    return result;
  } catch (error) {
    console.error('[Orchestrator] Error:', error.message);
    return {
      success: false,
      action: 'error',
      spoken: "Sorry, I encountered an error processing your request.",
      error: error.message
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
        const { workerId, message } = params;
        const worker = findWorker(workerId);
        if (!worker) {
          return {
            success: false,
            action,
            spoken: `I couldn't find a worker matching "${workerId}". Which worker did you mean?`
          };
        }
        await sendInput(worker.id, message);
        return {
          success: true,
          action,
          spoken: spoken || `Message sent to ${worker.label || worker.id}.`,
          data: { workerId: worker.id }
        };
      }

      case 'spawn_worker': {
        const { project, task } = params;
        // Find project by name
        const projects = scanProjects(theaRoot);
        const found = projects.find(p =>
          p.name.toLowerCase().includes(project.toLowerCase())
        );

        if (!found) {
          return {
            success: false,
            action,
            spoken: `I couldn't find a project matching "${project}". Available projects are: ${projects.map(p => p.name).join(', ')}`
          };
        }

        const worker = await spawnWorker(found.path, null, io);

        // If a task was specified, send it as initial input
        if (task) {
          // Give Claude a moment to start up
          setTimeout(() => sendInput(worker.id, task), 2000);
        }

        return {
          success: true,
          action,
          spoken: spoken || `Started a new worker on ${found.name}.${task ? ` I'll send it your task: "${task}"` : ''}`,
          data: { workerId: worker.id, project: found.name }
        };
      }

      case 'kill_worker': {
        const { workerId } = params;
        const worker = findWorker(workerId);
        if (!worker) {
          return {
            success: false,
            action,
            spoken: `I couldn't find a worker matching "${workerId}".`
          };
        }
        await killWorker(worker.id, io);
        return {
          success: true,
          action,
          spoken: spoken || `Stopped worker ${worker.label || worker.id}.`,
          data: { workerId: worker.id }
        };
      }

      case 'approve': {
        const { workerId } = params;
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
        const { workerId } = params;
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
    return {
      success: false,
      action,
      spoken: `Sorry, that action failed: ${error.message}`,
      error: error.message
    };
  }
}

/**
 * Find a worker by ID, label, or project name
 */
function findWorker(query) {
  if (!query) return null;

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

  // Return the most recently created worker
  return workers.sort((a, b) =>
    new Date(b.startedAt) - new Date(a.startedAt)
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
}
