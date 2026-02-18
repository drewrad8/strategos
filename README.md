<div align="center">
  <h1>Strategos</h1>
  <p><strong>Web-based orchestrator for managing multiple AI coding agents through a real-time dashboard</strong></p>
  <p>
    <a href="https://github.com/drewrad8/strategos/blob/main/LICENSE"><img src="https://img.shields.io/github/license/drewrad8/strategos" alt="License" /></a>
    <a href="https://github.com/drewrad8/strategos"><img src="https://img.shields.io/github/stars/drewrad8/strategos" alt="Stars" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js&logoColor=white" alt="Node.js >= 20" />
    <img src="https://img.shields.io/badge/platform-linux%20%7C%20macos-blue" alt="Platform" />
  </p>
</div>

---

Strategos gives you a single dashboard to spawn, monitor, and coordinate AI coding agents running in isolated tmux sessions. Point it at your projects directory, spawn workers with task descriptions, and watch them work in real-time through the web UI or CLI. Workers support both **Claude Code** and **Gemini CLI** backends, with hierarchical role templates, autonomous progress reporting, and crash-resilient state persistence.

## Highlights

- **Real-time Web Dashboard** — Live terminal output, worker cards with status indicators, project-organized views, and split-pane terminal monitoring
- **Multi-Backend Workers** — Spawn workers using Claude Code CLI or Gemini CLI, each running in its own tmux session with full terminal isolation
- **Hierarchical Roles** — Military-doctrine role templates (GENERAL, COLONEL, CAPTAIN, and specialist roles) with structured task decomposition and chain-of-command coordination
- **Ralph Protocol** — Workers autonomously signal progress (`in_progress` / `done` / `blocked`) with percentage completion, enabling hands-off orchestration
- **Parent-Child Workflows** — Workers can spawn child workers, with automatic progress aggregation, result delivery, and promotion on completion
- **Crash-Resilient** — Worker state persists to disk, tmux sessions survive server restarts (via dedicated socket and `KillMode=process`), circuit breakers prevent cascade failures
- **Auto-Accept & Bulldoze** — Automatically approve permission prompts and continue stalled workers through configurable continuation cycles
- **Security Hardened** — Helmet headers, rate limiting, CORS configuration, optional API key auth, path traversal prevention, localhost-only by default

## Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Web UI](#web-ui)
- [CLI Usage](#cli-usage)
- [Configuration](#configuration)
- [Role Templates](#role-templates)
- [Ralph Protocol](#ralph-protocol)
- [Security](#security)
- [API Reference](#api-reference)
- [Contributing](#contributing)
- [License](#license)

## Quick Start

### Prerequisites

- **Node.js** >= 20
- **tmux** >= 3.0
- **Claude Code CLI** and/or **Gemini CLI** installed and authenticated

### Install

```bash
git clone https://github.com/drewrad8/strategos.git
cd strategos
./install.sh
```

The installer will check prerequisites, prompt for your projects directory and API keys, and optionally set up a systemd (Linux) or launchd (macOS) service.

### First Run

If you skip the installer, Strategos will detect the missing configuration on first start and present a setup page in your browser:

```bash
npm start
# Open http://localhost:38007 — you'll be redirected to the setup page
```

The setup page asks for a **projects root directory** — the folder containing your coding projects. Strategos scans this directory for projects and allows workers to operate within them. You can add more project directories later from the UI.

### Start Working

```bash
# Start the server (if not using a system service)
strategos start

# Open the web UI
open http://localhost:38007

# Or use the CLI to spawn a worker
strategos-worker spawn ~/my-project "IMPL: Add user authentication"
```

## How It Works

```
 You ──────┐
           │
    ┌──────▼──────────────────────────────────────────────┐
    │              Strategos Server (:38007)               │
    │                                                      │
    │   ┌─────────┐  ┌──────────┐  ┌──────────────────┐  │
    │   │ REST API │  │ Socket.io│  │  Worker Manager   │  │
    │   └────┬────┘  └────┬─────┘  │  ┌────────────┐  │  │
    │        │            │        │  │  Lifecycle  │  │  │
    │        └─────┬──────┘        │  │  Health     │  │  │
    │              │               │  │  Output     │  │  │
    │              │               │  │  Persistence│  │  │
    │              │               │  │  Ralph      │  │  │
    │              │               │  │  Templates  │  │  │
    │              │               │  └────────────┘  │  │
    │              │               └─────────┬────────┘  │
    └──────────────┼─────────────────────────┼───────────┘
                   │                         │
        ┌──────────┴──────────┐    ┌────────▼─────────┐
        │                     │    │  tmux socket      │
        ▼                     ▼    │  (-L strategos)   │
   ┌─────────┐         ┌─────────┐│                   │
   │ Web UI  │         │  CLI    ││ ┌───┐ ┌───┐ ┌───┐│
   │ (React) │         │  Tools  ││ │W1 │ │W2 │ │W3 ││
   └─────────┘         └─────────┘│ └───┘ └───┘ └───┘│
                                   └──────────────────┘
```

1. **You** define tasks and spawn workers through the web UI or CLI
2. **Strategos Server** manages the lifecycle of each worker — spawning tmux sessions, capturing output, monitoring health, and persisting state
3. **Workers** run in isolated tmux sessions on a dedicated socket, executing Claude Code or Gemini CLI with your task instructions
4. **Ralph Protocol** lets workers signal their progress autonomously, so Strategos can track completion without polling
5. **Parent-child hierarchies** enable complex task decomposition — a GENERAL spawns COLONELs, who spawn specialists

## Architecture

### Server Modules

| Module | Purpose |
|--------|---------|
| `workers/lifecycle.js` | Spawn, kill, dismiss, complete, discover workers; dependency triggering; onComplete actions |
| `workers/output.js` | PTY capture via tmux, auto-accept engine, bulldoze continuation, command queuing |
| `workers/health.js` | Health monitoring, crash detection/recovery, stale worker cleanup, respawn suggestions |
| `workers/persistence.js` | Debounced save, crash-safe sync save, state restoration with zombie detection |
| `workers/ralph.js` | Ralph signal handling, parent-child progress aggregation, auto-promotion |
| `workers/templates.js` | Role-based prompt generation (military C2 doctrine), `.claude/rules/` management |
| `workers/state.js` | Centralized state, constants, tmux utilities, circuit breaker |
| `sentinel.js` | Toggleable diagnostics — process health, worker-tmux coherence, orphan detection |
| `socketHandler.js` | Real-time WebSocket events with per-event rate limiting |

### Routes

| Endpoint | Description |
|----------|-------------|
| `GET/POST/DELETE /api/workers` | Worker CRUD, spawn, kill, dismiss, interrupt |
| `GET /api/projects` | Project listing with tree/flat/full views |
| `POST /api/projects/create` | Create new project directories |
| `POST /api/ralph/signal` | Ralph autonomous progress signals |
| `GET /api/diagnostics` | Sentinel diagnostic reports |
| `GET /api/health` | Server health check |

## Web UI

The web dashboard provides:

- **Worker Cards** — Status, progress bar, role badge, backend indicator, Ralph signals, activity timer
- **Live Terminal** — Real-time terminal output via xterm.js-compatible rendering
- **Split Pane View** — Monitor multiple workers simultaneously
- **Project View** — Workers organized by project with folder hierarchy
- **Health Panel** — Worker health indicators, crash history, respawn suggestions
- **Sentinel Toggle** — Enable/disable background diagnostics from the header
- **Keyboard Shortcuts** — Quick navigation and worker management

## CLI Usage

### Server Management

```bash
strategos start          # Start the server
strategos stop           # Stop the server (graceful shutdown)
strategos restart        # Restart the server
strategos status         # Show server status and worker count
strategos logs           # Tail the server logs
strategos config         # Show current configuration
```

### Worker Management

```bash
# List all workers
strategos-worker list

# Spawn a worker with a task description
strategos-worker spawn ~/my-project "IMPL: Add login feature"

# Spawn with a specific provider
strategos-worker spawn ~/my-project "RESEARCH: Analyze dependencies" gemini

# Follow worker output in real-time
strategos-worker output <worker-id> --follow

# Send input to a running worker
strategos-worker send <worker-id> "Focus on the authentication module"

# Get worker details
strategos-worker get <worker-id>

# Get an AI-generated summary of worker state
strategos-worker summary <worker-id>

# Stop a worker
strategos-worker stop <worker-id>
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `38007` | Server port |
| `THEA_ROOT` | (set during setup) | Projects root directory |
| `STRATEGOS_HOST` | `127.0.0.1` | Bind address (use `0.0.0.0` for LAN access) |
| `STRATEGOS_API_KEY` | (none) | Optional API key for authentication |
| `STRATEGOS_CORS_ORIGINS` | (localhost) | Comma-separated allowed CORS origins |
| `NODE_ENV` | `development` | Set to `production` for security hardening |

### Config Files

| File | Purpose |
|------|---------|
| `config/strategos.env` | Projects root directory (created by installer or setup page) |
| `config/strategos.json` | Extended configuration (port, data directory, feature flags) |
| `.env` | API keys and secrets (created by installer) |

### System Service

The installer can set up a system service for auto-start on boot:

- **Linux**: systemd user service (`~/.config/systemd/user/strategos.service`)
- **macOS**: launchd plist (`~/Library/LaunchAgents/com.strategos.plist`)

```bash
# Linux service management
systemctl --user start strategos
systemctl --user stop strategos
systemctl --user status strategos
journalctl --user -u strategos -f
```

## Role Templates

Strategos uses a military command hierarchy for task decomposition:

| Role | Purpose | Spawns |
|------|---------|--------|
| **GENERAL** | Strategic mission planning, breaks down objectives into tasks | COLONELs |
| **COLONEL** | Tactical coordination, manages specialist teams | Specialists |
| **CAPTAIN** | Team lead for specific deliverables | Specialists |
| **RESEARCHER** | Deep investigation, documentation, analysis | — |
| **ARCHITECT** | System design, API contracts, technical decisions | — |
| **IMPLEMENTER** | Code writing, feature implementation | — |
| **TESTER** | Testing, validation, quality assurance | — |

Each role receives a structured prompt with:
- **Commander's Intent** — Purpose, key tasks, and end state
- **Scope boundaries** — What the worker should and should not do
- **On Failure / On Discovery** — Explicit protocols for handling issues
- **Post-mission protocol** — Consolidate work, report results, await further orders

## Ralph Protocol

Ralph (Report, Acknowledge, Log Progress, Halt) enables autonomous worker progress reporting:

```
Worker → POST /api/ralph/signal
{
  "workerId": "abc123",
  "status": "in_progress",    // in_progress | done | blocked
  "progress": 65,             // percentage (0-100)
  "summary": "Completed auth module, starting tests"
}
```

Workers send Ralph signals to report their progress without human intervention. The server:
- Updates worker status and progress bars in the UI
- Aggregates child worker progress into parent workers
- Auto-promotes parents when all children complete
- Tracks efficiency metrics (time to first signal, signal frequency)

## Security

Strategos is designed for local and trusted-network use:

- **Localhost-only by default** — Server binds to `127.0.0.1`; set `STRATEGOS_HOST=0.0.0.0` for LAN access
- **Helmet headers** — Standard security headers (CSP disabled for SPA compatibility)
- **Rate limiting** — 300 requests/min general, 30/min for spawn operations, per-socket event limits
- **Optional API key** — Set `STRATEGOS_API_KEY` to require authentication on all requests
- **CORS configuration** — Strict origin validation via `STRATEGOS_CORS_ORIGINS`
- **Path restrictions** — Workers can only operate within configured project directories; system paths are rejected
- **Dedicated tmux socket** — Worker sessions are isolated from your personal tmux via `-L strategos`
- **No telemetry** — Strategos does not phone home or collect usage data

### Reporting Vulnerabilities

If you discover a security issue, please email the maintainer directly rather than opening a public issue. See [SECURITY.md](SECURITY.md) for details.

## API Reference

The full REST API is available at `http://localhost:38007/api/`. Key endpoints:

<details>
<summary>Workers API</summary>

```
GET    /api/workers                    # List all workers (supports ?status=running&fields=id,label)
POST   /api/workers                    # Spawn a new worker
GET    /api/workers/:id                # Get worker details
DELETE /api/workers/:id                # Kill a worker
POST   /api/workers/:id/input          # Send input to a worker
GET    /api/workers/:id/output         # Get recent output
POST   /api/workers/:id/dismiss        # Dismiss (checks for uncommitted changes)
POST   /api/workers/:id/interrupt      # Send Ctrl-C with optional follow-up
POST   /api/workers/:id/complete       # Mark as completed
POST   /api/workers/:id/resize         # Resize terminal
GET    /api/workers/:id/status         # Plain-text status (for worker self-check)
GET    /api/workers/:id/children       # List child workers
GET    /api/workers/:id/siblings       # List sibling workers
POST   /api/workers/spawn-from-template # Spawn with role template
POST   /api/workers/batch              # Batch spawn multiple workers
```

</details>

<details>
<summary>Projects API</summary>

```
GET    /api/projects                   # List projects (?view=tree|flat|full)
GET    /api/projects/:name             # Get project with workers
POST   /api/projects/create            # Create a new project directory
GET    /api/projects/config            # Get project organization config
PUT    /api/projects/config            # Update project config
GET    /api/projects/external          # List external project directories
POST   /api/projects/external          # Add an external project directory
DELETE /api/projects/external          # Remove an external project directory
```

</details>

<details>
<summary>System API</summary>

```
GET    /api/health                     # Server health check
GET    /api/metrics                    # Server metrics and resource stats
GET    /api/diagnostics                # Sentinel diagnostic report
GET    /api/diagnostics/history        # Diagnostic history (24h)
POST   /api/sentinel/start             # Enable sentinel diagnostics
POST   /api/sentinel/stop              # Disable sentinel diagnostics
GET    /api/sentinel/status            # Sentinel status
POST   /api/ralph/signal               # Ralph progress signal
GET    /api/setup/status               # Check if setup is needed
POST   /api/setup/configure            # Configure projects root (first run)
```

</details>

## Contributing

Contributions are welcome. Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run syntax checks (`node --check server/index.js`)
5. Commit with a descriptive message
6. Push to your fork and open a pull request

## License

[MIT](LICENSE)
