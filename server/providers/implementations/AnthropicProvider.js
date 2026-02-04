/**
 * AnthropicProvider - Anthropic API provider (for API-based Claude calls)
 *
 * Note: This is for direct API access, not the Claude Code CLI.
 * Use ClaudeProvider for interactive worker sessions.
 */

import { ApiProvider } from '../ApiProvider.js';

export class AnthropicProvider extends ApiProvider {
  constructor(config = {}) {
    super({
      id: 'anthropic',
      name: 'Anthropic Claude',
      apiUrl: config.apiUrl || 'https://api.anthropic.com',
      model: config.model || process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
      capabilities: {
        canSpawnWorkers: false, // Use ClaudeProvider for workers
        canComplete: true,
        canStream: true,
        canFunctionCall: true,
        maxTokens: 200000,
        supportsImages: true
      },
      ...config
    });

    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    this.apiVersion = config.apiVersion || '2023-06-01';
  }

  getAuthHeaders() {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': this.apiVersion
    };
  }

  getCompletionUrl() {
    return `${this.apiUrl}/v1/messages`;
  }

  transformRequest(request) {
    const { prompt, systemPrompt, maxTokens, temperature, messages } = request;

    const apiMessages = [];
    if (messages) {
      apiMessages.push(...messages.map(m => ({
        role: m.role,
        content: m.content
      })));
    } else {
      apiMessages.push({ role: 'user', content: prompt });
    }

    const body = {
      model: this.model,
      max_tokens: maxTokens || 4096,
      messages: apiMessages
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (temperature !== undefined) {
      body.temperature = temperature;
    }

    return body;
  }

  transformResponse(response) {
    const content = response.content?.[0];

    return {
      response: content?.text || '',
      model: response.model,
      usage: {
        promptTokens: response.usage?.input_tokens,
        completionTokens: response.usage?.output_tokens
      },
      stopReason: response.stop_reason
    };
  }

  async _healthCheck(headers) {
    // Anthropic doesn't have a models list endpoint, so we just verify the key works
    // by checking if we get an auth error
    try {
      const response = await fetch(this.getCompletionUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.getAuthHeaders()
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }]
        })
      });

      // Even an error response (other than auth) means the key works
      if (response.status === 401 || response.status === 403) {
        throw new Error('Invalid Anthropic API key');
      }

      return {
        available: true,
        model: this.model
      };
    } catch (error) {
      if (error.message.includes('Invalid')) {
        throw error;
      }
      // Network errors etc
      throw new Error(`Anthropic API unreachable: ${error.message}`);
    }
  }

  isConfigured() {
    return !!this.apiKey;
  }
}

export default AnthropicProvider;
