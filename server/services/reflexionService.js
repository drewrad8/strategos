/**
 * Reflexion Service — generates structured post-failure analyses.
 * Triggered async on worker death. Reads checkpoint, calls Claude Haiku,
 * stores structured reflection in failure_reflections table.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { addFailureReflection } from '../learningsDb.js';
import { getLogger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKPOINT_DIR = path.join(__dirname, '..', '.tmp', 'checkpoints');

// Only reflect on worker types with historical failure patterns
const REFLECTION_TYPES = new Set(['colonel', 'fix', 'impl', 'general', 'research']);

// Lightweight model — reflexion is summarization, not reasoning
const REFLECTION_MODEL = 'claude-haiku-4-5-20251001';

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Async entry point — call on worker death, fire and forget.
 * @param {string} workerId
 * @param {string} templateType  e.g. 'fix', 'colonel'
 * @param {string} taskDescription
 */
export async function generateReflection(workerId, templateType, taskDescription) {
  if (!REFLECTION_TYPES.has(templateType)) return;
  if (!process.env.ANTHROPIC_API_KEY) return;

  try {
    const checkpointPath = path.join(CHECKPOINT_DIR, `${workerId}.json`);
    if (!existsSync(checkpointPath)) return;

    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    const lastOutput = checkpoint.lastOutput || '(no output captured)';
    const task = taskDescription || checkpoint.task?.description || checkpoint.task || '(unknown task)';
    const taskStr = typeof task === 'string' ? task : JSON.stringify(task);

    const prompt = `A ${templateType.toUpperCase()} worker failed (died without completing its task).

Task it was given:
<task>${taskStr.slice(0, 800)}</task>

Last 50 lines of terminal output before death:
<output>${lastOutput.slice(-3000)}</output>

Produce a structured failure reflection in JSON. Be concise and specific — not generic advice.

{
  "whatAttempted": "one sentence: what was the worker trying to do",
  "whatWentWrong": "one sentence: the specific failure (not generic — name the actual error/blocker)",
  "rootCause": "one sentence: underlying reason (environment? ambiguous task? missing dependency? wrong approach?)",
  "avoidNextTime": "2-3 bullet points: concrete things a future ${templateType.toUpperCase()} worker should do differently for similar tasks"
}

Respond with only the JSON object.`;

    const response = await getClient().messages.create({
      model: REFLECTION_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text?.trim();
    if (!text) return;

    // Validate it's parseable JSON
    const reflection = JSON.parse(text);

    addFailureReflection({
      workerId,
      templateType,
      taskDescription: taskStr.slice(0, 500),
      reflection: JSON.stringify(reflection),
      outputSample: lastOutput.slice(-1000),
    });

    getLogger().info(`[Reflexion] Generated reflection for ${workerId} (${templateType})`);
  } catch (err) {
    // Non-fatal — reflexion is best-effort
    getLogger().warn(`[Reflexion] Failed to generate reflection for ${workerId}: ${err.message}`);
  }
}
