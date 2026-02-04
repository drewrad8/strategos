/**
 * BaseProvider - Abstract base class for all AI providers
 *
 * Providers are divided into two types:
 * 1. Worker Providers - Can spawn interactive agents in tmux sessions
 * 2. API Providers - Provide completion/chat APIs for summaries, verification, etc.
 *
 * Some providers (like OpenAI, Gemini) can do both.
 */

export class BaseProvider {
  constructor(config) {
    this.id = config.id;
    this.name = config.name || config.id;
    this.config = config;
    this.type = config.type || 'unknown';
    this.capabilities = config.capabilities || {};
  }

  /**
   * Check if the provider is healthy and available
   * @returns {Promise<{available: boolean, error?: string, details?: object}>}
   */
  async checkHealth() {
    throw new Error('Not implemented: checkHealth');
  }

  /**
   * Get provider capabilities
   * @returns {object} Capability flags
   */
  getCapabilities() {
    return {
      canSpawnWorkers: false,
      canComplete: false,
      canStream: false,
      canFunctionCall: false,
      maxTokens: 4096,
      supportsImages: false,
      ...this.capabilities
    };
  }

  /**
   * Get provider metadata for API responses
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      capabilities: this.getCapabilities(),
      configured: this.isConfigured()
    };
  }

  /**
   * Check if the provider is properly configured
   */
  isConfigured() {
    return true; // Override in subclasses that need auth
  }

  /**
   * Get provider-specific configuration
   */
  getConfig() {
    return this.config;
  }
}

export default BaseProvider;
