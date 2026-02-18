import fs from 'fs';
import path from 'path';

const CONFIG_FILE = 'projects.json';

// ============================================
// SECURITY: Path Traversal Prevention
// ============================================

/**
 * Validate that a resolved path is within the allowed root directory.
 * Prevents path traversal attacks using "../" or absolute paths.
 * @param {string} resolvedPath - The resolved absolute path
 * @param {string} allowedRoot - The root directory that must contain the path
 * @returns {boolean} True if path is safe, false if it escapes the root
 */
export function isPathWithinRoot(resolvedPath, allowedRoot) {
  // Resolve symlinks to prevent symlink-based path traversal
  let normalizedPath = path.resolve(resolvedPath);
  let normalizedRoot = path.resolve(allowedRoot);
  try {
    normalizedPath = fs.realpathSync(normalizedPath);
  } catch {
    // Path doesn't exist yet — use logical resolution (path.resolve already applied)
  }
  try {
    normalizedRoot = fs.realpathSync(normalizedRoot);
  } catch {
    // Root doesn't exist — use logical resolution
  }

  // Check if the normalized path starts with the root
  // Add path.sep to avoid matching /home/user/projects2 when root is /home/user/projects
  return normalizedPath === normalizedRoot ||
         normalizedPath.startsWith(normalizedRoot + path.sep);
}

/**
 * Safely resolve a project path, ensuring it stays within theaRoot OR is a registered external project.
 * @param {string} projectPath - The project path (can be relative or absolute)
 * @param {string} theaRoot - The root directory
 * @returns {string|null} The resolved path if safe, null if path traversal detected
 */
export function safeResolvePath(projectPath, theaRoot) {
  if (!projectPath || typeof projectPath !== 'string' || projectPath.includes('\0')) {
    return null;
  }

  // Resolve the path
  let resolvedPath;
  if (path.isAbsolute(projectPath)) {
    resolvedPath = projectPath;
  } else {
    resolvedPath = path.join(theaRoot, projectPath);
  }

  // Normalize to resolve any ".." segments
  resolvedPath = path.resolve(resolvedPath);

  // Check if it's within theaRoot
  if (isPathWithinRoot(resolvedPath, theaRoot)) {
    return resolvedPath;
  }

  // Check if it's a registered external project
  const externalRoots = getAdditionalRoots(theaRoot);
  for (const extRoot of externalRoots) {
    const normalizedExtRoot = path.resolve(extRoot);
    if (resolvedPath === normalizedExtRoot || isPathWithinRoot(resolvedPath, normalizedExtRoot)) {
      return resolvedPath;
    }
  }

  console.warn(`[SECURITY] Path traversal attempt blocked: ${projectPath} -> ${resolvedPath}`);
  return null;
}

/**
 * Load the projects configuration file
 */
export function loadProjectConfig(theaRoot) {
  const configPath = path.join(theaRoot, 'strategos', CONFIG_FILE);

  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      // Validate parsed value is a plain object (not array, string, number, null)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn('[ProjectScanner] projects.json is not a JSON object, using defaults');
      } else {
        return parsed;
      }
    }
  } catch (error) {
    console.error('Error loading project config:', error.message);
  }

  return {
    folders: {},
    tags: {},
    projectMeta: {},
    settings: { defaultView: 'folders', showUncategorized: true, uncategorizedLabel: 'Other Projects' }
  };
}

/**
 * Save the projects configuration file
 */
export function saveProjectConfig(theaRoot, config) {
  const configPath = path.join(theaRoot, 'strategos', CONFIG_FILE);
  const tmpPath = configPath + `.tmp.${process.pid}.${Date.now()}`;

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(tmpPath, configPath);
    return true;
  } catch (error) {
    console.error('Error saving project config:', error.message);
    try { fs.unlinkSync(tmpPath); } catch { /* best effort cleanup */ }
    return false;
  }
}

/**
 * Get additional project roots from environment AND config
 * Format: THEA_ADDITIONAL_ROOTS=/path/one,/path/two
 */
const MAX_ADDITIONAL_ROOTS = 100;

function getAdditionalRoots(theaRoot) {
  const roots = new Set();

  // From environment (validate each root is absolute and not overly broad)
  const envRoots = process.env.THEA_ADDITIONAL_ROOTS;
  if (envRoots) {
    const entries = envRoots.split(',').map(p => p.trim()).filter(p => p);
    if (entries.length > MAX_ADDITIONAL_ROOTS) {
      console.warn(`[ProjectScanner] THEA_ADDITIONAL_ROOTS has ${entries.length} entries, truncating to ${MAX_ADDITIONAL_ROOTS}`);
      entries.length = MAX_ADDITIONAL_ROOTS;
    }
    entries.forEach(p => {
      const normalized = path.resolve(p);
      // Reject root-level paths (/) and relative paths to prevent full filesystem access
      // Also reject paths under dangerous system directories
      if (path.isAbsolute(p) && normalized !== '/' && !p.includes('..') && !isUnderDangerousPath(normalized)) {
        roots.add(normalized);
      } else {
        console.warn(`[ProjectScanner] Rejecting unsafe additional root: ${p}`);
      }
    });
  }

  // From config file (apply same validation as env roots, with same bound)
  const config = loadProjectConfig(theaRoot);
  if (config.externalProjects && Array.isArray(config.externalProjects)) {
    const configProjects = config.externalProjects.slice(0, MAX_ADDITIONAL_ROOTS);
    if (config.externalProjects.length > MAX_ADDITIONAL_ROOTS) {
      console.warn(`[ProjectScanner] Config has ${config.externalProjects.length} external projects, using first ${MAX_ADDITIONAL_ROOTS}`);
    }
    configProjects.forEach(p => {
      if (typeof p !== 'string' || !p) return;
      const normalized = path.resolve(p);
      if (path.isAbsolute(p) && normalized !== '/' && !p.includes('..') && !isUnderDangerousPath(normalized)) {
        roots.add(normalized);
      } else {
        console.warn(`[ProjectScanner] Rejecting unsafe config external root: ${p}`);
      }
    });
  }

  return [...roots];
}

/**
 * Add an external project directory
 */
// Dangerous system paths that should never be added as external project roots
const DANGEROUS_PATHS = ['/', '/etc', '/sys', '/proc', '/dev', '/boot', '/root', '/var', '/usr', '/bin', '/sbin', '/lib'];

/**
 * Check if a path is under a dangerous system directory (exact match or child).
 */
function isUnderDangerousPath(normalizedPath) {
  for (const dp of DANGEROUS_PATHS) {
    if (dp === '/') continue; // Already handled by normalized !== '/' check
    if (normalizedPath === dp || normalizedPath.startsWith(dp + path.sep)) {
      return true;
    }
  }
  return false;
}

export function addExternalProject(theaRoot, projectPath) {
  const config = loadProjectConfig(theaRoot);
  if (!config.externalProjects) {
    config.externalProjects = [];
  }

  // Normalize path
  const normalizedPath = path.resolve(projectPath);

  // Reject dangerous system paths (exact match or children like /var/log)
  if (isUnderDangerousPath(normalizedPath) || !path.isAbsolute(projectPath) || projectPath.includes('..') || projectPath.includes('\0')) {
    return { success: false, error: 'Path is not allowed (system directory or relative path)' };
  }

  // Check if already exists
  if (config.externalProjects.includes(normalizedPath)) {
    return { success: false, error: 'Project already added' };
  }

  // Verify path exists and is a directory, and reject symlinks pointing outside
  try {
    const lstat = fs.lstatSync(normalizedPath);
    if (lstat.isSymbolicLink()) {
      const realPath = fs.realpathSync(normalizedPath);
      if (isUnderDangerousPath(realPath)) {
        return { success: false, error: 'Symlink target is under a restricted system directory' };
      }
    }
    const stat = fs.statSync(normalizedPath);
    if (!stat.isDirectory()) {
      return { success: false, error: 'Path is not a directory' };
    }
  } catch {
    return { success: false, error: 'Path does not exist' };
  }

  // Enforce bound on external projects (same limit as env roots)
  if (config.externalProjects.length >= MAX_ADDITIONAL_ROOTS) {
    return { success: false, error: `Maximum of ${MAX_ADDITIONAL_ROOTS} external projects reached` };
  }

  config.externalProjects.push(normalizedPath);
  if (!saveProjectConfig(theaRoot, config)) {
    return { success: false, error: 'Failed to save project configuration' };
  }

  return { success: true, path: normalizedPath, name: path.basename(normalizedPath) };
}

/**
 * Remove an external project directory
 */
export function removeExternalProject(theaRoot, projectPath) {
  const config = loadProjectConfig(theaRoot);
  if (!config.externalProjects) {
    return { success: false, error: 'No external projects configured' };
  }

  const normalizedPath = path.resolve(projectPath);
  const index = config.externalProjects.indexOf(normalizedPath);

  if (index === -1) {
    return { success: false, error: 'Project not found in external projects' };
  }

  config.externalProjects.splice(index, 1);
  if (!saveProjectConfig(theaRoot, config)) {
    return { success: false, error: 'Failed to save project configuration' };
  }

  return { success: true };
}

/**
 * List all external project directories
 */
export function listExternalProjects(theaRoot) {
  const config = loadProjectConfig(theaRoot);
  const envRoots = process.env.THEA_ADDITIONAL_ROOTS?.split(',').map(p => p.trim()).filter(p => p) || [];

  return {
    fromConfig: config.externalProjects || [],
    fromEnv: envRoots
  };
}

/**
 * Scan THEA_ROOT (and additional roots) for project directories
 */
export function scanProjects(theaRoot) {
  const projects = [];
  const seenNames = new Set();

  // Scan main thea root
  scanDirectory(theaRoot, projects, seenNames);

  // Scan additional roots (individual project directories)
  const additionalRoots = getAdditionalRoots(theaRoot);
  for (const additionalPath of additionalRoots) {
    try {
      const stat = fs.statSync(additionalPath);
      if (stat.isDirectory()) {
        const name = path.basename(additionalPath);
        if (!seenNames.has(name) && !name.startsWith('.') && !name.startsWith('_')) {
          projects.push({
            name,
            path: additionalPath,
            workers: [],
            external: true  // Mark as external project
          });
          seenNames.add(name);
        }
      }
    } catch (error) {
      console.error(`Error accessing additional root ${additionalPath}:`, error.message);
    }
  }

  // Sort alphabetically
  projects.sort((a, b) => a.name.localeCompare(b.name));

  return projects;
}

/**
 * Scan a directory for project subdirectories
 */
function scanDirectory(dirPath, projects, seenNames) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      // Only include real directories — skip symlinks (could escape project root),
      // hidden dirs, and special folders
      if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
        if (!seenNames.has(entry.name)) {
          const fullPath = path.join(dirPath, entry.name);

          projects.push({
            name: entry.name,
            path: fullPath,
            workers: [] // Will be populated by combining with worker data
          });
          seenNames.add(entry.name);
        }
      }
    }
  } catch (error) {
    console.error(`Error scanning projects in ${dirPath}:`, error.message);
  }
}

/**
 * Get projects with full config metadata merged in
 */
export function getProjectsWithConfig(theaRoot) {
  const projects = scanProjects(theaRoot);
  const config = loadProjectConfig(theaRoot);

  // Build reverse lookup: project -> folder
  const projectToFolder = {};
  for (const [folderId, folder] of Object.entries(config.folders || {})) {
    for (const projectName of folder.projects || []) {
      projectToFolder[projectName] = folderId;
    }
  }

  // Build reverse lookup: project -> tags
  const projectToTags = {};
  for (const [tag, projectNames] of Object.entries(config.tags || {})) {
    for (const projectName of projectNames) {
      if (!projectToTags[projectName]) {
        projectToTags[projectName] = [];
      }
      projectToTags[projectName].push(tag);
    }
  }

  // Merge metadata into projects
  const enrichedProjects = projects.map(project => {
    const meta = config.projectMeta?.[project.name] || {};
    return {
      ...project,
      folder: projectToFolder[project.name] || null,
      tags: projectToTags[project.name] || [],
      description: meta.description || '',
      aliases: meta.aliases || [],
      meta
    };
  });

  return {
    projects: enrichedProjects,
    folders: config.folders || {},
    tags: Object.keys(config.tags || {}),
    settings: config.settings || {}
  };
}

/**
 * Get organized folder structure with projects nested
 */
export function getProjectTree(theaRoot) {
  const { projects, folders, settings } = getProjectsWithConfig(theaRoot);

  // Build tree structure
  const tree = [];
  const usedProjects = new Set();

  // Add folders with their projects
  for (const [folderId, folder] of Object.entries(folders)) {
    const folderProjects = projects.filter(p => p.folder === folderId);
    folderProjects.forEach(p => usedProjects.add(p.name));

    tree.push({
      type: 'folder',
      id: folderId,
      label: folder.label,
      icon: folder.icon,
      color: folder.color,
      projects: folderProjects,
      collapsed: false
    });
  }

  // Add uncategorized projects
  if (settings.showUncategorized) {
    const uncategorized = projects.filter(p => !usedProjects.has(p.name));
    if (uncategorized.length > 0) {
      tree.push({
        type: 'folder',
        id: '_uncategorized',
        label: settings.uncategorizedLabel || 'Other',
        icon: 'folder',
        color: '#888888',
        projects: uncategorized,
        collapsed: false
      });
    }
  }

  return tree;
}

/**
 * Get a single project by name
 */
export function getProject(theaRoot, projectName) {
  // SECURITY: Validate path stays within theaRoot to prevent traversal
  const projectPath = safeResolvePath(projectName, theaRoot);
  if (!projectPath) {
    return null;
  }

  try {
    const stat = fs.statSync(projectPath);

    if (stat.isDirectory()) {
      const config = loadProjectConfig(theaRoot);

      // Find folder
      let folder = null;
      for (const [folderId, folderData] of Object.entries(config.folders || {})) {
        if (folderData.projects?.includes(projectName)) {
          folder = folderId;
          break;
        }
      }

      // Find tags
      const tags = [];
      for (const [tag, projectNames] of Object.entries(config.tags || {})) {
        if (projectNames.includes(projectName)) {
          tags.push(tag);
        }
      }

      return {
        name: projectName,
        path: projectPath,
        folder,
        tags,
        meta: config.projectMeta?.[projectName] || {},
        workers: []
      };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Check if a project path exists
 */
export function projectExists(projectPath) {
  try {
    const stat = fs.statSync(projectPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
