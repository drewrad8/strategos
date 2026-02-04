#!/usr/bin/env node

/**
 * Strategos Agent - Unified CLI agent wrapper for OpenAI/Gemini workers
 *
 * Provides interactive agent capabilities via API-based providers:
 * - Interactive terminal I/O (readline + streaming output)
 * - Tool/function calling for file operations (read, write, edit, bash)
 * - Provider selection via --provider flag
 * - Model selection via --model flag
 * - Context file loading
 * - Graceful handling of rate limits and errors
 *
 * Usage:
 *   node strategos-agent.js --provider openai --model gpt-4o
 *   node strategos-agent.js --provider gemini --model gemini-2.0-flash
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// Parse command line arguments
const args = process.argv.slice(2);
let provider = 'openai';
let model = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--provider' && args[i + 1]) {
    provider = args[i + 1];
    i++;
  } else if (args[i] === '--model' && args[i + 1]) {
    model = args[i + 1];
    i++;
  }
}

// Default models per provider
const defaultModels = {
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash'
};

model = model || defaultModels[provider] || 'gpt-4o';

// API configuration
const apiConfig = {
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    apiKey: process.env.OPENAI_API_KEY,
    getHeaders: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    })
  },
  gemini: {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    apiKey: process.env.GEMINI_API_KEY,
    getHeaders: () => ({
      'Content-Type': 'application/json'
    }),
    getUrl: (key) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`
  }
};

// Tool definitions for function calling
const tools = {
  read_file: {
    description: 'Read the contents of a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' }
      },
      required: ['path']
    },
    execute: async (params) => {
      try {
        const content = fs.readFileSync(params.path, 'utf-8');
        return { success: true, content };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  write_file: {
    description: 'Write content to a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Content to write' }
      },
      required: ['path', 'content']
    },
    execute: async (params) => {
      try {
        const dir = path.dirname(params.path);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(params.path, params.content);
        return { success: true, message: `Wrote ${params.content.length} bytes to ${params.path}` };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  edit_file: {
    description: 'Edit a file by replacing old_string with new_string',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to edit' },
        old_string: { type: 'string', description: 'String to find and replace' },
        new_string: { type: 'string', description: 'Replacement string' }
      },
      required: ['path', 'old_string', 'new_string']
    },
    execute: async (params) => {
      try {
        let content = fs.readFileSync(params.path, 'utf-8');
        if (!content.includes(params.old_string)) {
          return { success: false, error: 'old_string not found in file' };
        }
        content = content.replace(params.old_string, params.new_string);
        fs.writeFileSync(params.path, content);
        return { success: true, message: `Edited ${params.path}` };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  },

  bash: {
    description: 'Execute a bash command',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' }
      },
      required: ['command']
    },
    execute: async (params) => {
      return new Promise((resolve) => {
        const proc = spawn('bash', ['-c', params.command], {
          cwd: process.cwd(),
          timeout: 60000
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
          process.stdout.write(data);
        });

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
          process.stderr.write(data);
        });

        proc.on('close', (code) => {
          resolve({
            success: code === 0,
            stdout,
            stderr,
            exitCode: code
          });
        });

        proc.on('error', (error) => {
          resolve({
            success: false,
            error: error.message
          });
        });
      });
    }
  },

  list_files: {
    description: 'List files in a directory',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path' },
        pattern: { type: 'string', description: 'Optional glob pattern' }
      },
      required: ['path']
    },
    execute: async (params) => {
      try {
        const dirPath = params.path || '.';
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const files = entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file'
        }));
        return { success: true, files };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  }
};

// Convert tools to OpenAI format
function getOpenAITools() {
  return Object.entries(tools).map(([name, tool]) => ({
    type: 'function',
    function: {
      name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

// Convert tools to Gemini format
function getGeminiTools() {
  return [{
    functionDeclarations: Object.entries(tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      parameters: tool.parameters
    }))
  }];
}

// Conversation history
const messages = [];

// System prompt
const systemPrompt = `You are a helpful AI coding assistant running as a Strategos worker.
You have access to the following tools to interact with the codebase:
- read_file: Read file contents
- write_file: Write to files
- edit_file: Make targeted edits to files
- bash: Execute shell commands
- list_files: List directory contents

When asked to work on code:
1. First understand the task
2. Read relevant files to understand the codebase
3. Make changes using the appropriate tools
4. Verify your changes work

Be concise and focused. Complete tasks efficiently.`;

// Load context file if present
function loadContextFile() {
  const contextFiles = ['.strategoscontext', '.claudecontext'];
  for (const file of contextFiles) {
    const contextPath = path.join(process.cwd(), file);
    if (fs.existsSync(contextPath)) {
      return fs.readFileSync(contextPath, 'utf-8');
    }
  }
  return null;
}

// Make API request to OpenAI
async function callOpenAI(messages, stream = false) {
  const config = apiConfig.openai;

  if (!config.apiKey) {
    throw new Error('OPENAI_API_KEY not set');
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ],
    tools: getOpenAITools(),
    tool_choice: 'auto',
    stream
  };

  const response = await fetch(config.url, {
    method: 'POST',
    headers: config.getHeaders(config.apiKey),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  return response.json();
}

// Make API request to Gemini
async function callGemini(messages) {
  const config = apiConfig.gemini;

  if (!config.apiKey) {
    throw new Error('GEMINI_API_KEY not set');
  }

  // Convert messages to Gemini format
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    tools: getGeminiTools(),
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 0.7
    }
  };

  const url = config.getUrl(config.apiKey);
  const response = await fetch(url, {
    method: 'POST',
    headers: config.getHeaders(),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${error}`);
  }

  return response.json();
}

// Process tool calls
async function processToolCalls(toolCalls) {
  const results = [];

  for (const call of toolCalls) {
    const toolName = call.function?.name || call.name;
    const argsStr = call.function?.arguments || call.args;
    const args = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr;

    console.log(`\n[Tool] ${toolName}(${JSON.stringify(args)})`);

    const tool = tools[toolName];
    if (tool) {
      const result = await tool.execute(args);
      console.log(`[Result] ${JSON.stringify(result).slice(0, 200)}...`);
      results.push({
        tool_call_id: call.id,
        role: 'tool',
        name: toolName,
        content: JSON.stringify(result)
      });
    } else {
      results.push({
        tool_call_id: call.id,
        role: 'tool',
        name: toolName,
        content: JSON.stringify({ error: `Unknown tool: ${toolName}` })
      });
    }
  }

  return results;
}

// Main chat loop for OpenAI
async function chatLoopOpenAI(userMessage) {
  messages.push({ role: 'user', content: userMessage });

  let response = await callOpenAI(messages);
  let assistantMessage = response.choices[0].message;

  // Handle tool calls
  while (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
    messages.push(assistantMessage);
    const toolResults = await processToolCalls(assistantMessage.tool_calls);
    messages.push(...toolResults);

    response = await callOpenAI(messages);
    assistantMessage = response.choices[0].message;
  }

  const content = assistantMessage.content || '';
  messages.push({ role: 'assistant', content });

  return content;
}

// Main chat loop for Gemini
async function chatLoopGemini(userMessage) {
  messages.push({ role: 'user', content: userMessage });

  let response = await callGemini(messages);
  let candidate = response.candidates?.[0];
  let content = candidate?.content;

  // Handle function calls
  while (content?.parts?.some(p => p.functionCall)) {
    const functionCalls = content.parts
      .filter(p => p.functionCall)
      .map(p => ({
        name: p.functionCall.name,
        args: p.functionCall.args
      }));

    const toolResults = await processToolCalls(functionCalls);

    // Add function response to conversation
    messages.push({
      role: 'assistant',
      content: JSON.stringify(content.parts)
    });
    messages.push({
      role: 'user',
      content: `Tool results: ${JSON.stringify(toolResults.map(r => JSON.parse(r.content)))}`
    });

    response = await callGemini(messages);
    candidate = response.candidates?.[0];
    content = candidate?.content;
  }

  const textContent = content?.parts?.map(p => p.text).join('') || '';
  messages.push({ role: 'assistant', content: textContent });

  return textContent;
}

// Main function
async function main() {
  console.log(`Strategos Agent - ${provider} (${model})`);
  console.log(`Working directory: ${process.cwd()}`);
  console.log('Type your message and press Enter. Type "exit" to quit.\n');

  // Load context file
  const context = loadContextFile();
  if (context) {
    console.log('[Loaded context file]\n');
    messages.push({ role: 'user', content: `Context:\n${context}` });
    messages.push({ role: 'assistant', content: 'I understand the context. How can I help you?' });
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const chatLoop = provider === 'gemini' ? chatLoopGemini : chatLoopOpenAI;

  const prompt = () => {
    rl.question('\n> ', async (input) => {
      if (!input || input.trim().toLowerCase() === 'exit') {
        console.log('Goodbye!');
        rl.close();
        process.exit(0);
      }

      try {
        const response = await chatLoop(input.trim());
        console.log(`\n${response}`);
      } catch (error) {
        console.error(`\nError: ${error.message}`);

        // Handle rate limits
        if (error.message.includes('429') || error.message.includes('rate')) {
          console.log('Rate limited. Waiting 10 seconds...');
          await new Promise(r => setTimeout(r, 10000));
        }
      }

      prompt();
    });
  };

  prompt();
}

main().catch(console.error);
