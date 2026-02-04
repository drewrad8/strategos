/**
 * Authentication Middleware for Strategos API
 *
 * Security model:
 * - When STRATEGOS_API_KEY is set, Bearer token authentication is required
 * - When not set, auth is disabled (development mode)
 * - Health and static endpoints are always public
 *
 * Usage:
 *   STRATEGOS_API_KEY=your_secret_key node server/index.js
 *
 * Client usage:
 *   curl -H "Authorization: Bearer your_secret_key" http://localhost:38007/api/workers
 */

const PUBLIC_PATHS = [
  '/api/health',
  '/api/ollama/health'
];

/**
 * Check if authentication is enabled
 * @returns {boolean}
 */
export function isAuthEnabled() {
  return !!process.env.STRATEGOS_API_KEY;
}

/**
 * Get the configured API key
 * @returns {string|undefined}
 */
export function getApiKey() {
  return process.env.STRATEGOS_API_KEY;
}

/**
 * Authentication middleware
 * Validates Bearer token against STRATEGOS_API_KEY environment variable
 */
export function authenticateRequest(req, res, next) {
  // Skip auth if not configured (development mode)
  if (!isAuthEnabled()) {
    return next();
  }

  // Skip auth for public paths
  if (PUBLIC_PATHS.some(path => req.path === path || req.path.startsWith(path))) {
    return next();
  }

  // Skip auth for non-API paths (static files, SPA routing)
  if (!req.path.startsWith('/api')) {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    console.warn(`[AUTH] Unauthorized request to ${req.path} - no Authorization header`);
    return res.status(401).json({
      error: 'Authorization required',
      message: 'Please provide a valid API key in the Authorization header',
      hint: 'Authorization: Bearer YOUR_API_KEY'
    });
  }

  if (!authHeader.startsWith('Bearer ')) {
    console.warn(`[AUTH] Invalid auth format for ${req.path}`);
    return res.status(401).json({
      error: 'Invalid authorization format',
      message: 'Authorization header must use Bearer token format',
      hint: 'Authorization: Bearer YOUR_API_KEY'
    });
  }

  const token = authHeader.substring(7);
  const validKey = getApiKey();

  if (token !== validKey) {
    console.warn(`[AUTH] Invalid API key for ${req.path}`);
    return res.status(403).json({
      error: 'Invalid API key',
      message: 'The provided API key is not valid'
    });
  }

  // Auth successful
  next();
}

/**
 * Socket.io authentication middleware
 * Validates token in socket handshake
 */
export function authenticateSocket(socket, next) {
  // Skip auth if not configured
  if (!isAuthEnabled()) {
    return next();
  }

  const token = socket.handshake.auth?.token || socket.handshake.query?.token;

  if (!token) {
    console.warn(`[AUTH] Socket connection rejected - no token`);
    return next(new Error('Authentication required'));
  }

  if (token !== getApiKey()) {
    console.warn(`[AUTH] Socket connection rejected - invalid token`);
    return next(new Error('Invalid API key'));
  }

  next();
}

/**
 * Log authentication status on startup
 */
export function logAuthStatus() {
  if (isAuthEnabled()) {
    console.log('Authentication: ENABLED (STRATEGOS_API_KEY is set)');
    console.log('All API requests require Bearer token authorization');
  } else {
    console.log('Authentication: DISABLED (development mode)');
    console.log('Set STRATEGOS_API_KEY environment variable to enable authentication');
  }
}
