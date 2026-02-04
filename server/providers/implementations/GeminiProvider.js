/**
 * GeminiProvider - Google Gemini API provider
 *
 * Provides both:
 * 1. API access for completions/chat
 * 2. Worker capability via strategos-agent.js wrapper
 */

import { ApiProvider } from '../ApiProvider.js';
import { CliProvider } from '../CliProvider.js';
import path from 'path';

// API-only provider for completions
export class GeminiApiProvider extends ApiProvider {
  constructor(config = {}) {
    super({
      id: 'gemini',
      name: 'Google Gemini',
      apiUrl: config.apiUrl || 'https://generativelanguage.googleapis.com/v1beta',
      model: config.model || process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      capabilities: {
        canSpawnWorkers: false,
        canComplete: true,
        canStream: true,
        canFunctionCall: true,
        maxTokens: 1000000, // Gemini supports up to 1M context
        supportsImages: true
      },
      ...config
    });

    this.apiKey = config.apiKey || process.env.GEMINI_API_KEY;
  }

  getAuthHeaders() {
    // Gemini uses query param for API key, not header
    return {};
  }

  getCompletionUrl() {
    return `${this.apiUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;
  }

  transformRequest(request) {
    const { prompt, systemPrompt, maxTokens, temperature, messages } = request;

    const contents = [];

    // Add messages if provided
    if (messages) {
      for (const msg of messages) {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : msg.role,
          parts: [{ text: msg.content }]
        });
      }
    } else {
      contents.push({
        role: 'user',
        parts: [{ text: prompt }]
      });
    }

    const body = {
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens || this.maxTokens,
        temperature: temperature ?? this.temperature
      }
    };

    // System instruction (Gemini-specific)
    if (systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: systemPrompt }]
      };
    }

    return body;
  }

  transformResponse(response) {
    const candidate = response.candidates?.[0];
    const content = candidate?.content?.parts?.[0]?.text || '';

    return {
      response: content,
      model: this.model,
      usage: {
        promptTokens: response.usageMetadata?.promptTokenCount,
        completionTokens: response.usageMetadata?.candidatesTokenCount,
        totalTokens: response.usageMetadata?.totalTokenCount
      },
      finishReason: candidate?.finishReason
    };
  }

  async _healthCheck(headers) {
    // List models to verify API key
    const url = `${this.apiUrl}/models?key=${this.apiKey}`;

    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 400 || response.status === 403) {
        throw new Error('Invalid Gemini API key');
      }
      throw new Error(`Gemini API returned ${response.status}`);
    }

    const data = await response.json();
    return {
      available: true,
      modelCount: data.models?.length || 0
    };
  }

  isConfigured() {
    return !!this.apiKey;
  }
}

// CLI wrapper provider for workers
export class GeminiWorkerProvider extends CliProvider {
  constructor(config = {}) {
    super({
      id: 'gemini-worker',
      name: 'Gemini Worker',
      capabilities: {
        canSpawnWorkers: true,
        canComplete: false,
        canStream: false,
        canFunctionCall: true,
        maxTokens: 1000000,
        supportsImages: true
      },
      ...config
    });

    this.model = config.model || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    this.apiKey = config.apiKey || process.env.GEMINI_API_KEY;
  }

  getSpawnCommand(options) {
    const binDir = process.env.STRATEGOS_BIN_DIR || path.join(process.cwd(), '..', 'bin');
    const agentPath = path.join(binDir, 'strategos-agent.js');

    return {
      command: 'node',
      args: [agentPath, '--provider', 'gemini', '--model', this.model],
      env: {
        GEMINI_API_KEY: this.apiKey
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

    return `# Strategos Worker Context (Gemini)

## Your Identity
- **Worker ID:** ${workerId}
- **Label:** ${workerLabel}
- **Project:** ${projectName}
- **Provider:** Google Gemini (${this.model})
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
        error: 'GEMINI_API_KEY not set'
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
export { GeminiApiProvider as GeminiProvider };
export default GeminiApiProvider;
