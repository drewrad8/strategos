/**
 * Review Gate Service — evaluates worker output quality before parent delivery.
 *
 * Stage 1: fast programmatic checks (synchronous, zero cost)
 *   - Learnings text scan for red/soft flag phrases
 *   - Output completeness check (missing learnings, missing artifacts)
 *   - Git activity check for impl/fix workers (no commits = suspicious)
 *
 * Stage 2: LLM review via Haiku (async, triggered only by Stage 1 flags)
 *   - Direct API call, NOT a spawned worker (~2–8 seconds vs 30–90 seconds)
 *   - Checks output against original task spec (Commander's Intent)
 *
 * Called from ralph.js immediately before deliverResultsToParent().
 * Non-blocking: always resolves with a decision, even on Haiku failure.
 * The gate ANNOTATES delivery — it never blocks it.
 *
 * TODO: blackboard warning — on fail/conditional, optionally write a warning
 * entry to the hierarchy blackboard so sibling workers see it immediately.
 */

import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'child_process';
import { addReviewResult } from '../learningsDb.js';
import { getLogger } from '../logger.js';

// Worker types that pass through the review gate
const REVIEW_GATE_TYPES = new Set(['impl', 'fix', 'colonel']);

// Red-flag phrases — suggest serious defect (trigger Stage 2)
const RED_FLAGS = [
  'broke', 'breaking', 'regression', 'reverted', 'rolled back',
  'tests are failing', 'test failed', 'builds failing', "couldn't complete",
  'ran out of context', 'context limit',
];

// Soft-flag phrases — suggest partial completion (accumulate; 2+ triggers Stage 2)
const SOFT_FLAGS = [
  'partial', 'incomplete', "didn't have time", "didn't test", 'not tested',
  'needs follow-up', 'premise was wrong', 'skipped', 'todo', 'left as exercise',
  'out of scope', "couldn't verify",
];

const REVIEW_MODEL = 'claude-haiku-4-5-20251001';

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Run the review gate for a completed worker.
 *
 * @param {Object} worker - The worker object (from workers Map)
 * @param {string} workerId - Worker ID
 * @param {string} templateType - e.g. 'impl', 'fix', 'colonel'
 * @returns {Promise<{decision: 'pass'|'conditional'|'fail', annotation: string|null}>}
 */
export async function runReviewGate(worker, workerId, templateType) {
  const startMs = Date.now();

  // Skip worker types not subject to review
  if (!REVIEW_GATE_TYPES.has(templateType)) {
    return { decision: 'pass', annotation: null };
  }

  // Skip if caller explicitly opted out at spawn time
  if (worker.task?.reviewGate === false) {
    return { decision: 'pass', annotation: null };
  }

  // ─── Stage 1: Programmatic checks ─────────────────────────────────────────

  const redFlags = [];
  const softFlags = [];
  const learningsText = (worker.ralphLearnings || '').toLowerCase();
  const outputsText = JSON.stringify(worker.ralphOutputs || '').toLowerCase();
  const combined = learningsText + ' ' + outputsText;

  for (const rf of RED_FLAGS) {
    if (combined.includes(rf)) {
      redFlags.push(`red flag: "${rf}" found in learnings`);
    }
  }

  for (const sf of SOFT_FLAGS) {
    if (combined.includes(sf)) {
      softFlags.push(`soft flag: "${sf}" found in learnings`);
    }
  }

  // impl/fix workers should always report what they changed
  if (!worker.ralphLearnings && templateType !== 'colonel') {
    softFlags.push('no learnings reported (impl/fix workers should describe what changed)');
  }

  // Git activity check: impl/fix workers that committed nothing are suspicious.
  // Colonels excluded — their output is the work of children, not direct commits.
  // We count commits made SINCE THE WORKER WAS SPAWNED (not just the last commit),
  // so a worker that committed cleanly is not flagged as suspicious.
  if (templateType === 'impl' || templateType === 'fix') {
    try {
      const projectPath = worker.projectPath || worker.project;
      if (projectPath) {
        // Use createdAt to count commits made after the worker was spawned.
        // git log --after uses ISO 8601 or epoch; we pass ISO string for clarity.
        const createdAt = worker.createdAt ? new Date(worker.createdAt).toISOString() : null;
        const sinceFlag = createdAt ? `--after="${createdAt}"` : '';
        const commitCount = execSync(
          `git -C "${projectPath}" log --oneline ${sinceFlag} 2>/dev/null | wc -l`,
          { timeout: 5000, encoding: 'utf8' }
        ).trim();
        const commits = parseInt(commitCount, 10);

        if (commits > 0) {
          // Worker committed — git activity looks healthy, no flag needed
        } else {
          // No commits found since spawn — evaluate suspicion by runtime
          const uptimeMs = worker.createdAt ? Date.now() - new Date(worker.createdAt).getTime() : null;
          const ranLong = uptimeMs === null || uptimeMs > 5 * 60 * 1000; // >5 min or unknown
          if (ranLong) {
            redFlags.push('no commits since worker was spawned and worker ran >5 min (impl/fix worker with no changes is suspicious)');
          } else {
            softFlags.push('no commits since worker was spawned (short-lived worker — may be expected)');
          }
        }
      }
    } catch {
      // Non-fatal: git check failure doesn't affect decision
    }
  }

  // Stage 1 decision: clean
  if (redFlags.length === 0 && softFlags.length === 0) {
    addReviewResult({
      workerId,
      stage1Flags: null,
      finalDecision: 'pass',
      durationMs: Date.now() - startMs,
    });
    return { decision: 'pass', annotation: null };
  }

  const allFlags = [...redFlags, ...softFlags];

  // Stage 1 decision: only 1 soft flag, no red flags → conditional without LLM
  if (redFlags.length === 0 && softFlags.length === 1) {
    const verdict = softFlags[0];
    addReviewResult({
      workerId,
      stage1Flags: JSON.stringify(allFlags),
      finalDecision: 'conditional',
      stage2Verdict: verdict,
      deliveredWithAnnotation: 1,
      durationMs: Date.now() - startMs,
    });
    return { decision: 'conditional', annotation: `[REVIEW: ${verdict}]` };
  }

  // ─── Stage 2: LLM review (2+ soft flags or any red flag) ──────────────────

  if (!process.env.ANTHROPIC_API_KEY) {
    // No API key: fall back to conditional
    const verdict = redFlags[0] || softFlags[0] || 'review check inconclusive';
    addReviewResult({
      workerId,
      stage1Flags: JSON.stringify(allFlags),
      finalDecision: 'conditional',
      stage2Verdict: `API key unavailable — ${verdict}`,
      deliveredWithAnnotation: 1,
      durationMs: Date.now() - startMs,
    });
    return { decision: 'conditional', annotation: `[REVIEW: ${verdict} — LLM check unavailable]` };
  }

  try {
    const taskSpec = (() => {
      const t = worker.task;
      if (!t) return '(task spec unavailable)';
      if (typeof t === 'string') return t.slice(0, 800);
      if (t.description) return t.description.slice(0, 800);
      return JSON.stringify(t).slice(0, 800);
    })();

    const workerOutput = [
      worker.ralphLearnings ? `Learnings: ${worker.ralphLearnings}` : null,
      worker.ralphOutputs ? `Outputs: ${JSON.stringify(worker.ralphOutputs)}` : null,
      worker.ralphArtifacts ? `Artifacts: ${JSON.stringify(worker.ralphArtifacts)}` : null,
    ].filter(Boolean).join('\n').slice(0, 1200);

    const prompt = `A ${templateType.toUpperCase()} worker completed this task and signaled done. Evaluate whether the reported output adequately addresses the task specification.

Task spec: <spec>${taskSpec}</spec>

Worker reported: <output>${workerOutput || '(nothing reported)'}</output>

Preliminary flags: <flags>${allFlags.join('; ')}</flags>

Respond with JSON only:
{
  "decision": "pass" | "fail" | "conditional",
  "verdict": "one sentence — the specific issue or confirmation of completeness",
  "keyTasksCovered": ["list which KEY TASKS from the spec are addressed"],
  "keyTasksMissed": ["list which KEY TASKS from the spec are NOT addressed or only partially addressed"]
}`;

    const response = await getClient().messages.create({
      model: REVIEW_MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text?.trim() || '';
    const parsed = JSON.parse(text);
    const { decision, verdict } = parsed;

    const normalizedDecision = ['pass', 'fail', 'conditional'].includes(decision) ? decision : 'conditional';

    addReviewResult({
      workerId,
      stage1Flags: JSON.stringify(allFlags),
      stage2Decision: normalizedDecision,
      stage2Verdict: verdict || null,
      stage2Raw: text,
      finalDecision: normalizedDecision,
      deliveredWithAnnotation: normalizedDecision !== 'pass' ? 1 : 0,
      durationMs: Date.now() - startMs,
    });

    if (normalizedDecision === 'pass') {
      return { decision: 'pass', annotation: null };
    } else if (normalizedDecision === 'fail') {
      return { decision: 'fail', annotation: `[REVIEW FAILED: ${verdict}]` };
    } else {
      return { decision: 'conditional', annotation: `[REVIEW: ${verdict}]` };
    }
  } catch (err) {
    // Stage 2 failure: annotate with Stage 1 result, never block delivery
    getLogger().warn(`[ReviewGate] Stage 2 LLM call failed for ${workerId}: ${err.message}`, { workerId });
    const verdict = redFlags[0] || softFlags[0] || 'review check inconclusive';
    addReviewResult({
      workerId,
      stage1Flags: JSON.stringify(allFlags),
      finalDecision: 'conditional',
      stage2Verdict: `LLM review unavailable — ${verdict}`,
      deliveredWithAnnotation: 1,
      durationMs: Date.now() - startMs,
    });
    return { decision: 'conditional', annotation: `[REVIEW: ${verdict} — LLM check unavailable]` };
  }
}
