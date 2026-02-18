# Strategos

**Multi-provider AI Orchestrator** - Coordinate multiple AI agents across different providers to work on complex software engineering tasks.

## What is Strategos?

Strategos is an open-source orchestration system that lets you:

- **Spawn AI workers** - Create interactive AI agents that work in tmux sessions
- **Multi-provider support** - Use Claude, OpenAI, Gemini, or Ollama
- **Coordinate work** - Workers can spawn child workers, creating hierarchies
- **Track progress** - Real-time web UI and CLI for monitoring all workers
- **Auto-accept** - Workers can automatically accept permission prompts
- **Ralph mode** - Workers can signal when their tasks are complete

## Quick Install

```bash
# Clone the repository
git clone https://github.com/drewrad8/strategos.git
cd strategos

# Run the interactive installer
./install.sh
```

The installer will:
1. Check prerequisites (Node.js 18+, tmux)
2. Configure your preferred providers
3. Set up API keys
4. Optionally install as a system service

## Requirements

- **Node.js 18+** - JavaScript runtime
- **tmux** - Terminal multiplexer (for worker sessions)
- **Claude Code CLI** (recommended) - For Claude workers
- **API Keys** (optional) - For OpenAI, Gemini, or Anthropic

## Usage

### Start the Server

```bash
# Using the CLI
strategos start

# Or directly
node server/index.js
```

### Open the Web UI

Navigate to `http://localhost:38007` in your browser.

### Spawn Workers

```bash
# Using the CLI
strategos-worker spawn ~/my-project "IMPL: Add user authentication"

# Using the API
curl -X POST http://localhost:38007/api/workers \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/home/user/my-project", "label": "IMPL: Add auth"}'
```

### Monitor Workers

```bash
# List all workers
strategos-worker list

# Watch worker output
strategos-worker output <worker-id> --follow

# Send instructions
strategos-worker send <worker-id> "Now add unit tests"
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Strategos Server                        │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  Claude  │  │  OpenAI  │  │  Gemini  │  │  Ollama  │   │
│  │ Provider │  │ Provider │  │ Provider │  │ Provider │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │             │             │             │          │
│  ┌────▼─────────────▼─────────────▼─────────────▼────┐    │
│  │              Worker Manager                        │    │
│  │  - Spawn workers in tmux sessions                  │    │
│  │  - Track health, output, dependencies              │    │
│  │  - Auto-accept prompts                             │    │
│  └────────────────────────────────────────────────────┘    │
│                          │                                  │
│  ┌───────────────────────▼───────────────────────────┐    │
│  │                 REST API + WebSocket               │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
         │                                    │
         ▼                                    ▼
    ┌─────────┐                         ┌─────────┐
    │ Web UI  │                         │   CLI   │
    └─────────┘                         └─────────┘
```

## Worker Naming Convention

Workers use prefixes to indicate their role:

**Rank Prefixes (Hierarchy):**
- `GENERAL:` - Strategic orchestrator, manages other workers
- `COLONEL:` - Domain supervisor, coordinates 3-5 workers
- `CAPTAIN:` - Senior specialist

**Role Prefixes (Function):**
- `RESEARCH:` - Information gathering, analysis
- `IMPL:` - Implementation, coding
- `TEST:` - Testing, validation
- `REVIEW:` - Code review, QA
- `FIX:` - Bug fixes
- `DEPLOY:` - Deployment, infrastructure

**Examples:**
```
RESEARCH: Security Vulnerability Assessment
IMPL: User Authentication Module
TEST: E2E Integration Suite
GENERAL: Feature Implementation Lead
```

## Configuration

Configuration is stored in `~/.strategos/config/strategos.json`:

```json
{
  "port": 38007,
  "projectsRoot": "~/strategos-projects",
  "providers": {
    "workers": {
      "default": "claude",
      "available": ["claude", "openai", "gemini"]
    },
    "api": {
      "default": "ollama",
      "ollama": {
        "url": "http://localhost:11434",
        "model": "qwen3:8b"
      }
    }
  }
}
```

API keys are stored in `~/.strategos/.env`:

```bash
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...
ANTHROPIC_API_KEY=sk-ant-...
```

## Documentation

- [Quick Start Guide](QUICKSTART.md)
- [Configuration Reference](CONFIGURATION.md)
- [Provider Setup](PROVIDERS.md)

## License

MIT License - see [LICENSE](../LICENSE) file.
