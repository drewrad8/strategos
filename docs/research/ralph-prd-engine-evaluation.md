# Ralph PRD Engine Evaluation Report

**Researcher:** RESEARCH: ralph-prd-engine-evaluation (d80f36f1)
**Date:** 2026-02-12
**Status:** COMPLETE

---

## Executive Summary

**Recommendation: REMOVE the Ralph PRD autonomous execution engine. Keep standalone worker signals.**

The PRD engine is a well-engineered but fundamentally misguided feature. It implements sequential story execution — spawning one worker at a time, waiting for completion, then spawning the next — in a system whose core value proposition is *parallel hierarchical delegation*. The GENERAL worker pattern already does everything the PRD engine attempts, but better: it decomposes tasks dynamically, delegates in parallel, adapts to failures in real-time, and maintains strategic context across the entire operation. The PRD engine is ~1,400 lines of carefully hardened code (ralphService.js + ralphDb.js + routes/ralph.js + RalphPanel.jsx) that solves a problem Strategos already solved more effectively with its existing architecture.

---

## 1. What the PRD Engine Actually Does

### Architecture (source: `server/services/ralphService.js`)

The PRD engine implements a **sequential story execution loop**:

1. User creates a PRD with ordered user stories (via API or UI)
2. User hits "Run" — creates a `ralph_run` in SQLite
3. Engine picks the highest-priority pending story
4. Spawns a single Claude Code worker with the story prompt + completion token
5. Health-monitors the worker (5s polling intervals)
6. Worker signals completion via `POST /api/ralph/signal/{token}`
7. Engine stores learnings, marks story complete, spawns next worker
8. Loop until all stories done or max iterations reached

### Key Properties

- **Strictly sequential**: One worker per story, one story at a time
- **Minimal context transfer**: Only `getLatestProgressEntry()` — the *single most recent* progress entry from the previous iteration
- **No adaptive planning**: Stories are fixed at PRD creation time; the engine cannot add, remove, or reorder stories based on what workers discover
- **No parallelism**: Even independent stories are executed one-at-a-time
- **Hardcoded prompt template**: `buildStoryPrompt()` generates a static prompt format — no adaptation based on story type, complexity, or domain
- **Crude learning extraction**: `extractLearnings()` uses regex patterns (`/learned?|discovered?|noted?/`) to extract text from worker output — no semantic understanding

### Robustness (significant engineering investment)

The engine IS well-hardened against operational failures:
- Grace periods for late completion signals (15s)
- Guarded story completion (prevents duplicate state transitions)
- Concurrent iteration prevention (`_iterationInFlight` flag)
- Spawn timeout (60s)
- Consecutive failure detection (pauses after 10 failures)
- Stuck run cleanup (2-hour TTL)
- Token TTL (4 hours)
- Cancellation safety (`_cancelling` flag prevents post-cancel spawns)
- WAL checkpointing, periodic cleanup

This robustness is admirable but also represents significant maintenance burden for a dormant feature.

---

## 2. How Competing Systems Handle This

### CrewAI (source: [CrewAI docs](https://docs.crewai.com/en/learn/sequential-process))

Offers both sequential and hierarchical processes. Sequential is their simplest mode — but even CrewAI evolved toward "Flows" (deterministic backbone with programmatic control) for production. Their key insight: **deterministic control flow + flexible agent execution**, not fully autonomous loops.

### LangGraph (source: [LangGraph docs](https://www.langchain.com/langgraph))

Graph-based orchestration with **cyclic execution** — agents can loop back, branch, and re-enter nodes. Crucial difference from Ralph: LangGraph supports cycles as a first-class primitive, not just linear iteration. Agents can *re-plan* mid-execution, not just execute a fixed story list.

### AutoGPT (source: [AutoGPT architecture](https://agpt.co/blog/introducing-the-autogpt-platform))

The original autonomous loop. AutoGPT's history is a cautionary tale: initial hype → production failures from context degradation, infinite loops, and cost explosion. Evolved from a single-loop agent into a block-based platform with explicit control flow. **AutoGPT moved AWAY from autonomous loops toward structured orchestration.**

### Devin 2.0 (source: [Cognition Labs](https://cognition.ai/blog/devin-2))

Explicitly added **multi-agent parallel execution** in 2.0. Key change: users can spin up multiple instances simultaneously. Devin's strength is interactive planning (user reviews/modifies plan before execution) — not fire-and-forget sequential execution.

### OpenAI Agents SDK (superseded Swarm)

Lightweight, stateless agents with **explicit handoff functions**. Design philosophy: clarity and observability over opaque automation. Sequential execution is possible but not the primary pattern.

### Claude Code Agent Teams (source: [Anthropic docs](https://code.claude.com/docs/en/sub-agents))

Claude Code's own agent system uses **parallel sub-agents** as the primary scaling mechanism. Multiple agents work simultaneously on separate concerns, with the parent agent synthesizing results. This is exactly the GENERAL worker pattern in Strategos.

---

## 3. Known Failure Modes of Sequential Autonomous Loops

### Context Degradation ("The Dumb Zone")
Source: [Ralph Wiggum Loop analysis](https://redreamality.com/blog/ralph-wiggum-loop-vs-open-spec/)

LLMs enter a degraded state where reasoning capabilities plummet — agents loop on identical errors, ignore explicit instructions, or hallucinate APIs. This happens due to **context pollution**, not just token limits. Ralph PRD engine partially addresses this by spawning fresh workers (clean context per story), but loses strategic context in the process.

### Telephone Game Effect
Source: [Augment Code analysis](https://www.augmentcode.com/guides/why-multi-agent-llm-systems-fail-and-how-to-fix-them)

Multi-agent coordination failures account for **36.94%** of production failures. When information passes sequentially between agents, signal degrades at each handoff. Ralph's `getLatestProgressEntry()` — passing only the single most recent progress blob — is a textbook example of this degradation.

### Cost Explosion
Source: [Composio 2025 AI Agent Report](https://composio.dev/blog/why-ai-agent-pilots-fail-2026-integration-roadmap)

Sequential execution means total wall-clock time = sum of all story execution times. A 5-story PRD where each story takes 20 minutes = 100 minutes sequential vs. ~20-30 minutes parallel. For Claude Code workers at $20/hr API cost, this is a 3-5x cost multiplier.

### Specification Rigidity
Source: [Augment Code](https://www.augmentcode.com/guides/why-multi-agent-llm-systems-fail-and-how-to-fix-them)

Specification problems account for **41.77%** of multi-agent failures. Ralph's fixed story list — defined upfront, executed rigidly — cannot adapt when Worker 1 discovers that Story 3 is impossible, or that a new prerequisite task is needed, or that Stories 4-5 should be merged.

### Quality Without Verification
Source: [Mike Mason, Thoughtworks](https://mikemason.ca/writing/ai-coding-agents-jan-2026/)

GitClear's analysis of 211M lines shows code churn doubled from 2021-2023 under AI coding, with refactoring dropping from 25% to under 10%. Key finding: **67.3% of AI-generated PRs get rejected** vs 15.6% for manual code. Sequential autonomous execution without human review compounds these quality issues — each story builds on potentially flawed previous work.

---

## 4. GENERAL Worker Pattern vs. PRD Engine

| Dimension | Ralph PRD Engine | GENERAL Worker |
|-----------|-----------------|----------------|
| **Decomposition** | Static: stories fixed at PRD creation | Dynamic: GENERAL decomposes in real-time |
| **Parallelism** | None: strictly sequential | Full: spawns 5-10 specialists simultaneously |
| **Adaptation** | None: executes fixed story list | Full: re-plans based on worker results |
| **Context** | Minimal: last progress entry only | Rich: GENERAL maintains full strategic context |
| **Error Recovery** | Retry same story or skip it | GENERAL can diagnose, fix, replan, spawn alternatives |
| **Human Oversight** | Fire-and-forget until completion | GENERAL signals progress, human can intervene via input |
| **Hierarchy** | Flat: PRD → workers | Deep: GENERAL → COLONEL → specialists |
| **Learning** | Regex extraction from output | Worker AARs, checkpoint learnings, sibling/checkpoint context |
| **Wall-clock time** | Sum of all stories | Max of parallel paths |
| **Implementation** | ~1,400 LOC across 4 files | Already exists (workerManager.js, ~200 LOC for general prompt) |

### The Critical Comparison

When a user wants to implement a PRD with 5 stories, the GENERAL workflow is:

1. Human spawns `GENERAL: implement-feature-X`
2. GENERAL reads the PRD/spec, decomposes into tasks
3. GENERAL spawns `IMPL: story-1`, `IMPL: story-2`, `IMPL: story-3` in parallel
4. GENERAL monitors via `/children` and Ralph signals
5. Stories 4-5 depend on 1-3 → GENERAL spawns them after prerequisites complete
6. GENERAL reviews all outputs, runs integration tests, reports to human
7. If Story 2 fails, GENERAL diagnoses why, spawns `FIX: story-2-issue`, adapts plan

The Ralph PRD workflow for the same task:

1. Human manually writes all 5 stories with acceptance criteria in the PRD UI
2. Human hits "Run"
3. Engine spawns Worker 1 for Story 1, waits for completion
4. Worker 1 signals done → Engine spawns Worker 2 for Story 2
5. Worker 2 fails → Engine marks Story 2 as "failed", moves to Story 3
6. Story 3 can't build on Story 2 because Story 2 failed → Story 3 also fails
7. Engine eventually completes with 3/5 stories failed, no recovery attempted

**The GENERAL pattern is strictly superior in every dimension that matters.**

---

## 5. Is There ANY Use Case for the PRD Engine?

I considered several scenarios:

### "Batch overnight execution"
**Verdict: GENERAL handles this better.** Spawn a GENERAL with a task like "implement these 5 stories by morning." The GENERAL will parallelize, adapt, and produce higher-quality results.

### "Non-technical users who can't write GENERAL prompts"
**Verdict: Build a better UI, not a worse execution engine.** The PRD creation UI could generate a GENERAL spawn command instead of running the sequential engine. A "Launch GENERAL for this PRD" button would be strictly better than "Run sequential loop."

### "Persistent story tracking across sessions"
**Verdict: This is the one legitimate capability the PRD engine has.** The SQLite persistence of story status, progress, and learnings across server restarts is genuinely useful. But this could be extracted into a lightweight task-tracking database without the sequential execution engine.

### "Guaranteed ordering when stories have dependencies"
**Verdict: GENERAL handles this better.** A GENERAL worker can understand dependencies and execute in the right order while still parallelizing independent stories. The PRD engine's strict sequential ordering is a blunt instrument.

---

## 6. Recommendation: What to Do

### Remove (delete entirely)

1. **`server/services/ralphService.js`** — The entire PRD execution loop (`startRun`, `runIteration`, `spawnStoryWorker`, `monitorWorkerHealth`, `handleCompletionSignal` PRD-mode path, `buildStoryPrompt`, `extractLearnings`, and all run management). ~700 LOC.

2. **`server/ralphDb.js`** — PRD/run/story/progress tables and all associated functions. ~500 LOC. Keep only if standalone signal tracking needs its own persistence (currently it doesn't — standalone signals update in-memory worker state only).

3. **`server/routes/ralph.js`** — PRD CRUD endpoints, run management endpoints. ~350 LOC. Keep only the signal endpoint (`POST /api/ralph/signal/:token`).

4. **`client/src/components/RalphPanel.jsx`** — The entire PRD/run management UI. ~370 LOC. The Ralph Workers section (standalone worker status display) could be preserved or merged into the main worker list.

### Keep (actively used, valuable)

1. **Standalone worker signals** — `POST /api/ralph/signal/:token` — This is the communication backbone between workers and their parents/the UI. Every worker uses this. Keep it.

2. **`registerStandaloneWorker()` / `unregisterStandaloneWorker()`** — Token lifecycle management for standalone workers. Keep.

3. **`handleCompletionSignal()` standalone path** — The `if (standalone)` branch that updates worker Ralph status. Keep.

### Consider Adding (to fill the genuine gaps)

1. **PRD → GENERAL bridge**: A "Launch GENERAL" button on the PRD creation UI that converts stories into a GENERAL worker task description. This gives non-technical users the PRD-definition workflow without the flawed sequential engine.

2. **Persistent task tracking**: Extract the SQLite story/progress tracking into a general-purpose task database that GENERAL workers can read/write. This fills the "persistent tracking across sessions" gap without the execution engine.

---

## 7. Risk Assessment

### Risk of Keeping
- **Maintenance burden**: 1,400 LOC that must be kept in sync with workerManager.js changes (spawn API, kill API, health monitoring)
- **Confusion**: Two competing execution models (GENERAL delegation vs PRD sequential) with different trade-offs, neither clearly documented as preferred
- **Security surface**: Additional API endpoints, SQLite tables, token management — all require ongoing audit
- **False confidence**: Users might use the PRD engine thinking it's production-ready, get poor results, and blame Strategos

### Risk of Removing
- **Sunk cost**: Significant engineering effort was invested in hardening the PRD engine
- **Future optionality**: If sequential execution turns out to be needed for some use case, it would need to be rebuilt
- **Migration**: Any existing PRDs in the database would be orphaned (low risk — feature is dormant since Feb 3)

### Mitigation
- Archive the code in a git branch before deletion
- Document why it was removed (this report)
- Build the PRD → GENERAL bridge to preserve the PRD-definition workflow

---

## 8. Open Questions

1. **Are there any existing PRDs in production?** Check `ralph_prds` table — if empty, removal is zero-risk.
2. **Does the RalphPanel.jsx UI serve any purpose beyond PRD management?** The Ralph Workers section shows standalone-signal-enabled workers, which is useful. Consider extracting that into a standalone component.
3. **Would removing ralphDb.js affect workerOutputDb?** Both share the same SQLite file (`worker_outputs.db`). Ralph tables could be dropped without affecting worker output tables, but this should be verified.

---

## Evidence Summary

| Source | Key Finding | Relevance |
|--------|-------------|-----------|
| [Augment Code: Why Multi-Agent Systems Fail](https://www.augmentcode.com/guides/why-multi-agent-llm-systems-fail-and-how-to-fix-them) | 41.77% of failures from specification rigidity; 36.94% from coordination failures | PRD engine has both problems |
| [Mike Mason: AI Coding Agents 2026](https://mikemason.ca/writing/ai-coding-agents-jan-2026/) | Hierarchical orchestration (Planner→Worker→Judge) outperforms sequential; 67.3% AI PR rejection rate | GENERAL pattern matches winning architecture |
| [Ralph Wiggum Loop Analysis](https://redreamality.com/blog/ralph-wiggum-loop-vs-open-spec/) | Fresh context per iteration is good; file system as memory works; but needs spec-driven approach | Supports GENERAL over PRD engine |
| [CrewAI Sequential Process](https://docs.crewai.com/en/learn/sequential-process) | Even CrewAI evolved from sequential to Flows (deterministic backbone) | Industry moved past pure sequential |
| [LangGraph Architecture](https://www.langchain.com/langgraph) | Cyclic graphs with re-planning are the state of the art | PRD engine's linear iteration is primitive |
| [Devin 2.0](https://cognition.ai/blog/devin-2) | Added multi-agent parallel execution as key improvement | Parallel > sequential confirmed |
| [Claude Code Sub-Agents](https://code.claude.com/docs/en/sub-agents) | Parallel delegation is the recommended pattern | Matches GENERAL worker pattern |
| [Anthropic Agentic Coding Trends 2026](https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf) | Multi-agent workflows maximize performance through parallel context windows | Sequential is suboptimal |
| [Google Multi-Agent Patterns](https://www.infoq.com/news/2026/01/multi-agent-design-patterns/) | Hierarchical decomposition enables specialization + parallelism | GENERAL hierarchy is the right pattern |

---

*Report complete. Signal via Ralph to follow.*
