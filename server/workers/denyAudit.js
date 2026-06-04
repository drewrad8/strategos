// Append-only audit log for deny-list events
import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'server/logs');
const LOG_FILE = path.join(LOG_DIR, 'deny-audit.log');

export function logDenyEvent({ workerId, workerLabel, attemptedPath, denyPattern, layer }) {
  const event = JSON.stringify({
    ts: new Date().toISOString(),
    workerId: workerId || 'unknown',
    workerLabel: workerLabel || 'unknown',
    attemptedPath, // path that was attempted — NOT the file contents
    denyPattern,   // which deny rule matched
    layer          // 'L1', 'L2', 'L3', 'L4', or 'L5'
  });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, event + '\n');
}
