/**
 * retestMapper.js — Component-to-test mapping for auto-retest system.
 *
 * Maps changed source files to the Playwright spec files that cover them.
 * Uses a two-tier system:
 *   1. Direct mapping — explicit file-to-spec associations (high confidence)
 *   2. Pattern matching — directory-based fallbacks (medium confidence)
 *
 * If no mapping matches a client file, falls back to visual-verification.spec.js.
 *
 * Spec: research/33-auto-retest-framework.md Section 4.2–4.3
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ─── Views ────────────────────────────────────────────
// ─── Worker Components ────────────────────────────────
// ─── Project Components ───────────────────────────────
// ─── Terminal Components ──────────────────────────────
// ─── Data Components ──────────────────────────────────
// ─── Voice Components ─────────────────────────────────
// ─── System Components ────────────────────────────────
// ─── Common Components ────────────────────────────────
// ─── Context ──────────────────────────────────────────
// ─── CSS / Tailwind ───────────────────────────────────

export const COMPONENT_TO_TESTS = {
  // ─── Views ────────────────────────────────────────────
  'client/src/App.jsx': [
    'visual-verification.spec.js',
    'orchestrator.spec.js',
    'ipad-responsive.spec.js',
  ],
  'client/src/views/WorkersView.jsx': [
    'visual-verification.spec.js',
    'orchestrator.spec.js',
    'multi-terminal.spec.js',
    'ipad-responsive.spec.js',
  ],
  'client/src/views/ProjectsView.jsx': [
    'visual-verification.spec.js',
    'projects-tab.spec.js',
    'orchestrator.spec.js',
  ],
  'client/src/views/VoiceModeView.jsx': [
    'visual-verification.spec.js',
  ],
  'client/src/views/CheckpointsView.jsx': [
    'visual-verification.spec.js',
  ],

  // ─── Worker Components ────────────────────────────────
  'client/src/components/worker/WorkerCard.jsx': [
    'visual-verification.spec.js',
    'orchestrator.spec.js',
    'ipad-responsive.spec.js',
  ],
  'client/src/components/worker/WorkerTreeView.jsx': [
    'visual-verification.spec.js',
    'orchestrator.spec.js',
  ],
  'client/src/components/worker/WorkerHealthPanel.jsx': [
    'visual-verification.spec.js',
    'ipad-responsive.spec.js',
  ],
  'client/src/components/worker/WorkerSummary.jsx': [
    'visual-verification.spec.js',
    'orchestrator.spec.js',
  ],

  // ─── Project Components ───────────────────────────────
  'client/src/components/project/FolderTree.jsx': [
    'projects-tab.spec.js',
    'visual-verification.spec.js',
    'orchestrator.spec.js',
  ],
  'client/src/components/project/ProjectCard.jsx': [
    'visual-verification.spec.js',
    'projects-tab.spec.js',
  ],
  'client/src/components/project/ProjectDetailView.jsx': [
    'projects-tab.spec.js',
    'visual-verification.spec.js',
  ],
  'client/src/components/project/RoleSelector.jsx': [
    'projects-tab.spec.js',
  ],
  'client/src/components/project/BulldozeConfigModal.jsx': [
    'visual-verification.spec.js',
  ],

  // ─── Terminal Components ──────────────────────────────
  'client/src/components/terminal/Terminal.jsx': [
    'multi-terminal.spec.js',
    'visual-verification.spec.js',
    'orchestrator.spec.js',
  ],
  'client/src/components/terminal/TerminalPane.jsx': [
    'multi-terminal.spec.js',
  ],
  'client/src/components/terminal/MultiTerminalView.jsx': [
    'multi-terminal.spec.js',
    'visual-verification.spec.js',
  ],
  'client/src/components/terminal/SplitPane.jsx': [
    'multi-terminal.spec.js',
  ],

  // ─── Data Components ──────────────────────────────────
  'client/src/components/data/ActivityFeed.jsx': [
    'visual-verification.spec.js',
    'orchestrator.spec.js',
    'sidebar-tabs.spec.js',
    'user-workflow.spec.js',
  ],
  'client/src/components/data/ADRPanel.jsx': [
    'sidebar-tabs.spec.js',
    'user-workflow.spec.js',
    'strategos-architect-integration.spec.js',
  ],
  'client/src/components/data/MetricsDashboard.jsx': [
    'visual-verification.spec.js',
  ],
  'client/src/components/data/RalphPanel.jsx': [
    'visual-verification.spec.js',
  ],

  // ─── Voice Components ─────────────────────────────────
  'client/src/components/voice/VoiceControl.jsx': [
    'visual-verification.spec.js',
  ],
  'client/src/components/voice/VoiceInput.jsx': [
    'visual-verification.spec.js',
    'ipad-responsive.spec.js',
  ],

  // ─── System Components ────────────────────────────────
  'client/src/components/system/Toast.jsx': [
    'visual-verification.spec.js',
  ],
  'client/src/components/system/ErrorBoundary.jsx': [
    'visual-verification.spec.js',
  ],
  'client/src/components/system/HealthIndicator.jsx': [
    'visual-verification.spec.js',
    'orchestrator.spec.js',
  ],
  'client/src/components/system/SettingsDropdown.jsx': [
    'visual-verification.spec.js',
  ],
  'client/src/components/system/KeyboardShortcutHelp.jsx': [
    'visual-verification.spec.js',
  ],
  'client/src/components/system/UsageMeter.jsx': [
    'visual-verification.spec.js',
  ],

  // ─── Common Components ────────────────────────────────
  'client/src/components/common/SearchInput.jsx': [
    'projects-tab.spec.js',
    'visual-verification.spec.js',
  ],
  'client/src/components/common/RalphProgressBar.jsx': [
    'visual-verification.spec.js',
  ],
  'client/src/components/common/EmptyState.jsx': [
    'visual-verification.spec.js',
  ],
  'client/src/components/common/LoadingSpinner.jsx': [
    'visual-verification.spec.js',
  ],

  // ─── Context ──────────────────────────────────────────
  'client/src/context/OrchestratorContext.jsx': [
    'orchestrator.spec.js',
    'visual-verification.spec.js',
    'worker-lifecycle.spec.js',
    'projects-tab.spec.js',
    'multi-terminal.spec.js',
    'sidebar-tabs.spec.js',
    'user-workflow.spec.js',
    'ipad-responsive.spec.js',
  ],

  // ─── CSS / Tailwind ───────────────────────────────────
  'client/src/index.css': [
    'visual-verification.spec.js',
    'ipad-responsive.spec.js',
  ],
  'client/tailwind.config.js': [
    'visual-verification.spec.js',
    'ipad-responsive.spec.js',
  ],
};

// ─── Server change mappings (API tests) ─────────────────
export const SERVER_TO_TESTS = {
  'server/routes/workers.js':       ['worker-lifecycle.spec.js'],
  'server/routes/projects.js':      ['projects-tab.spec.js'],
  'server/routes/system.js':        ['api-verification.test.js'],
  'server/routes/ralph.js':         ['api-verification.test.js'],
  'server/routes/integration.js':   ['strategos-architect-integration.spec.js'],
  'server/routes/adrs.js':          ['strategos-architect-integration.spec.js'],
  'server/workerManager.js':        ['worker-lifecycle.spec.js'],
  'server/workers/lifecycle.js':    ['worker-lifecycle.spec.js', 'general-enforcement.test.js'],
  'server/workers/ralph.js':        ['api-verification.test.js', 'general-enforcement.test.js'],
  'server/workers/output.js':       ['general-enforcement.test.js'],
  'server/workers/templates.js':    ['general-enforcement.test.js'],
  'server/sentinel.js':             ['api-verification.test.js'],
  'server/socketHandler.js':        ['orchestrator.spec.js', 'visual-verification.spec.js'],
  'server/retestService.js':        ['api-verification.test.js'],
  'server/retestMapper.js':         ['api-verification.test.js'],
  'server/routes/retest.js':        ['api-verification.test.js'],
};

// ─── Directory-based fallback patterns ──────────────────
export const DIRECTORY_FALLBACKS = [
  { pattern: 'client/src/components/worker/',   tests: ['visual-verification.spec.js', 'orchestrator.spec.js'] },
  { pattern: 'client/src/components/project/',   tests: ['projects-tab.spec.js', 'visual-verification.spec.js'] },
  { pattern: 'client/src/components/terminal/',  tests: ['multi-terminal.spec.js', 'visual-verification.spec.js'] },
  { pattern: 'client/src/components/data/',      tests: ['sidebar-tabs.spec.js', 'visual-verification.spec.js'] },
  { pattern: 'client/src/components/voice/',     tests: ['visual-verification.spec.js'] },
  { pattern: 'client/src/components/system/',    tests: ['visual-verification.spec.js', 'orchestrator.spec.js'] },
  { pattern: 'client/src/components/common/',    tests: ['visual-verification.spec.js'] },
  { pattern: 'client/src/views/',                tests: ['visual-verification.spec.js', 'orchestrator.spec.js'] },
  { pattern: 'client/src/',                      tests: ['visual-verification.spec.js'] },
];

// All UI specs — used when OrchestratorContext changes trigger a full UI suite run
const ALL_UI_SPECS = [
  'orchestrator.spec.js',
  'visual-verification.spec.js',
  'worker-lifecycle.spec.js',
  'projects-tab.spec.js',
  'multi-terminal.spec.js',
  'sidebar-tabs.spec.js',
  'user-workflow.spec.js',
  'ipad-responsive.spec.js',
];

/**
 * Resolve which test specs to run for a set of changed files.
 *
 * Algorithm (from spec Section 4.3):
 *   1. Try direct COMPONENT_TO_TESTS mapping
 *   2. Try SERVER_TO_TESTS mapping
 *   3. Try DIRECTORY_FALLBACKS (first match wins)
 *   4. Ultimate fallback: any client/ file → visual-verification.spec.js
 *   5. If OrchestratorContext changed, add ALL_UI_SPECS
 *
 * @param {string[]} changedFiles - Array of file paths relative to project root
 * @returns {string[]} Deduplicated array of spec file names to run
 */
export function resolveTests(changedFiles) {
  const testSet = new Set();

  for (const file of changedFiles) {
    // 1. Try direct component mapping
    if (COMPONENT_TO_TESTS[file]) {
      for (const spec of COMPONENT_TO_TESTS[file]) {
        testSet.add(spec);
      }
      continue;
    }

    // 2. Try server mapping
    if (SERVER_TO_TESTS[file]) {
      for (const spec of SERVER_TO_TESTS[file]) {
        testSet.add(spec);
      }
      continue;
    }

    // 3. Try directory fallback (first match wins)
    let matched = false;
    for (const fallback of DIRECTORY_FALLBACKS) {
      if (file.startsWith(fallback.pattern)) {
        for (const spec of fallback.tests) {
          testSet.add(spec);
        }
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // 4. Ultimate fallback for any client file
    if (file.startsWith('client/')) {
      testSet.add('visual-verification.spec.js');
    }
  }

  // 5. If OrchestratorContext changed, add all UI specs
  if (changedFiles.includes('client/src/context/OrchestratorContext.jsx')) {
    for (const spec of ALL_UI_SPECS) {
      testSet.add(spec);
    }
  }

  return Array.from(testSet);
}

/**
 * Get the list of changed files by running git diff --name-only against a ref.
 *
 * @param {string} ref - Git ref to diff against (e.g. "HEAD~1", a commit hash, a branch)
 * @returns {Promise<string[]>} Array of changed file paths relative to project root
 */
export async function getChangedFiles(ref = 'HEAD~1') {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${ref}..HEAD`], {
      cwd: process.cwd(),
      timeout: 10000,
    });
    return stdout.trim().split('\n').filter(Boolean);
  } catch (err) {
    console.error(`[retestMapper] git diff failed for ref "${ref}":`, err.message);
    return [];
  }
}
