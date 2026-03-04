/**
 * Delegation metrics — tracking general/colonel worker behavior.
 * Extracted from ralph.js to separate concerns.
 */

import { workers } from './state.js';
import { getLogger } from '../logger.js';

const VALID_DELEGATION_FIELDS = ['roleViolations', 'filesEdited', 'commandsRun'];

/**
 * Increment a delegation metric for a worker.
 * Called by sentinel role-violation detection to record general misbehavior.
 * @param {string} workerId - Worker ID
 * @param {string} field - One of: roleViolations, filesEdited, commandsRun
 * @param {number} [amount=1] - Amount to increment by
 * @returns {boolean} True if metric was incremented
 */
export function incrementDelegationMetric(workerId, field, amount = 1) {
  if (!VALID_DELEGATION_FIELDS.includes(field)) {
    getLogger().warn(`Invalid delegation metric field: ${field}`, { workerId, field });
    return false;
  }
  const worker = workers.get(workerId);
  if (!worker) return false;
  if (!worker.delegationMetrics) {
    worker.delegationMetrics = { spawnsIssued: 0, roleViolations: 0, filesEdited: 0, commandsRun: 0 };
  }
  worker.delegationMetrics[field] += amount;
  getLogger().info(`Delegation metric ${field} incremented for ${workerId} (${worker.label}): now ${worker.delegationMetrics[field]}`, { workerId, field, value: worker.delegationMetrics[field] });
  return true;
}

/**
 * Get delegation metrics for a worker.
 * Returns null if worker not found.
 */
export function getDelegationMetrics(workerId) {
  const worker = workers.get(workerId);
  if (!worker) return null;
  const metrics = worker.delegationMetrics || { spawnsIssued: 0, roleViolations: 0, filesEdited: 0, commandsRun: 0 };
  const upperLabel = (worker.label || '').toUpperCase();
  const isGeneral = upperLabel.startsWith('GENERAL:') || upperLabel.startsWith('GENERAL ');
  return {
    workerId,
    label: worker.label,
    isGeneral,
    metrics: { ...metrics },
    status: worker.status,
    ralphStatus: worker.ralphStatus,
    childCount: (worker.childWorkerIds || []).length,
  };
}
