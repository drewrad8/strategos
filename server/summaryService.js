/**
 * Ollama-based Summary Service for Worker Output
 *
 * Provides context-compressed summaries of Claude Code terminal output
 * using a local Ollama model as an intermediary.
 */

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || 'qwen3:8b';

// Runtime toggle for summaries (can be changed via API)
// Default to disabled - set ENABLE_OLLAMA_SUMMARIES=true to enable by default
let summariesEnabled = process.env.ENABLE_OLLAMA_SUMMARIES === 'true';

/**
 * Get current summaries enabled state
 */
export function getSummariesEnabled() {
  return summariesEnabled;
}

/**
 * Set summaries enabled state at runtime
 */
export function setSummariesEnabled(enabled) {
  summariesEnabled = enabled;
  console.log(`[Summary] Summaries ${enabled ? 'enabled' : 'disabled'}`);
  return summariesEnabled;
}

// Context storage per worker
const workerContexts = new Map();

// Minimum time between Ollama calls (30 seconds)
const MIN_SUMMARY_INTERVAL_MS = 30000;

// Structure for compressed context
function createEmptyContext() {
  return {
    task: null,
    status: 'idle',
    lastAction: null,
    recentMessages: [],
    pendingItems: [],
    errors: [],
    lastUpdated: new Date(),
    lastOutputHash: null,     // Track output hash to avoid redundant Ollama calls
    lastSummary: null,        // Cached summary
    lastOllamaCall: null,     // Timestamp of last Ollama call
  };
}

// Simple hash function for output comparison
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Strip ANSI escape codes from terminal output
 */
function stripAnsi(str) {
  if (!str) return '';
  // Remove all ANSI escape sequences - comprehensive pattern
  return str
    // CSI sequences (colors, cursor movement, etc) - including 38;2;R;G;B and 48;2;R;G;B
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // OSC sequences (title, etc)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Character set selection
    .replace(/\x1b[()][AB012]/g, '')
    // Other escape sequences
    .replace(/\x1b[=>]/g, '')
    // ST (String Terminator)
    .replace(/\x1b\\/g, '')
    // Control chars except newline/tab/carriage return
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/**
 * Extract the last N meaningful lines from output
 */
function extractRecentLines(output, maxLines = 50) {
  const cleaned = stripAnsi(output);
  const lines = cleaned.split('\n')
    .map(l => l.trim())
    .filter(l => {
      if (l.length === 0) return false;
      // Remove separator lines
      if (l.match(/^[-─═━┄┅┈┉]+$/)) return false;
      // Remove line number prefixes from diff output (just noise)
      if (l.match(/^\d+\s*[-+]?\s*$/)) return false;
      return true;
    });

  return lines.slice(-maxLines);
}

/**
 * Call Ollama API for summary generation
 */
async function callOllama(prompt, options = {}) {
  const { model = SUMMARY_MODEL, maxTokens = 500 } = options;

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
          temperature: 0.3, // Low temp for factual summaries
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json();
    return data.response;
  } catch (error) {
    console.error('Ollama call failed:', error.message);
    throw error;
  }
}

/**
 * Execute a prompt via Ollama (for testing/evaluation)
 * Uses the chat API for better multi-turn support
 */
export async function executePrompt(prompt, options = {}) {
  const {
    model = process.env.EXECUTE_MODEL || 'qwen3-coder:30b',
    maxTokens = 4096,
    temperature = 0.7,
    systemPrompt = null
  } = options;

  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          num_predict: maxTokens,
          temperature,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return {
      response: data.message?.content || '',
      model: data.model,
      totalDuration: data.total_duration,
      promptTokens: data.prompt_eval_count,
      completionTokens: data.eval_count
    };
  } catch (error) {
    console.error('Ollama execute failed:', error.message);
    throw error;
  }
}

/**
 * Generate a summary of the current worker output
 */
export async function generateSummary(workerId, rawOutput, options = {}) {
  const { forceRefresh = false } = options;

  // If Ollama summaries are disabled, return quick status only
  if (!summariesEnabled) {
    const quickStatus = getQuickStatus(rawOutput);
    return {
      workerId,
      task: 'Check terminal for details',
      status: quickStatus.status,
      lastAction: 'Ollama summaries disabled',
      summary: `Ollama summaries disabled. Last line: ${quickStatus.lastLine.slice(0, 100)}`,
      pendingItems: [],
      hasError: quickStatus.status === 'error',
      disabled: true,
      timestamp: new Date().toISOString(),
    };
  }

  // Get or create context for this worker
  let context = workerContexts.get(workerId);
  if (!context) {
    context = createEmptyContext();
    workerContexts.set(workerId, context);
  }

  // Extract recent lines from output
  const recentLines = extractRecentLines(rawOutput, 100);
  const recentText = recentLines.join('\n');

  // Check if output has changed (using hash of recent text)
  const outputHash = hashString(recentText);
  const now = Date.now();
  const timeSinceLastCall = context.lastOllamaCall ? now - context.lastOllamaCall : Infinity;

  // Return cached summary if:
  // 1. Output hasn't changed, OR
  // 2. Not enough time has passed since last Ollama call (unless forcing refresh)
  if (!forceRefresh && context.lastSummary) {
    if (context.lastOutputHash === outputHash) {
      console.log(`[Summary] Returning cached summary for worker ${workerId} (output unchanged)`);
      return {
        ...context.lastSummary,
        cached: true,
        cacheReason: 'output_unchanged',
        timestamp: new Date().toISOString(),
      };
    }

    if (timeSinceLastCall < MIN_SUMMARY_INTERVAL_MS) {
      console.log(`[Summary] Returning cached summary for worker ${workerId} (rate limited, ${Math.round(timeSinceLastCall/1000)}s since last call)`);
      return {
        ...context.lastSummary,
        cached: true,
        cacheReason: 'rate_limited',
        timestamp: new Date().toISOString(),
      };
    }
  }

  console.log(`[Summary] Generating new summary for worker ${workerId} (hash: ${outputHash}, time since last: ${Math.round(timeSinceLastCall/1000)}s)`);

  // Use more lines for better context (cleaned output is much smaller than raw)
  const contextLines = extractRecentLines(rawOutput, 80);
  const cleanedText = contextLines.join('\n');

  // Build the prompt with strict instructions to avoid hallucination
  const prompt = `Summarize this Claude Code terminal session. Output ONLY valid JSON.

TERMINAL OUTPUT (last 80 lines, cleaned):
${cleanedText.slice(-4000)}

RULES:
1. Status (pick first match):
   - "waiting_input" = sees "Do you want to proceed?" or "1. Yes" or "Esc to exit"
   - "running_command" = sees "Running…"
   - "thinking" = sees "..." spinner
   - "error" = sees error message
   - "coding" = sees Edit/Write tool
   - "idle" = just prompt visible

2. For pendingItems: find the command BEFORE "Do you want to proceed?". Examples:
   - "Bash command" + "ls -la /foo" → "Bash: ls -la /foo"
   - "Edit" + "/path/file.js" → "Edit: /path/file.js"
   - Ignore "Esc to exit", "? for shortcuts", numbered options

3. Look for "Todos" section to understand the task context

JSON format:
{"task":"what Claude is working on","status":"waiting_input|running_command|thinking|error|coding|idle","lastAction":"last tool used","recentProgress":["step1","step2"],"summary":"2 sentences about current state","pendingItems":["command if waiting"],"hasError":false}`;

  // Try up to 2 times to get valid JSON
  let parsed = null;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await callOllama(prompt, { maxTokens: 600 });

      // Extract JSON - use simple approach: find first { and try to parse from there
      const jsonStart = response.indexOf('{');
      if (jsonStart !== -1) {
        // Try to parse from { to end, trimming any trailing garbage
        let jsonStr = response.slice(jsonStart);
        // Remove trailing non-JSON content (markdown, etc)
        const lastBrace = jsonStr.lastIndexOf('}');
        if (lastBrace !== -1) {
          jsonStr = jsonStr.slice(0, lastBrace + 1);
        }
        parsed = JSON.parse(jsonStr);
        break; // Success!
      } else {
        lastError = new Error('No JSON found in response');
        console.warn(`[Summary] Attempt ${attempt}: No JSON start found. Raw: ${response.slice(0, 200)}...`);
      }
    } catch (parseErr) {
      lastError = parseErr;
      console.warn(`[Summary] Attempt ${attempt}: Parse failed: ${parseErr.message}`);
    }
  }

  // If all attempts failed, use fallback
  if (!parsed) {
    console.warn('[Summary] All attempts failed, using fallback');
    parsed = {
      task: context.task || 'Unknown task',
      status: 'unknown',
      lastAction: 'Unable to parse output',
      summary: 'Claude is active. Check raw terminal for details.',
      pendingItems: [],
      hasError: false,
    };
  }

  // Update context with new information
  context.task = parsed.task || context.task;
  context.status = parsed.status || context.status;
  context.lastAction = parsed.lastAction;
  context.pendingItems = parsed.pendingItems || [];
  context.lastUpdated = new Date();
  context.lastOutputHash = outputHash;
  context.lastOllamaCall = Date.now(); // Track when we called Ollama

  if (parsed.hasError) {
    context.errors.push(parsed.lastAction);
    if (context.errors.length > 10) context.errors.shift();
  }

  // Server-side heuristic override for waiting_input detection
  // LLMs are inconsistent at detecting this, so we check the raw output
  const waitingInputPatterns = [
    'Do you want to proceed',
    '1. Yes',
    'Yes, allow',
    'Type here to tell Claude',
    'Esc to exit'
  ];
  const isWaitingInput = waitingInputPatterns.some(p => cleanedText.includes(p));

  if (isWaitingInput && parsed.status !== 'waiting_input') {
    console.log(`[Summary] Overriding status from "${parsed.status}" to "waiting_input" (heuristic match)`);
    parsed.status = 'waiting_input';
  }

  const result = {
    ...parsed,
    workerId,
    timestamp: new Date().toISOString(),
    contextAge: Date.now() - context.lastUpdated.getTime(),
  };

  // Cache the summary
  context.lastSummary = result;

  return result;
}

/**
 * Get the current context for a worker (without calling Ollama)
 */
export function getWorkerContext(workerId) {
  return workerContexts.get(workerId) || createEmptyContext();
}

/**
 * Clear context for a worker
 */
export function clearWorkerContext(workerId) {
  workerContexts.delete(workerId);
}

/**
 * Quick status check - just look at the last few lines without Ollama
 */
export function getQuickStatus(rawOutput) {
  const lines = extractRecentLines(rawOutput, 20);
  const lastLine = lines[lines.length - 1] || '';

  // Simple heuristics
  let status = 'active';

  if (lastLine.match(/^>\s*$/)) {
    status = 'waiting_input';
  } else if (lastLine.includes('Error') || lastLine.includes('error')) {
    status = 'error';
  } else if (lastLine.includes('...') || lastLine.includes('thinking')) {
    status = 'thinking';
  } else if (lastLine.includes('✓') || lastLine.includes('completed')) {
    status = 'completed';
  }

  return {
    status,
    lastLine: lastLine.slice(0, 200),
    lineCount: lines.length,
  };
}

/**
 * Check if Ollama is available
 */
export async function checkOllamaHealth() {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!response.ok) return { available: false, error: 'API returned error' };

    const data = await response.json();
    const hasModel = data.models?.some(m => m.name.startsWith(SUMMARY_MODEL.split(':')[0]));

    return {
      available: true,
      model: SUMMARY_MODEL,
      modelAvailable: hasModel,
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}
