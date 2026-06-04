// Context-less input guard — shared between REST API and socket rawInput paths.
// Returns true if `text` is a bare short imperative with no task context.
// Fast-allow: >80 chars or containing technical markers always has context.

const CONTEXT_LESS_PATTERNS = [
  /^(proceed|continue|go|next)\.?$/i,
  /^(proceed|continue)\s+(please|working|forward|on|along|further|now|ahead|it|this|that)\.?$/i,
  /^(proceed|continue)\s+with\s+(the\s+)?(rest|more|it|this|that|everything|all|others|work)\.?$/i,
  /^(proceed|continue)\s+(with\s+)?(the\s+)?(next|the\s+next)\s+(batch|one|item|task|thing)\.?$/i,
  /^go\s+(ahead|on|forward|now)\.?$/i,
  /^next\s+(one|item|task|batch|please|thing)\.?$/i,
  /^do\s+(it|this|that|the\s+next(\s+(one|item|task|batch|thing))?)\.?$/i,
  /^keep\s+(going|at\s+it|working|up|on)\.?$/i,
];

export function isContextLessInput(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length > 80 || /[/()\d]/.test(t)) return false;
  return CONTEXT_LESS_PATTERNS.some(p => p.test(t));
}
