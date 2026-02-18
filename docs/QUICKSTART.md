# Quick Start Guide

Get Strategos running in 5 minutes.

## 1. Installation

```bash
# Clone the repository
git clone https://github.com/drewrad8/strategos.git
cd strategos

# Run the installer
./install.sh
```

Follow the prompts to configure your installation.

## 2. Start the Server

```bash
strategos start
```

Or if you didn't add to PATH:
```bash
~/.strategos/bin/strategos start
```

## 3. Open the Web UI

Open your browser to: **http://localhost:38007**

You'll see the Strategos dashboard where you can:
- View all active workers
- Spawn new workers
- Monitor worker output in real-time
- Send instructions to workers

## 4. Spawn Your First Worker

### Using the Web UI

1. Click "New Worker"
2. Select a project directory
3. Enter a label like `IMPL: Add login page`
4. Click "Spawn"

### Using the CLI

```bash
# Create a test project
mkdir -p ~/strategos-projects/my-app
cd ~/strategos-projects/my-app
git init
echo "# My App" > README.md

# Spawn a worker
strategos-worker spawn ~/strategos-projects/my-app "IMPL: Create basic Express server"
```

### Using the API

```bash
curl -X POST http://localhost:38007/api/workers \
  -H "Content-Type: application/json" \
  -d '{
    "projectPath": "/home/user/strategos-projects/my-app",
    "label": "IMPL: Create basic Express server",
    "autoAccept": true
  }'
```

## 5. Monitor Your Worker

### Watch Output

```bash
# Get the worker ID from the spawn response
strategos-worker output <worker-id> --follow
```

### Send Instructions

```bash
strategos-worker send <worker-id> "Add error handling to all routes"
```

### Get AI Summary

```bash
strategos-worker summary <worker-id>
```

## 6. Worker Coordination

Workers can spawn other workers. For complex tasks, use a `GENERAL:` worker:

```bash
strategos-worker spawn ~/my-project "GENERAL: Build user authentication system"
```

The GENERAL worker will:
1. Analyze the task
2. Break it into subtasks
3. Spawn specialized workers (IMPL, TEST, etc.)
4. Coordinate their work
5. Report when complete

## Tips

### Auto-Accept Mode

Enable auto-accept to let workers automatically approve prompts:

```bash
curl -X POST http://localhost:38007/api/workers/<id>/settings \
  -H "Content-Type: application/json" \
  -d '{"autoAccept": true}'
```

### Ralph Mode

Enable Ralph mode so workers can signal when they're done:

```bash
curl -X POST http://localhost:38007/api/workers/<id>/settings \
  -H "Content-Type: application/json" \
  -d '{"ralphMode": true}'
```

Workers will then call the Ralph API when finished:
```bash
curl -X POST http://localhost:38007/api/ralph/signal/<token> \
  -H "Content-Type: application/json" \
  -d '{"status": "done", "learnings": "Completed authentication module"}'
```

### Using Different Providers

Spawn workers with different AI providers:

```bash
# OpenAI worker (requires OPENAI_API_KEY)
curl -X POST http://localhost:38007/api/workers \
  -d '{"projectPath": "/path", "provider": "openai"}'

# Gemini worker (requires GEMINI_API_KEY)
curl -X POST http://localhost:38007/api/workers \
  -d '{"projectPath": "/path", "provider": "gemini"}'
```

## Next Steps

- Read [Configuration Reference](CONFIGURATION.md) for all options
- See [Provider Setup](PROVIDERS.md) for detailed provider configuration
- Check out the example workflows in the web UI
