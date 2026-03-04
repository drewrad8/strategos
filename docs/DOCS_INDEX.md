# Strategos Documentation Index

Catalog of all documentation files in `strategos/docs/`. Maintained to help future contributors navigate the documentation landscape.

---

## Guides

| File | Description | Date | Category |
|------|-------------|------|----------|
| [STRATEGOS_USAGE_GUIDE.md](STRATEGOS_USAGE_GUIDE.md) | Practical usage guide covering spawning workers, checking output, Ralph signaling, templates, hierarchies, and MCP integration. The primary reference for day-to-day Strategos operation. | Feb 2026 | Guide |

---

## Audits (`audits/`)

Results from the comprehensive security and functionality audit conducted Feb 9-11, 2026 (135+ commits). These document the state of the codebase at that time and the bugs found/fixed.

| File | Description | Date | Category |
|------|-------------|------|----------|
| [audits/workermanager-audit.md](audits/workermanager-audit.md) | Deep audit of `workerManager.js` (~3900 lines). Covers race conditions, error handling, resource leaks, logic bugs, and security. Found sendInput queue race (CRITICAL, fixed), shallow spread mutation, and several medium/low issues. | Feb 9, 2026 | Audit |
| [audits/api-recon-results.md](audits/api-recon-results.md) | API surface testing results. 76+ endpoint/method/input combinations tested across 4 route groups. Found 4 bugs (delete 200 for nonexistent, queue process 200 for nonexistent, unvalidated log level, metrics period=0 behavior). | Feb 9, 2026 | Audit |
| [audits/client-socket-audit.md](audits/client-socket-audit.md) | Audit of `socketHandler.js`, `summaryService.js`, `index.js`, and all client-side code. Found unvalidated spawn fields (HIGH), force-kill without server verification, and summary service prompt injection surface. | Feb 9, 2026 | Audit |
| [audits/ralph-audit.md](audits/ralph-audit.md) | Audit of the Ralph autonomous execution system: `ralphService.js`, `ralphDb.js`, `routes/ralph.js`, signal system, and workerManager integration. Found delete-while-active-run gap and other medium/low issues. | Feb 9, 2026 | Audit |
| [audits/database-audit.md](audits/database-audit.md) | Audit of all 3 SQLite databases (`worker_outputs.db`, `metrics.db`, `logs.db`) plus JSON file persistence. Covers WAL config, SQL injection safety, cleanup routines, and size limits. | Feb 9, 2026 | Audit |
| [audits/integration-adr-audit.md](audits/integration-adr-audit.md) | Audit of `routes/integration.js`, `routes/adrs.js`, and `routes/ralph.js`. 3 MEDIUM and 4 LOW findings, primarily consistency gaps. Batch endpoint silently drops invalid paths. | Feb 9, 2026 | Audit |
| [audits/autoaccept-template-audit.md](audits/autoaccept-template-audit.md) | Audit of auto-accept system, template system, and self-awareness prompt generation. Found 1 MEDIUM (template task validation), 3 LOW issues. Hash dedup, pattern analysis, and timing race analysis. | Feb 10, 2026 | Audit |
| [audits/autoaccept-prompt-audit.md](audits/autoaccept-prompt-audit.md) | Deeper audit of auto-accept patterns and prompt effectiveness. Found and fixed 3 bugs: hash reset timeout race (HIGH), fast-path case sensitivity (MEDIUM), ANSI strip gap (LOW). 33 successful accepts, 0 failures. | Feb 11, 2026 | Audit |
| [audits/mcp-ralph-audit.md](audits/mcp-ralph-audit.md) | Audit of MCP server (`server.ts`) and Ralph signaling system. All 11 MCP tool handlers verified. Rate limiting, error handling, and dist/server.js sync all pass. | Feb 11, 2026 | Audit |
| [audits/stress-test-results.md](audits/stress-test-results.md) | Concurrent stress testing: rapid spawns (5 workers), rapid inputs (10 concurrent), spawn+kill race, save/restore under load, checkpoint flood, output buffer pressure. 6/6 PASS. | Feb 9, 2026 | Test Results |
| [audits/edge-case-results.md](audits/edge-case-results.md) | Edge case scenario testing: dependency chains, long labels, rapid kill sequences. Found dependency graph treats unknown deps as completed (MEDIUM), pending workers not in API response (LOW). | Feb 10, 2026 | Test Results |
| [audits/ralph-live-test.md](audits/ralph-live-test.md) | Live test of Ralph PRD execution. 2-story PRD completed in 45 seconds. Verified worker spawning, signal processing, story completion detection, and run state transitions. | Feb 9, 2026 | Test Results |
| [audits/verification-results.md](audits/verification-results.md) | Post-fix verification of 10 bug fixes after PM2 restart. All 10 pass: sendInput mutex, inFlightSpawns, Ralph validation, context serialization, cancelRun stories, metrics WAL, and more. | Feb 9, 2026 | Verification |
| [audits/deploy-audit.md](audits/deploy-audit.md) | Infrastructure audit: PM2 config, systemd startup (NOT CONFIGURED at time), npm audit results (0 server vulns, 2 dev-only client), environment variables, and firewall status. | Feb 9, 2026 | Audit |

---

## Research (`research/`)

Analysis reports from Feb 12-16, 2026 covering system improvements, performance, and architectural evaluation.

| File | Description | Date | Category |
|------|-------------|------|----------|
| [research/improvement-report.md](research/improvement-report.md) | Post-audit improvement report. Full codebase review (33 client + 20 server files). Top findings: zero ARIA accessibility attributes, unused react-router-dom (~60KB), missing unit tests, WorkerHealthPanel retry bug. | Feb 15, 2026 | Research |
| [research/ralph-prd-engine-evaluation.md](research/ralph-prd-engine-evaluation.md) | Architectural evaluation recommending REMOVAL of Ralph PRD engine. Argues sequential story execution contradicts Strategos' parallel hierarchical delegation model. ~1,400 lines of code solving a problem the GENERAL pattern already solves better. | Feb 12, 2026 | Research |
| [research/self-audit-report.md](research/self-audit-report.md) | Full codebase read-through (read-only). Found dual auto-promotion race condition (Medium-High), stability improvements, prompting improvements, architecture concerns, and quick wins. | Feb 16, 2026 | Research |
| [research/wave2-performance-analysis.md](research/wave2-performance-analysis.md) | Performance analysis of 7 issues across workerManager, socketHandler, statusWriter, and OrchestratorContext. Covers respawnAttempts leak (LOW, bounded), timer consolidation, metrics broadcast, getWorkers caching. | Feb 12, 2026 | Research |

---

## Other Docs

| File | Description | Date | Category |
|------|-------------|------|----------|
| [gemini-cli-research.md](gemini-cli-research.md) | Research report on integrating Google's Gemini CLI as a Strategos worker backend. Covers tmux-based and headless JSONL approaches. Recommends tmux first, then headless migration. | Feb 18, 2026 | Research |
| [gemini-integration-audit.md](gemini-integration-audit.md) | Audit of the implemented Gemini CLI integration against official docs. Found 3 bugs (wrong `@import` syntax, bulldoze writes Claude context for Gemini, etc.), 2 incorrect assumptions, 5 gaps. | Feb 18, 2026 | Audit |
| screenshot.png | Screenshot of the Strategos UI. | Feb 23, 2026 | Asset |

---

## Root-Level Spec

| File | Description | Date | Category |
|------|-------------|------|----------|
| [../spec.md](../spec.md) | **HISTORICAL.** Original design specification for "Thea Orchestrator" — the initial prototype that became Strategos. Describes the basic worker-in-tmux architecture, original API surface, and iPad-first UI design. The system has evolved far beyond this spec (Ralph, dependency graphs, templates, MCP, Gemini backend, hierarchical worker trees, etc.). | Early Feb 2026 | Historical Spec |
