/**
 * SMOKE PROOF (spec §6.3): per-worker worktree isolation eliminates cross-worker git
 * contamination — the direct regression test for the 21-commit leak incident
 * (thea-trader feedback_cross_worker_git_add_contamination.md).
 *
 * This is a scripted, self-contained proof. It does NOT spawn real tmux/claude workers
 * (that needs the running server); instead it drives the SAME worktree primitives the
 * lifecycle spawn path uses (createWorktree) and then runs each "worker's" git commands
 * in its own worktree, exactly as the spec describes:
 *
 *   worker1: echo a > marker1.txt; git add marker1.txt; git commit -m w1
 *   worker2: echo b > marker2.txt; git add -A;          git commit -m w2
 *   worker3: git checkout -b sidebranch; echo c > marker3.txt; git commit -am w3
 *
 * ASSERTS:
 *   - worker1's worktree shows ONLY marker1 (no marker2/marker3 leakage) even though
 *     worker2 ran `git add -A` concurrently.
 *   - each worktree's HEAD has only that worker's commit on top of the shared base.
 *   - worker3's `git checkout -b` did NOT flip the branch of the main checkout or siblings.
 *   - the main checkout's branch and working tree are UNCHANGED.
 *
 * Everything is created under strategos/tmp (THEA_ROOT-compliant) and cleaned up.
 *
 * Run: node server/workers/__smoke__/worktree-cross-contamination.smoke.js
 * Exit 0 = isolation proven; exit 1 = contamination detected.
 */

import { promises as fsp } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_BASE = path.join(__dirname, '..', '..', '..', 'tmp', `smoke-worktree-${process.pid}`);
const WT_ROOT = path.join(TMP_BASE, 'worktrees');

// Configure isolation BEFORE importing the module (it reads env on demand, but be explicit).
process.env.STRATEGOS_WORKTREE_ROOT = WT_ROOT;
process.env.STRATEGOS_ENABLE_WORKTREE_ISOLATION = '1';
delete process.env.STRATEGOS_DISABLE_WORKTREE_ISOLATION;

const { createWorktree, removeWorktree } = await import('../worktree.js');

function git(dir, args, opts = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(' ')} in ${dir} failed: ${r.stderr || r.stdout}`);
  }
  return (r.stdout || '').trim();
}

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ FAIL: ${label}`);
    failures++;
  }
}

async function main() {
  console.log('=== Worktree cross-contamination smoke proof ===\n');
  await fsp.rm(TMP_BASE, { recursive: true, force: true });
  await fsp.mkdir(TMP_BASE, { recursive: true });

  // Throwaway repo on branch `main` with a base commit.
  const repo = path.join(TMP_BASE, 'repo');
  await fsp.mkdir(repo, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 'test@test']);
  git(repo, ['config', 'user.name', 'Test']);
  await fsp.writeFile(path.join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  const baseSha = git(repo, ['rev-parse', 'HEAD']);
  const baseBranch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  console.log(`Repo at ${repo}\n  base=${baseSha.slice(0, 8)} branch=${baseBranch}\n`);

  // Spawn 3 isolated worktrees (simulating 3 concurrent workers).
  const w1 = await createWorktree(repo, 'worker0001');
  const w2 = await createWorktree(repo, 'worker0002');
  const w3 = await createWorktree(repo, 'worker0003');
  console.log('Created 3 isolated worktrees.\n');
  check('all three are isolated', w1.isolated && w2.isolated && w3.isolated);

  // --- worker1: marker1 + targeted add/commit ---
  await fsp.writeFile(path.join(w1.workingDir, 'marker1.txt'), 'a\n');
  git(w1.workingDir, ['add', 'marker1.txt']);
  git(w1.workingDir, ['commit', '-q', '-m', 'w1']);

  // --- worker2: marker2 + `git add -A` (the dangerous one) ---
  await fsp.writeFile(path.join(w2.workingDir, 'marker2.txt'), 'b\n');
  git(w2.workingDir, ['add', '-A']);
  git(w2.workingDir, ['commit', '-q', '-m', 'w2']);

  // --- worker3: new branch + marker3 + commit -am (the branch-flip one) ---
  git(w3.workingDir, ['checkout', '-q', '-b', 'sidebranch']);
  await fsp.writeFile(path.join(w3.workingDir, 'marker3.txt'), 'c\n');
  git(w3.workingDir, ['add', '-A']); // marker3 is new/untracked; -am alone wouldn't stage it
  git(w3.workingDir, ['commit', '-q', '-m', 'w3']);

  console.log('All three workers committed in their own worktrees.\n');

  // ===== ASSERTIONS =====
  console.log('Assertions:');

  // worker1 saw ONLY its own file — no marker2/marker3 leaked in despite worker2's add -A.
  const w1Files = git(w1.workingDir, ['ls-files']).split('\n').filter(Boolean);
  check('worker1 tree has marker1.txt', w1Files.includes('marker1.txt'));
  check('worker1 tree does NOT have marker2.txt (no add -A leak)', !w1Files.includes('marker2.txt'));
  check('worker1 tree does NOT have marker3.txt', !w1Files.includes('marker3.txt'));

  // worker2 likewise isolated.
  const w2Files = git(w2.workingDir, ['ls-files']).split('\n').filter(Boolean);
  check('worker2 tree has marker2.txt only (no marker1/marker3)',
    w2Files.includes('marker2.txt') && !w2Files.includes('marker1.txt') && !w2Files.includes('marker3.txt'));

  // Each worktree HEAD = exactly one commit on top of the shared base.
  const w1Log = git(w1.workingDir, ['log', '--format=%s', `${baseSha}..HEAD`]).split('\n').filter(Boolean);
  const w2Log = git(w2.workingDir, ['log', '--format=%s', `${baseSha}..HEAD`]).split('\n').filter(Boolean);
  const w3Log = git(w3.workingDir, ['log', '--format=%s', `${baseSha}..HEAD`]).split('\n').filter(Boolean);
  check('worker1 HEAD = [w1] on base', w1Log.length === 1 && w1Log[0] === 'w1');
  check('worker2 HEAD = [w2] on base', w2Log.length === 1 && w2Log[0] === 'w2');
  check('worker3 HEAD = [w3] on base', w3Log.length === 1 && w3Log[0] === 'w3');

  // worker3's `git checkout -b sidebranch` did NOT flip the main repo's branch.
  const mainBranchAfter = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  check(`main checkout branch still '${baseBranch}' (worker3 branch-switch contained)`, mainBranchAfter === baseBranch);

  // Main checkout HEAD unchanged and working tree clean (no leaked files/commits).
  const mainShaAfter = git(repo, ['rev-parse', 'HEAD']);
  check('main checkout HEAD unchanged', mainShaAfter === baseSha);
  const mainStatus = git(repo, ['status', '--porcelain']);
  check('main checkout working tree clean (no contamination)', mainStatus === '');

  // The three commits DO live in the shared object store (reachable by SHA) — E6.
  const w1Sha = git(w1.workingDir, ['rev-parse', 'HEAD']);
  const reachable = git(repo, ['cat-file', '-t', w1Sha], { allowFail: true });
  check('worker1 commit reachable in shared object store (E6)', reachable === 'commit');

  // Cleanup.
  await removeWorktree(repo, 'worker0001');
  await removeWorktree(repo, 'worker0002');
  await removeWorktree(repo, 'worker0003');
  await fsp.rm(TMP_BASE, { recursive: true, force: true });

  console.log('');
  if (failures === 0) {
    console.log('=== RESULT: PASS — cross-worker contamination ELIMINATED ===');
    process.exit(0);
  } else {
    console.log(`=== RESULT: FAIL — ${failures} contamination check(s) failed ===`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke script error:', err);
  fsp.rm(TMP_BASE, { recursive: true, force: true }).finally(() => process.exit(1));
});
