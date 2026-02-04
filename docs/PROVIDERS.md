# Provider Setup Guide

Strategos supports multiple AI providers for different use cases. This guide covers setup for each provider.

## Provider Types

1. **Worker Providers** - Spawn interactive AI agents in tmux sessions
2. **API Providers** - Used for summaries, verification, and quick completions

## Claude (Recommended)

Claude Code is the recommended and default worker provider. It provides the best interactive coding experience.

### Installation

Install the Claude Code CLI:

```bash
# Using npm
npm install -g @anthropic-ai/claude-code

# Or using the official installer
# See: https://github.com/anthropics/claude-code
```

### Configuration

Claude Code uses its own authentication - no API key needed in Strategos config.

```json
{
  "providers": {
    "workers": {
      "default": "claude",
      "available": ["claude"]
    }
  }
}
```

### Usage

```bash
# Default - uses Claude
strategos-worker spawn ~/my-project "IMPL: Add feature"
```

## OpenAI

OpenAI can be used as both a worker provider (via strategos-agent.js wrapper) and API provider.

### Get API Key

1. Go to [platform.openai.com](https://platform.openai.com)
2. Navigate to API Keys
3. Create a new secret key

### Configuration

Add your API key to `~/.strategos/.env`:

```bash
OPENAI_API_KEY=sk-proj-...
```

Configure in `strategos.json`:

```json
{
  "providers": {
    "workers": {
      "available": ["claude", "openai"],
      "openai": {
        "model": "gpt-4o",
        "maxTokens": 8192
      }
    },
    "api": {
      "openai": {
        "model": "gpt-4o-mini"
      }
    }
  }
}
```

### Available Models

**For Workers (interactive agents):**
- `gpt-4o` (recommended) - Best quality
- `gpt-4o-mini` - Faster, cheaper
- `gpt-4-turbo` - Previous generation

**For API (summaries, verification):**
- `gpt-4o-mini` (recommended) - Good balance
- `gpt-3.5-turbo` - Cheapest option

### Usage

```bash
# Spawn OpenAI worker
curl -X POST http://localhost:38007/api/workers \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/path", "provider": "openai"}'
```

## Google Gemini

Gemini provides both worker and API capabilities.

### Get API Key

1. Go to [makersuite.google.com/app/apikey](https://makersuite.google.com/app/apikey)
2. Create a new API key

### Configuration

Add your API key to `~/.strategos/.env`:

```bash
GEMINI_API_KEY=AIza...
```

Configure in `strategos.json`:

```json
{
  "providers": {
    "workers": {
      "available": ["claude", "gemini"],
      "gemini": {
        "model": "gemini-2.0-flash",
        "maxTokens": 8192
      }
    },
    "api": {
      "gemini": {
        "model": "gemini-1.5-flash"
      }
    }
  }
}
```

### Available Models

**For Workers:**
- `gemini-2.0-flash` (recommended) - Latest, best quality
- `gemini-1.5-pro` - Previous generation
- `gemini-1.5-flash` - Fast option

**For API:**
- `gemini-1.5-flash` (recommended) - Fast and cheap
- `gemini-1.5-pro` - Higher quality

### Usage

```bash
# Spawn Gemini worker
curl -X POST http://localhost:38007/api/workers \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/path", "provider": "gemini"}'
```

## Ollama (Local)

Ollama runs models locally on your machine. Great for summaries without API costs.

### Installation

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# Start the server
ollama serve
```

### Pull a Model

```bash
# Recommended for summaries
ollama pull qwen3:8b

# Alternative options
ollama pull llama3:8b
ollama pull codellama:7b
```

### Configuration

```json
{
  "providers": {
    "api": {
      "default": "ollama",
      "ollama": {
        "url": "http://localhost:11434",
        "model": "qwen3:8b"
      }
    }
  },
  "features": {
    "summaries": true
  }
}
```

### Environment Variables

```bash
OLLAMA_URL=http://localhost:11434
SUMMARY_MODEL=qwen3:8b
```

### Usage

Ollama is automatically used for summaries when configured:

```bash
# Get AI summary of worker state
strategos-worker summary <worker-id>

# Or via API
curl http://localhost:38007/api/workers/<id>/summary
```

## Anthropic API

The Anthropic API provider allows direct API calls (not for workers - use Claude Code CLI for that).

### Get API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Navigate to API Keys
3. Create a new key

### Configuration

Add your API key to `~/.strategos/.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

Configure in `strategos.json`:

```json
{
  "providers": {
    "api": {
      "anthropic": {
        "model": "claude-3-haiku-20240307"
      }
    }
  }
}
```

### Available Models

- `claude-3-haiku-20240307` - Fast and cheap
- `claude-3-sonnet-20240229` - Balanced
- `claude-3-opus-20240229` - Highest quality

## Provider Health Check

Check which providers are configured and available:

```bash
# CLI
strategos providers

# API
curl http://localhost:38007/api/providers/health
```

Response:
```json
{
  "workers": {
    "claude": {"available": true, "command": "claude"},
    "openai": {"available": true, "model": "gpt-4o"}
  },
  "api": {
    "ollama": {"available": true, "modelAvailable": true},
    "openai": {"available": true}
  }
}
```

## Switching Providers

### Change Default Worker Provider

```json
{
  "providers": {
    "workers": {
      "default": "openai"
    }
  }
}
```

### Change Default API Provider

```json
{
  "providers": {
    "api": {
      "default": "openai"
    }
  }
}
```

### Per-Request Provider

```bash
# Spawn with specific provider
curl -X POST http://localhost:38007/api/workers \
  -d '{"projectPath": "/path", "provider": "gemini"}'

# API completion with specific provider
curl -X POST http://localhost:38007/api/providers/complete \
  -d '{"prompt": "Hello", "provider": "openai"}'
```

## Troubleshooting

### Claude Code not found

```
Error: Claude Code CLI not found
```

Solution: Install Claude Code CLI from https://github.com/anthropics/claude-code

### OpenAI API key invalid

```
Error: Invalid OpenAI API key
```

Solution: Check your API key in `~/.strategos/.env` and ensure it starts with `sk-`

### Ollama not responding

```
Error: Ollama API unreachable
```

Solution:
1. Start Ollama: `ollama serve`
2. Check URL in config matches Ollama port (default 11434)
3. Pull required model: `ollama pull qwen3:8b`

### Rate limits

If you hit rate limits, consider:
1. Using different models (mini/flash variants)
2. Enabling Ollama for summaries (no rate limits)
3. Reducing concurrent workers
