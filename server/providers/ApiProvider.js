/**
 * ApiProvider - Base class for API-based providers
 *
 * API providers offer completion/chat endpoints for tasks like:
 * - Generating summaries
 * - Verification
 * - Orchestration decisions
 */

import { BaseProvider } from './BaseProvider.js';

export class ApiProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.type = 'api';
    this.capabilities = {
      canSpawnWorkers: false,
      canComplete: true,
      canStream: true,
      canFunctionCall: false,
      ...config.capabilities
    };

    this.apiUrl = config.apiUrl || config.url;
    this.model = config.model;
    this.maxTokens = config.maxTokens || 4096;
    this.temperature = config.temperature || 0.7;
  }

  /**
   * Get authentication headers for API requests
   * @returns {object}
   */
  getAuthHeaders() {
    return {};
  }

  /**
   * Transform a request to the provider's format
   * @param {object} request - Standard request format
   * @param {string} request.prompt - The prompt text
   * @param {string} request.systemPrompt - Optional system prompt
   * @param {number} request.maxTokens - Max tokens to generate
   * @param {number} request.temperature - Sampling temperature
   * @returns {object} Provider-specific request body
   */
  transformRequest(request) {
    throw new Error('Not implemented: transformRequest');
  }

  /**
   * Transform provider response to standard format
   * @param {object} response - Provider response
   * @returns {{response: string, model: string, usage?: object}}
   */
  transformResponse(response) {
    throw new Error('Not implemented: transformResponse');
  }

  /**
   * Get the completion endpoint URL
   * @returns {string}
   */
  getCompletionUrl() {
    throw new Error('Not implemented: getCompletionUrl');
  }

  /**
   * Get the chat endpoint URL (if different from completion)
   * @returns {string}
   */
  getChatUrl() {
    return this.getCompletionUrl();
  }

  /**
   * Make a completion request
   * @param {object} params - Request parameters
   * @returns {Promise<{response: string, model: string, usage?: object}>}
   */
  async complete(params) {
    const url = this.getCompletionUrl();
    const headers = {
      'Content-Type': 'application/json',
      ...this.getAuthHeaders()
    };
    const body = this.transformRequest(params);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return this.transformResponse(data);
    } catch (error) {
      throw new Error(`${this.name} completion failed: ${error.message}`);
    }
  }

  /**
   * Make a streaming completion request
   * @param {object} params - Request parameters
   * @yields {string} Response chunks
   */
  async *streamComplete(params) {
    throw new Error('Not implemented: streamComplete');
  }

  /**
   * Check if the API is healthy
   */
  async checkHealth() {
    try {
      // Try a minimal completion to verify the API works
      // Most providers don't have a dedicated health endpoint
      const headers = {
        'Content-Type': 'application/json',
        ...this.getAuthHeaders()
      };

      // Try to get models list or make a minimal request
      const response = await this._healthCheck(headers);
      return response;
    } catch (error) {
      return {
        available: false,
        error: error.message
      };
    }
  }

  /**
   * Provider-specific health check implementation
   * @protected
   */
  async _healthCheck(headers) {
    throw new Error('Not implemented: _healthCheck');
  }

  /**
   * Check if the provider has valid credentials
   */
  isConfigured() {
    return true; // Override in subclasses
  }
}

export default ApiProvider;
