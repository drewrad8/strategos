/**
 * Blackboard Service — per-hierarchy shared context.
 * Stores ephemeral facts in JSON files under {projectPath}/tmp/.
 * Workers read at spawn time; write on discovery.
 *
 * Storage: {projectPath}/tmp/blackboard-{hierarchyRootId}.json
 * Cleared: when hierarchy root (GENERAL) signals done, or on 24h cleanup cron.
 */

import path from 'path';
import fs from 'fs/promises';

const VALID_TYPES = new Set(['file_read', 'decision', 'error_found', 'research_result', 'file_changed', 'warning']);

// Priority order for truncation — lower index = higher priority (kept last)
const TYPE_PRIORITY = ['decision', 'error_found', 'warning', 'research_result', 'file_changed', 'file_read'];

/**
 * Walk the parentWorkerId chain to find the root worker of a hierarchy.
 * If parentWorkerId chain is broken, returns the workerId itself.
 *
 * @param {string} workerId
 * @param {Map} workers - The live workers Map from state.js
 * @returns {string} hierarchyRootId
 */
export function getHierarchyRootId(workerId, workers) {
  let current = workers.get(workerId);
  if (!current) return workerId;

  const visited = new Set();
  while (current?.parentWorkerId) {
    if (visited.has(current.id)) break; // cycle guard
    visited.add(current.id);
    const parent = workers.get(current.parentWorkerId);
    if (!parent) break;
    current = parent;
  }
  return current?.id ?? workerId;
}

/**
 * Get the file path for a hierarchy's blackboard.
 */
export function getBlackboardPath(projectPath, hierarchyRootId) {
  return path.join(projectPath, 'tmp', `blackboard-${hierarchyRootId}.json`);
}

/**
 * Read the blackboard for a hierarchy root. Returns empty structure if not found.
 */
export async function readBlackboard(projectPath, hierarchyRootId) {
  const bbPath = getBlackboardPath(projectPath, hierarchyRootId);
  try {
    const raw = await fs.readFile(bbPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { hierarchyRootId, projectPath, createdAt: null, updatedAt: null, entries: [] };
  }
}

/**
 * Append an entry to a hierarchy's blackboard.
 * Uses atomic tmp+rename write. Deduplicates by type+key (last-write-wins).
 *
 * @param {string} projectPath
 * @param {string} hierarchyRootId
 * @param {string} workerId - Worker writing the entry
 * @param {string} workerLabel
 * @param {string} type - One of VALID_TYPES
 * @param {string} key - Short identifier (truncated to 60 chars)
 * @param {string} value - Fact value (truncated to 200 chars)
 * @returns {{ success: boolean, entryId: string }}
 */
export async function appendBlackboardEntry(projectPath, hierarchyRootId, workerId, workerLabel, type, key, value) {
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Invalid blackboard entry type: ${type}. Must be one of: ${[...VALID_TYPES].join(', ')}`);
  }

  const normalizedKey = String(key).slice(0, 60).trim();
  const normalizedValue = String(value).slice(0, 200).trim();
  const normalizedType = type;

  const bbPath = getBlackboardPath(projectPath, hierarchyRootId);
  const tmpPath = bbPath + '.tmp.' + Date.now() + '.' + Math.random().toString(36).slice(2);

  // Ensure tmp dir exists
  await fs.mkdir(path.join(projectPath, 'tmp'), { recursive: true });

  // Read current state
  let bb = await readBlackboard(projectPath, hierarchyRootId);
  const now = new Date().toISOString();

  if (!bb.createdAt) {
    bb.createdAt = now;
    bb.hierarchyRootId = hierarchyRootId;
    bb.projectPath = projectPath;
  }
  bb.updatedAt = now;

  // Generate entry ID
  const entryId = `bb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const newEntry = {
    id: entryId,
    workerId,
    workerLabel: String(workerLabel).slice(0, 80),
    type: normalizedType,
    key: normalizedKey,
    value: normalizedValue,
    timestamp: now,
  };

  // Dedup: last-write-wins on same type+key
  bb.entries = bb.entries.filter(e => !(e.type === normalizedType && e.key === normalizedKey));
  bb.entries.push(newEntry);

  // Atomic write: write to tmp then rename
  await fs.writeFile(tmpPath, JSON.stringify(bb, null, 2), 'utf-8');
  await fs.rename(tmpPath, bbPath);

  return { success: true, entryId };
}

/**
 * Delete the blackboard file for a hierarchy root. Non-fatal if missing.
 */
export async function clearBlackboard(projectPath, hierarchyRootId) {
  const bbPath = getBlackboardPath(projectPath, hierarchyRootId);
  try {
    await fs.unlink(bbPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * Format blackboard entries as a markdown context section.
 * Budget: ≤500 tokens (~2400 chars). Drops lower-priority types first if over budget.
 *
 * Priority (always kept): decision, error_found, warning
 * Dropped first if over budget: file_read, then research_result, then file_changed
 *
 * @param {Object} blackboard - Result of readBlackboard()
 * @param {number} tokenBudget - Approximate token budget (default 500)
 * @returns {string} Markdown section, or empty string if no entries
 */
export function formatBlackboardForContext(blackboard, tokenBudget = 500) {
  if (!blackboard?.entries?.length) return '';

  // Character budget: ~4 chars per token
  const charBudget = tokenBudget * 4;

  // Group entries by type, keep at most 5 per type
  const byType = {};
  for (const entry of blackboard.entries) {
    if (!byType[entry.type]) byType[entry.type] = [];
    if (byType[entry.type].length < 5) {
      byType[entry.type].push(entry);
    }
  }

  const TYPE_LABELS = {
    decision: 'Decisions',
    error_found: 'Errors found',
    warning: 'Warnings',
    research_result: 'Research results',
    file_changed: 'Files changed',
    file_read: 'Files already read',
  };

  function buildSection(types) {
    let out = `## Hierarchy Blackboard\n\nInformation your colleagues have already discovered. Do not re-investigate these items.\n\n`;
    for (const type of TYPE_PRIORITY) {
      if (!types.includes(type) || !byType[type]?.length) continue;
      out += `**${TYPE_LABELS[type] || type}:**\n`;
      for (const entry of byType[type]) {
        const by = entry.workerLabel ? ` (by ${entry.workerLabel})` : '';
        const val = entry.value.slice(0, 150);
        out += `- ${entry.key}: "${val}"${by}\n`;
      }
      out += '\n';
    }
    return out.trim();
  }

  // Try with all types; drop lowest priority first if over budget
  const allTypes = TYPE_PRIORITY.filter(t => byType[t]?.length > 0);
  let section = buildSection(allTypes);

  if (section.length <= charBudget) return section;

  // Drop file_read first
  let trimmedTypes = allTypes.filter(t => t !== 'file_read');
  section = buildSection(trimmedTypes);
  if (section.length <= charBudget) return section;

  // Drop research_result next
  trimmedTypes = trimmedTypes.filter(t => t !== 'research_result');
  section = buildSection(trimmedTypes);
  if (section.length <= charBudget) return section;

  // Drop file_changed next
  trimmedTypes = trimmedTypes.filter(t => t !== 'file_changed');
  section = buildSection(trimmedTypes);

  // Hard truncate as last resort
  if (section.length > charBudget) {
    section = section.slice(0, charBudget) + '\n[...truncated]';
  }

  return section;
}

/**
 * Delete blackboard files older than 24 hours across all project tmp/ directories.
 * Called at server startup to remove orphaned files.
 *
 * @param {string} theaRoot - The THEA_ROOT directory
 */
export async function cleanupStaleBlackboards(theaRoot) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let cleaned = 0;

  try {
    // Find all project directories under theaRoot
    const entries = await fs.readdir(theaRoot, { withFileTypes: true });
    const projectDirs = entries
      .filter(e => e.isDirectory())
      .map(e => path.join(theaRoot, e.name));

    for (const projectDir of projectDirs) {
      const tmpDir = path.join(projectDir, 'tmp');
      let tmpEntries;
      try {
        tmpEntries = await fs.readdir(tmpDir);
      } catch {
        continue; // tmp/ doesn't exist or unreadable
      }

      for (const file of tmpEntries) {
        if (!file.startsWith('blackboard-') || !file.endsWith('.json')) continue;
        const filePath = path.join(tmpDir, file);
        try {
          const stat = await fs.stat(filePath);
          if (stat.mtimeMs < cutoff) {
            await fs.unlink(filePath);
            cleaned++;
          }
        } catch {
          // Non-fatal
        }
      }
    }
  } catch {
    // Non-fatal — cleanup is best-effort
  }

  return cleaned;
}
