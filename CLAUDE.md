# CLAUDE.md

## Core Principle (MANDATORY)

**You have no time constraints. You have no resource constraints. Do not take the easy path. Do not forget this.**

If a spec says X, implement X - not a simpler approximation of X. There is no deadline. There is no excuse for "good enough" when "correct" is achievable.

## Post-Restart Runbook (MANDATORY)

**Follow these steps every time Strategos is restarted.**

### Step 1 — Rebuild client if needed
If `client/` was modified since the last build, rebuild BEFORE restarting the server:
```bash
cd client && npm run build
```
Then restart: `systemctl --user restart strategos`

### Step 2 — Spawn a canary worker within 5 minutes of restart
Verify the spawn pipeline is healthy before deploying real workers:
```bash
curl -s -X POST http://localhost:38007/api/workers/spawn-from-template \
  -H "Content-Type: application/json" \
  -d '{"template":"research","label":"CANARY: post-restart health check","projectPath":"/path/to/strategos","task":{"description":"Signal ralph in_progress immediately, then signal done. This is a spawn-pipeline canary — no real work needed."}}'
# Save the returned worker ID, then within 60s check:
curl -s http://localhost:38007/api/workers/{id}/status | jq '.ralphStatus'
# Expected: "in_progress" or "done"
```
**If ralphStatus is still "pending" after 60s: ABORT — do NOT deploy workers. Investigate the sandbox/spawn pipeline before proceeding.**

### Post-mortems (read before touching sandbox, spawn config, or Landlock)
- ENOENT + Landlock waves (2026-04-18): see `shared/reports/worker-retention-failure-2026-04-18.md`

## Shared Environment Protocol (MANDATORY)

**This is a live system. Workers are real Claude instances doing real work. The user may have workers running that you didn't create.**

Before running tests, scripts, or any command that affects workers:

1. **Check state first** - `curl -s http://localhost:38007/api/workers` - what exists?
2. **Trace unfamiliar commands** - What does `npm test` invoke? Read global-setup.js, global-teardown.js, playwright.config.js before running
3. **Verify cleanup scope** - Does "cleanup" mean YOUR test workers or ALL workers? Read the code.
4. **Check state after** - Did you change something you shouldn't have?

**Divergence signals to watch for:**
- User asks about workers/processes you're creating - pause and investigate
- Cleanup scripts report killing workers with unfamiliar labels - stop immediately
- Test output mentions more workers than you spawned - something is wrong

**The rule:** Before any command that could affect shared state, ask "what else could this affect?" and actually verify. Not after. Before.

## Worker Protection Protocol (MANDATORY)

**NEVER kill, stop, or delete workers without EXPLICIT user permission.**

This includes:
- `curl -X DELETE .../api/workers/{id}` - FORBIDDEN without permission
- Any cleanup scripts that affect workers
- Any command that terminates tmux sessions
- Restarting the server in ways that orphan workers

**Before ANY action that could terminate a worker:**
1. List current workers: `curl -s http://localhost:38007/api/workers | jq '.[] | {id, label}'`
2. **ASK THE USER** which workers (if any) can be terminated
3. Only proceed with explicit confirmation

**Why this matters:**
- Workers represent hours of Claude compute time
- Workers may have uncommitted work in progress
- Workers may be actively doing tasks the user is monitoring
- Killing workers without permission destroys user trust

**There are NO exceptions.** Even for "cleanup" before UI reviews. Even for testing. Ask first.

## File System Rules (MANDATORY)

**NEVER write files outside of the THEA_ROOT directory** (set via `THEA_ROOT` env var, or auto-detected as the parent of the strategos directory)

- All temporary files must go in project-local tmp directories (e.g., `<THEA_ROOT>/strategos/tmp/`)
- NEVER use system `/tmp` or any path outside the THEA_ROOT directory
- Create tmp directories within projects as needed: `mkdir -p <THEA_ROOT>/PROJECT_NAME/tmp`

## Verification Protocol (MANDATORY)

Before marking ANY implementation task complete, you MUST:

1. **Run it** - Start the dev server or run the relevant command
2. **See it** - Observe the actual output/behavior yourself
3. **Test it** - Interact with the feature, not just compile it
4. **Report it** - State what you observed, not what you expected

"npm run build succeeds" is NOT verification. Verification means you witnessed the feature working.

If you cannot run/test something, explicitly state that and ask the user to verify.

## Server Restart Protocol (MANDATORY)

Strategos is managed by **systemd** (`systemctl --user`). It runs on port 38007.

**WORKERS MUST NEVER RESTART THE SERVER.** Only the human may restart Strategos.
- `pkill`, `kill`, `killall` targeting the server process are **FORBIDDEN**
- `systemctl --user restart strategos` is **FORBIDDEN** for workers
- Starting a standalone `node server/index.js` is **FORBIDDEN** (conflicts with systemd)
- `lsof -ti:PORT | xargs kill` and `fuser -k PORT/tcp` are **FORBIDDEN**

If you made a code change that requires a server restart, **signal done via Ralph** and note in your report that a restart is needed. The human will restart when ready.

**Only the human may run:**
```bash
systemctl --user restart strategos
```

**Important:** Client changes require rebuilding:
```bash
cd client && npm run build   # Then human restarts server to serve new build
```

## Context Compaction Protocol (MANDATORY)

If context compaction occurs mid-task, immediately re-orient by checking: (1) your current task description, (2) files you've modified (`git status`, `git diff HEAD`), (3) test commands you ran and their results, (4) any blocking issues encountered, and (5) your current git branch (`git branch --show-current`). Do not re-do completed work — git history is ground truth.

## Per-Spawn Context Injection

Spawn API accepts `injectProjectContext: true | false | "auto"` (default: `"auto"`). Smart defaults: RESEARCH, COLONEL, GENERAL workers inherit project context; IMPL, FIX, TEST, REVIEW workers do not. Explicit value always wins.

Project context is synthesized from the memory DB (decisions + approaches + warnings, 30-day window) and last 5 done-worker learnings. It is written to `<projectPath>/.thea/program.md` and regenerated within 500ms of any `memory_add`. Workers injected with context receive a `<project-context>` block in their rules file.

For mid-task re-orientation: `POST /api/workers/:id/reinject-context` returns fresh `{ programDoc, siblingLearnings, generated }` with `Cache-Control: no-store`. Any running worker can call this endpoint via `curl` to get current project context without respawning.

## Project Commands
- `npm run server` - Start server only (serves built client from 38007)
- `npm run build` - Build client (run this after client changes)
- `npm run dev` - Start both dev servers (38007 server + 38008 Vite HMR - for active client development)
- `npm test` - Run e2e tests (Playwright)

## Project Structure
- `client/` - React frontend (Vite)
- `server/` - Node.js backend (Express + Socket.io)
- `e2e/` - Playwright end-to-end tests
