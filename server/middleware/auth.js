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

import crypto from 'crypto';
import { getLogger } from '../logger.js';

/**
 * Timing-safe string comparison to prevent timing attacks on API key.
 */
function timingSafeEqual(a, b) {
  // Coerce to strings to avoid timing leak from early type-check return.
  // Without this, typeof check returns ~2ns vs ~150ns for actual comparison,
  // leaking whether the input was a string at all.
  const strA = typeof a === 'string' ? a : '';
  const strB = typeof b === 'string' ? b : '';
  // Pad to same length to avoid leaking key length via timing
  const maxLen = Math.max(strA.length, strB.length, 1);
  const bufA = Buffer.alloc(maxLen);
  const bufB = Buffer.alloc(maxLen);
  bufA.write(strA);
  bufB.write(strB);
  // Constant-time comparison + explicit length check (both constant-time)
  return crypto.timingSafeEqual(bufA, bufB) && strA.length === strB.length;
}

const PUBLIC_PATHS = [
  '/api/health',
  '/api/ollama/health'
];

// Prefix-based public paths (for routes with dynamic segments).
// /api/ralph/signal/:token — authenticated by 128-bit completion token in the URL.
// /api/ralph/signal/by-worker/:id — authenticated by X-Ralph-Token header (worker's ralphToken).
// Both routes have their own caller-identity checks; ambient API key auth is not needed and
// would break worker curl calls that don't carry an Authorization header.
const PUBLIC_PATH_PREFIXES = [
  '/api/ralph/signal/'
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

  // Skip auth for public paths (exact match, normalize trailing slash)
  const normalizedPath = req.path.length > 1 && req.path.endsWith('/')
    ? req.path.slice(0, -1)
    : req.path;
  if (PUBLIC_PATHS.includes(normalizedPath)) {
    return next();
  }

  // Skip auth for prefix-matched public paths (dynamic segments like :token)
  if (PUBLIC_PATH_PREFIXES.some(prefix => normalizedPath.startsWith(prefix))) {
    return next();
  }

  // Skip auth for non-API paths (static files, SPA routing)
  if (!req.path.startsWith('/api')) {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    getLogger().warn('[workers.auth] Unauthorized request: no Authorization header', { event: 'security.unauthorized', path: req.path });
    return res.status(401).json({
      error: 'Authorization required',
      message: 'Please provide a valid API key in the Authorization header',
      hint: 'Authorization: Bearer YOUR_API_KEY'
    });
  }

  if (!authHeader.startsWith('Bearer ')) {
    getLogger().warn('[workers.auth] Invalid auth format', { event: 'security.invalid_format', path: req.path });
    return res.status(401).json({
      error: 'Invalid authorization format',
      message: 'Authorization header must use Bearer token format',
      hint: 'Authorization: Bearer YOUR_API_KEY'
    });
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    return res.status(401).json({
      error: 'Authorization required',
      message: 'Bearer token is empty'
    });
  }

  const validKey = getApiKey();

  if (!timingSafeEqual(token, validKey)) {
    getLogger().warn('[workers.auth] Invalid API key', { event: 'security.invalid_key', path: req.path });
    return res.status(401).json({
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

  // Only accept token from auth object — never from query string (leaks key in server logs)
  const token = socket.handshake.auth?.token;

  if (!token) {
    getLogger().warn('[workers.auth] Socket connection rejected: no token', { event: 'security.socket_no_token' });
    return next(new Error('Authentication required'));
  }

  if (!timingSafeEqual(token, getApiKey())) {
    getLogger().warn('[workers.auth] Socket connection rejected: invalid token', { event: 'security.socket_invalid_token' });
    return next(new Error('Invalid API key'));
  }

  next();
}

/**
 * Log authentication status on startup
 */
export function logAuthStatus() {
  if (isAuthEnabled()) {
    getLogger().info('[workers.auth] Authentication enabled');
    getLogger().info('[workers.auth] All API requests require Bearer token authorization');
  } else {
    getLogger().info('[workers.auth] Authentication disabled (development mode)');
    getLogger().info('[workers.auth] Set STRATEGOS_API_KEY to enable authentication');
  }
}
