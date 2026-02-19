# Strategos Codebase Improvement Report

**Date:** 2026-02-15
**Auditor:** Worker 7b71e850 (RESEARCH)
**Scope:** Full codebase — client/src/ (33 files), server/ (20 files), e2e/ (11 files)
**Context:** Post-deep-audit (135+ commits). This report identifies remaining rough edges after the extensive Feb 9 audit.

---

## Summary

The codebase is in excellent shape following the deep audit. Security, validation, and resource management are thorough. The findings below are improvements, not emergencies. The most impactful are: zero accessibility attributes (affects all users relying on assistive tech), unused react-router-dom dependency (dead weight), and missing unit tests (all testing is e2e).

---

## Critical Bugs

### 1. WorkerHealthPanel retry button ignores AbortController signal
- **File:** `client/src/components/WorkerHealthPanel.jsx:83`
- **Description:** The retry button calls `fetchMetrics()` without passing an AbortController signal. If the component unmounts while a retry is in-flight, the stale response could call `setState` on an unmounted component. The normal auto-fetch path correctly uses an AbortController.
- **Suggested fix:** Create a new AbortController in the retry handler or pass the existing signal from the effect's controller.
- **Severity:** Low (React silently ignores setState on unmounted in 18, but it's still a correctness issue)

### 2. Swallowed error in summaries fetch
- **File:** `client/src/App.jsx:72`
- **Description:** `.catch(() => {})` silently swallows network/auth errors when fetching the summaries-enabled setting. If the server is down or auth is misconfigured, the user gets no feedback.
- **Suggested fix:** Log to console.warn or show a toast notification on failure.

---

## High Priority Improvements

### 3. Zero accessibility (ARIA) attributes across entire client
- **Files:** All 33 client files in `client/src/`
- **Evidence:** `grep -r 'aria-' client/src/` returns zero matches. `grep -r 'role=' client/src/` returns zero matches (excluding JSX spread).
- **Impact:** Screen readers, keyboard navigation, and assistive technology cannot meaningfully interact with the UI. This affects Section 508 / WCAG 2.1 compliance.
- **Suggested fix:** Prioritized additions:
  1. `role="main"`, `role="navigation"`, `role="complementary"` on major layout regions (App.jsx)
  2. `aria-label` on all icon-only buttons (kill, terminal, expand — dozens across WorkerCard, WorkersView, TerminalPane)
  3. `aria-live="polite"` on Toast container for screen reader announcements
  4. `aria-expanded` on collapsible sections (FolderTree, CheckpointsView)
  5. `role="alert"` on error states (ErrorBoundary)
  6. Keyboard focus management for modal dialogs (BulldozeConfigModal, RoleSelector)

### 4. react-router-dom imported but no Routes defined
- **Files:** `client/src/main.jsx:4-5`, `client/package.json`
- **Description:** `BrowserRouter` wraps the app but no `<Routes>` or `<Route>` components are used anywhere. The app is a single-page dashboard with tab-based navigation managed entirely in state.
- **Impact:** ~60KB gzip of unused JS in the production bundle. Also, BrowserRouter causes the SPA fallback route on the server to be necessary — without it, the entire routing concern disappears.
- **Suggested fix:** Remove `react-router-dom` dependency. Replace `<BrowserRouter>` with a `<React.Fragment>` or remove it entirely.

### 5. No unit tests — all testing is e2e
- **Files:** `e2e/` (11 files, 4472 lines)
- **Evidence:** Zero `*.test.js` or `*.spec.js` files outside `e2e/`. No Jest/Vitest/Mocha configuration.
- **Impact:** Server-side logic (dependency graph cycle detection, normalizeWorker field stripping, validation regex matching, circuit breaker state machine) can only be verified through full browser-based e2e tests, which are slow and flaky.
- **Suggested fix:** Add Vitest (ships with Vite) for unit tests on:
  - `server/dependencyGraph.js` — cycle detection, cascading failure
  - `server/validation.js` — regex edge cases
  - `server/errorUtils.js` — sanitization completeness
  - `server/workerManager.js` — normalizeWorker, detectWorkerType
  - `client/src/components/RoleSelector.jsx` — parseWorkerLabel, getRoleInfo

---

## Medium Priority Improvements

### 6. key={index} anti-pattern (7 occurrences)
- **Files:**
  - `client/src/components/SplitPane.jsx:124,194` — grid pane children keyed by index
  - `client/src/components/VoiceControl.jsx:223` — command list items
  - `client/src/components/WorkerSummary.jsx:297` — summary items
  - `client/src/views/VoiceModeView.jsx:167` — conversation messages
  - `client/src/views/CheckpointsView.jsx:132,142` — output/artifact badges
- **Impact:** React may incorrectly reuse DOM elements when list items are reordered, inserted, or removed, causing visual glitches or stale state.
- **Suggested fix:** Use stable IDs where available (worker IDs, command names). For conversation messages, use a monotonic counter or timestamp.

### 7. Duplicated upload logic between WorkersView and TerminalPane
- **Files:** `client/src/views/WorkersView.jsx` (~lines 250-320), `client/src/components/TerminalPane.jsx` (~lines 50-100)
- **Description:** Both implement independent file upload via drag-drop + paste + button with FormData/multer, each with their own error handling and progress feedback.
- **Suggested fix:** Extract to a shared `useFileUpload(workerId)` hook or `FileUploadHandler` utility.

### 8. Console.log/warn/error in production client code (30 occurrences)
- **Files:** 13 client files — heaviest in `OrchestratorContext.jsx` (10), `useSocket.js` (5)
- **Impact:** Pollutes browser console in production. Some log sensitive data (worker IDs, API responses).
- **Suggested fix:** Either:
  - Add a `if (import.meta.env.DEV)` guard around console calls
  - Use a tiny logger utility that strips in production builds (Vite can tree-shake this)
  - At minimum, remove `console.log` calls (keep `.warn` and `.error`)

### 9. ADRPanel useEffect has missing dependency
- **File:** `client/src/components/ADRPanel.jsx:47-48`
- **Description:** `useEffect(() => { fetchADRs(); }, [limit])` — `fetchADRs` is not stable (it's recreated every render) and is not in the dependency array. This works by accident because `fetchADRs` closes over state setters which are stable, but it violates exhaustive-deps rules.
- **Suggested fix:** Wrap `fetchADRs` in `useCallback` or move the fetch logic inline in the effect.

### 10. VoiceModeView conversation uses unbounded array
- **File:** `client/src/views/VoiceModeView.jsx:34`
- **Description:** `setConversation(prev => [...prev, ...])` — the conversation array grows without bound. In a long voice session, this could cause memory pressure and slow rendering.
- **Suggested fix:** Cap at a reasonable limit (e.g., 100 messages) with `prev.slice(-99).concat(newMsg)`.

### 11. MetricTypes has only one metric type
- **File:** `server/metricsService.js:20-22`
- **Description:** `MetricTypes` contains only `WORKER_SPAWN_TIME`. The infrastructure supports many metric types, but only spawn time is recorded. No error rates, input latency, output capture latency, or API response times are tracked.
- **Impact:** The MetricsDashboard shows limited data. The `errorRate: 0, errorCount: 0` hardcoded in routes.js confirms this gap.
- **Suggested fix:** Add metrics for: `worker_kill_time`, `api_response_time`, `output_capture_latency`, `worker_error_count`. Record them in relevant code paths.

---

## Low Priority Improvements

### 12. Inconsistent error response format
- **Files:** Various server routes
- **Description:** Most errors return `{ error: string }`, but some return `{ error: string, details: ... }` or `{ success: false, error: string }`. The health endpoint returns `{ error: 'Health check failed' }` without the standard `sanitizeErrorMessage()` wrapper.
- **Suggested fix:** Standardize on `{ error: string }` for all error responses. Add OpenAPI/JSON Schema validation or at least document the contract.

### 13. Checkpoint file count cap (50) may be low for multi-project setups
- **File:** `server/workerManager.js:366-376`
- **Description:** Only the last 50 checkpoints are retained. With multiple projects running 5-10 workers each, checkpoints cycle out quickly.
- **Suggested fix:** Make configurable via environment variable (e.g., `STRATEGOS_MAX_CHECKPOINTS=200`).

### 14. useVoiceCommands "stop all workers" bypasses GENERAL protection
- **File:** `client/src/hooks/useVoiceCommands.js:188-201`
- **Description:** The "stop all workers" voice command calls `killWorker` on every running worker without checking if they're protected GENERALs. The server-side kill endpoint has GENERAL protection, but the client will show "Stopping N workers" even if some kills are rejected.
- **Suggested fix:** Either filter out GENERALs client-side or handle the rejection response per-worker and report accurate counts.

### 15. Missing AbortController in several polling effects
- **Files:**
  - `client/src/components/ADRPanel.jsx:46` — no abort on unmount
  - `client/src/views/ProjectsView.jsx` — projects fetch lacks abort
- **Impact:** Stale responses after tab switches could trigger unnecessary re-renders.
- **Suggested fix:** Follow the `WorkerHealthPanel` pattern: create AbortController in effect, pass signal to fetch, abort in cleanup.

### 16. Hardcoded Ollama model in summaryService
- **File:** `server/summaryService.js` (referenced in routes but not fully audited in this session)
- **Description:** Based on routes.js integration, the summary service calls Ollama with a fixed model name. If the model isn't pulled, summaries silently fail.
- **Suggested fix:** Make model name configurable via env var. Add health check that verifies model availability at startup.

### 17. VoiceControl auto-submit timeout not cancelled on unmount
- **File:** `client/src/components/VoiceControl.jsx:67-78`
- **Description:** The 2-second auto-submit timer calls `stopListening()` and `handleSubmit()`. The cleanup returns `clearTimeout(timer)` which is correct, but `handleSubmit` and `stopListening` are in the dependency array — if these change, the old timer is cleared and a new one starts. This is technically correct but fragile.
- **Severity:** Very low — functional but worth noting.

---

## Dependency Health

### Client Dependencies (package.json)
| Package | Version | Status |
|---------|---------|--------|
| react | 18.3.1 | Current |
| react-dom | 18.3.1 | Current |
| react-router-dom | 6.22.0 | **UNUSED — remove** |
| xterm | 5.3.0 | Current |
| @xterm/addon-webgl | 0.18.0 | Current |
| socket.io-client | 4.7.2 | Current (4.8.x available) |
| lucide-react | 0.309.0 | Outdated (0.460+ available) — cosmetic only |
| clsx | 2.1.0 | Current |

### Server Dependencies (package.json)
| Package | Version | Status |
|---------|---------|--------|
| express | 4.18.2 | Stable (4.21 available — minor) |
| socket.io | 4.7.2 | Current (4.8.x available) |
| better-sqlite3 | 12.5.0 | Current |
| helmet | 8.1.0 | Current |
| multer | 2.0.2 | Current |
| express-rate-limit | 8.2.1 | Current |
| uuid | 11.1.0 | Current |

**Assessment:** Dependencies are healthy. Only actionable item is removing react-router-dom.

---

## Test Coverage Gaps

### Current Coverage (e2e only)
| File | Lines | Coverage Area |
|------|-------|---------------|
| worker-lifecycle.spec.js | 1420 | Spawn, kill, settings, hierarchy |
| visual-verification.spec.js | 750 | UI rendering, screenshots |
| api-verification.test.js | 550 | REST API endpoints |
| projects-tab.spec.js | 356 | Project management |
| orchestrator.spec.js | 347 | Core orchestration |
| ipad-responsive.spec.js | 292 | Responsive design |
| multi-terminal.spec.js | 289 | Split pane, multi-terminal |
| strategos-architect-integration.spec.js | 277 | Integration scenarios |
| user-workflow.spec.js | 87 | User journey |
| quick-check.spec.js | 60 | Smoke tests |
| sidebar-tabs.spec.js | 44 | Tab navigation |

### Untested Areas
1. **Dependency graph** — Cycle detection, cascading failure, cleanup of finished workflows. No test exercises the dependency chain (dependsOn → pending → start on completion).
2. **Bulldoze mode** — State file parsing, continuation prompts, pause conditions, compaction limit, metric collection. Only tested indirectly through worker-lifecycle settings toggle.
3. **Circuit breaker** — Tmux failure counting, threshold behavior, reset. Not tested at all.
4. **Ralph signal validation** — The signal endpoint validates status values, but no test exercises invalid status rejection.
5. **Output database** — Session lifecycle, deduplication, size enforcement. No test covers `workerOutputDb.js`.
6. **Checkpoint system** — File creation, 50-checkpoint cap, concurrent kills. Partial coverage in worker-lifecycle.
7. **Voice commands** — `useVoiceCommands.js` has zero test coverage.
8. **Rate limiting** — Socket.io per-event rate limits in `socketHandler.js`. Not tested.

---

## Performance Observations

1. **Global PTY capture interval (5s)** — Efficient single-timer design. However, `captureWorkerOutput` runs sequentially through all workers. With 20+ workers, the 5s budget could be tight if tmux capture-pane is slow. Consider: parallel `Promise.all` for captures, or adaptive interval.

2. **Output buffer cap (2MB per worker)** — Adequate. The `_outputTruncationLogged` flag prevents log spam. Good pattern.

3. **DB cleanup cycles** — Three independent SQLite databases (metrics.db, worker_outputs.db, logs.db) each run their own periodic cleanup. These could collide, causing brief I/O spikes. Consider staggering cleanup timers.

4. **Socket.io room-based output** — Efficient pattern — output only sent to clients subscribed to a specific worker room. No N^2 broadcast issue.

5. **In-memory Maps** — All bounded: activityLog (100), checkpoints (50), outputBuffers (2MB/worker), inMemoryMetrics (1000/type). Good discipline.

---

## Architecture Strengths (for context)

These patterns are well-implemented and should be preserved:
- `normalizeWorker()` allowlist — prevents internal field leakage
- `safeResolvePath()` + `validateSessionName()` — injection prevention
- `escapePromptXml()` + `escapeJsonValue()` — prompt injection prevention
- Shared `validation.js` constants — single source of truth
- Per-worker rules files (`.claude/rules/strategos-worker-{id}.md`) — clean identity isolation
- Circuit breaker on tmux spawns — graceful degradation
- GENERAL protection in auto-cleanup — prevents accidental termination of command workers
- Atomic file writes (tmp + rename) — prevents corruption

---

## Prioritized Recommendations

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| **P1** | Add basic ARIA attributes to UI (#3) | Medium | High (accessibility) |
| **P1** | Remove react-router-dom (#4) | Trivial | Medium (bundle size) |
| **P2** | Add Vitest unit tests for server logic (#5) | Large | High (test confidence) |
| **P2** | Fix key={index} anti-patterns (#6) | Small | Medium (correctness) |
| **P2** | Extract duplicated upload logic (#7) | Small | Medium (maintainability) |
| **P3** | Strip console.logs from production (#8) | Small | Low (cleanliness) |
| **P3** | Add more MetricTypes (#11) | Medium | Medium (observability) |
| **P3** | Fix AbortController gaps (#1, #15) | Small | Low (correctness) |
| **P4** | Voice command GENERAL protection (#14) | Trivial | Low (edge case) |
| **P4** | Configurable checkpoint limit (#13) | Trivial | Low (flexibility) |

---

*Report generated by RESEARCH worker 7b71e850. All findings are based on static analysis of the codebase as of commit `73481a9` (2026-02-15). No code was modified during this audit.*
