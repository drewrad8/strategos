# Strategos

**Multi-provider AI Orchestrator** - Coordinate multiple AI agents across Claude, OpenAI, Gemini, and Ollama.

## Features

- **Multi-Provider Support** - Use Claude Code, OpenAI, Gemini, or Ollama as worker providers
- **Interactive Workers** - AI agents run in tmux sessions with full terminal access
- **Real-time Monitoring** - Web UI and CLI for tracking all workers
- **Worker Coordination** - Workers can spawn child workers for complex tasks
- **Auto-Accept** - Workers can automatically approve permission prompts
- **Ralph Mode** - Workers signal task completion autonomously

## Quick Start

```bash
# Clone and install
git clone https://github.com/drewrad8/strategos.git
cd strategos
./install.sh

# Start the server
strategos start

# Open the web UI
open http://localhost:38007

# Or use the CLI
strategos-worker spawn ~/my-project "IMPL: Add login feature"
```

## Requirements

- Node.js 18+
- tmux
- Claude Code CLI (recommended) or API keys for OpenAI/Gemini

## Documentation

- [Quick Start Guide](docs/QUICKSTART.md)
- [Configuration Reference](docs/CONFIGURATION.md)
- [Provider Setup](docs/PROVIDERS.md)

## Architecture

```
┌──────────────────────────────────────────┐
│           Strategos Server               │
├──────────────────────────────────────────┤
│  Providers: Claude | OpenAI | Gemini     │
│            └──────────┬─────────────┘    │
│                       ▼                  │
│  ┌────────────────────────────────────┐  │
│  │         Worker Manager             │  │
│  │  - tmux sessions                   │  │
│  │  - health monitoring               │  │
│  │  - dependency tracking             │  │
│  └────────────────────────────────────┘  │
│                       │                  │
│            REST API + WebSocket          │
└───────────────────────┬──────────────────┘
                        │
         ┌──────────────┴───────────────┐
         ▼                              ▼
    ┌─────────┐                   ┌─────────┐
    │ Web UI  │                   │   CLI   │
    └─────────┘                   └─────────┘
```

## License

MIT - see [LICENSE](LICENSE)
