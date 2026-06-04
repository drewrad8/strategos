/**
 * Memory Service — auto-captures decisions/patterns from general/colonel done signals.
 *
 * Two responsibilities:
 * (a) Auto-capture: when a general/colonel signals done with learnings, call Haiku to
 *     distill learnings into discrete memory entries stored in memoryDb.
 * (b) Auto-inject: return the top N most relevant memory entries for a given project+role,
 *     for injection into worker context at spawn time.
 *
 * Triggered async (fire-and-forget) from ralph.js on done signals.
 * Read synchronously from templates.js during context generation.
 */

import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import { writeMemoryEntry, getMemoryEntries } from '../memoryDb.js';
import { detectWorkerType } from '../workers/templates.js';
import { getLogger } from '../logger.js';

// Haiku — lightweight distillation, same choice as reflexionService
const MEMORY_MODEL = 'claude-haiku-4-5-20251001';

const COMMAND_TIER_TYPES = new Set(['general', 'colonel']);

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

// ============================================
// AUTO-CAPTURE
// ============================================

/**
 * Extract and store memory entries from a completed general/colonel worker.
 * Fire-and-forget — call from ralph.js with setImmediate. Errors are swallowed.
 *
 * @param {Object} worker - The worker object (from workers Map)
 * @param {string} workerId
 */
export async function captureFromDoneSignal(worker, workerId) {
  const typeInfo = detectWorkerType(worker.label);
  const templateType = typeInfo.prefix ? typeInfo.prefix.toLowerCase() : null;

  if (!COMMAND_TIER_TYPES.has(templateType)) return;
  if (!worker.ralphLearnings || worker.ralphLearnings.trim().length < 20) return;
  if (!process.env.ANTHROPIC_API_KEY) return;

  const namespace = worker.projectPath
    ? path.basename(worker.projectPath)
    : (worker.workingDir ? path.basename(worker.workingDir) : 'unknown');

  const taskDesc = worker.taskDescription || worker.task?.description || worker.task || '';
  const taskStr = typeof taskDesc === 'string' ? taskDesc : JSON.stringify(taskDesc);

  try {
    const prompt = `A ${templateType.toUpperCase()} worker just completed a task. Extract reusable memory entries from its learnings.

Task (for context):
<task>${taskStr.slice(0, 500)}</task>

Learnings:
<learnings>${worker.ralphLearnings.slice(0, 3000)}</learnings>

Extract 2-5 discrete, reusable memory entries. Each entry must be:
- Specific to THIS project's patterns/decisions (not generic advice)
- Useful to a FUTURE general/colonel starting fresh on this project
- Concise (under 200 characters)

Categories:
- "decision": a specific choice made and why ("Chose X over Y because Z")
- "pattern": a recurring structure or approach that works ("When doing X, always Y")
- "approach": a successful strategy ("To accomplish X, do Y then Z")
- "warning": something to avoid ("Do NOT X — causes Y")

Respond with ONLY a JSON array (no markdown, no explanation):
[
  {"category": "decision|pattern|approach|warning", "content": "...", "relevance_score": 0.6-1.0}
]`;

    const response = await getClient().messages.create({
      model: MEMORY_MODEL,
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text?.trim();
    if (!text) return;

    // Strip possible markdown code fences
    const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const entries = JSON.parse(cleaned);
    if (!Array.isArray(entries)) return;

    let captured = 0;
    for (const entry of entries) {
      if (!entry.content || typeof entry.content !== 'string') continue;
      if (!entry.category) continue;

      writeMemoryEntry({
        namespace,
        category: entry.category,
        content: entry.content,
        source: workerId,
        worker_role: templateType,
        relevance_score: typeof entry.relevance_score === 'number' ? entry.relevance_score : 0.8,
      });
      captured++;
    }

    if (captured > 0) {
      getLogger().info(`[Memory] Captured ${captured} entries from ${workerId} (${templateType}) for project "${namespace}"`, { workerId, templateType, namespace, captured });
    }
  } catch (err) {
    // Non-fatal — memory capture is best-effort
    getLogger().error(`[Memory] Failed to capture from ${workerId}: ${err.message}`, { workerId, err: err?.message ?? err });
  }
}

// ============================================
// AUTO-INJECT
// ============================================

/**
 * Get the most relevant memory entries for a project + role.
 * Called synchronously from templates.js context generation.
 *
 * @param {string} namespace - Project basename (e.g. "strategos")
 * @param {string} workerRole - 'general' | 'colonel'
 * @param {number} [limit=5]
 * @returns {Array<{id, namespace, category, content, source, worker_role, relevance_score, created_at}>}
 */
export function getRelevantMemories(namespace, workerRole, limit = 5) {
  try {
    return getMemoryEntries(namespace, workerRole, limit);
  } catch {
    return [];
  }
}
