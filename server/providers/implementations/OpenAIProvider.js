/**
 * OpenAIProvider - OpenAI API provider
 *
 * Provides both:
 * 1. API access for completions/chat
 * 2. Worker capability via strategos-agent.js wrapper
 */

import { ApiProvider } from '../ApiProvider.js';
import { CliProvider } from '../CliProvider.js';
import path from 'path';

// API-only provider for completions
export class OpenAIApiProvider extends ApiProvider {
  constructor(config = {}) {
    super({
      id: 'openai',
      name: 'OpenAI',
      apiUrl: config.apiUrl || 'https://api.openai.com/v1',
      model: config.model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      capabilities: {
        canSpawnWorkers: false,
        canComplete: true,
        canStream: true,
        canFunctionCall: true,
        maxTokens: 128000,
        supportsImages: true
      },
      ...config
    });

    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  }

  getAuthHeaders() {
    return {
      'Authorization': `Bearer ${this.apiKey}`
    };
  }

  getCompletionUrl() {
    return `${this.apiUrl}/chat/completions`;
  }

  transformRequest(request) {
    const { prompt, systemPrompt, maxTokens, temperature, messages } = request;

    const apiMessages = [];
    if (systemPrompt) {
      apiMessages.push({ role: 'system', content: systemPrompt });
    }
    if (messages) {
      apiMessages.push(...messages);
    } else {
      apiMessages.push({ role: 'user', content: prompt });
    }

    return {
      model: this.model,
      messages: apiMessages,
      max_tokens: maxTokens || this.maxTokens,
      temperature: temperature ?? this.temperature
    };
  }

  transformResponse(response) {
    const choice = response.choices?.[0];
    return {
      response: choice?.message?.content || '',
      model: response.model,
      usage: {
        promptTokens: response.usage?.prompt_tokens,
        completionTokens: response.usage?.completion_tokens,
        totalTokens: response.usage?.total_tokens
      },
      finishReason: choice?.finish_reason
    };
  }

  async _healthCheck(headers) {
    const response = await fetch(`${this.apiUrl}/models`, {
      headers: {
        ...headers,
        ...this.getAuthHeaders()
      }
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid OpenAI API key');
      }
      throw new Error(`OpenAI API returned ${response.status}`);
    }

    const data = await response.json();
    return {
      available: true,
      modelCount: data.data?.length || 0
    };
  }

  isConfigured() {
    return !!this.apiKey;
  }
}

// CLI wrapper provider for workers
export class OpenAIWorkerProvider extends CliProvider {
  constructor(config = {}) {
    super({
      id: 'openai-worker',
      name: 'OpenAI Worker',
      capabilities: {
        canSpawnWorkers: true,
        canComplete: false,
        canStream: false,
        canFunctionCall: true,
        maxTokens: 128000,
        supportsImages: true
      },
      ...config
    });

    this.model = config.model || process.env.OPENAI_MODEL || 'gpt-4o';
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  }

  getSpawnCommand(options) {
    const binDir = process.env.STRATEGOS_BIN_DIR || path.join(process.cwd(), '..', 'bin');
    const agentPath = path.join(binDir, 'strategos-agent.js');

    return {
      command: 'node',
      args: [agentPath, '--provider', 'openai', '--model', this.model],
      env: {
        OPENAI_API_KEY: this.apiKey
      }
    };
  }

  getContextFileName() {
    return '.strategoscontext';
  }

  generateContextFile(workerContext) {
    const {
      workerId,
      workerLabel,
      projectPath,
      ralphToken,
      strategosApiUrl = 'http://localhost:38007'
    } = workerContext;

    const projectName = projectPath.split('/').pop();

    return `# Strategos Worker Context (OpenAI)

## Your Identity
- **Worker ID:** ${workerId}
- **Label:** ${workerLabel}
- **Project:** ${projectName}
- **Provider:** OpenAI (${this.model})
${ralphToken ? `- **Ralph Token:** ${ralphToken}` : ''}

## Strategos API: ${strategosApiUrl}

### Signal Task Completion
\`\`\`bash
curl -X POST ${strategosApiUrl}/api/ralph/signal/${ralphToken || 'TOKEN'} \\
  -H "Content-Type: application/json" \\
  -d '{"status": "done", "learnings": "Summary"}'
\`\`\`

### Spawn New Worker
\`\`\`bash
curl -X POST ${strategosApiUrl}/api/workers \\
  -H "Content-Type: application/json" \\
  -d '{"projectPath": "${projectPath}", "label": "ROLE: Task", "ralphMode": true}'
\`\`\`

## Available Tools
- read_file: Read file contents
- write_file: Write to a file
- edit_file: Edit a file with search/replace
- bash: Execute shell commands
- list_files: List directory contents

Use these tools to interact with the codebase.
`;
  }

  async checkHealth() {
    // Check API key is set
    if (!this.apiKey) {
      return {
        available: false,
        error: 'OPENAI_API_KEY not set'
      };
    }

    // Check agent script exists
    try {
      const spawnInfo = this.getSpawnCommand({ workingDir: '/tmp' });
      const fs = await import('fs');
      const agentPath = spawnInfo.args[0];

      if (!fs.existsSync(agentPath)) {
        return {
          available: false,
          error: `strategos-agent.js not found at ${agentPath}`
        };
      }

      return {
        available: true,
        model: this.model
      };
    } catch (error) {
      return {
        available: false,
        error: error.message
      };
    }
  }

  isConfigured() {
    return !!this.apiKey;
  }
}

// Export both for different use cases
export { OpenAIApiProvider as OpenAIProvider };
export default OpenAIApiProvider;
