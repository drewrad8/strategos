/**
 * CliProvider - Base class for CLI-based worker providers
 *
 * CLI providers spawn interactive agent processes in tmux sessions.
 * Examples: Claude Code CLI, Ollama CLI, custom agent wrappers
 */

import { BaseProvider } from './BaseProvider.js';

export class CliProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.type = 'cli';
    this.capabilities = {
      canSpawnWorkers: true,
      canComplete: false,
      canStream: false,
      canFunctionCall: false,
      ...config.capabilities
    };
  }

  /**
   * Get the command to spawn the worker process
   * @param {object} options - Spawn options
   * @param {string} options.workingDir - Working directory for the worker
   * @param {string} options.workerId - Unique worker ID
   * @param {string} options.label - Worker label
   * @returns {{command: string, args: string[], env: object}}
   */
  getSpawnCommand(options) {
    throw new Error('Not implemented: getSpawnCommand');
  }

  /**
   * Get patterns that trigger auto-accept (y/n prompts)
   * @returns {RegExp[]}
   */
  getAutoAcceptPatterns() {
    return [
      /\[Y\/n\]/i,
      /\[y\/N\]/i,
      /\(Y\)es/i,
      /Do you want to proceed/i,
      /Do you want to make this edit/i,
      /Do you want to create/i,
      /Do you want to overwrite/i,
      /Allow (this|once|always)/i,
      /Yes.*to (allow|proceed|continue)/i,
      /Press Enter to continue/i,
      /Do you want to (run|execute|allow)/i,
    ];
  }

  /**
   * Get keywords that should pause auto-accept (need human decision)
   * @returns {string[]}
   */
  getAutoAcceptPauseKeywords() {
    return [
      'plan mode',
      'ExitPlanMode',
      'AskUserQuestion',
      'EnterPlanMode',
    ];
  }

  /**
   * Generate context file content for the worker
   * @param {object} workerContext - Worker context information
   * @param {string} workerContext.workerId - Worker ID
   * @param {string} workerContext.workerLabel - Worker label
   * @param {string} workerContext.projectPath - Project directory
   * @param {string} workerContext.ralphToken - Optional Ralph completion token
   * @param {string} workerContext.strategosApiUrl - Strategos API URL
   * @returns {string} Context file content
   */
  generateContextFile(workerContext) {
    throw new Error('Not implemented: generateContextFile');
  }

  /**
   * Get the context file name (e.g., '.claudecontext')
   * @returns {string}
   */
  getContextFileName() {
    return '.strategoscontext';
  }

  /**
   * Get the initialization delay (ms) before sending the prompt
   * Some CLIs need time to initialize before accepting input
   * @returns {number}
   */
  getInitDelay() {
    return 3000;
  }

  /**
   * Check if the CLI tool is installed and available
   */
  async checkHealth() {
    const spawnInfo = this.getSpawnCommand({ workingDir: '/tmp', workerId: 'test', label: 'test' });
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      await execAsync(`which ${spawnInfo.command}`);
      return {
        available: true,
        command: spawnInfo.command,
        details: { path: spawnInfo.command }
      };
    } catch (error) {
      return {
        available: false,
        error: `${spawnInfo.command} not found in PATH`,
        command: spawnInfo.command
      };
    }
  }
}

export default CliProvider;
