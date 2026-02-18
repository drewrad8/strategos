/**
 * Sanitize error messages before sending to HTTP/socket clients.
 * Prevents leaking server filesystem paths, module names, and internal details.
 */
export function sanitizeErrorMessage(error) {
  const msg = error?.message || String(error);
  if (/\/[a-z][\w/.-]+/i.test(msg)) return 'Internal server error';
  if (msg.includes('MODULE_NOT_FOUND') || msg.includes('Cannot find module')) return 'Internal server error';
  return msg;
}
