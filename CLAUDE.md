# CLAUDE.md

## Core Principle (MANDATORY)

**You have no time constraints. You have no resource constraints. Do not take the easy path. Do not forget this.**

If a spec says X, implement X - not a simpler approximation of X. There is no deadline. There is no excuse for "good enough" when "correct" is achievable.

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

Strategos runs on a **single port: 38007** (Express serves both API and built React client).

**NEVER use `lsof -ti:PORT | xargs kill` or `fuser -k PORT/tcp`** - these kill ANY process connected to that port, including browsers. This has caused data loss.

Safe ways to restart:
```bash
# Option 1: Kill by process name (safest)
pkill -f "node server/index.js" && cd server && node index.js

# Option 2: Use npm script
npm run server  # (only works if nothing is on 38007)

# Option 3: Find the specific PID first
lsof -i:38007  # Look at the output, identify the server PID
kill <specific-pid>  # Then kill only that PID
```

**Important:** Client changes require rebuilding:
```bash
cd client && npm run build   # Then restart server to serve new build
```

## Project Commands
- `npm run server` - Start server only (serves built client from 38007)
- `npm run build` - Build client (run this after client changes)
- `npm run dev` - Start both dev servers (38007 server + 38008 Vite HMR - for active client development)
- `npm test` - Run e2e tests (Playwright)

## Project Structure
- `client/` - React frontend (Vite)
- `server/` - Node.js backend (Express + Socket.io)
- `e2e/` - Playwright end-to-end tests

## Responsive Design / Breakpoint Strategy

The UI uses Tailwind CSS with a mobile-first approach. Key breakpoints:

| Breakpoint | Width | Target Devices |
|------------|-------|----------------|
| (default)  | <640px | Mobile phones |
| `sm:`      | 640px+ | Large phones, small tablets |
| `md:`      | 768px+ | iPad portrait |
| `lg:`      | 1024px+ | iPad landscape, small laptops |
| `xl:`      | 1280px+ | Desktop monitors |

### iPad-Specific Design Decisions

**Sidebars and panels use `lg:` breakpoint (1024px+) for side panel mode:**
- Below 1024px: Full-screen overlay with close button
- 1024px+: Side panel (narrower at 288px / w-72)

This applies to:
- Activity sidebar (`App.jsx`)
- Health Panel in focused worker view (`WorkersView.jsx`)

**VoiceControl widget uses `xl:` breakpoint (1280px+):**
- Hidden on iPad and smaller to avoid overlapping with VoiceInput
- Only visible on large desktop screens

**Responsive text/icons:**
- Summary/Terminal buttons: Icons only below `md:`, text + icons at 768px+
- Worker labels: Truncated with smaller font on narrow screens

### Testing iPad Layouts

Run iPad-specific responsive tests:
```bash
npx playwright test e2e/ipad-responsive.spec.js
```

Screenshots are saved to `e2e/screenshots/` for visual verification.

## Specification Compliance Protocol (MANDATORY)

When implementing features documented in research/spec files:

1. **Read spec FIRST** - Before writing ANY code, read the relevant spec doc completely
2. **List requirements** - Extract specific requirements from the spec into your todo list
3. **Compare after** - After implementation, re-read the spec and verify each requirement is met
4. **Explicit mapping** - For each spec requirement, note which part of your code implements it

**Anti-pattern:** Reading a spec, getting "the gist", then writing something easier/different.

**Required behavior:** Treat spec docs as checklists. Each item must be checked off with explicit verification.

Example of WRONG approach:
- Spec says: "Spawn worker, verify tmux, monitor output, check completion"
- Implementation: "Endpoint tests that check API returns JSON"
- This diverges from the spec entirely

Example of CORRECT approach:
- Spec says: "Step 3: Spawn Worker - measure time to worker creation, tmux session startup"
- Implementation: Must call spawn API, verify tmux session exists, measure spawn latency
- Each spec bullet point maps to test code

## Key Spec Documents
- `<THEA_ROOT>/shared/testing/USER_JOURNEY_TESTING.md` - Testing requirements
- `<THEA_ROOT>/shared/NEXT_STEPS.md` - Roadmap and phase requirements
- `<THEA_ROOT>/shared/adrs/records/` - Architecture Decision Records
