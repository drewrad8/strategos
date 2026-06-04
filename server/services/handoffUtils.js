/**
 * Pure helpers for building worker handoff notes on respawn.
 * No imports — safe to use in tests without server infrastructure.
 */

/**
 * Build a handoff note from a dead worker's last Ralph state.
 * Returns a formatted block to prepend to the replacement worker's task description.
 *
 * @param {object|null} workerSnapshot  { ralphProgress, ralphCurrentStep, ralphLearnings, ralphBlockedReason }
 * @param {number} respawnCount         1-based index of this respawn attempt
 * @param {string} reason               "crashed" | "session_exhausted" | "killed"
 * @returns {string}
 */
export function buildHandoffNote(workerSnapshot, respawnCount, reason) {
  const snap = workerSnapshot || {};
  const lines = [];

  if (snap.ralphProgress !== undefined && snap.ralphProgress !== null) {
    lines.push(`Progress at death: ${snap.ralphProgress}%`);
  }
  if (snap.ralphCurrentStep) {
    lines.push(`Last step: ${snap.ralphCurrentStep}`);
  }
  if (snap.ralphLearnings) {
    lines.push(`Learnings from previous run:\n${snap.ralphLearnings}`);
  }
  if (snap.ralphBlockedReason) {
    lines.push(`Blocked reason at death: ${snap.ralphBlockedReason}`);
  }

  const body = lines.length > 0
    ? lines.join('\n')
    : 'No prior progress information available.';

  return `--- HANDOFF NOTE (auto-respawn #${respawnCount}, reason: ${reason}) ---\n${body}\n--- END HANDOFF NOTE ---\n\n`;
}
