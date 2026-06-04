/**
 * Consolidation service for post-compaction re-orientation.
 *
 * When Claude Code compacts a worker's conversation context, the worker loses
 * short-term memory of its current task state. This service generates a structured
 * re-orientation message from server-side data so the worker can resume without drift.
 */

import fs from 'fs';
import path from 'path';
import { getLogger } from '../logger.js';
import { execAsync } from '../workers/state.js';

const logger = getLogger();

/**
 * Build a structured POST-COMPACTION RE-ORIENTATION message for a worker.
 *
 * Pulls from server-side state: task description, recent Ralph progress steps,
 * recent git commits, current progress %, and any known blockers.
 *
 * @param {object} worker - The worker object from the workers Map
 * @returns {string} Formatted re-orientation message to inject via sendInput
 */
export async function generateConsolidationMessage(worker) {
  // Check for handoff document from predecessor rotation
  const handoffPath = path.join(worker.projectPath || worker.workingDir || '', `tmp/handoff-${worker.id}.md`);
  if (handoffPath && fs.existsSync(handoffPath)) {
    const handoff = fs.readFileSync(handoffPath, 'utf8');
    return `[CONTEXT ROTATION DETECTED]\n\nYour predecessor left this handoff document:\n\n${handoff}\n\nResume from the Remaining Work section. Do not re-do completed work.`;
  }

  const lines = [
    '=== POST-COMPACTION RE-ORIENTATION ===',
    'Your context was just compacted by Claude Code. Use the information below to re-orient and continue your task without repeating completed work.',
    '',
  ];

  // 1. Original task description (verbatim)
  const taskDesc = worker.task?.description || null;
  if (taskDesc) {
    lines.push('## YOUR TASK (original, verbatim)');
    lines.push(taskDesc.trim());
    lines.push('');
  }

  // 2. Last 3 Ralph signal currentStep values from rolling history
  const stepHistory = worker._ralphStepHistory || [];
  if (stepHistory.length > 0) {
    lines.push('## RECENT PROGRESS STEPS (most recent last)');
    const recent = stepHistory.slice(-3);
    recent.forEach((entry, i) => {
      lines.push(`${i + 1}. [${entry.at.slice(11, 19)} UTC] ${entry.step}`);
    });
    lines.push('');
  } else if (worker.ralphCurrentStep) {
    lines.push('## LAST KNOWN STEP');
    lines.push(worker.ralphCurrentStep);
    lines.push('');
  }

  // 3. Recent git commits in the worker's working directory (last 5)
  const workingDir = worker.workingDir || null;
  if (workingDir) {
    try {
      const { stdout: gitLogRaw } = await execAsync(
        `git -C "${workingDir}" log --oneline -5 --no-color 2>/dev/null`,
        { timeout: 5000 }
      );
      const gitLog = gitLogRaw.trim();
      if (gitLog) {
        lines.push('## RECENT COMMITS (last 5 in project)');
        lines.push(gitLog);
        lines.push('');
      }
    } catch (err) {
      logger.warn(`[consolidation] git log unavailable for workingDir=${workingDir}: ${err.message}`);
    }
  }

  // 4. Current Ralph progress percentage
  if (worker.ralphProgress !== undefined && worker.ralphProgress !== null) {
    lines.push(`## PROGRESS: ${worker.ralphProgress}%`);
    lines.push('');
  }

  // 5. Known blockers
  if (worker.ralphBlockedReason) {
    lines.push('## KNOWN BLOCKERS');
    lines.push(worker.ralphBlockedReason.trim());
    lines.push('');
  }

  lines.push('Continue from where you left off. Do NOT restart from scratch. Do NOT repeat already-committed work (check git log).');
  lines.push('=== END RE-ORIENTATION ===');

  return lines.join('\n');
}
