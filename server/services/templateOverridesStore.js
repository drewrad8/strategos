/**
 * Template Overrides Store
 *
 * The SINGLE serialized read → merge → write-to-temp → atomic-rename path for
 * server/template-overrides.json.
 *
 * Background (codebase-review finding #2, HIGH — live data-corruption bug):
 * template-overrides.json gates every future worker's injected mission text and
 * had THREE unsynchronized writers, each doing a whole-file read → mutate → write
 * with NO atomic rename:
 *   - insightAnalyzer.js     (tier warnings, on a 10-min interval + ralph trigger)
 *   - learningsFeedbackService.js (success learnings, on POST /feedback-sync)
 *   - reflexionFeedbackService.js (failure warnings, on POST /reflexion-feedback-sync)
 *
 * insightAnalyzer additionally used a plain (non-atomic) writeFileSync, so a crash
 * mid-write could truncate the file — _loadTemplateOverrides() then parses garbage,
 * returns null, and EVERY spawned worker silently loses its overrides.
 *
 * This module fixes that by giving all writers one code path that:
 *   1. reads the current file (missing/garbage → safe default),
 *   2. lets the caller merge changes,
 *   3. writes to a unique temp file,
 *   4. atomically renames temp → target (crash-safe; readers never see a partial file).
 *
 * Serialization:
 *   - Production writers are synchronous (updateOverridesSync / writeOverridesAtomic).
 *     Node is single-threaded, so a synchronous read→merge→write runs to completion
 *     with no event-loop yield — it cannot interleave with another writer. That IS
 *     the serialization for the in-process production case.
 *   - updateOverrides() is the async entry point. It is guarded by an in-process
 *     promise-chain mutex keyed on the file path, so concurrent async read→merge→write
 *     cycles (which DO yield at their awaits) are serialized and cannot lose updates.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Canonical path to the overrides file shared by all writers. */
export const OVERRIDES_PATH = path.join(__dirname, '..', 'template-overrides.json');

function defaultOverrides() {
  return { version: 0, updatedAt: null, overrides: {} };
}

/**
 * Read and parse the overrides file. A missing or corrupt file yields a safe
 * default rather than throwing — callers always get a usable object.
 *
 * Intentionally does NOT use existsSync: a single readFileSync wrapped in
 * try/catch is both fewer syscalls and race-free (no TOCTOU between exists/read).
 *
 * @param {string} [filePath]
 * @returns {{version:number, updatedAt:string|null, overrides:Object}}
 */
export function readOverrides(filePath = OVERRIDES_PATH) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultOverrides();
  }
}

// Monotonic counter to keep temp filenames unique within a process even if two
// writes land in the same millisecond.
let _tmpCounter = 0;
function tmpPathFor(filePath) {
  _tmpCounter = (_tmpCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${filePath}.tmp.${process.pid}.${_tmpCounter}`;
}

/**
 * Synchronously write `data` via temp file + atomic rename. Crash-safe: a reader
 * either sees the old complete file or the new complete file, never a partial one.
 *
 * Does NOT bump version/updatedAt — versioning is the caller's responsibility
 * (each writer owns its own version/timestamp semantics).
 *
 * @param {Object} data
 * @param {string} [filePath]
 */
export function writeOverridesAtomic(data, filePath = OVERRIDES_PATH) {
  const tmp = tmpPathFor(filePath);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Synchronous serialized read → merge → atomic write.
 *
 * The mutator receives the current overrides object, mutates it (or returns a
 * replacement), and the result is atomically written. Because this is fully
 * synchronous, no other JS can run between the read and the write — the update
 * is inherently serialized within the process.
 *
 * @param {(current: Object) => (Object|void)} mutator
 * @param {string} [filePath]
 * @returns {Object} the object written
 */
export function updateOverridesSync(mutator, filePath = OVERRIDES_PATH) {
  const current = readOverrides(filePath);
  const result = mutator(current);
  const data = result === undefined ? current : result;
  writeOverridesAtomic(data, filePath);
  return data;
}

// ── Async path: in-process mutex keyed on file path ──────────────────────────
//
// Map<filePath, Promise> holding the tail of the serialized chain for that path.
// Each updateOverrides() call chains its work after the previous tail, so the
// read→merge→write cycles run strictly one-at-a-time even though each yields at
// its awaits. The stored tail swallows errors so one failed update does not wedge
// the chain for that path.
const _locks = new Map();

/**
 * Asynchronous serialized read → merge → atomic write, guarded by a per-path
 * in-process mutex. Use this for any caller that must await (or that performs
 * async work inside the mutator). Concurrent calls for the same path are
 * serialized, so no update is lost.
 *
 * @param {(current: Object) => (Object|Promise<Object>|void)} mutator
 * @param {string} [filePath]
 * @returns {Promise<Object>} the object written
 */
export function updateOverrides(mutator, filePath = OVERRIDES_PATH) {
  const prev = _locks.get(filePath) || Promise.resolve();
  const run = prev.then(async () => {
    const current = readOverrides(filePath);
    const result = await mutator(current);
    const data = result === undefined ? current : result;
    const tmp = tmpPathFor(filePath);
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, filePath);
    return data;
  });
  // Keep the chain alive even if this run rejects; never expose the rejection
  // on the stored tail (callers get it via the returned `run`).
  _locks.set(filePath, run.then(() => {}, () => {}));
  return run;
}
