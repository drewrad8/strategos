# Wave 2 Performance Analysis

**Researcher:** a517697e | **Date:** 2026-02-12
**Status:** Complete

---

## Executive Summary

Seven performance issues analyzed across `workerManager.js`, `socketHandler.js`, `statusWriter.js`, and `OrchestratorContext.jsx`. Three are high-impact fixes (timer consolidation, metrics broadcast, getWorkers caching). Two are low-risk quick wins (respawnAttempts cleanup, activity feed cap). Two are low priority (statusWriter sync IO, output buffer sizing).

**Recommended implementation order:** 1 > 4 > 5 > 7 > 2 > 3 > 6

---

## Issue 1: RESPAWN ATTEMPTS MEMORY LEAK

### Current Behavior
- **File:** `server/workerManager.js`
- **Map declaration:** Line 2191: `const respawnAttempts = new Map()`
- **Entry format:** `{ count: number, lastAttempt: number }`

### Trace of All Mutations

| Operation | Line | Context |
|-----------|------|---------|
| `.set(workerId, attempts)` | 2243 | After incrementing count in `handleCrashedWorker()` |
| `.set(newWorker.id, ...)` | 2294 | Transfer counter to new worker ID after successful respawn |
| `.delete(workerId)` | 2295 | Clean up old entry after transfer to new worker ID |
| `.delete(workerId)` | 2438 | In `cleanupWorker()` |
| `.delete(workerId)` | 2560 | In `killWorker()` |
| `.delete(workerId)` | 1370 | In spawn failure path (cleanup after tmux creation failed) |
| `.delete(workerId)` | 1568 | In pending worker start failure path |
| `.delete(workerId)` | 1782 | In PtyCapture session-died handler (comment: "Was missing") |
| `.delete(workerId)` | 4356 | In periodic cleanup (stale entries > 1 hour) |
| `.get(workerId)` | 2207 | In `handleCrashedWorker()` to read current attempts |

### Analysis: Is There Still a Leak?

**Previously:** The PtyCapture session-died handler (line 1782) was missing `.delete()` — entries leaked until periodic cleanup caught them after 1 hour. This was fixed (commit noted in comment).

**Currently:** There is **one remaining gap** — `completeWorker()` (line 3990-4073) does **NOT** delete respawnAttempts. However, `completeWorker()` schedules auto-cleanup which calls `killWorker()` after `AUTO_CLEANUP_DELAY_MS`, and `killWorker()` does delete at line 2560. For GENERAL workers, auto-cleanup is skipped (line 4048), so if a GENERAL crashes, gets a respawnAttempts entry, then later completes successfully, the entry leaks until periodic cleanup after 1 hour.

**Severity:** LOW. The periodic cleanup at lines 4351-4362 runs every 60s and removes entries older than 1 hour. Even without any explicit deletion, entries are bounded to at most `MAX_WORKERS` entries surviving for at most 1 hour. The Map will never grow unbounded.

### Proposed Fix

Add `respawnAttempts.delete(workerId)` to `completeWorker()` for completeness, but this is cosmetic:

```javascript
// In completeWorker(), after line 4010 (worker.completedAt = new Date())
respawnAttempts.delete(workerId);
```

### Risk: MINIMAL
- Pure Map deletion, no side effects
- Safe to deploy on live system at any time

---

## Issue 2: PER-WORKER TIMER CONSOLIDATION

### Current Timer Architecture

Each worker spawns **2 independent intervals**:

| Timer | Function | Frequency | Per-Worker? | Line |
|-------|----------|-----------|-------------|------|
| **PTY Capture** | `startPtyCapture()` | Every **5000ms** | Yes | 1609, freq at 1800 |
| **Health Monitor** | `startHealthMonitor()` | Every **10000ms** | Yes | 2041, freq at 2147 |

**For N workers:** `2N` active `setInterval` timers.

**At 20 workers:** 40 timers (20 firing every 5s, 20 every 10s)
**At 50 workers:** 100 timers
**At 100 workers:** 200 timers

### Additional Global Timer

| Timer | Function | Frequency | Line |
|-------|----------|-----------|------|
| **Periodic Cleanup** | `startPeriodicCleanup()` | Every **60000ms** | 4253 |

This one is fine — single global timer.

### Analysis: Can Timers Be Merged?

**PTY Capture** (5s per worker): Each tick spawns a tmux subprocess (`capture-pane`). This is the heaviest per-tick operation. A single global tick iterating all workers sequentially would serialize tmux calls, which is actually better (reduces concurrent subprocess count).

**Health Monitor** (10s per worker): Pure in-memory analysis — reads `outputBuffers`, checks crash patterns, updates health flags, emits socket events. Very cheap per-tick. Easily merged into a single global loop.

### Proposed Architecture

Replace per-worker timers with **two global intervals**:

```javascript
// Global PTY capture tick — every 5000ms
let globalCaptureInterval = null;

function startGlobalPtyCapture(io) {
  globalCaptureInterval = setInterval(async () => {
    for (const [workerId, instance] of ptyInstances.entries()) {
      if (!workers.has(workerId)) {
        ptyInstances.delete(workerId);
        continue;
      }
      try {
        await captureSingleWorker(workerId, instance, io);
      } catch (err) {
        console.error(`[PtyCapture] Error for ${workerId}: ${err.message}`);
      }
    }
  }, 5000);
}

// Global health monitor tick — every 10000ms
let globalHealthInterval = null;

function startGlobalHealthMonitor(io) {
  globalHealthInterval = setInterval(() => {
    for (const [workerId] of workers.entries()) {
      checkWorkerHealth(workerId, io);
    }
  }, 10000);
}
```

### What Breaks If We Change Timing?

1. **PTY capture becomes sequential per-tick** — Currently all N tmux captures fire concurrently. Sequential is actually better: reduces tmux subprocess contention. But a tick for 50 workers at ~20ms per capture = ~1000ms, which is well within the 5s window.

2. **Per-worker grace period** — Current PTY capture has `initialChecksDone` flag with 5s setTimeout per worker. Must be preserved in the refactored version (store per-worker state in the `ptyInstances` Map entry).

3. **Per-worker state** — `lastCaptureHash`, `initialChecksDone`, session fail counts are currently closures. Must move to per-worker state objects in the Map.

4. **Cleanup semantics** — Currently `clearInterval(captureInterval)` inside the callback self-clears when worker is deleted. With a global loop, instead just delete from `ptyInstances` Map.

### Risk: MODERATE
- Large refactor touching core output pipeline
- Must preserve per-worker state (hash, grace period, fail counts)
- Must handle async errors per-worker without breaking the loop
- Test thoroughly: spawn, kill, respawn, concurrent captures
- **Do NOT deploy during active work** — restart required

### Performance Impact
- At 20 workers: 40 timers → 2 timers (20x reduction)
- At 50 workers: 100 timers → 2 timers (50x reduction)
- Reduced concurrent tmux subprocesses (sequential within tick)
- Reduced Node.js event loop timer heap pressure

---

## Issue 3: STATUSWRITER SYNC IO

### Current Behavior
- **File:** `server/statusWriter.js`
- **Sync calls found:**

| Call | Line | Context |
|------|------|---------|
| `fs.writeFileSync(tmpFile, ...)` | 71 | `_write()` — periodic heartbeat every 30s |
| `fs.renameSync(tmpFile, STATUS_FILE)` | 72 | `_write()` — atomic rename |
| `fs.unlinkSync(tmpFile)` | 76 | `_write()` — cleanup on error |
| `fs.writeFileSync(tmpFile, ...)` | 147 | `shutdown()` — one-time on shutdown |
| `fs.renameSync(tmpFile, STATUS_FILE)` | 148 | `shutdown()` |
| `fs.unlinkSync(tmpFile)` | 151 | `shutdown()` — error cleanup |
| `fs.writeFileSync(tmpFile, ...)` | 186 | `crash()` — one-time on crash |
| `fs.renameSync(tmpFile, STATUS_FILE)` | 187 | `crash()` |
| `fs.unlinkSync(tmpFile)` | 191 | `crash()` — error cleanup |
| `fs.existsSync(dir)` | 30 | `_ensureDirectory()` — constructor, one-time |
| `fs.mkdirSync(dir, ...)` | 31 | `_ensureDirectory()` — constructor, one-time |
| `fs.existsSync(STATUS_FILE)` | 207 | `readStatus()` — static, called externally |
| `fs.readFileSync(STATUS_FILE, ...)` | 208 | `readStatus()` — static |

### Event Loop Blocking Analysis

**`_write()` (line 40-77):** Called every 30s via `setInterval`. Writes ~300 bytes of JSON. On SSD, `writeFileSync` for 300 bytes takes <1ms. `renameSync` is an atomic filesystem operation, also <1ms on same filesystem.

**`shutdown()` and `crash()`:** One-time calls. Sync is actually **correct** here — during crash/shutdown, async operations may not complete (event loop may stop). Using sync ensures the status file is written before process exit.

### Proposed Fix

Only `_write()` benefits from async conversion (it runs periodically during normal operation):

```javascript
async _write() {
  if (this._statusFileWritable === false) return;
  // ... build data object ...

  const tmpFile = STATUS_FILE + `.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.promises.writeFile(tmpFile, JSON.stringify(data, null, 2) + '\n');
    await fs.promises.rename(tmpFile, STATUS_FILE);
  } catch (err) {
    console.error(`[StatusWriter] Write failed: ${err.message}`);
    try { await fs.promises.unlink(tmpFile); } catch (e) { /* ignore */ }
  }
}
```

**Keep `shutdown()` and `crash()` synchronous** — async is unsafe during process exit.

### Is Atomic Rename Still Safe Async?

Yes. `fs.promises.rename()` is the async equivalent of `renameSync()`. On Linux/ext4, rename is atomic at the filesystem level regardless of whether the Node.js API is sync or async. The atomicity guarantee comes from the OS, not from Node.js.

### Risk: MINIMAL
- 30s frequency means blocking is negligible (~0.5ms every 30s)
- Only `_write()` needs conversion; shutdown/crash stay sync
- Async rename is equally atomic on same filesystem
- **Low priority** — the sync IO here blocks for <1ms total per 30s tick

---

## Issue 4: METRICS BROADCAST

### Current Behavior
- **File:** `server/socketHandler.js`
- **Interval:** Lines 582-617, `startMetricsBroadcast()` — every 5000ms
- **Pattern:** Iterates `metricsSubscribers` Set, calls `socket.emit()` per socket

```javascript
// Current: O(N) individual socket.emit() calls
const subscriberSnapshot = [...metricsSubscribers];  // Line 594
for (const socketId of subscriberSnapshot) {         // Line 595
  const socket = io.sockets.sockets.get(socketId);   // Line 596
  if (socket) {
    socket.emit('metrics:update', metricsData);       // Line 599
  }
}
```

### Analysis: Would `io.to(room).emit()` Be Better?

**Yes, significantly.** Socket.io rooms are the idiomatic approach for pub/sub patterns. Benefits:

1. **Single call replaces N calls** — `io.to('metrics').emit('metrics:update', data)` is one call regardless of subscriber count.
2. **No manual subscriber tracking** — Socket.io manages room membership internally. No `metricsSubscribers` Set needed.
3. **No stale socket cleanup** — Socket.io automatically removes sockets from rooms on disconnect. No need for the cleanup code at lines 496-503.
4. **Serialization happens once** — Socket.io serializes the payload once for room broadcasts, vs N times for individual emits.

### Proposed Fix

```javascript
// In 'metrics:subscribe' handler (line 450):
socket.on('metrics:subscribe', () => {
  socket.join('metrics');
  // Send immediate update to this socket
  socket.emit('metrics:update', getSystemMetricsData());
  // Start broadcast if not running
  if (!metricsBroadcastInterval) {
    startMetricsBroadcast(io);
  }
});

// In 'metrics:unsubscribe' handler (line 473):
socket.on('metrics:unsubscribe', () => {
  socket.leave('metrics');
  // Stop broadcast if room is empty
  const room = io.sockets.adapter.rooms.get('metrics');
  if (!room || room.size === 0) {
    clearInterval(metricsBroadcastInterval);
    metricsBroadcastInterval = null;
  }
});

// In 'disconnect' handler: REMOVE metricsSubscribers cleanup (Socket.io handles it)

// In startMetricsBroadcast:
function startMetricsBroadcast(io) {
  metricsBroadcastInterval = setInterval(() => {
    const room = io.sockets.adapter.rooms.get('metrics');
    if (!room || room.size === 0) return;

    try {
      const metricsData = getSystemMetricsData();
      io.to('metrics').emit('metrics:update', metricsData);
    } catch (error) {
      console.error('[Socket] Error broadcasting metrics:', error.message);
    }
  }, 5000);
  metricsBroadcastInterval.unref();
}
```

### Additional Optimization: `getSystemMetricsData()` calls `getWorkers()`

Line 524: `const workers = getWorkers()` inside `getSystemMetricsData()`. This normalizes all workers every 5 seconds for metrics. After Issue 5 (caching) is implemented, this becomes free.

### Risk: LOW
- Socket.io rooms are well-tested, idiomatic pattern
- Remove ~30 lines of manual subscriber management
- Must verify `stopMetricsBroadcast()` export still works for graceful shutdown
- Can deploy on live system — only affects metrics panel users

---

## Issue 5: GETWORKERS NORMALIZATION CACHING

### Current Behavior
- **File:** `server/workerManager.js`
- **Function:** Lines 2818-2822

```javascript
export function getWorkers() {
  const active = Array.from(workers.values()).map(normalizeWorker);  // O(N) normalization
  const pending = getPendingWorkers();
  return [...active, ...pending];  // Array spread creates new array
}
```

### Callers (17 total)

| File | Line | Context | Frequency |
|------|------|---------|-----------|
| `socketHandler.js` | 113 | On each client connect | Per-connect |
| `socketHandler.js` | 119 | Output preview loop on connect | Per-connect |
| `socketHandler.js` | 524 | `getSystemMetricsData()` | Every 5s (metrics broadcast) |
| `routes.js` | 154 | `GET /api/workers` | Per-request |
| `routes.js` | 178 | `GET /api/workers?project=X` | Per-request |
| `routes.js` | 1171 | `GET /api/health` | Per-request |
| `routes.js` | 1603 | `GET /api/briefing` | Per-request |
| `orchestratorService.js` | 139 | Ralph context | Per-ralph-call |
| `orchestratorService.js` | 299 | Context building | Periodic |
| `orchestratorService.js` | 467 | Worker lookup | On-demand |
| `orchestratorService.js` | 482 | Worker lookup | On-demand |
| `workerManager.js` | 2861 | `getWorkersByProject()` | Per-broadcast |
| `workerManager.js` | 3394 | `discoverExistingWorkers()` | Once at startup |
| `index.js` | 218 | Startup log | Once |
| `index.js` | 254 | Status writer provider | Every 30s |
| `index.js` | 256 | Health provider | Every 30s |

**Hot path:** `socketHandler.js:524` — called every 5s for metrics broadcast. With N workers, this is `O(N)` normalization every 5 seconds even if nothing changed.

### Proposed Fix: Dirty-Flag Cache

```javascript
let _normalizedCache = null;
let _normalizedCacheDirty = true;

function invalidateWorkersCache() {
  _normalizedCacheDirty = true;
  _normalizedCache = null;
}

export function getWorkers() {
  if (!_normalizedCacheDirty && _normalizedCache) {
    return _normalizedCache;
  }
  const active = Array.from(workers.values()).map(normalizeWorker);
  const pending = getPendingWorkers();
  _normalizedCache = [...active, ...pending];
  _normalizedCacheDirty = false;
  return _normalizedCache;
}
```

**Invalidation points** — call `invalidateWorkersCache()` whenever workers Map changes:
- `workers.set()` — spawn, restore, discover (~8 call sites)
- `workers.delete()` — kill, cleanup, PtyCapture death (~6 call sites)
- `pendingWorkers.set()` / `pendingWorkers.delete()` (~4 call sites)
- Worker property mutations that affect normalized fields (health, status, label, etc.)

### Edge Cases

1. **Mutation after cache** — `normalizeWorker()` creates new objects (no shared references), so cached results are safe to return to multiple callers. BUT callers should not mutate the returned objects (they currently don't).

2. **Worker property updates without Map.set()** — The workers Map stores references. When code does `worker.health = 'crashed'` without re-setting the Map, the cache is stale. These mutations happen frequently (health monitor, auto-accept, etc.). **Every worker property mutation must invalidate the cache.**

3. **Cache returning same array reference** — Multiple callers getting the same array reference is fine since no caller mutates the returned array. But if a caller does `workers.push(...)` or `workers[0].x = y`, it corrupts other callers. Current code doesn't do this.

4. **Pending workers** — `getPendingWorkers()` also normalizes. Must invalidate on pending worker changes too.

### Risk: MODERATE
- Must identify ALL worker mutation sites (there are many — health, status, label, timestamps, ralph fields, queue counts, etc.)
- Missing an invalidation point = stale data in UI
- Consider: simpler approach of just caching with a TTL (e.g., 1s max-age) avoids tracking all mutation points:

```javascript
let _cachedWorkers = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 1000; // 1 second

export function getWorkers() {
  const now = Date.now();
  if (_cachedWorkers && (now - _cacheTime) < CACHE_TTL_MS) {
    return _cachedWorkers;
  }
  const active = Array.from(workers.values()).map(normalizeWorker);
  const pending = getPendingWorkers();
  _cachedWorkers = [...active, ...pending];
  _cacheTime = now;
  return _cachedWorkers;
}
```

**TTL-based approach is SAFER** — no risk of missing invalidation points. The trade-off is up-to-1s staleness, which is acceptable for UI display.

---

## Issue 6: OUTPUT BUFFER SIZING

### Current Behavior
- **File:** `server/workerManager.js`, line 1648
- **Constant:** `const MAX_OUTPUT_BUFFER = 2 * 1024 * 1024` (2MB per worker)
- **Scope:** Defined inside `startPtyCapture()` callback, not module-level

### Memory Analysis

**Theoretical worst case:** 100 workers x 2MB = 200MB output buffers + 200MB client-side (React state mirrors server buffers for connected workers).

**Actual per-worker output size:** The buffer stores `tmux capture-pane -p -e` output. This captures the **visible terminal pane**, not the full scrollback. A typical tmux pane is 80x24 = ~1920 characters. Even with ANSI escape codes, the visible pane output is typically **5-20KB**.

However, the buffer is **cumulative** — it captures the pane each tick and the entire buffer grows. Wait, re-reading the code:

```javascript
let { stdout } = await spawnTmux(['capture-pane', '-t', sessionName, '-p', '-e']);
// ...
outputBuffers.set(workerId, stdout);  // Line 1656 — REPLACES, doesn't append
```

**Each tick replaces the buffer with the current pane capture.** The buffer is NOT cumulative. `capture-pane -p` only captures the **visible pane content** (typically 5-20KB). The 2MB cap is a safety net that would only trigger if tmux somehow returned a massive pane.

### Actual Memory Usage

- Per worker: **5-20KB** typical (visible pane content)
- 100 workers: **0.5-2MB** typical, not 200MB
- The periodic cleanup monitor at line 4334 tracks actual usage and warns at >100MB

### Assessment: NOT A REAL ISSUE

The 2MB cap is reasonable as a safety net. Actual usage is 100x lower than the theoretical max. The `MAX_OUTPUT_BUFFER` constant is locally scoped (line 1648, inside the closure) — could be promoted to module-level for clarity but doesn't change behavior.

### Proposed Fix: Cosmetic Only

```javascript
// Move to module-level constant (near line 127)
const MAX_OUTPUT_BUFFER = 2 * 1024 * 1024; // 2MB safety cap (actual: ~5-20KB per worker)
```

### Risk: NONE
- No behavioral change needed
- Current sizing is appropriate

---

## Issue 7: ACTIVITY FEED CAP

### Current Behavior

**Server side:**
- **File:** `server/workerManager.js`, lines 127-128, 320-324
- `MAX_ACTIVITY_LOG = 100` (line 128)
- `addActivity()` (line 301) does `activityLog.unshift(entry)` then `if (activityLog.length > 100) activityLog.pop()`
- `getActivityLog()` (line 329) returns the full array reference

**On socket connect:**
- **File:** `server/socketHandler.js`, line 115
- `socket.emit('activity:list', getActivityLog())` — sends ALL 100 entries

**Client side:**
- **File:** `client/src/context/OrchestratorContext.jsx`, line 180
- `'activity:list': (data) => setActivity(data)` — stores full list (up to 100 entries)
- `'activity:new': (entry) => setActivity(prev => [entry, ...prev].slice(0, 100))` — caps at 100

### Analysis: Is Initial List Capped?

**Yes**, but indirectly. The server-side `activityLog` array is capped at 100 entries by `addActivity()`. So `getActivityLog()` always returns at most 100 items. The client receives at most 100 items on connect.

The client also caps `activity:new` at 100 via `.slice(0, 100)` on line 181. So the client is double-capped: initial list is <=100, and new entries maintain the <=100 invariant.

### Potential Issue: Reference Leak

`getActivityLog()` returns **the direct array reference**, not a copy:

```javascript
export function getActivityLog() {
  return activityLog;  // Direct reference!
}
```

Socket.io will serialize it for transmission so that's fine for socket emit. But any server-side caller that holds a reference could see mutations (new entries pushed, old entries popped). This is a correctness concern, not a performance concern.

### Proposed Fix

Return a shallow copy to prevent reference leakage:

```javascript
export function getActivityLog() {
  return [...activityLog];  // or activityLog.slice()
}
```

### Risk: MINIMAL
- Tiny change, no behavioral impact for socket callers
- Prevents subtle bugs if server code ever holds a reference

---

## Safe Implementation Order

Ordered by: risk (lowest first), impact (highest first), dependencies.

| Order | Issue | Risk | Impact | Restart? | Notes |
|-------|-------|------|--------|----------|-------|
| 1 | **#1 respawnAttempts** | Minimal | Low | No | 1 line, pure cleanup |
| 2 | **#4 metrics broadcast** | Low | Medium | Yes | Socket.io rooms, removes ~30 LOC |
| 3 | **#5 getWorkers caching** | Low-Mod | High | Yes | TTL approach is safest |
| 4 | **#7 activity feed cap** | Minimal | Low | No | 2 line change |
| 5 | **#2 timer consolidation** | Moderate | High | Yes | Largest refactor, test heavily |
| 6 | **#3 statusWriter async** | Minimal | Negligible | No | Low priority, <1ms blocking |
| 7 | **#6 output buffer sizing** | None | None | No | Cosmetic only, current sizing is correct |

### Deployment Strategy for Live System

**Phase 1 (no restart needed):**
- Fix #1 (respawnAttempts) and #7 (activity feed) can be code-committed and will take effect on next natural restart.

**Phase 2 (single restart):**
- Fix #4 (metrics broadcast) and #5 (getWorkers caching) should be deployed together.
- Restart during low-activity period (few active workers).
- Workers survive server restart (tmux sessions persist, `discoverExistingWorkers` re-attaches).

**Phase 3 (careful restart):**
- Fix #2 (timer consolidation) is the largest change.
- Must be tested with controlled worker count first.
- Deploy when workers can tolerate a brief reconnection.

**Phase 4 (opportunistic):**
- Fix #3 (statusWriter async) and #6 (output buffer cosmetic) — do whenever convenient.

---

## Appendix: Line Number Reference

All line numbers reference the current `master` branch as of 2026-02-12.

| File | Total Lines | Key Sections |
|------|-------------|--------------|
| `server/workerManager.js` | ~4400 | respawnAttempts:2191, startPtyCapture:1588, startHealthMonitor:2034, normalizeWorker:2768, getWorkers:2818, completeWorker:3990, periodicCleanup:4244 |
| `server/socketHandler.js` | ~630 | metricsSubscribers:26, metrics:subscribe:450, startMetricsBroadcast:582, getSystemMetricsData:522 |
| `server/statusWriter.js` | ~227 | _write:40, shutdown:120, crash:158 |
| `client/src/context/OrchestratorContext.jsx` | ~651 | activity:list:180, activity:new:181 |
