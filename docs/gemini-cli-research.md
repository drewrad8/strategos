# Gemini CLI Integration Research Report

**Researcher:** Worker f4b73c34 | **Date:** 2026-02-18
**Parent:** General 53162f86

---

## Executive Summary

Google's Gemini CLI is a strong candidate for Strategos worker backend integration. It's an open-source (Apache 2.0) Node.js-based AI agent that runs in the terminal, similar to Claude Code. The integration is **highly feasible** using two approaches:

1. **Tmux-based (like Claude Code)** — spawn `gemini` in tmux with `--yolo` flag, reuse existing PTY capture infrastructure, requires new prompt detection patterns
2. **Headless/JSONL-based (native)** — spawn `gemini -p "..." --output-format stream-json --yolo` as a subprocess, parse structured JSONL events, cleaner but requires new output pipeline

**Recommendation:** Start with Approach 1 (tmux) for fastest time-to-integration, then migrate to Approach 2 (headless JSONL) for a cleaner long-term architecture.

---

## 1. What is Gemini CLI?

- **GitHub:** https://github.com/google-gemini/gemini-cli
- **Docs:** https://geminicli.com/docs/
- **License:** Apache 2.0 (fully open source)
- **Runtime:** Node.js 18+ (same as Strategos)
- **Install:** `npm install -g @google/gemini-cli` or `npx @google/gemini-cli`
- **Binary name:** `gemini`

Gemini CLI is Google's answer to Claude Code — an AI coding agent that runs in your terminal with file operations, shell commands, Google Search grounding, and MCP server support. It uses a ReAct loop with built-in tools.

### Models
- **Gemini 3 Pro** — 1M token context window, 64k output tokens, PhD-level reasoning (1501 Elo on LMArena)
- **Gemini Flash** — faster, cheaper variant
- Model selection via `-m` flag or `GEMINI_MODEL` env var

### Authentication Options
1. **Google Login** (free): 60 req/min, 1,000 req/day — no API key needed
2. **API Key** (`GEMINI_API_KEY`): 1,000 req/day free, usage-based billing available
3. **Vertex AI** (enterprise): Higher limits, Google Cloud billing

### Key Features
- Built-in tools: file ops, shell commands, Google Search, web fetch
- MCP server support (configurable in `~/.gemini/settings.json`)
- Context files (`GEMINI.md` — equivalent of `CLAUDE.md`)
- Session checkpointing and resumption
- Sandboxing (Docker/Podman)

---

## 2. How Gemini CLI Runs

### Interactive Mode (TUI)
```bash
gemini                    # Start interactive session
gemini -i "initial prompt" # Interactive with initial prompt
```
- Full terminal UI with colors, gradients, animations
- Prompts user for tool execution approval
- Detects TTY — uses rich TUI when TTY present

### Non-Interactive / Headless Mode
```bash
gemini -p "Your prompt here"                        # Single prompt, text output
gemini -p "prompt" --output-format json              # JSON output
gemini -p "prompt" --output-format stream-json       # Streaming JSONL
gemini -p "prompt" --yolo                            # Auto-approve all tools
gemini -p "prompt" --yolo --output-format stream-json # Full automation mode
```

**Headless mode activates when:**
- Running in a non-TTY environment (piped/redirected)
- Using `-p`/`--prompt` flag (processes single prompt, then exits)

### Key CLI Flags
| Flag | Description |
|------|-------------|
| `-p, --prompt <text>` | Non-interactive single prompt mode |
| `-i, --prompt-interactive <text>` | Interactive with initial prompt |
| `-m, --model <model>` | Model selection (e.g., `gemini-3-pro`) |
| `--yolo` or `-y` | Auto-approve ALL tool calls |
| `--output-format json` | Structured JSON output |
| `--output-format stream-json` | Streaming JSONL events |
| `--sandbox` | Run tools in Docker/Podman sandbox |
| `--checkpointing` | Save snapshots before file modifications |
| `-d, --debug` | Debug output |
| `--include-directories` | Additional workspace directories |

### Exit Codes
| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error / API failure |
| `42` | Input error (invalid prompt/args) |
| `53` | Turn limit exceeded |

---

## 3. Output Formats (Critical for Integration)

### JSON Output (`--output-format json`)
Returns a single JSON object after completion:
```json
{
  "response": "The model's final answer",
  "stats": { /* token usage, latency metrics */ },
  "error": { /* optional, if request failed */ }
}
```

### Streaming JSONL (`--output-format stream-json`)
Newline-delimited JSON events emitted in real-time:

| Event Type | Description |
|-----------|-------------|
| `init` | Session metadata (session ID, model) |
| `message` | User and assistant message chunks |
| `tool_use` | Tool invocation requests with arguments |
| `tool_result` | Executed tool outputs |
| `error` | Non-fatal warnings and system errors |
| `result` | Final outcome with aggregated statistics |

This is **ideal for Strategos** — it provides structured, real-time visibility into what the worker is doing, without needing PTY scraping.

---

## 4. Comparison: How Strategos Integrates with Claude Code Today

### Current Architecture (Claude Code)
```
Strategos Server
  └─ spawnTmux(['new-session', '-d', '-s', sessionName, '-c', projectPath, 'claude'])
      └─ PTY capture via node-pty attached to tmux session
          └─ Output buffer (raw terminal output with ANSI codes)
              └─ Pattern matching for:
                  - Prompt detection (AUTO_ACCEPT_PATTERNS: [Y/n], (Y)es, etc.)
                  - Idle detection (CLAUDE_CODE_IDLE_PATTERNS: ❯, "Context left", etc.)
                  - Active detection (CLAUDE_CODE_ACTIVE_PATTERNS: Flowing, Thinking, etc.)
              └─ AutoAccept: detects permission prompts, sends Enter via tmux send-keys
              └─ Input: tmux send-keys -l "text" + Enter
```

### Key Mechanisms
1. **Spawning:** `tmux new-session -d -s <name> -c <dir> claude`
2. **Input:** `tmux send-keys -t <session> -l "<text>" && tmux send-keys -t <session> Enter`
3. **Output capture:** node-pty attached to tmux, streams raw terminal bytes
4. **Auto-accept:** Regex patterns match Claude Code's permission prompts, sends Enter
5. **Idle detection:** Regex patterns detect Claude's `❯` prompt
6. **Rules injection:** `.claude/rules/strategos-worker-<id>.md` — Claude loads this automatically
7. **Ralph signaling:** Worker uses curl to POST to Strategos API

---

## 5. Integration Approaches

### Approach A: Tmux-Based (Minimal Changes)

**Concept:** Spawn Gemini CLI in tmux just like Claude Code, but with `--yolo` flag to skip permission prompts.

**Spawn command:**
```bash
tmux new-session -d -s strategos-<id> -c <projectPath> \
  "GEMINI_API_KEY=<key> gemini --yolo"
```

Or for interactive mode with initial prompt:
```bash
tmux new-session -d -s strategos-<id> -c <projectPath> \
  "GEMINI_API_KEY=<key> gemini -i 'Your task here' --yolo"
```

**Changes needed:**

| Component | Change |
|-----------|--------|
| `workers/lifecycle.js` | New spawn command: `gemini --yolo` instead of `claude` |
| `workers/templates.js` | Add Gemini-specific idle/active/prompt patterns |
| `workers/templates.js` | Add `GEMINI.md` context file template (like `.claude/rules/`) |
| `workers/output.js` | Gemini-specific `autoAcceptCheck()` (may be minimal with `--yolo`) |
| Worker data model | Add `backend` field: `"claude"` or `"gemini"` |
| Configuration | `GEMINI_API_KEY` env var management |

**Gemini-specific patterns needed:**
- Idle patterns: Gemini uses different prompt characters than Claude's `❯`
- Active patterns: Different thinking/working indicators
- Auto-accept: With `--yolo`, tool approval is automatic — but file/shell confirmations may still appear
- Auto-accept pause keywords: Gemini equivalents of plan mode

**GEMINI.md context file:** Equivalent of `.claude/rules/strategos-worker-<id>.md`, placed at project root or `~/.gemini/GEMINI.md`. Gemini CLI loads GEMINI.md hierarchically from:
1. `~/.gemini/GEMINI.md` (global)
2. Project root `GEMINI.md`
3. Subdirectory `GEMINI.md` files (discovered on access)

**Pros:**
- Reuses 90% of existing infrastructure (tmux, PTY capture, output buffers, health monitoring)
- Familiar architecture
- Both interactive and multi-turn (worker can receive follow-up inputs)

**Cons:**
- PTY scraping is fragile — Gemini's TUI rendering differs from Claude Code
- Known tmux compatibility issues (Issue #9751 — TERM=screen crash, fixed in PR #11637; Issue #13396 — tmux server kill, model-level issue)
- Must maintain two sets of pattern regexes
- Gemini's TUI has flickering issues in SSH/tmux (Issue #11305)

**Risk: tmux compatibility.** Issue #9751 (crash in tmux due to TERM=screen) was fixed, but Issue #13396 (Gemini killing tmux server) is a model-behavior issue. Mitigation: Use GEMINI.md to explicitly instruct "NEVER use pkill, always kill by specific PID."

---

### Approach B: Headless JSONL Subprocess (Clean Architecture)

**Concept:** Spawn Gemini CLI as a child process with `--output-format stream-json --yolo`, parse JSONL events directly.

**Spawn command:**
```javascript
const proc = spawn('gemini', [
  '-p', taskPrompt,
  '--yolo',
  '--output-format', 'stream-json',
  '-m', 'gemini-3-pro'
], {
  cwd: projectPath,
  env: { ...process.env, GEMINI_API_KEY: apiKey }
});
```

**Changes needed:**

| Component | Change |
|-----------|--------|
| New module | `workers/geminiBackend.js` — JSONL parser, event handler |
| `workers/lifecycle.js` | Backend-aware spawn: tmux for Claude, subprocess for Gemini |
| Worker data model | `backend`, `backendConfig`, output events array |
| Output pipeline | Parse JSONL events instead of PTY scraping |
| Health monitoring | Use `init`/`result` events + process alive check instead of PTY idle |
| UI (client) | Render structured events (tool_use, tool_result) instead of raw terminal |

**JSONL event handling:**
```javascript
proc.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    switch (event.type) {
      case 'init': // Session started, capture model info
      case 'message': // Assistant response chunks
      case 'tool_use': // Tool being called (file edit, shell, etc.)
      case 'tool_result': // Tool output
      case 'error': // Non-fatal error
      case 'result': // Task complete, capture stats
    }
  }
});
```

**Pros:**
- Clean, structured output — no ANSI stripping, no regex pattern matching
- No tmux dependency for Gemini workers
- Real-time tool visibility (know exactly what commands Gemini runs)
- Better health monitoring (structured events vs PTY heuristics)
- No auto-accept needed (`--yolo` handles everything)

**Cons:**
- **Single-prompt only** — headless mode processes one prompt and exits. No multi-turn conversation.
- Cannot send follow-up inputs after initial prompt
- Cannot use Ralph signaling (worker is a single-shot process)
- No session persistence between invocations
- Requires new output pipeline code

**Critical limitation:** Headless mode is fire-and-forget. Issue #15338 requests daemon/server mode for persistent sessions, but it's P2 (future release). There's no way to send follow-up prompts to a running headless Gemini process.

---

### Approach C: Hybrid (Recommended)

**Concept:** Use tmux for long-running interactive Gemini workers (like Claude Code workers today), but leverage headless mode for single-shot tasks.

**Interactive workers (tmux):**
- Template types: `gemini-general`, `gemini-colonel`, `gemini-impl`
- Spawn: `tmux new-session ... "gemini --yolo"`
- Input: tmux send-keys (same as Claude)
- Output: PTY capture with Gemini-specific patterns
- Use case: Multi-turn agent tasks, Ralph-enabled workers

**Headless workers (subprocess):**
- Template types: `gemini-research`, `gemini-review`, `gemini-fix`
- Spawn: `child_process.spawn('gemini', ['-p', prompt, '--yolo', '--output-format', 'stream-json'])`
- Output: JSONL event stream
- Use case: Single-shot analysis, code review, test generation

**This gives the best of both worlds:** Familiar tmux for complex agent work + clean JSONL for quick tasks.

---

## 6. Specific Changes Needed in Strategos

### 6.1 Worker Data Model Changes

```javascript
// New fields in worker object
{
  backend: 'claude' | 'gemini',     // Which AI backend
  backendConfig: {
    model: 'gemini-3-pro',          // For Gemini workers
    apiKeyRef: 'env:GEMINI_API_KEY', // Key reference
    headless: false,                 // true for subprocess mode
  },
}
```

### 6.2 New Template Types (`workers/templates.js`)

```javascript
// Gemini worker templates
'gemini-research': { backend: 'gemini', headless: true, ... }
'gemini-impl':     { backend: 'gemini', headless: false, ... }
'gemini-general':  { backend: 'gemini', headless: false, ... }
'gemini-review':   { backend: 'gemini', headless: true, ... }
'gemini-fix':      { backend: 'gemini', headless: false, ... }
```

### 6.3 New Pattern Sets (`workers/templates.js`)

```javascript
// Gemini-specific patterns (need empirical testing)
export const GEMINI_IDLE_PATTERNS = [
  // Gemini's prompt indicator (needs testing in tmux)
  />\s*$/m,
  /gemini>\s*$/m,
];

export const GEMINI_ACTIVE_PATTERNS = [
  /Thinking/i,
  /Running/i,
  /Executing/i,
  /Searching/i,
];

// With --yolo, auto-accept patterns may not be needed
// But keep for safety in case some prompts still appear
export const GEMINI_AUTO_ACCEPT_PATTERNS = [
  /\[Y\/n\]/i,
  /Approve\?/i,
];
```

### 6.4 Context File Generation (`workers/templates.js`)

Instead of `.claude/rules/strategos-worker-<id>.md`, generate a `GEMINI.md` file:

```markdown
# Strategos Worker Instructions

Worker ID: {id} | Label: {label} | Role: {role}
Project: {project} | Dir: {dir}

## Mission
{task description}

## Ralph Signaling
Signal progress via curl:
curl -s -X POST http://localhost:38007/api/ralph/signal/by-worker/{id} \
  -H "Content-Type: application/json" \
  -d '{"status":"in_progress","progress":50,"currentStep":"..."}'

## API Reference
{same API reference as Claude workers}

## Safety Rules
- NEVER use pkill, killall, or broad process-killing commands
- Always kill processes by specific PID
- Stay within your project directory
- Git commit frequently
```

**Placement:** Project-level `GEMINI.md` will be loaded automatically. For worker-specific instructions, could use `@import` syntax to reference a per-worker file from a shared GEMINI.md.

### 6.5 Spawn Logic Changes (`workers/lifecycle.js`)

```javascript
// Line ~333-340 — backend-aware spawn
if (backend === 'gemini') {
  if (headless) {
    // Subprocess spawn — different code path entirely
    return spawnGeminiHeadless(id, projectPath, task, options);
  } else {
    // Tmux spawn with gemini binary
    await spawnTmux([
      'new-session', '-d',
      '-s', sessionName,
      '-x', String(DEFAULT_COLS),
      '-y', String(DEFAULT_ROWS),
      '-c', projectPath,
      'gemini', '--yolo'
    ]);
  }
} else {
  // Existing Claude Code spawn
  await spawnTmux([...existing code...]);
}
```

### 6.6 API Key Management

New env vars or config:
```
GEMINI_API_KEY=<key>          # For free tier / API key auth
GOOGLE_CLOUD_PROJECT=<id>     # For Vertex AI
GOOGLE_GENAI_USE_VERTEXAI=1   # Enable Vertex AI mode
```

Strategos needs a way to pass these to worker environments. Options:
1. Server-level env vars (inherited by tmux sessions)
2. Per-worker config in spawn options
3. Settings file at `~/.gemini/settings.json`

### 6.7 MCP Server Configuration

Gemini CLI supports MCP servers — Strategos could expose its own API as an MCP server for Gemini workers, providing:
- Ralph signaling tool
- Worker communication tool
- Project state queries

Config in `~/.gemini/settings.json`:
```json
{
  "mcpServers": {
    "strategos": {
      "command": "node",
      "args": ["./server/mcp-bridge.js"],
      "env": { "STRATEGOS_URL": "http://localhost:38007" }
    }
  }
}
```

This would let Gemini workers call Strategos tools natively instead of using curl.

---

## 7. Known Issues and Risks

### 7.1 Tmux Compatibility
- **Issue #9751** (crash in tmux, TERM=screen): **FIXED** in PR #11637
- **Issue #13396** (kills tmux server): Model behavior issue, mitigated by GEMINI.md instructions
- **Issue #11305** (flickering in SSH/tmux): UI rendering issue, non-blocking
- **Mitigation:** Set `TERM=xterm-256color` in tmux, use GEMINI.md safety rules

### 7.2 Headless Mode Limitations
- Single-prompt only — no multi-turn (Issue #15338 requests daemon mode, P2 priority)
- Cannot send follow-up inputs
- No session persistence between invocations
- Ralph signaling not possible from headless workers (no ongoing process)

### 7.3 Authentication Complexity
- Google Login auth requires interactive browser flow (not suitable for headless)
- API key auth (`GEMINI_API_KEY`) is simplest for Strategos
- Vertex AI requires Google Cloud project setup
- Rate limits: 60 req/min with Google Login, 1,000 req/day with API key

### 7.4 Tool Approval
- `--yolo` auto-approves all tools, but is a blanket override
- No granular tool allow-listing via CLI flags
- Can configure `tools.allowed` in settings.json for specific tool names
- `general.defaultApprovalMode: "yolo"` in settings.json as alternative to `--yolo` flag

### 7.5 No Equivalent of `.claude/rules/` Per-Worker
- GEMINI.md is hierarchical (global → project → subdirectory)
- No native per-worker context injection mechanism
- **Workaround:** Create unique GEMINI.md files in worker-specific subdirectories, or use `@import` syntax

---

## 8. Comparison Summary

| Feature | Claude Code | Gemini CLI |
|---------|------------|------------|
| Binary | `claude` | `gemini` |
| Context file | `.claude/rules/*.md`, `CLAUDE.md` | `GEMINI.md` (hierarchical) |
| Auto-approve | Custom auto-accept via PTY scraping | `--yolo` flag (built-in) |
| Headless mode | Limited (`--print` flag) | Full (`-p` + `--output-format json/stream-json`) |
| Structured output | No (PTY scraping only) | Yes (JSONL streaming) |
| MCP support | Yes | Yes (similar config) |
| Multi-turn headless | No | No (requested in #15338) |
| tmux compatibility | Excellent (designed for it) | Good (past issues fixed) |
| Context window | ~200K tokens | 1M tokens |
| Free tier | No free tier | 1,000 req/day free |
| Open source | No | Yes (Apache 2.0) |

---

## 9. Implementation Roadmap (Suggested)

### Phase 1: Tmux Integration (Fastest Path)
1. Add `backend` field to worker data model
2. Add Gemini spawn path in `lifecycle.js` (`gemini --yolo`)
3. Create GEMINI.md template generator (like `writeStrategosContext()`)
4. Add Gemini-specific patterns (idle, active — needs empirical testing in tmux)
5. Add `gemini-*` template types
6. Test with GEMINI_API_KEY env var

### Phase 2: Headless JSONL for Single-Shot Tasks
7. Create `workers/geminiBackend.js` — subprocess spawn + JSONL parser
8. Add headless worker type (no tmux, no PTY, event-based output)
9. Wire events to existing output buffer / activity system
10. UI: render structured events (tool_use, tool_result) in worker detail view

### Phase 3: MCP Bridge (Optional, High Value)
11. Create Strategos MCP server (`server/mcp-bridge.js`)
12. Expose Ralph signaling, worker comms, project state as MCP tools
13. Configure in `~/.gemini/settings.json` for all Gemini workers

### Phase 4: UI Integration
14. Backend indicator in worker cards/list (Claude vs Gemini badge)
15. Model info display (which Gemini model)
16. Structured event viewer for headless workers

---

## 10. Open Questions

1. **What are Gemini CLI's exact idle/prompt patterns in tmux?** Needs empirical testing — spawn Gemini in tmux and observe the actual output.
2. **Does `--yolo` suppress ALL prompts?** Issue #18816 suggests YOLO mode may still require manual confirmation in some cases.
3. **Can we use `-i` (interactive with initial prompt) + `--yolo` together?** Documentation unclear on flag combinations.
4. **Rate limits under load:** With multiple Gemini workers, will 60 req/min or 1,000 req/day be sufficient? May need Vertex AI for serious use.
5. **GEMINI.md per-worker isolation:** Can we reliably inject per-worker context without conflicting GEMINI.md files?
6. **Daemon mode timeline:** Issue #15338 is P2. If shipped, it would be the ideal integration path (persistent sessions with structured I/O).

---

## Sources

- [Gemini CLI GitHub Repo](https://github.com/google-gemini/gemini-cli)
- [Gemini CLI Documentation](https://geminicli.com/docs/)
- [Headless Mode Docs](https://geminicli.com/docs/cli/headless/)
- [Configuration Reference](https://geminicli.com/docs/get-started/configuration/)
- [MCP Server Docs](https://geminicli.com/docs/tools/mcp-server/)
- [Gemini CLI Cheatsheet](https://www.philschmid.de/gemini-cli-cheatsheet)
- [Automation Tutorial](https://geminicli.com/docs/cli/tutorials/automation)
- [Issue #9751 — tmux crash](https://github.com/google-gemini/gemini-cli/issues/9751) (FIXED)
- [Issue #13396 — tmux server kill](https://github.com/google-gemini/gemini-cli/issues/13396) (model behavior)
- [Issue #15338 — daemon mode request](https://github.com/google-gemini/gemini-cli/issues/15338) (P2, open)
- [Issue #18816 — YOLO mode prompts](https://github.com/google-gemini/gemini-cli/issues/18816)
- [GitHub Actions Integration](https://github.com/google-github-actions/run-gemini-cli)
- [YOLO Mode Deep Wiki](https://deepwiki.com/addyosmani/gemini-cli-tips/9.2-yolo-mode-and-auto-approval)
