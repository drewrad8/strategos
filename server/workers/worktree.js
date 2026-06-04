/**
 * Per-worker git worktree isolation.
 *
 * Every Strategos worker for a project historically shared one working directory
 * (`projectPath`). Because git's index, HEAD, and `git checkout` are per-working-tree
 * and process-global to that tree, concurrent workers stomp on each other — a
 * `git add -A` sweeps in a sibling's edits, a `git checkout` flips the branch out from
 * under everyone. This module gives each worker its own `git worktree` (a detached-HEAD
 * checkout at the repo's current commit), so a worker's add/commit/checkout cannot
 * contaminate any other tree.
 *
 * See docs/proposals/worktree-isolation-2026-05-30.md for the full design.
 */

import { spawn, path, fs, existsSync } from './state.js';
import os from 'os';
import { getLogger } from '../logger.js';

const logger = getLogger();

/**
 * V1 ROLLOUT FLAG — isolation is OFF by default (per rollout §8).
 *
 * To flip to default-ON in v2, change this single constant to `true`. After the flip,
 * `STRATEGOS_DISABLE_WORKTREE_ISOLATION=true` becomes the per-job/per-project escape
 * hatch (e.g. for collaborative same-branch surgery). This is the one-line v2 change.
 */
const DEFAULT_ISOLATION_ENABLED = false;

/**
 * Base directory for per-worker worktrees. Override via STRATEGOS_WORKTREE_ROOT.
 * Read dynamically (not cached) so the env override can be set at runtime (tests).
 * @returns {string}
 */
function worktreeRoot() {
  return process.env.STRATEGOS_WORKTREE_ROOT
    || path.join(os.homedir(), '.strategos', 'worktrees');
}

/**
 * Per-repo serialization lock. `git worktree add`/`remove` take the repo's worktrees
 * admin lock internally, but we serialize per-repoPath defensively (E5) so a remove
 * never races an add for the same repo.
 * @type {Map<string, Promise<unknown>>}
 */
const _repoLocks = new Map();

/**
 * Run `fn` serialized against any other worktree op on the same repo.
 * @param {string} repoPath
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
function withRepoLock(repoPath, fn) {
  const prev = _repoLocks.get(repoPath) || Promise.resolve();
  const next = prev.then(fn, fn);
  // Swallow rejections on the stored chain so one failure doesn't poison the next op.
  _repoLocks.set(repoPath, next.then(() => {}, () => {}));
  return next;
}

/**
 * Run `git` with args as an array (never a shell string — avoids injection/quoting).
 * @param {string[]} args
 * @returns {Promise<string>} trimmed stdout on success
 */
function git(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Whether per-worker worktree isolation is active.
 *
 * v1: OFF unless explicitly enabled via STRATEGOS_ENABLE_WORKTREE_ISOLATION=1 (or =true).
 * STRATEGOS_DISABLE_WORKTREE_ISOLATION=true always wins (the v2 escape hatch).
 * @returns {boolean}
 */
export function worktreeIsolationEnabled() {
  if (process.env.STRATEGOS_DISABLE_WORKTREE_ISOLATION === 'true') return false;
  if (DEFAULT_ISOLATION_ENABLED) return true;
  return process.env.STRATEGOS_ENABLE_WORKTREE_ISOLATION === '1'
    || process.env.STRATEGOS_ENABLE_WORKTREE_ISOLATION === 'true';
}

/** Absolute worktree destination dir for a worker. @param {string} workerId */
function worktreeDest(workerId) {
  return path.join(worktreeRoot(), workerId);
}

/**
 * Durable branch a worker's worktree is checked out on. Every commit a worker makes
 * lands here, so it survives `git worktree remove` (a detached HEAD would not — its
 * commits become dangling and are reaped by the next `git gc`).
 * @param {string} workerId
 * @returns {string}
 */
function workerBranch(workerId) {
  return `worker/${workerId}`;
}

/**
 * Last-resort safety ref capturing a worktree's HEAD before teardown. Lives under
 * `refs/worker-output/` (NOT `refs/heads/`) so it is never "checked out" anywhere and
 * `update-ref` against it can never collide with the worktree's own branch.
 * @param {string} workerId
 * @returns {string}
 */
function workerOutputRef(workerId) {
  return `refs/worker-output/${workerId}`;
}

/**
 * Defense-in-depth (§3.4): before a worktree is torn down, guarantee any commits it
 * holds beyond the source branch are reachable from a named ref, so teardown can NEVER
 * orphan a worker's output — even if its branch ref was somehow lost. Best-effort and
 * non-throwing, mirroring the idempotent removal path.
 * @param {string} repoPath
 * @param {string} dest      worktree working dir (may already be gone)
 * @param {string} workerId
 */
async function ensureCommitsReachable(repoPath, dest, workerId) {
  try {
    if (!existsSync(dest)) return; // nothing to inspect — already removed
    const head = await git(['-C', dest, 'rev-parse', '--verify', 'HEAD']);
    // Compare against the source branch tip (repo HEAD). If the worktree HEAD is an
    // ancestor of it, the worker added no new commits — nothing to preserve.
    let base = null;
    try { base = await git(['-C', repoPath, 'rev-parse', '--verify', 'HEAD']); } catch { /* fresh repo */ }
    if (base) {
      try {
        const mb = await git(['-C', repoPath, 'merge-base', base, head]);
        if (mb === head) return; // HEAD ⊆ base → no worker commits to save
      } catch { /* unrelated histories — fall through and capture HEAD */ }
    }
    await git(['-C', repoPath, 'update-ref', workerOutputRef(workerId), head]);
    logger.info(`[Worktree] Captured ${workerId} HEAD ${head.slice(0, 8)} at ${workerOutputRef(workerId)} before teardown`);
  } catch (err) {
    logger.debug(`[Worktree] ensureCommitsReachable best-effort skip for ${workerId}: ${err.message}`);
  }
}

/**
 * Best-effort, idempotent removal of a worktree at `dest` belonging to `repoPath`.
 * Tries `git worktree remove --force`, then rm -rf any survivor, then prunes admin
 * entries. Never throws.
 * @param {string} repoPath
 * @param {string} dest
 */
async function removeWorktreeDir(repoPath, dest) {
  try {
    await git(['-C', repoPath, 'worktree', 'remove', dest, '--force']);
  } catch (err) {
    logger.debug(`[Worktree] 'worktree remove' failed for ${dest} (will rm + prune): ${err.message}`);
  }
  // rm survivors: out-of-band deletions or a failed remove leave the dir behind.
  try {
    await fs.rm(dest, { recursive: true, force: true });
  } catch (err) {
    logger.warn(`[Worktree] rm failed for ${dest}: ${err.message}`);
  }
  // Clear admin entries for now-missing worktrees.
  try {
    await git(['-C', repoPath, 'worktree', 'prune']);
  } catch { /* best-effort */ }
}

/**
 * Create a per-worker isolated worktree for `repoPath`.
 *
 * Falls back to the shared cwd (no isolation) when the feature is disabled or the
 * project is not a git repo. Uses `worktree add -B worker/<id> <dest> <base>` so the
 * worker starts at `base` on a DURABLE NAMED BRANCH (not a detached HEAD). Every commit
 * the worker makes lands on `worker/<id>`, a ref that survives `git worktree remove` —
 * without this, commits on a detached HEAD become dangling and are lost at the next
 * `git gc` (the #1 integrity bug this fix closes). `-B` (force-create) makes a reused
 * worker id from a prior run reset cleanly instead of failing on an existing branch.
 * The worker's git operations still cannot contaminate any other tree (spec E3).
 *
 * @param {string} repoPath  Canonical repo (has .git); also the context source.
 * @param {string} workerId  uuid-derived worker id; used as the worktree dir name.
 * @param {string} [base='HEAD']  Commit-ish to check out.
 * @returns {Promise<{workingDir: string, repoPath: string, isolated: boolean}>}
 */
export async function createWorktree(repoPath, workerId, base = 'HEAD') {
  if (!worktreeIsolationEnabled()) {
    return { workingDir: repoPath, repoPath, isolated: false };
  }
  if (!existsSync(path.join(repoPath, '.git'))) {
    logger.warn(`[Worktree] ${repoPath} has no .git — worker runs in shared cwd (no isolation)`);
    return { workingDir: repoPath, repoPath, isolated: false };
  }

  const dest = worktreeDest(workerId);
  return withRepoLock(repoPath, async () => {
    // E1: a stale dir from a prior crash / id reuse must be cleaned before re-adding.
    if (existsSync(dest)) {
      logger.warn(`[Worktree] dest ${dest} already exists — cleaning stale worktree first`);
      await removeWorktreeDir(repoPath, dest);
    }
    await fs.mkdir(worktreeRoot(), { recursive: true });
    // -B (force-create/reset) on worker/<id>: a leftover branch from a pruned worktree
    // (boot-GC removes the dir + admin entry but NOT the branch) is reset cleanly here.
    await git(['-C', repoPath, 'worktree', 'add', '-B', workerBranch(workerId), dest, base]);
    logger.info(`[Worktree] Created isolated worktree for ${workerId} at ${dest} on branch ${workerBranch(workerId)}`);
    return { workingDir: dest, repoPath, isolated: true };
  });
}

/**
 * Remove a worker's worktree. Best-effort and idempotent — safe to call for a worker
 * that never had one, or whose worktree was already removed.
 * @param {string} repoPath
 * @param {string} workerId
 */
export async function removeWorktree(repoPath, workerId) {
  const dest = worktreeDest(workerId);
  return withRepoLock(repoPath, async () => {
    // Defense-in-depth: capture any worker commits under a named ref BEFORE removal,
    // so teardown can never orphan output even if the worktree branch was lost.
    await ensureCommitsReachable(repoPath, dest, workerId);
    await removeWorktreeDir(repoPath, dest);
  });
}

/**
 * Boot-time GC: prune admin entries on known repos and remove orphan worktree dirs
 * whose owning worker is no longer alive (crash-during-downtime hygiene, spec E4).
 *
 * @param {string[]} [liveWorkerIds=[]]  Worker ids still alive — their dirs are kept.
 *   (Worktree dirs are named by worker id, so this is the keep-set.)
 * @param {string[]} [repoPaths=[]]  Repos to run `git worktree prune` on.
 * @returns {Promise<{removed: string[]}>}
 */
export async function pruneWorktrees(liveWorkerIds = [], repoPaths = []) {
  const live = new Set(liveWorkerIds);
  const root = worktreeRoot();

  // 1. Remove orphan dirs whose worker is no longer alive.
  let entries;
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn(`[Worktree] cannot scan ${root}: ${err.message}`);
    }
    entries = [];
  }

  const removed = [];
  for (const entry of entries) {
    if (live.has(entry)) continue;
    const dir = path.join(root, entry);
    try {
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(dir);
      logger.info(`[Worktree] Pruned orphan worktree dir: ${dir}`);
    } catch (err) {
      logger.warn(`[Worktree] Failed to prune ${dir}: ${err.message}`);
    }
  }

  // 2. Clear now-stale admin entries on each known repo (must run AFTER dir removal).
  for (const repoPath of new Set(repoPaths)) {
    try {
      if (existsSync(path.join(repoPath, '.git'))) {
        await git(['-C', repoPath, 'worktree', 'prune']);
      }
    } catch (err) {
      logger.debug(`[Worktree] prune failed for ${repoPath}: ${err.message}`);
    }
  }

  return { removed };
}

/** Exposed for tests / diagnostics. @returns {string} */
export function getWorktreeRoot() {
  return worktreeRoot();
}
