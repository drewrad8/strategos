/**
 * Bootstrap Reflexion — retroactively generates failure reflections for
 * all existing failed workers in learningsDb that have checkpoints on disk.
 *
 * Run once after deploying reflexionService.js:
 *   node --experimental-vm-modules server/scripts/bootstrap-reflections.js
 *
 * Or from the strategos root:
 *   node server/scripts/bootstrap-reflections.js
 */

import { getLearnings } from '../learningsDb.js';
import { generateReflection } from '../services/reflexionService.js';

async function main() {
  const failures = getLearnings(null, 90).filter(l => l.success === 0 && l.workerId && l.templateType);
  console.log(`Bootstrapping reflections for ${failures.length} existing failures...`);

  let generated = 0;
  let skipped = 0;

  for (const f of failures) {
    try {
      await generateReflection(f.workerId, f.templateType, f.taskDescription);
      generated++;
      console.log(`  [${generated}/${failures.length}] ${f.workerId} (${f.templateType})`);
    } catch (err) {
      console.warn(`  SKIP ${f.workerId}: ${err.message}`);
      skipped++;
    }
    // Rate-limit to avoid hammering the API
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nDone. Generated: ${generated}, Skipped: ${skipped}`);
}

main().catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
