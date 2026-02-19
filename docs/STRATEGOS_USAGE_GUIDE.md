# Strategos Usage Guide

Strategos is a multi-agent worker orchestrator. It manages Claude Code instances running in tmux sessions with health monitoring, auto-accept, and autonomous completion signaling (Ralph).

**Base URL:** `http://localhost:38007`

---

## Quick Start

### 1. List Projects
```bash
curl -s http://localhost:38007/api/projects?view=flat | jq '.[].name'
```

### 2. Spawn a Worker
```bash
curl -s -X POST http://localhost:38007/api/workers/spawn-from-template \
  -H "Content-Type: application/json" \
  -d '{
    "template": "impl",
    "label": "IMPL: fix-login-bug",
    "projectPath": "/path/to/your/project",
    "task": {"description": "Fix the login timeout bug in auth.js. The session expires after 5 minutes instead of 30."}
  }'
```

### 3. Check Output
```bash
curl -s http://localhost:38007/api/workers/{id}/output?strip_ansi=true&lines=50
```

### 4. Send Input
```bash
curl -s -X POST http://localhost:38007/api/workers/{id}/input \
  -H "Content-Type: application/json" \
  -d '{"input": "Also check the refresh token logic"}'
```

### 5. Check Status
```bash
# Plain text (fast)
curl -s http://localhost:38007/api/workers/{id}/status
# Returns: "running healthy 40% fixing auth module"

# JSON (detailed)
curl -s http://localhost:38007/api/workers/{id}
```

---

## Templates

Spawn workers from templates to get pre-configured roles with auto-accept and Ralph signaling enabled.

| Template | Prefix | Role |
|----------|--------|------|
| `research` | RESEARCH | Read-only investigation. Does NOT write code. |
| `impl` | IMPL | Implementation. Writes code, tests, commits. |
| `test` | TEST | Test writing. Does NOT fix production code. |
| `review` | REVIEW | Code review. Does NOT make changes. |
| `fix` | FIX | Bug fixing. Fixes only the assigned bug. |
| `general` | GENERAL | Strategic commander. Delegates to subordinates. Never writes code. |
| `colonel` | COLONEL | Intermediate commander. Manages a subset of workers. |

### Spawn Body Format
```json
{
  "template": "impl",
  "label": "IMPL: descriptive-name",
  "projectPath": "/absolute/path/to/project",
  "parentWorkerId": "abc12345",
  "task": {"description": "What to do..."},
  "settings": {"bulldoze": true}
}
```

- `template` (required): One of the templates above. `role` is an alias.
- `label` (required): Human-readable label. Convention: `TEMPLATE: short-name`.
- `projectPath` (optional): Working directory. Defaults to THEA_ROOT.
- `parentWorkerId` (optional): Creates parent-child hierarchy for monitoring.
- `task.description` (required): The mission. No control characters allowed.
- `settings.bulldoze` (optional): When true, worker auto-restarts after completing each cycle.

---

## Core API Reference

### Workers

| Action | Method | Endpoint |
|--------|--------|----------|
| List all workers | GET | `/api/workers` |
| List by status | GET | `/api/workers?status=running` |
| List with specific fields | GET | `/api/workers?fields=id,label,status,ralphProgress` |
| Get single worker | GET | `/api/workers/{id}` |
| Get plain-text status | GET | `/api/workers/{id}/status` |
| Get output | GET | `/api/workers/{id}/output?strip_ansi=true` |
| Get last N lines of output | GET | `/api/workers/{id}/output?strip_ansi=true&lines=50` |
| Send input | POST | `/api/workers/{id}/input` |
| Spawn from template | POST | `/api/workers/spawn-from-template` |
| Spawn raw | POST | `/api/workers` |
| Kill worker | DELETE | `/api/workers/{id}` |
| Kill GENERAL-tier | DELETE | `/api/workers/{id}?force=true` |
| Dismiss (awaiting_review) | POST | `/api/workers/{id}/dismiss` |
| Interrupt (Ctrl+C) | POST | `/api/workers/{id}/interrupt` |
| Update label | PATCH | `/api/workers/{id}` |
| Update settings | POST | `/api/workers/{id}/settings` |
| Get children | GET | `/api/workers/{id}/children` |
| Get siblings | GET | `/api/workers/{id}/siblings` |
| Get worker tree | GET | `/api/workers/tree` |
| Get available templates | GET | `/api/workers/templates` |

### Ralph Signaling

Ralph is the autonomous completion protocol. Workers signal their status so commanders and the UI know what's happening.

| Action | Method | Endpoint |
|--------|--------|----------|
| Signal by worker ID | POST | `/api/ralph/signal/by-worker/{id}` |
| Signal by token | POST | `/api/ralph/signal/{token}` |

**Signal body:**
```json
{
  "status": "in_progress",
  "progress": 50,
  "currentStep": "Reading source files"
}
```

```json
{
  "status": "done",
  "learnings": "Found the bug was in the rate limiter, not the auth module",
  "outputs": "Fixed in commit abc1234",
  "artifacts": ["backend/auth.js", "backend/rateLimiter.js"]
}
```

```json
{
  "status": "blocked",
  "reason": "Need database credentials to proceed"
}
```

### Projects

| Action | Method | Endpoint |
|--------|--------|----------|
| List projects | GET | `/api/projects` or `?view=full` |
| Get single project | GET | `/api/projects/{name}` |
| List external projects | GET | `/api/projects/external` |
| Add external project | POST | `/api/projects/external` |
| Remove external project | DELETE | `/api/projects/external` |

### Monitoring

| Action | Method | Endpoint |
|--------|--------|----------|
| Service health | GET | `/api/health` |
| Detailed health | GET | `/api/health?detailed=true` |
| System metrics | GET | `/api/metrics/system` |
| Worker metrics | GET | `/api/metrics/worker/{id}` |
| Resource stats | GET | `/api/resources` |
| Text status page | GET | `/api/status` |

---

## Worker Lifecycle

```
spawned → running → awaiting_review → dismissed
                 ↘ error / crashed
```

1. **spawned**: Worker is being created (tmux session starting, Claude Code launching)
2. **running**: Worker is active and executing
3. **awaiting_review**: Worker signaled "done" via Ralph. Output is preserved for review.
4. **dismissed**: Worker has been cleaned up and resources freed.

Workers in `awaiting_review` can be dismissed or given new input to continue.

---

## Commander Pattern (GENERAL)

GENERALs are strategic commanders that delegate work to specialist workers.

### Workflow
1. GENERAL spawns with a high-level mission
2. It reads context (project state, audit reports, git log)
3. It spawns specialist workers (IMPL, RESEARCH, TEST, FIX) with Commander's Intent
4. It monitors children via `/api/workers/{id}/children`
5. When children complete, it consolidates results and signals done
6. With `bulldoze: true`, it auto-cycles to the next highest-impact task

### Commander's Intent Format
Every task a GENERAL assigns must contain:
```
PURPOSE: Why this task matters (one sentence)
KEY TASKS: What must be accomplished (2-4 verifiable conditions)
END STATE: What success looks like (observable condition)
```

### Protection
GENERAL-tier workers cannot be killed without `?force=true`. This prevents accidental deletion of the command chain.

---

## Bulldoze Mode

Bulldoze mode makes a worker continuously cycle. After completing a task and signaling done, the orchestrator automatically sends a continuation prompt.

**Enable at spawn:**
```json
{"settings": {"bulldoze": true}}
```

**Enable on running worker (via Socket.io — not REST):**
```javascript
socket.emit('worker:settings', { workerId: 'abc123', settings: { bulldozeMode: true } });
```

**Or via REST:**
```bash
curl -s -X POST http://localhost:38007/api/workers/{id}/settings \
  -H "Content-Type: application/json" \
  -d '{"bulldozeMode": true}'
```

The worker maintains a state file at `{project}/tmp/bulldoze-state-{id}.md` to track progress across cycles.

---

## Practical Patterns

### Pattern 1: Quick Research Task
```bash
# Spawn researcher
ID=$(curl -s -X POST http://localhost:38007/api/workers/spawn-from-template \
  -H "Content-Type: application/json" \
  -d '{"template":"research","label":"RESEARCH: api-audit","projectPath":"/path/to/your/project","task":{"description":"Audit all API endpoints and document which ones lack authentication."}}' | jq -r '.id')

# Wait, then check results
sleep 120
curl -s http://localhost:38007/api/workers/$ID/output?strip_ansi=true&lines=100
```

### Pattern 2: Parallel Workers
```bash
# Spawn 3 workers in parallel for different tasks
for task in "fix-auth" "fix-logging" "fix-validation"; do
  curl -s -X POST http://localhost:38007/api/workers/spawn-from-template \
    -H "Content-Type: application/json" \
    -d "{\"template\":\"fix\",\"label\":\"FIX: $task\",\"projectPath\":\"/path/to/your/project\",\"task\":{\"description\":\"Fix the $task module.\"}}"
done

# Monitor all running workers
curl -s http://localhost:38007/api/workers?status=running&fields=id,label,ralphProgress
```

### Pattern 3: Parent-Child Monitoring
```bash
# Spawn a GENERAL
GEN=$(curl -s -X POST http://localhost:38007/api/workers/spawn-from-template \
  -H "Content-Type: application/json" \
  -d '{"template":"general","label":"GENERAL: System Overhaul","projectPath":"/path/to/your/project","task":{"description":"..."}}' | jq -r '.id')

# Monitor its children
curl -s http://localhost:38007/api/workers/$GEN/children | jq '.children[] | {id, label, status: .ralphStatus, progress: .ralphProgress}'
```

### Pattern 4: Send Multi-line Input
```bash
curl -s -X POST http://localhost:38007/api/workers/{id}/input \
  -H "Content-Type: application/json" \
  -d '{"input":"Please also:\n1. Check error handling\n2. Add retry logic\n3. Update the tests"}'
```

---

## API Best Practices

1. **Save curl output to a file** before parsing — piping curl to python/jq fails intermittently:
   ```bash
   curl -s URL -o tmp/result.json && jq '.' tmp/result.json
   ```

2. **Use `strip_ansi=true`** when reading output — raw output contains terminal escape codes.

3. **Use `fields=` query param** to reduce response size:
   ```bash
   curl -s http://localhost:38007/api/workers?fields=id,label,status,ralphProgress
   ```

4. **Check siblings before spawning** to avoid duplicate workers:
   ```bash
   curl -s http://localhost:38007/api/workers/{id}/siblings
   ```

5. **Always include `parentWorkerId`** when spawning from a worker — this enables the children/siblings hierarchy.

6. **Signal progress via Ralph** every 15-30 minutes so the UI and commanders know you're alive.

7. **Git commit before signaling done** — uncommitted work is lost when workers are dismissed.

---

## Worker Statuses

| Status | Meaning |
|--------|---------|
| `running` | Worker is active |
| `pending` | Waiting on dependencies |
| `awaiting_review` | Signaled done, waiting for dismissal |
| `error` | Worker encountered a fatal error |
| `crashed` | Worker process died unexpectedly |

## Ralph Statuses

| Status | Meaning |
|--------|---------|
| `pending` | Worker hasn't signaled yet |
| `in_progress` | Worker is actively working (with progress %) |
| `done` | Worker completed its task |
| `blocked` | Worker is stuck and needs help |

---

## Architecture Notes

- **Port 38007**: Express serves both the REST API and the built React client
- **Workers run in tmux sessions**: Named `thea-worker-{id}`
- **Managed by systemd**: `systemctl --user start/stop/restart strategos`
- **KillMode=process**: Server restarts preserve running tmux worker sessions
- **Auto-accept**: Workers automatically accept Claude Code permission prompts
- **Health monitoring**: Workers are checked every 10 seconds for responsiveness
- **Circuit breaker**: tmux operations have a circuit breaker that trips after repeated failures
