/**
 * Provider Registry - Manages all AI providers
 *
 * Provides a unified interface for:
 * - Getting worker providers (for spawning interactive agents)
 * - Getting API providers (for completions/summaries)
 * - Health checking all providers
 */

import { getConfig, getSecrets } from '../config.js';

// Provider implementations
import { ClaudeProvider } from './implementations/ClaudeProvider.js';
import { OllamaProvider } from './implementations/OllamaProvider.js';
import { OpenAIApiProvider, OpenAIWorkerProvider } from './implementations/OpenAIProvider.js';
import { GeminiApiProvider, GeminiWorkerProvider } from './implementations/GeminiProvider.js';
import { AnthropicProvider } from './implementations/AnthropicProvider.js';

// Singleton instances
let workerProviders = null;
let apiProviders = null;
let initialized = false;

/**
 * Initialize all providers based on configuration
 */
export function initializeProviders() {
  const config = getConfig();
  const secrets = getSecrets();

  // Worker providers (can spawn interactive agents)
  workerProviders = new Map();

  // Claude - always available if CLI is installed
  workerProviders.set('claude', new ClaudeProvider());

  // OpenAI worker - requires API key
  if (secrets.openaiApiKey) {
    const openaiConfig = config.providers?.workers?.openai || {};
    workerProviders.set('openai', new OpenAIWorkerProvider({
      apiKey: secrets.openaiApiKey,
      model: openaiConfig.model
    }));
  }

  // Gemini worker - requires API key
  if (secrets.geminiApiKey) {
    const geminiConfig = config.providers?.workers?.gemini || {};
    workerProviders.set('gemini', new GeminiWorkerProvider({
      apiKey: secrets.geminiApiKey,
      model: geminiConfig.model
    }));
  }

  // API providers (for completions, summaries, etc.)
  apiProviders = new Map();

  // Ollama - local, no auth needed
  const ollamaConfig = config.providers?.api?.ollama || {};
  apiProviders.set('ollama', new OllamaProvider({
    url: ollamaConfig.url,
    model: ollamaConfig.model
  }));

  // OpenAI API
  if (secrets.openaiApiKey) {
    const openaiConfig = config.providers?.api?.openai || {};
    apiProviders.set('openai', new OpenAIApiProvider({
      apiKey: secrets.openaiApiKey,
      model: openaiConfig.model
    }));
  }

  // Gemini API
  if (secrets.geminiApiKey) {
    const geminiConfig = config.providers?.api?.gemini || {};
    apiProviders.set('gemini', new GeminiApiProvider({
      apiKey: secrets.geminiApiKey,
      model: geminiConfig.model
    }));
  }

  // Anthropic API
  if (secrets.anthropicApiKey) {
    const anthropicConfig = config.providers?.api?.anthropic || {};
    apiProviders.set('anthropic', new AnthropicProvider({
      apiKey: secrets.anthropicApiKey,
      model: anthropicConfig.model
    }));
  }

  initialized = true;
  console.log(`[Providers] Initialized ${workerProviders.size} worker providers, ${apiProviders.size} API providers`);

  return { workerProviders, apiProviders };
}

/**
 * Ensure providers are initialized
 */
function ensureInitialized() {
  if (!initialized) {
    initializeProviders();
  }
}

/**
 * Get the default worker provider
 */
export function getDefaultWorkerProvider() {
  ensureInitialized();
  const config = getConfig();
  const defaultId = config.providers?.workers?.default || 'claude';

  if (workerProviders.has(defaultId)) {
    return workerProviders.get(defaultId);
  }

  // Fallback to claude
  return workerProviders.get('claude');
}

/**
 * Get a specific worker provider by ID
 */
export function getWorkerProvider(providerId) {
  ensureInitialized();
  return workerProviders.get(providerId);
}

/**
 * Get all worker providers
 */
export function getWorkerProviders() {
  ensureInitialized();
  return workerProviders;
}

/**
 * Get the default API provider
 */
export function getDefaultApiProvider() {
  ensureInitialized();
  const config = getConfig();
  const defaultId = config.providers?.api?.default || 'ollama';

  if (apiProviders.has(defaultId)) {
    return apiProviders.get(defaultId);
  }

  // Fallback to first available
  const first = apiProviders.values().next();
  return first.done ? null : first.value;
}

/**
 * Get a specific API provider by ID
 */
export function getApiProvider(providerId) {
  ensureInitialized();
  return apiProviders.get(providerId);
}

/**
 * Get all API providers
 */
export function getApiProviders() {
  ensureInitialized();
  return apiProviders;
}

/**
 * Health check all providers
 */
export async function checkAllProviders() {
  ensureInitialized();

  const results = {
    workers: {},
    api: {},
    timestamp: new Date().toISOString()
  };

  // Check worker providers in parallel
  const workerChecks = Array.from(workerProviders.entries()).map(async ([id, provider]) => {
    try {
      const health = await provider.checkHealth();
      results.workers[id] = health;
    } catch (error) {
      results.workers[id] = { available: false, error: error.message };
    }
  });

  // Check API providers in parallel
  const apiChecks = Array.from(apiProviders.entries()).map(async ([id, provider]) => {
    try {
      const health = await provider.checkHealth();
      results.api[id] = health;
    } catch (error) {
      results.api[id] = { available: false, error: error.message };
    }
  });

  await Promise.all([...workerChecks, ...apiChecks]);

  return results;
}

/**
 * Get provider info for API response
 */
export function getProvidersInfo() {
  ensureInitialized();
  const config = getConfig();

  return {
    workers: {
      default: config.providers?.workers?.default || 'claude',
      available: Array.from(workerProviders.entries()).map(([id, p]) => ({
        id,
        ...p.toJSON()
      }))
    },
    api: {
      default: config.providers?.api?.default || 'ollama',
      available: Array.from(apiProviders.entries()).map(([id, p]) => ({
        id,
        ...p.toJSON()
      }))
    }
  };
}

/**
 * Make a completion request using the default or specified API provider
 */
export async function complete(params, providerId = null) {
  const provider = providerId ? getApiProvider(providerId) : getDefaultApiProvider();

  if (!provider) {
    throw new Error(`No API provider available${providerId ? `: ${providerId}` : ''}`);
  }

  return provider.complete(params);
}

/**
 * Make a streaming completion request
 */
export async function* streamComplete(params, providerId = null) {
  const provider = providerId ? getApiProvider(providerId) : getDefaultApiProvider();

  if (!provider) {
    throw new Error(`No API provider available${providerId ? `: ${providerId}` : ''}`);
  }

  yield* provider.streamComplete(params);
}

// Re-export base classes for extension
export { BaseProvider } from './BaseProvider.js';
export { CliProvider } from './CliProvider.js';
export { ApiProvider } from './ApiProvider.js';

// Re-export implementations
export { ClaudeProvider } from './implementations/ClaudeProvider.js';
export { OllamaProvider } from './implementations/OllamaProvider.js';
export { OpenAIApiProvider, OpenAIWorkerProvider } from './implementations/OpenAIProvider.js';
export { GeminiApiProvider, GeminiWorkerProvider } from './implementations/GeminiProvider.js';
export { AnthropicProvider } from './implementations/AnthropicProvider.js';
