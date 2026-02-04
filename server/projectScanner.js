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
  // Normalize both paths to handle symlinks and relative segments
  const normalizedPath = path.resolve(resolvedPath);
  const normalizedRoot = path.resolve(allowedRoot);

  // Check if the normalized path starts with the root
  // Add path.sep to avoid matching /home/druzy/thea2 when root is /home/druzy/thea
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
  if (!projectPath || typeof projectPath !== 'string') {
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
      return JSON.parse(content);
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

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving project config:', error.message);
    return false;
  }
}

/**
 * Get additional project roots from environment AND config
 * Format: STRATEGOS_ADDITIONAL_ROOTS=/path/one,/path/two
 */
function getAdditionalRoots(theaRoot) {
  const roots = new Set();

  // From environment
  const envRoots = process.env.STRATEGOS_ADDITIONAL_ROOTS;
  if (envRoots) {
    envRoots.split(',').map(p => p.trim()).filter(p => p).forEach(p => roots.add(p));
  }

  // From config file
  const config = loadProjectConfig(theaRoot);
  if (config.externalProjects && Array.isArray(config.externalProjects)) {
    config.externalProjects.forEach(p => roots.add(p));
  }

  return [...roots];
}

/**
 * Add an external project directory
 */
export function addExternalProject(theaRoot, projectPath) {
  const config = loadProjectConfig(theaRoot);
  if (!config.externalProjects) {
    config.externalProjects = [];
  }

  // Normalize path
  const normalizedPath = path.resolve(projectPath);

  // Check if already exists
  if (config.externalProjects.includes(normalizedPath)) {
    return { success: false, error: 'Project already added' };
  }

  // Verify path exists and is a directory
  try {
    const stat = fs.statSync(normalizedPath);
    if (!stat.isDirectory()) {
      return { success: false, error: 'Path is not a directory' };
    }
  } catch {
    return { success: false, error: 'Path does not exist' };
  }

  config.externalProjects.push(normalizedPath);
  saveProjectConfig(theaRoot, config);

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
  saveProjectConfig(theaRoot, config);

  return { success: true };
}

/**
 * List all external project directories
 */
export function listExternalProjects(theaRoot) {
  const config = loadProjectConfig(theaRoot);
  const envRoots = process.env.STRATEGOS_ADDITIONAL_ROOTS?.split(',').map(p => p.trim()).filter(p => p) || [];

  return {
    fromConfig: config.externalProjects || [],
    fromEnv: envRoots
  };
}

/**
 * Scan projects root (and additional roots) for project directories
 */
export function scanProjects(theaRoot) {
  const projects = [];
  const seenNames = new Set();

  // Scan main projects root
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
      // Only include directories, skip hidden and special folders
      if (entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
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
  const projectPath = path.join(theaRoot, projectName);

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
