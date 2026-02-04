/**
 * Strategos Configuration Loader
 *
 * Loads configuration from:
 * 1. Default values
 * 2. Config file (~/.strategos/config/strategos.json)
 * 3. Environment variables (highest priority)
 * 4. .env file (~/.strategos/.env) for secrets
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// Default configuration
const DEFAULT_CONFIG = {
  version: '1.0.0',
  port: 38007,
  projectsRoot: path.join(os.homedir(), 'strategos-projects'),
  dataDir: path.join(os.homedir(), '.strategos', 'data'),

  providers: {
    workers: {
      default: 'claude',
      available: ['claude', 'openai', 'gemini'],
      openai: {
        model: 'gpt-4o',
        maxTokens: 8192
      },
      gemini: {
        model: 'gemini-2.0-flash',
        maxTokens: 8192
      }
    },
    api: {
      default: 'ollama',
      ollama: {
        url: 'http://localhost:11434',
        model: 'qwen3:8b'
      },
      openai: {
        model: 'gpt-4o-mini'
      },
      gemini: {
        model: 'gemini-1.5-flash'
      },
      anthropic: {
        model: 'claude-3-haiku-20240307'
      }
    }
  },

  features: {
    summaries: false,           // Disabled by default - requires Ollama
    autoAcceptDefault: false,   // Workers don't auto-accept by default
    ralphModeDefault: false,    // Ralph mode disabled by default
    maxConcurrentWorkers: 100,
    workerTimeout: 30 * 60 * 1000, // 30 minutes
  }
};

let config = null;
let configPath = null;
let envPath = null;

/**
 * Get the configuration directory path
 */
export function getConfigDir() {
  return process.env.STRATEGOS_CONFIG_DIR || path.join(os.homedir(), '.strategos', 'config');
}

/**
 * Get the data directory path
 */
export function getDataDir() {
  return config?.dataDir || process.env.STRATEGOS_DATA_DIR || path.join(os.homedir(), '.strategos', 'data');
}

/**
 * Load .env file for secrets
 */
function loadEnvFile(envFilePath) {
  if (!fs.existsSync(envFilePath)) {
    return {};
  }

  const envVars = {};
  const content = fs.readFileSync(envFilePath, 'utf-8');

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    envVars[key] = value;
  }

  return envVars;
}

/**
 * Deep merge two objects
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Load configuration from all sources
 */
export function loadConfig(options = {}) {
  const { reload = false } = options;

  if (config && !reload) {
    return config;
  }

  // Start with defaults
  let mergedConfig = { ...DEFAULT_CONFIG };

  // Determine config file path
  configPath = process.env.STRATEGOS_CONFIG ||
    path.join(getConfigDir(), 'strategos.json');

  // Load config file if it exists
  if (fs.existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      mergedConfig = deepMerge(mergedConfig, fileConfig);
      console.log(`[Config] Loaded configuration from ${configPath}`);
    } catch (error) {
      console.warn(`[Config] Failed to load config file: ${error.message}`);
    }
  } else {
    console.log(`[Config] No config file found at ${configPath}, using defaults`);
  }

  // Load .env file for secrets
  envPath = path.join(path.dirname(configPath), '..', '.env');
  const envVars = loadEnvFile(envPath);

  // Set environment variables from .env (don't override existing)
  for (const [key, value] of Object.entries(envVars)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  // Apply environment variable overrides
  if (process.env.PORT) {
    mergedConfig.port = parseInt(process.env.PORT, 10);
  }
  if (process.env.STRATEGOS_PROJECTS_ROOT) {
    mergedConfig.projectsRoot = process.env.STRATEGOS_PROJECTS_ROOT;
  }
  if (process.env.STRATEGOS_DATA_DIR) {
    mergedConfig.dataDir = process.env.STRATEGOS_DATA_DIR;
  }
  if (process.env.ENABLE_OLLAMA_SUMMARIES) {
    mergedConfig.features.summaries = process.env.ENABLE_OLLAMA_SUMMARIES === 'true';
  }

  // Provider-specific environment overrides
  if (process.env.OLLAMA_URL) {
    mergedConfig.providers.api.ollama.url = process.env.OLLAMA_URL;
  }
  if (process.env.SUMMARY_MODEL) {
    mergedConfig.providers.api.ollama.model = process.env.SUMMARY_MODEL;
  }
  if (process.env.OPENAI_MODEL) {
    mergedConfig.providers.workers.openai.model = process.env.OPENAI_MODEL;
    mergedConfig.providers.api.openai.model = process.env.OPENAI_MODEL;
  }
  if (process.env.GEMINI_MODEL) {
    mergedConfig.providers.workers.gemini.model = process.env.GEMINI_MODEL;
    mergedConfig.providers.api.gemini.model = process.env.GEMINI_MODEL;
  }

  // Default worker provider
  if (process.env.DEFAULT_WORKER_PROVIDER) {
    mergedConfig.providers.workers.default = process.env.DEFAULT_WORKER_PROVIDER;
  }

  // Default API provider
  if (process.env.DEFAULT_API_PROVIDER) {
    mergedConfig.providers.api.default = process.env.DEFAULT_API_PROVIDER;
  }

  // Expand ~ in paths
  if (mergedConfig.projectsRoot.startsWith('~')) {
    mergedConfig.projectsRoot = path.join(os.homedir(), mergedConfig.projectsRoot.slice(1));
  }
  if (mergedConfig.dataDir.startsWith('~')) {
    mergedConfig.dataDir = path.join(os.homedir(), mergedConfig.dataDir.slice(1));
  }

  config = mergedConfig;
  return config;
}

/**
 * Get the current configuration
 */
export function getConfig() {
  if (!config) {
    return loadConfig();
  }
  return config;
}

/**
 * Get a specific config value by path (e.g., 'providers.workers.default')
 */
export function getConfigValue(keyPath, defaultValue = undefined) {
  const cfg = getConfig();
  const parts = keyPath.split('.');

  let value = cfg;
  for (const part of parts) {
    if (value === undefined || value === null) {
      return defaultValue;
    }
    value = value[part];
  }

  return value !== undefined ? value : defaultValue;
}

/**
 * Check if a provider is configured and available
 */
export function isProviderAvailable(providerType, providerName) {
  const cfg = getConfig();

  if (providerType === 'worker') {
    return cfg.providers.workers.available.includes(providerName);
  }

  if (providerType === 'api') {
    return providerName in cfg.providers.api;
  }

  return false;
}

/**
 * Get secrets (API keys) from environment
 */
export function getSecrets() {
  return {
    openaiApiKey: process.env.OPENAI_API_KEY || null,
    geminiApiKey: process.env.GEMINI_API_KEY || null,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    strategosApiKey: process.env.STRATEGOS_API_KEY || null
  };
}

/**
 * Check which providers have valid credentials
 */
export function getAvailableProviders() {
  const secrets = getSecrets();
  const cfg = getConfig();

  const available = {
    workers: [],
    api: []
  };

  // Claude is always available if installed (no API key needed for CLI)
  available.workers.push('claude');

  // OpenAI - requires API key
  if (secrets.openaiApiKey) {
    available.workers.push('openai');
    available.api.push('openai');
  }

  // Gemini - requires API key
  if (secrets.geminiApiKey) {
    available.workers.push('gemini');
    available.api.push('gemini');
  }

  // Anthropic API - requires API key (for API calls, not CLI)
  if (secrets.anthropicApiKey) {
    available.api.push('anthropic');
  }

  // Ollama - check if URL is configured (no auth needed)
  if (cfg.providers.api.ollama?.url) {
    available.api.push('ollama');
  }

  return available;
}

/**
 * Get the projects root directory
 */
export function getProjectsRoot() {
  return getConfig().projectsRoot;
}

/**
 * Save current config to file (for installer use)
 */
export function saveConfig(configToSave) {
  const savePath = configPath || path.join(getConfigDir(), 'strategos.json');

  // Ensure directory exists
  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(savePath, JSON.stringify(configToSave, null, 2));
  console.log(`[Config] Saved configuration to ${savePath}`);

  // Reload config
  config = null;
  return loadConfig();
}

export { DEFAULT_CONFIG };
