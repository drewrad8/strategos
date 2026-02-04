# Configuration Reference

Strategos configuration is loaded from multiple sources in order of priority:

1. **Environment variables** (highest priority)
2. **Config file** (`~/.strategos/config/strategos.json`)
3. **Default values** (lowest priority)

## Config File Location

The config file is loaded from:
- `$STRATEGOS_CONFIG` environment variable, or
- `~/.strategos/config/strategos.json` (default)

## Configuration Options

### Core Settings

```json
{
  "version": "1.0.0",
  "port": 38007,
  "projectsRoot": "~/strategos-projects",
  "dataDir": "~/.strategos/data"
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `version` | string | `"1.0.0"` | Config schema version |
| `port` | number | `38007` | Server port |
| `projectsRoot` | string | `~/strategos-projects` | Directory for projects |
| `dataDir` | string | `~/.strategos/data` | Directory for databases, logs |

### Provider Configuration

#### Worker Providers

Worker providers spawn interactive AI agents in tmux sessions.

```json
{
  "providers": {
    "workers": {
      "default": "claude",
      "available": ["claude", "openai", "gemini"],
      "openai": {
        "model": "gpt-4o",
        "maxTokens": 8192
      },
      "gemini": {
        "model": "gemini-2.0-flash",
        "maxTokens": 8192
      }
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `default` | string | `"claude"` | Default worker provider |
| `available` | array | `["claude"]` | Enabled providers |
| `openai.model` | string | `"gpt-4o"` | OpenAI model for workers |
| `gemini.model` | string | `"gemini-2.0-flash"` | Gemini model for workers |

#### API Providers

API providers are used for summaries, verification, and quick completions.

```json
{
  "providers": {
    "api": {
      "default": "ollama",
      "ollama": {
        "url": "http://localhost:11434",
        "model": "qwen3:8b"
      },
      "openai": {
        "model": "gpt-4o-mini"
      },
      "gemini": {
        "model": "gemini-1.5-flash"
      },
      "anthropic": {
        "model": "claude-3-haiku-20240307"
      }
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `default` | string | `"ollama"` | Default API provider |
| `ollama.url` | string | `http://localhost:11434` | Ollama server URL |
| `ollama.model` | string | `"qwen3:8b"` | Ollama model |
| `openai.model` | string | `"gpt-4o-mini"` | OpenAI model for API |
| `gemini.model` | string | `"gemini-1.5-flash"` | Gemini model for API |
| `anthropic.model` | string | `"claude-3-haiku-20240307"` | Anthropic model |

### Feature Flags

```json
{
  "features": {
    "summaries": false,
    "autoAcceptDefault": false,
    "ralphModeDefault": false,
    "maxConcurrentWorkers": 100,
    "workerTimeout": 1800000
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `summaries` | boolean | `false` | Enable AI summaries (requires Ollama) |
| `autoAcceptDefault` | boolean | `false` | Default auto-accept for new workers |
| `ralphModeDefault` | boolean | `false` | Default Ralph mode for new workers |
| `maxConcurrentWorkers` | number | `100` | Maximum concurrent workers |
| `workerTimeout` | number | `1800000` | Worker timeout in ms (30 min) |

## Environment Variables

Environment variables override config file values.

### Core Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port |
| `STRATEGOS_CONFIG` | Path to config file |
| `STRATEGOS_CONFIG_DIR` | Config directory |
| `STRATEGOS_DATA_DIR` | Data directory |
| `STRATEGOS_PROJECTS_ROOT` | Projects directory |
| `LOG_LEVEL` | Log level (`debug`, `info`, etc.) |

### API Keys

Store API keys in `~/.strategos/.env`:

```bash
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...
ANTHROPIC_API_KEY=sk-ant-...
STRATEGOS_API_KEY=your-key  # Optional: API authentication
```

### Provider Variables

| Variable | Description |
|----------|-------------|
| `OLLAMA_URL` | Ollama server URL |
| `SUMMARY_MODEL` | Model for summaries |
| `OPENAI_MODEL` | Override OpenAI model |
| `GEMINI_MODEL` | Override Gemini model |
| `DEFAULT_WORKER_PROVIDER` | Default worker provider |
| `DEFAULT_API_PROVIDER` | Default API provider |

## Example Configurations

### Minimal (Claude Only)

```json
{
  "port": 38007,
  "projectsRoot": "~/projects"
}
```

### With OpenAI

```json
{
  "port": 38007,
  "projectsRoot": "~/projects",
  "providers": {
    "workers": {
      "default": "openai",
      "available": ["claude", "openai"],
      "openai": {
        "model": "gpt-4o"
      }
    }
  }
}
```

### With Local Summaries

```json
{
  "port": 38007,
  "projectsRoot": "~/projects",
  "providers": {
    "api": {
      "default": "ollama",
      "ollama": {
        "url": "http://localhost:11434",
        "model": "llama3:8b"
      }
    }
  },
  "features": {
    "summaries": true
  }
}
```

### Production Setup

```json
{
  "port": 38007,
  "projectsRoot": "/var/strategos/projects",
  "dataDir": "/var/strategos/data",
  "providers": {
    "workers": {
      "default": "claude",
      "available": ["claude", "openai", "gemini"]
    },
    "api": {
      "default": "openai",
      "openai": {
        "model": "gpt-4o-mini"
      }
    }
  },
  "features": {
    "summaries": true,
    "maxConcurrentWorkers": 50
  }
}
```

## Reloading Configuration

The server reads configuration at startup. To apply changes:

```bash
strategos restart
```

Or send SIGHUP to the process:
```bash
kill -HUP $(cat ~/.strategos/data/strategos.pid)
```
