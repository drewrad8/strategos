# Gemini CLI Integration Audit Report

**Auditor:** Worker 66fd4ae6 | **Date:** 2026-02-18
**Scope:** Compare Strategos Gemini CLI integration against official [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) documentation and wiki.
**Files audited:** `server/workers/lifecycle.js`, `server/workers/templates.js`, `server/workers/output.js`, `server/routes/workers.js`, `docs/gemini-cli-research.md`

---

## Executive Summary

The Gemini CLI integration is **well-architected** with proper backend selection, context file generation, and pattern-based output detection. However, this audit found **3 bugs**, **2 incorrect assumptions**, and **5 gaps** when compared against the official Gemini CLI documentation.

| Severity | Count | Description |
|----------|-------|-------------|
| **BUG** | 3 | Code that will produce incorrect behavior |
| **INCORRECT** | 2 | Assumptions in code/docs that contradict official docs |
| **GAP** | 5 | Missing features or handling that should be added |
| **VERIFIED OK** | 8 | Areas that are correctly implemented |

---

## BUGS

### BUG-1: `@import` syntax is wrong in master GEMINI.md (CRITICAL)

**File:** `server/workers/templates.js:750`
**What:** The `_updateGeminiMasterFile()` function generates imports using `@import ./filename.md` syntax.
**Problem:** Gemini CLI uses `@path/to/file.md` syntax — NOT `@import`. The `@import` prefix does not exist in Gemini CLI's import processor.

```javascript
// Current (WRONG):
const imports = workerFiles.map(f => `@import ./${f}`).join('\n');

// Correct:
const imports = workerFiles.map(f => `@./${f}`).join('\n');
```

**Evidence:** [Official GEMINI.md docs](https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html) state: "importing other Markdown files using the `@path/to/file.md` syntax". The [Memory Import Processor issue #2983](https://github.com/google-gemini/gemini-cli/issues/2983) confirms the format is `@file.md`, and explicitly warns about incorrect formats.

**Impact:** Per-worker context files are never actually loaded by Gemini CLI. Workers run without their mission, Ralph instructions, or API reference. This renders the entire Gemini context injection non-functional.

**Fix:** Change line 750 from `@import ./${f}` to `@./${f}`.

---

### BUG-2: Bulldoze mode writes Claude context for Gemini workers

**File:** `server/workers/output.js:752`
**What:** When bulldoze mode is enabled via `updateWorkerSettings()`, it always calls `writeStrategosContext()` regardless of `worker.backend`.

```javascript
// Current (WRONG — always writes Claude context):
writeStrategosContext(worker.id, worker.label, worker.workingDir, worker.ralphToken, {
  bulldozeMode: true,
  parentWorkerId: worker.parentWorkerId,
  parentLabel: worker.parentLabel,
}).catch(err => ...);

// Should be:
if (worker.backend === 'gemini') {
  writeGeminiContext(worker.id, worker.label, worker.workingDir, worker.ralphToken, {
    bulldozeMode: true,
    parentWorkerId: worker.parentWorkerId,
    parentLabel: worker.parentLabel,
  }).catch(err => ...);
} else {
  writeStrategosContext(worker.id, worker.label, worker.workingDir, worker.ralphToken, {
    bulldozeMode: true,
    parentWorkerId: worker.parentWorkerId,
    parentLabel: worker.parentLabel,
  }).catch(err => ...);
}
```

**Impact:** Enabling bulldoze mode on a Gemini worker writes a `.claude/rules/strategos-worker-{id}.md` file (which Gemini CLI ignores) instead of updating the Gemini context file.

**Additionally:** `generateGeminiContext()` does not include a bulldoze section at all. The function needs a bulldoze section added, matching the `generateStrategosContext()` bulldoze section.

---

### BUG-3: Crash detection patterns are Claude-specific only

**File:** `server/workers/health.js:41-51`
**What:** `getCrashPatterns()` only checks for Claude Code error strings. Gemini CLI has different error messages.

```javascript
// Current Claude-only patterns:
{ test: () => tail.includes('Cannot read properties of undefined'), reason: 'Claude Code internal error' },
{ test: () => tail.includes('Disconnected from') && tail.includes('Claude'), reason: 'Disconnected from Claude API' },
```

**Missing Gemini patterns:**
- Gemini CLI exit code 42 (input error) — terminal may show argument parsing errors
- Gemini CLI exit code 53 (turn limit exceeded)
- API quota errors: "RESOURCE_EXHAUSTED" or "quota exceeded"
- Auth failures: "UNAUTHENTICATED" or "invalid API key"
- Model errors: "INVALID_ARGUMENT" from the Gemini API
- TUI crash: `tinygradient` errors (related to tmux TERM issues, [Issue #9751](https://github.com/google-gemini/gemini-cli/issues/9751))

**Impact:** Gemini workers that crash are not detected by the health monitor, leading to stale "healthy" status on dead workers.

---

## INCORRECT ASSUMPTIONS

### INCORRECT-1: `--output-format` values in research doc

**File:** `docs/gemini-cli-research.md:81`
**What:** Research doc lists `--output-format stream-json` as a supported format.
**Reality:** While `stream-json` was implemented via [PR #10883](https://github.com/google-gemini/gemini-cli/issues/8203), the [official headless docs](https://google-gemini.github.io/gemini-cli/docs/cli/headless.html) only document `text` (default) and `json` as valid values for `--output-format`. The stream-json feature was added later and may not be in all versions.

**Impact:** Low — this only affects future headless Gemini integration (not yet implemented). But code targeting `stream-json` should version-check or have a fallback.

---

### INCORRECT-2: Research doc claims `general.defaultApprovalMode: "yolo"` works in settings.json

**File:** `docs/gemini-cli-research.md:462`
**What:** States that `"general.defaultApprovalMode": "yolo"` can be set in settings.json as alternative to `--yolo` flag.
**Reality:** Per [official configuration docs](https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html), `defaultApprovalMode` supports `"default"`, `"auto_edit"`, and `"plan"`. The value `"yolo"` was documented but marked as **"not supported yet"** in settings.json — it only works as a CLI flag (`--yolo`) or as an `--approval-mode yolo` argument.

**Impact:** If Strategos ever tries to configure yolo mode via settings.json instead of the `--yolo` flag, it would silently fail.

---

## GAPS

### GAP-1: No `--approval-mode` flag support

**What:** Gemini CLI supports `--approval-mode <mode>` with values: `default`, `auto_edit`, `yolo`. Our spawn code only uses `--yolo`.
**Why it matters:** `--approval-mode auto_edit` would be a safer alternative for workers that only need file editing approved automatically (without blanket shell command approval). This is especially relevant because [Issue #18816](https://github.com/google-gemini/gemini-cli/issues/18816) reports that `--yolo` may still prompt for confirmation in some cases (P1, open).
**Recommendation:** Consider `--approval-mode yolo` as the explicit form, and offer `auto_edit` for security-sensitive workers.

---

### GAP-2: No `.gemini/settings.json` injection for workers

**What:** Gemini CLI loads project-level settings from `.gemini/settings.json`. Strategos doesn't create this file for workers.
**Why it matters:** Several useful behaviors can only be configured via settings.json:
- `tools.allowed` — Whitelist specific tools to skip confirmation (e.g., `["run_shell_command(git)", "run_shell_command(curl)"]`)
- `ui.hideBanner`, `ui.hideTips`, `ui.hideFooter` — Reduce TUI noise in tmux (less output to parse)
- `context.fileName` — Could be set to include worker-specific files directly
- `model.name` — Set model per-worker
- `security.folderTrust.enabled: false` — Ensure no trust prompt appears

**Recommendation:** Generate a `.gemini/settings.json` alongside the context files, at minimum setting `ui.hideBanner: true`, `ui.hideTips: true`, and `security.folderTrust.enabled: false`.

---

### GAP-3: Trust folder prompt may block worker startup

**What:** If `security.folderTrust.enabled` is true (not default, but possible), Gemini CLI shows a trust dialog on first run in a new folder. This would block a tmux-based worker indefinitely.
**Our handling:** `GEMINI_AUTO_ACCEPT_PATTERNS` includes `/Trust folder/i` and `/Do you trust this folder/i` — this would catch and auto-accept the prompt.
**Risk:** The trust prompt has 3 options (Trust folder / Trust parent / Don't trust). Simply pressing Enter may select the wrong option depending on TUI state.
**Recommendation:** Pre-trust folders by writing to `~/.gemini/trustedFolders.json` before spawning, OR set `security.folderTrust.enabled: false` in the project's `.gemini/settings.json`.

---

### GAP-4: `GOOGLE_API_KEY` not supported as auth alternative

**What:** Gemini CLI accepts both `GEMINI_API_KEY` and `GOOGLE_API_KEY` as environment variables for API key authentication. Our code only passes `GEMINI_API_KEY`.
**Evidence:** [Official configuration docs](https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html) list both `GEMINI_API_KEY` and `GOOGLE_API_KEY` as valid auth env vars.
**Impact:** Users who only have `GOOGLE_API_KEY` set (common for Google Cloud users) won't have auth propagated to Gemini workers.
**Fix:** Check for both env vars in `lifecycle.js`:

```javascript
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (geminiApiKey) {
  geminiEnvArgs.push('-e', `GEMINI_API_KEY=${geminiApiKey}`);
}
```

---

### GAP-5: No Gemini-specific crash patterns in health monitor

(See BUG-3 above — this is both a bug and a gap.)

---

## VERIFIED CORRECT

### OK-1: Tmux spawn command structure

**File:** `lifecycle.js:346-361`
**Verification:** The spawn command `tmux new-session -d -s sessionName -x cols -y rows -e "GEMINI_API_KEY=..." -c projectPath gemini --yolo` is correct.
- tmux `new-session` does support `-e environment` for setting env vars (verified: `new-session [-e environment]`)
- `-c start-directory` correctly sets working directory
- `gemini --yolo` is the correct binary name and flag
- `-d` for detached mode is correct

### OK-2: Backend field in worker data model

**File:** `lifecycle.js:74`
**Verification:** `backend: backend || 'claude'` correctly defaults to Claude and propagates through the entire lifecycle (spawn, teardown, context cleanup, discovery).

### OK-3: Backend detection in worker discovery

**File:** `lifecycle.js:1122-1128`
**Verification:** Detecting backend by checking `pane_current_command` for "gemini" is a reasonable heuristic for rediscovering orphaned workers.

### OK-4: Context file cleanup dispatches by backend

**File:** `lifecycle.js:430-434, 592-597`
**Verification:** Both spawn-failure cleanup and teardown correctly call `removeGeminiContext()` vs `removeStrategosContext()` based on backend.

### OK-5: Per-worker GEMINI.md file naming

**File:** `templates.js:703`
**Verification:** `GEMINI-strategos-worker-{id}.md` at project root is a valid naming convention. Gemini CLI only auto-discovers files named `GEMINI.md` (or configured alternatives), so using the master GEMINI.md with imports is the correct approach. (The import syntax is wrong per BUG-1, but the architecture is sound.)

### OK-6: Auto-accept pattern selection by backend

**File:** `output.js:322-325`
**Verification:** The output handler correctly selects `GEMINI_AUTO_ACCEPT_PATTERNS` vs `AUTO_ACCEPT_PATTERNS` based on `worker.backend`. The tail size is also correctly increased for Gemini (5000 vs 500) to account for Gemini's larger TUI rendering.

### OK-7: Idle/active pattern selection by backend

**File:** `output.js:131-136`
**Verification:** Bulldoze mode correctly selects `GEMINI_IDLE_PATTERNS`/`GEMINI_ACTIVE_PATTERNS` for Gemini workers, with appropriately larger tail sizes (8000 vs 1500, 5000 vs 200).

### OK-8: Gemini templates in spawn-from-template route

**File:** `routes/workers.js:96-137`
**Verification:** All 7 Gemini templates (`gemini-research`, `gemini-impl`, `gemini-test`, `gemini-review`, `gemini-fix`, `gemini-general`, `gemini-colonel`) are properly defined with `backend: 'gemini'` and correct prefix/autoAccept/ralphMode settings.

---

## WARNINGS (Non-blocking but worth noting)

### WARN-1: Gemini idle/active patterns are unverified

**File:** `templates.js:108-133`
**What:** The `GEMINI_IDLE_PATTERNS` and `GEMINI_ACTIVE_PATTERNS` are speculative — they have not been empirically tested against actual Gemini CLI TUI output in tmux.
**Known issues that affect pattern reliability:**
- [Issue #3481](https://github.com/google-gemini/gemini-cli/issues/3481): Screen flickering in tmux (redraws in loop)
- [Issue #13396](https://github.com/google-gemini/gemini-cli/issues/13396): Gemini killing tmux server (model behavior, P1)
- Gemini's TUI uses heavy ANSI rendering that may not produce clean "idle prompt" text
**Recommendation:** Spawn a test Gemini worker in tmux and capture actual PTY output to calibrate patterns.

### WARN-2: Issue #18816 — YOLO mode may still prompt (P1, Open)

[Issue #18816](https://github.com/google-gemini/gemini-cli/issues/18816) reports that `--yolo` mode "still pauses and prompts me to confirm/agree before applying text edits." This is a P1 issue, currently open, and may be environment-specific (possibly IDE mode related). Our `GEMINI_AUTO_ACCEPT_PATTERNS` provide a fallback, but if the auto-accept fails, the worker would be stuck.

### WARN-3: tmux server kill risk (Issue #13396)

[Issue #13396](https://github.com/google-gemini/gemini-cli/issues/13396) reports that Gemini CLI can kill the entire tmux server. This is a model-behavior issue — Gemini may run `killall tmux` or similar. The GEMINI.md safety rules include "NEVER kill the tmux server" (templates.js:675), which is the correct mitigation, but it depends on the model following instructions.

### WARN-4: `--screen-reader` flag could simplify output parsing

Gemini CLI has a `--screen-reader` flag that "optimizes for screen reader compatibility." This likely produces simpler, less decorated output that would be easier to parse via PTY capture. Worth investigating as an alternative to parsing the full TUI.

### WARN-5: `--allowed-tools` deprecated in favor of policy engine

The `--allowed-tools` CLI flag and `tools.allowed` setting are being deprecated in favor of a [policy engine](https://geminicli.com/docs/core/policy-engine/). Future integrations should use the policy engine for granular tool control rather than `--allowed-tools`.

---

## Recommended Fix Priority

| Priority | Item | Effort |
|----------|------|--------|
| **P0** | BUG-1: Fix `@import` → `@` syntax in master GEMINI.md | 1 line change |
| **P0** | BUG-2: Fix bulldoze mode context write for Gemini workers | ~10 lines |
| **P1** | BUG-3: Add Gemini-specific crash patterns | ~15 lines |
| **P1** | GAP-2: Generate `.gemini/settings.json` for workers | ~30 lines |
| **P1** | GAP-4: Support `GOOGLE_API_KEY` fallback | 2 lines |
| **P2** | GAP-1: Add `--approval-mode` support | ~10 lines |
| **P2** | GAP-3: Pre-trust folders or disable folderTrust | ~15 lines |
| **P2** | WARN-1: Empirically test idle/active patterns | Manual testing |
| **P3** | WARN-4: Investigate `--screen-reader` for cleaner output | Research |
| **P3** | BUG-2 (part 2): Add bulldoze section to `generateGeminiContext()` | ~20 lines |

---

## Sources

- [Gemini CLI GitHub Repository](https://github.com/google-gemini/gemini-cli)
- [Official Configuration Reference](https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html)
- [GEMINI.md Context Files Docs](https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html)
- [Headless Mode Reference](https://google-gemini.github.io/gemini-cli/docs/cli/headless.html)
- [Trusted Folders Documentation](https://geminicli.com/docs/cli/trusted-folders/)
- [YOLO Mode Deep Dive](https://deepwiki.com/addyosmani/gemini-cli-tips/9.2-yolo-mode-and-auto-approval)
- [Issue #9751 — tmux TERM=screen crash](https://github.com/google-gemini/gemini-cli/issues/9751) (FIXED)
- [Issue #13396 — Gemini kills tmux server](https://github.com/google-gemini/gemini-cli/issues/13396) (OPEN, P1)
- [Issue #18816 — YOLO mode still prompts](https://github.com/google-gemini/gemini-cli/issues/18816) (OPEN, P1)
- [Issue #8203 — stream-json output format](https://github.com/google-gemini/gemini-cli/issues/8203) (CLOSED, implemented via PR #10883)
- [Issue #2983 — Import processor only supports .md files](https://github.com/google-gemini/gemini-cli/issues/2983)
- [Memory Import Processor](https://google-gemini.github.io/gemini-cli/docs/core/memport.html)
- [Policy Engine](https://geminicli.com/docs/core/policy-engine/)
