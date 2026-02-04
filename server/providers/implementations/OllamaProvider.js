/**
 * OllamaProvider - Ollama API provider
 *
 * Provides local LLM access for summaries, verification, and other tasks.
 * Ollama runs locally and doesn't require API keys.
 */

import { ApiProvider } from '../ApiProvider.js';

export class OllamaProvider extends ApiProvider {
  constructor(config = {}) {
    super({
      id: 'ollama',
      name: 'Ollama',
      apiUrl: config.url || process.env.OLLAMA_URL || 'http://localhost:11434',
      model: config.model || process.env.SUMMARY_MODEL || 'qwen3:8b',
      capabilities: {
        canSpawnWorkers: false,
        canComplete: true,
        canStream: true,
        canFunctionCall: false,
        maxTokens: 32768,
        supportsImages: false
      },
      ...config
    });
  }

  /**
   * No auth needed for local Ollama
   */
  getAuthHeaders() {
    return {};
  }

  /**
   * Get completion endpoint
   */
  getCompletionUrl() {
    return `${this.apiUrl}/api/generate`;
  }

  /**
   * Get chat endpoint
   */
  getChatUrl() {
    return `${this.apiUrl}/api/chat`;
  }

  /**
   * Transform request to Ollama format
   */
  transformRequest(request) {
    const { prompt, systemPrompt, maxTokens, temperature } = request;

    // For generate endpoint
    if (!request.messages) {
      return {
        model: this.model,
        prompt: systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
        stream: false,
        options: {
          num_predict: maxTokens || this.maxTokens,
          temperature: temperature ?? this.temperature
        }
      };
    }

    // For chat endpoint
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    if (request.messages) {
      messages.push(...request.messages);
    } else {
      messages.push({ role: 'user', content: prompt });
    }

    return {
      model: this.model,
      messages,
      stream: false,
      options: {
        num_predict: maxTokens || this.maxTokens,
        temperature: temperature ?? this.temperature
      }
    };
  }

  /**
   * Transform Ollama response to standard format
   */
  transformResponse(response) {
    // Generate endpoint response
    if (response.response !== undefined) {
      return {
        response: response.response,
        model: response.model,
        usage: {
          promptTokens: response.prompt_eval_count,
          completionTokens: response.eval_count,
          totalDuration: response.total_duration
        }
      };
    }

    // Chat endpoint response
    return {
      response: response.message?.content || '',
      model: response.model,
      usage: {
        promptTokens: response.prompt_eval_count,
        completionTokens: response.eval_count,
        totalDuration: response.total_duration
      }
    };
  }

  /**
   * Make completion with support for both generate and chat endpoints
   */
  async complete(params) {
    const useChat = params.messages || params.systemPrompt;
    const url = useChat ? this.getChatUrl() : this.getCompletionUrl();
    const body = this.transformRequest(params);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return this.transformResponse(data);
    } catch (error) {
      throw new Error(`Ollama completion failed: ${error.message}`);
    }
  }

  /**
   * Streaming completion
   */
  async *streamComplete(params) {
    const useChat = params.messages || params.systemPrompt;
    const url = useChat ? this.getChatUrl() : this.getCompletionUrl();
    const body = {
      ...this.transformRequest(params),
      stream: true
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        throw new Error(`Ollama API error ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            const text = data.response || data.message?.content || '';
            if (text) {
              yield text;
            }
          } catch {
            // Skip invalid JSON lines
          }
        }
      }
    } catch (error) {
      throw new Error(`Ollama streaming failed: ${error.message}`);
    }
  }

  /**
   * Health check - get list of models
   */
  async _healthCheck(headers) {
    const response = await fetch(`${this.apiUrl}/api/tags`, {
      headers
    });

    if (!response.ok) {
      throw new Error(`Ollama API returned ${response.status}`);
    }

    const data = await response.json();
    const models = data.models || [];
    const hasConfiguredModel = models.some(m =>
      m.name === this.model || m.name.startsWith(this.model.split(':')[0])
    );

    return {
      available: true,
      modelAvailable: hasConfiguredModel,
      configuredModel: this.model,
      availableModels: models.map(m => m.name)
    };
  }

  /**
   * Always configured (no auth needed)
   */
  isConfigured() {
    return true;
  }
}

export default OllamaProvider;
