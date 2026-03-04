#!/usr/bin/env node

/**
 * Thea-CC CLI - Control Claude Code workers from the command line
 *
 * Usage:
 *   thea-cc start <project> [--label "Label"]
 *   thea-cc list
 *   thea-cc stop <worker-id>
 */

const SERVER_URL = process.env.THEA_SERVER_URL || 'http://localhost:38007';
const API_KEY = process.env.STRATEGOS_API_KEY || '';

async function api(method, endpoint, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }

  const options = { method, headers };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${SERVER_URL}/api${endpoint}`, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

function printUsage() {
  console.log(`
Thea-CC - Claude Code Worker Manager

Usage:
  thea-cc start <project>              Start worker in /thea/<project>
  thea-cc start <project> --label "X"  Start worker with custom label
  thea-cc list                         List all running workers
  thea-cc stop <worker-id>             Stop a worker by ID

Examples:
  thea-cc start finance
  thea-cc start oracle --label "API Development"
  thea-cc list
  thea-cc stop abc123

Environment:
  THEA_SERVER_URL      Server URL (default: http://localhost:38007)
  STRATEGOS_API_KEY    API key for authentication (optional)
`);
}

async function startWorker(args) {
  if (args.length < 1) {
    console.error('Error: project name required');
    console.error('Usage: thea-cc start <project> [--label "Label"]');
    process.exit(1);
  }

  const projectPath = args[0];
  let label = null;

  // Parse --label flag
  const labelIdx = args.indexOf('--label');
  if (labelIdx !== -1 && args[labelIdx + 1]) {
    label = args[labelIdx + 1];
  }

  try {
    console.log(`Starting worker for ${projectPath}...`);
    const worker = await api('POST', '/workers', { projectPath, label });

    console.log(`\nWorker started successfully!`);
    console.log(`  ID:      ${worker.id}`);
    console.log(`  Label:   ${worker.label}`);
    console.log(`  Project: ${worker.project}`);
    console.log(`  Path:    ${worker.workingDir}`);
    console.log(`  Session: ${worker.tmuxSession}`);
    console.log(`\nAttach with: tmux attach -t ${worker.tmuxSession}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

async function listWorkers() {
  try {
    const workers = await api('GET', '/workers');

    if (workers.length === 0) {
      console.log('No active workers');
      return;
    }

    console.log(`\nActive Workers (${workers.length}):`);
    console.log('─'.repeat(70));

    for (const worker of workers) {
      const status = worker.status === 'running' ? '\x1b[32m●\x1b[0m' : '\x1b[31m●\x1b[0m';
      console.log(`${status} ${worker.id}  ${worker.label.padEnd(20)}  ${worker.project.padEnd(15)}  ${worker.status}`);
    }

    console.log('─'.repeat(70));
    console.log('\nStop with: thea-cc stop <worker-id>');
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

async function stopWorker(args) {
  if (args.length < 1) {
    console.error('Error: worker ID required');
    console.error('Usage: thea-cc stop <worker-id>');
    process.exit(1);
  }

  const workerId = args[0];

  try {
    console.log(`Stopping worker ${workerId}...`);
    await api('DELETE', `/workers/${workerId}`);
    console.log('Worker stopped successfully');
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  switch (command) {
    case 'start':
      await startWorker(commandArgs);
      break;
    case 'list':
      await listWorkers();
      break;
    case 'stop':
      await stopWorker(commandArgs);
      break;
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
