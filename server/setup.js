/**
 * First-Run Setup Module
 *
 * Handles initial configuration when Strategos is started for the first time.
 * Checks for a valid projects root directory and presents a setup flow if needed.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'strategos.env');

// Side effect: read config on import so THEA_ROOT is set before state.js evaluates.
// This MUST be imported before ./workers/state.js in index.js.
if (!process.env.THEA_ROOT) {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const match = content.match(/^THEA_ROOT=(.+)$/m);
      if (match) {
        const root = path.resolve(match[1].trim().replace(/^["']|["']$/g, ''));
        if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
          process.env.THEA_ROOT = root;
        }
      }
    }
  } catch {
    // Config not readable — will enter setup mode
  }
}

/**
 * Check if Strategos has been configured with a valid projects root.
 * Returns the configured root if valid, null if setup is needed.
 */
export function getConfiguredRoot() {
  // 1. Check env var (highest priority — set by installer or systemd)
  if (process.env.THEA_ROOT) {
    const root = path.resolve(process.env.THEA_ROOT);
    if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
      return root;
    }
  }

  // 2. Check local config file
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const match = content.match(/^THEA_ROOT=(.+)$/m);
      if (match) {
        const root = path.resolve(match[1].trim().replace(/^["']|["']$/g, ''));
        if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
          // Also set it in env so the rest of the app can use it
          process.env.THEA_ROOT = root;
          return root;
        }
      }
    } catch {
      // Config file is corrupt — treat as unconfigured
    }
  }

  return null;
}

/**
 * Save the projects root configuration.
 */
export function saveProjectsRoot(rootPath) {
  const resolved = path.resolve(rootPath);

  // Security validations
  const DANGEROUS = ['/', '/etc', '/sys', '/proc', '/dev', '/boot', '/root', '/var', '/usr', '/bin', '/sbin', '/lib'];
  if (DANGEROUS.includes(resolved) || DANGEROUS.some(d => resolved.startsWith(d + '/'))) {
    throw new Error(`Cannot use system directory as projects root: ${resolved}`);
  }

  if (resolved.includes('\0')) {
    throw new Error('Invalid path');
  }

  // Create the directory if it doesn't exist
  fs.mkdirSync(resolved, { recursive: true });

  // Verify it's writable
  const testFile = path.join(resolved, '.strategos-test');
  try {
    fs.writeFileSync(testFile, 'test', { mode: 0o600 });
    fs.unlinkSync(testFile);
  } catch {
    throw new Error(`Directory is not writable: ${resolved}`);
  }

  // Save to config file
  const configDir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `THEA_ROOT=${resolved}\n`, { mode: 0o600 });

  // Update env for current process
  process.env.THEA_ROOT = resolved;

  return resolved;
}

/**
 * Mount setup routes on an Express app.
 * These routes handle the first-run configuration flow.
 */
export function mountSetupRoutes(app) {
  // GET /setup - Serve setup page
  app.get('/setup', (req, res) => {
    res.send(getSetupHTML());
  });

  // GET /api/setup/status - Check if setup is needed
  app.get('/api/setup/status', (req, res) => {
    const root = getConfiguredRoot();
    res.json({
      configured: !!root,
      projectsRoot: root,
      defaults: {
        projectsRoot: path.join(process.env.HOME || '/home', 'strategos-projects')
      }
    });
  });

  // POST /api/setup/configure - Set the projects root
  app.post('/api/setup/configure', (req, res) => {
    try {
      const { projectsRoot } = req.body;
      if (!projectsRoot || typeof projectsRoot !== 'string') {
        return res.status(400).json({ error: 'projectsRoot is required' });
      }

      // Expand ~ to home directory
      const expanded = projectsRoot.replace(/^~/, process.env.HOME || '/home');
      const saved = saveProjectsRoot(expanded);

      res.json({
        success: true,
        projectsRoot: saved,
        message: 'Configuration saved. Restart the server to apply changes.'
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Redirect to setup if not configured (only for browser requests, not API)
  app.use((req, res, next) => {
    if (getConfiguredRoot()) {
      return next();
    }

    // Don't redirect API calls or static assets
    if (req.path.startsWith('/api') || req.path.startsWith('/setup') ||
        req.path.startsWith('/assets') || req.path.includes('.')) {
      return next();
    }

    // Redirect browser requests to setup
    res.redirect('/setup');
  });
}

function getSetupHTML() {
  const defaultRoot = path.join(process.env.HOME || '/home', 'strategos-projects');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Strategos — Setup</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .setup-container {
      max-width: 560px;
      width: 100%;
      padding: 2rem;
    }
    .logo {
      text-align: center;
      margin-bottom: 2rem;
    }
    .logo h1 {
      font-size: 2.5rem;
      font-weight: 700;
      letter-spacing: 0.2em;
      color: #d4a017;
      text-transform: uppercase;
    }
    .logo p {
      color: #888;
      margin-top: 0.5rem;
      font-size: 0.9rem;
    }
    .card {
      background: #151515;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 2rem;
    }
    .card h2 {
      font-size: 1.1rem;
      color: #d4a017;
      margin-bottom: 0.5rem;
    }
    .card p {
      color: #999;
      font-size: 0.85rem;
      margin-bottom: 1.5rem;
      line-height: 1.5;
    }
    .field { margin-bottom: 1.5rem; }
    .field label {
      display: block;
      font-size: 0.8rem;
      color: #d4a017;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 0.5rem;
    }
    .field input {
      width: 100%;
      padding: 0.75rem 1rem;
      background: #0a0a0a;
      border: 1px solid #444;
      border-radius: 4px;
      color: #e0e0e0;
      font-family: 'SF Mono', 'Consolas', monospace;
      font-size: 0.9rem;
    }
    .field input:focus {
      outline: none;
      border-color: #d4a017;
    }
    .field .hint {
      font-size: 0.75rem;
      color: #666;
      margin-top: 0.4rem;
    }
    .btn {
      width: 100%;
      padding: 0.85rem;
      background: linear-gradient(135deg, #d4a017 0%, #b8860b 100%);
      border: none;
      border-radius: 4px;
      color: #000;
      font-weight: 700;
      font-size: 0.95rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.9; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .error {
      background: #2a1515;
      border: 1px solid #a33;
      color: #f88;
      padding: 0.75rem 1rem;
      border-radius: 4px;
      font-size: 0.85rem;
      margin-bottom: 1rem;
      display: none;
    }
    .success {
      background: #152a15;
      border: 1px solid #3a3;
      color: #8f8;
      padding: 0.75rem 1rem;
      border-radius: 4px;
      font-size: 0.85rem;
      margin-bottom: 1rem;
      display: none;
    }
    .prereqs {
      margin-top: 1.5rem;
      padding-top: 1.5rem;
      border-top: 1px solid #333;
    }
    .prereqs h3 {
      font-size: 0.8rem;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 0.75rem;
    }
    .prereq-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.3rem 0;
      font-size: 0.85rem;
      color: #999;
    }
    .prereq-item .check { color: #4a4; }
    .prereq-item .warn { color: #aa4; }
  </style>
</head>
<body>
  <div class="setup-container">
    <div class="logo">
      <h1>Strategos</h1>
      <p>Multi-Agent AI Orchestrator</p>
    </div>
    <div class="card">
      <h2>Initial Setup</h2>
      <p>
        Welcome! Strategos needs a <strong>projects root directory</strong> — this is
        where your coding projects live. Strategos will scan this directory for projects
        and allow AI workers to operate within them.
      </p>

      <div id="error" class="error"></div>
      <div id="success" class="success"></div>

      <form id="setupForm" onsubmit="return handleSubmit(event)">
        <div class="field">
          <label for="projectsRoot">Projects Root Directory</label>
          <input type="text" id="projectsRoot" value="${defaultRoot}"
                 placeholder="/path/to/your/projects" required>
          <div class="hint">
            This directory will be created if it doesn't exist. You can add more project
            directories later from the UI.
          </div>
        </div>
        <button type="submit" class="btn" id="submitBtn">Configure &amp; Start</button>
      </form>

      <div class="prereqs">
        <h3>Prerequisites</h3>
        <div id="prereqs"></div>
      </div>
    </div>
  </div>

  <script>
    // Check prerequisites on load
    fetch('/api/setup/status')
      .then(r => r.json())
      .then(data => {
        if (data.configured) {
          window.location.href = '/';
          return;
        }
        document.getElementById('projectsRoot').value =
          data.defaults?.projectsRoot || '${defaultRoot}';
      });

    async function handleSubmit(e) {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      const errorEl = document.getElementById('error');
      const successEl = document.getElementById('success');
      const root = document.getElementById('projectsRoot').value.trim();

      errorEl.style.display = 'none';
      successEl.style.display = 'none';
      btn.disabled = true;
      btn.textContent = 'Configuring...';

      try {
        const res = await fetch('/api/setup/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectsRoot: root })
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Configuration failed');
        }

        successEl.textContent = 'Configuration saved! Restarting server...';
        successEl.style.display = 'block';

        // The server needs to restart to pick up the new THEA_ROOT.
        // If running via systemd, it will auto-restart.
        // Otherwise, redirect after a delay.
        setTimeout(() => {
          window.location.href = '/';
        }, 3000);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Configure & Start';
      }
    }
  </script>
</body>
</html>`;
}
