/**
 * Insight Analyzer & Auto-Tuner for Strategos
 *
 * Analyzes worker learnings data to identify failure patterns, uptime anomalies,
 * and success rate issues. Auto-applies tiered template overrides based on
 * success rates and extracted failure patterns.
 *
 * Tiered auto-apply:
 *   Below 95%: append error recovery warnings
 *   Below 90%: append stronger warnings + specific failure patterns from learnings
 *   Below 80%: append critical warnings with exact failure quotes
 *
 * Runs on a 10-minute interval + event-driven on new learnings.
 * No LLM needed — pure statistical analysis.
 */

import crypto from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSummaryStats, getRecentFailures, getRecentFailuresByType } from '../learningsDb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDES_PATH = path.join(__dirname, '..', 'template-overrides.json');

const ANALYSIS_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// Tiered success rate thresholds
const THRESHOLD_WARNING = 0.95;   // Below 95%: basic warnings
const THRESHOLD_DANGER = 0.90;    // Below 90%: stronger warnings + failure patterns
const THRESHOLD_CRITICAL = 0.80;  // Below 80%: critical warnings + exact failure quotes

// Minimum unique-worker sample size before generating an override.
// Below this threshold, success rates are statistically unreliable and
// should not produce failure alerts that confuse workers.
const MIN_SAMPLE_SIZE = 10;

const UPTIME_TOO_SHORT = 120_000;       // 2 minutes in ms — likely crash
const UPTIME_TOO_LONG = 24 * 3600_000;  // 24 hours in ms — raised from 2h to exclude normal GENERALs/COLONELs

// Debounce event-driven analysis to avoid rapid re-runs
const DEBOUNCE_MS = 30_000; // 30 seconds
let debounceTimer = null;

// Stop-words excluded from failure keyword extraction
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'was', 'were', 'are', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
  'just', 'because', 'if', 'when', 'while', 'that', 'this', 'it', 'i',
  'my', 'we', 'they', 'he', 'she', 'what', 'which', 'who', 'how', 'where',
  'purpose', 'tasks', 'task', 'worker', 'workers', 'spawn', 'check',
  'commit', 'file', 'files', 'code', 'make', 'ensure', 'update',
]);

// ============================================
// STATE
// ============================================

let latestAnalysis = null;
let proposals = [];
let analysisInterval = null;

// ============================================
// INSIGHT ANALYZER
// ============================================

/**
 * Run statistical analysis on learnings data.
 * @returns {Object} Analysis result
 */
export function runAnalysis() {
  const analysis = {
    timestamp: new Date().toISOString(),
    successRates: {},
    uptimeAnomalies: [],
    failurePatterns: [],
    typeFailurePatterns: {},
    alerts: [],
  };

  // 1. Success rate by worker type
  try {
    const stats = getSummaryStats();
    for (const row of stats) {
      const type = row.templateType || 'unknown';
      analysis.successRates[type] = {
        total: row.total,
        successes: row.successes || 0,
        failures: row.failures || 0,
        rate: row.rate ?? 0,
      };

      if (row.total >= MIN_SAMPLE_SIZE && row.rate < THRESHOLD_WARNING) {
        const pct = (row.rate * 100).toFixed(1);
        const severity = row.rate < THRESHOLD_CRITICAL ? 'critical'
          : row.rate < THRESHOLD_DANGER ? 'warning'
          : 'info';
        const msg = `${type.toUpperCase()} workers at ${pct}% success rate (${severity})`;
        analysis.alerts.push({ severity, message: msg });
        console.log(`[InsightAnalyzer] ${msg}`);
      }

      // 2. Uptime anomalies
      if (row.avgUptime != null && row.total >= MIN_SAMPLE_SIZE) {
        if (row.avgUptime < UPTIME_TOO_SHORT) {
          const anomaly = { type, avgUptime: row.avgUptime, issue: 'too_short' };
          analysis.uptimeAnomalies.push(anomaly);
          console.log(`[InsightAnalyzer] ${type.toUpperCase()} avg uptime ${row.avgUptime}s — too short (likely crash)`);
        } else if (row.avgUptime > UPTIME_TOO_LONG) {
          const anomaly = { type, avgUptime: row.avgUptime, issue: 'too_long' };
          analysis.uptimeAnomalies.push(anomaly);
          console.log(`[InsightAnalyzer] ${type.toUpperCase()} avg uptime ${row.avgUptime}s — too long (likely stall)`);
        }
      }
    }
  } catch (err) {
    console.log(`[InsightAnalyzer] Error reading summary stats: ${err.message}`);
  }

  // 3. Global failure pattern clustering
  try {
    const failures = getRecentFailures(7);
    if (failures.length > 0) {
      analysis.failurePatterns = _clusterFailures(failures);
      if (analysis.failurePatterns.length > 0) {
        console.log(`[InsightAnalyzer] Found ${analysis.failurePatterns.length} failure pattern(s) in ${failures.length} recent failures`);
      }
    }
  } catch (err) {
    console.log(`[InsightAnalyzer] Error reading recent failures: ${err.message}`);
  }

  // 4. Per-type failure pattern extraction
  try {
    for (const [type, stats] of Object.entries(analysis.successRates)) {
      if (type === 'unknown' || stats.failures === 0) continue;
      const typeFailures = getRecentFailuresByType(type, 30);
      if (typeFailures.length > 0) {
        analysis.typeFailurePatterns[type] = _extractTypeFailureData(typeFailures);
      }
    }
  } catch (err) {
    console.log(`[InsightAnalyzer] Error extracting type failures: ${err.message}`);
  }

  latestAnalysis = analysis;

  // Run auto-tuner after analysis
  _runAutoTuner(analysis);

  return analysis;
}

// ============================================
// FAILURE CLUSTERING
// ============================================

/**
 * Group failures by common keywords in their learnings text.
 * @param {Array} failures - Failed learning entries
 * @returns {Array} Clustered failure patterns
 */
function _clusterFailures(failures) {
  const wordCounts = new Map();
  const wordToWorkers = new Map();

  for (const f of failures) {
    const text = (f.learnings || '') + ' ' + (f.label || '') + ' ' + (f.taskDescription || '');
    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOP_WORDS.has(w));

    // Deduplicate words per failure to avoid counting repeats within one entry
    const uniqueWords = new Set(words);
    for (const word of uniqueWords) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
      if (!wordToWorkers.has(word)) wordToWorkers.set(word, []);
      wordToWorkers.get(word).push(f.workerId);
    }
  }

  // Only keep words that appear in 2+ failures
  const patterns = [];
  for (const [word, count] of wordCounts) {
    if (count >= 2) {
      patterns.push({
        pattern: word,
        count,
        examples: wordToWorkers.get(word).slice(0, 5),
      });
    }
  }

  // Sort by frequency descending, take top 10
  patterns.sort((a, b) => b.count - a.count);
  return patterns.slice(0, 10);
}

/**
 * Check if a failure entry is a test scaffold worker (e.g. "IMPL: TEST: ...").
 * These are system validation workers deliberately killed during testing — not
 * real task failures — and should not pollute the auto-tuner analysis.
 * @param {Object} entry - Learning entry
 * @returns {boolean}
 */
function _isTestScaffold(entry) {
  if (!entry.label) return false;
  // After stripping the template prefix (e.g. "IMPL: "), if the remaining
  // label starts with "TEST:" it's a system test scaffold, not a real task.
  const stripped = entry.label.replace(/^(IMPL|FIX|REVIEW|TEST|RESEARCH|COLONEL|GENERAL):\s*/i, '');
  return /^TEST:/i.test(stripped);
}

/**
 * Check if a failure entry is an infrastructure artifact (e.g. orphaned e2e
 * test scaffolding stall-killed by the health monitor). These workers had no
 * task and no parent — they were never real work items.
 * @param {Object} entry - Learning entry
 * @returns {boolean}
 */
function _isInfrastructure(entry) {
  return (!entry.taskDescription || entry.taskDescription.trim() === '')
    && !entry.parentWorkerId;
}

/**
 * Extract failure data for a specific worker type: keywords, labels, and task snippets.
 * Excludes test scaffold workers (e.g. "IMPL: TEST: ...") to keep analysis signal clean.
 * @param {Array} typeFailures - Failed learning entries for one type
 * @returns {Object} { keywords: string[], failedTasks: string[], quotes: string[] }
 */
function _extractTypeFailureData(typeFailures) {
  // Filter out test scaffold workers and infrastructure artifacts — they are
  // deliberately killed or orphaned by e2e tests and produce misleading failure
  // examples for real workers.
  const realFailures = typeFailures.filter(f => !_isTestScaffold(f) && !_isInfrastructure(f));

  const keywords = _clusterFailures(realFailures)
    .slice(0, 5)
    .map(p => p.pattern);

  // Extract labels of failed tasks (clean up the label format)
  const failedTasks = realFailures
    .map(f => f.label || '')
    .filter(Boolean)
    .map(label => label.replace(/^(IMPL|FIX|REVIEW|TEST|RESEARCH|COLONEL|GENERAL):\s*/i, ''))
    .slice(0, 5);

  // Extract relevant quotes from learnings text or task descriptions
  const quotes = realFailures
    .map(f => {
      if (f.learnings) return f.learnings.substring(0, 150);
      if (f.taskDescription) {
        // Extract the PURPOSE line if present
        const purposeMatch = f.taskDescription.match(/PURPOSE:\s*(.+?)(?:\n|$)/);
        if (purposeMatch) return purposeMatch[1].trim().substring(0, 150);
        return f.taskDescription.substring(0, 150);
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, 3);

  return { keywords, failedTasks, quotes };
}

// ============================================
// AUTO-TUNER
// ============================================

/**
 * Generate and auto-apply tiered template overrides based on analysis.
 * @param {Object} analysis - The latest analysis result
 */
function _runAutoTuner(analysis) {
  const overrides = _readOverrides();
  let overridesChanged = false;

  // Clear any existing append_to_mission content — injection is permanently disabled
  for (const type of Object.keys(overrides.overrides)) {
    if (overrides.overrides[type].append_to_mission) {
      overrides.overrides[type].append_to_mission = '';
      overridesChanged = true;
    }
  }

  // Clear old investigation proposals — they are noise
  const oldProposalCount = proposals.length;
  proposals = [];
  if (oldProposalCount > 0) {
    console.log(`[AutoTuner] Cleared ${oldProposalCount} stale proposals`);
  }

  // Tiered auto-apply for worker types below threshold
  for (const [type, stats] of Object.entries(analysis.successRates)) {
    if (type === 'unknown' || stats.total < MIN_SAMPLE_SIZE) continue;

    // Skip types above warning threshold
    if (stats.rate >= THRESHOLD_WARNING) continue;

    const pct = (stats.rate * 100).toFixed(1);
    const typeData = analysis.typeFailurePatterns[type] || { keywords: [], failedTasks: [], quotes: [] };

    let warning;

    if (stats.rate < THRESHOLD_CRITICAL) {
      // CRITICAL tier (<80%): exact failure quotes + strongest warnings
      warning = _buildCriticalOverride(type, pct, stats, typeData);
    } else if (stats.rate < THRESHOLD_DANGER) {
      // DANGER tier (<90%): stronger warnings + specific failure patterns
      warning = _buildDangerOverride(type, pct, stats, typeData);
    } else {
      // WARNING tier (<95%): basic error recovery warnings
      warning = _buildWarningOverride(type, pct, stats, typeData);
    }

    if (!overrides.overrides[type]) {
      overrides.overrides[type] = {};
    }
    overrides.overrides[type].append_to_mission = ''; // analysis kept, injection disabled
    overrides.overrides[type].tier = stats.rate < THRESHOLD_CRITICAL ? 'critical'
      : stats.rate < THRESHOLD_DANGER ? 'danger' : 'warning';
    overrides.overrides[type].successRate = stats.rate;
    overrides.overrides[type].sampleSize = stats.total;
    overrides.overrides[type].updatedAt = new Date().toISOString();
    overridesChanged = true;
    console.log(`[AutoTuner] Auto-applied ${overrides.overrides[type].tier} override for ${type.toUpperCase()} (${pct}% success rate)`);
  }

  // Low-risk: add stability warnings for types with short uptime
  for (const anomaly of analysis.uptimeAnomalies) {
    if (anomaly.issue !== 'too_short') continue;

    const warning = `\nWARNING (auto-tuned): ${anomaly.type.toUpperCase()} workers have very short average uptime (${anomaly.avgUptime}s). This suggests crashes or premature exits. Ensure your environment is correct and dependencies are installed before starting work.`;

    if (!overrides.overrides[anomaly.type]) {
      overrides.overrides[anomaly.type] = {};
    }
    // Only set if no existing success-rate override already covers this
    if (!overrides.overrides[anomaly.type].append_to_mission) {
      overrides.overrides[anomaly.type].append_to_mission = ''; // analysis kept, injection disabled
      overridesChanged = true;
      console.log(`[AutoTuner] Applied override: ${anomaly.type.toUpperCase()} stability warning (avg uptime ${anomaly.avgUptime}s)`);
    }
  }

  // Write overrides if changed
  if (overridesChanged) {
    overrides.version = (overrides.version || 0) + 1;
    overrides.updatedAt = new Date().toISOString();
    _writeOverrides(overrides);
  }

  // Clean up overrides for types that have recovered above threshold
  _cleanRecoveredOverrides(analysis);
}

/**
 * Build WARNING tier override (<95% success rate).
 * Basic error recovery warnings.
 */
function _buildWarningOverride(type, pct, stats, typeData) {
  let warning = `\n⚠ AUTO-TUNED WARNING: ${type.toUpperCase()} workers have a ${pct}% success rate (${stats.failures} failures out of ${stats.total} total, based on ${stats.total} workers).`;
  warning += ' Double-check your approach before starting. Commit frequently. Signal progress early.';

  if (typeData.keywords.length > 0) {
    warning += ` Common failure keywords: ${typeData.keywords.join(', ')}.`;
  }

  if (typeData.failedTasks.length > 0) {
    warning += ` Previously failed tasks: ${typeData.failedTasks.join('; ')}.`;
  }

  return warning;
}

/**
 * Build DANGER tier override (<90% success rate).
 * Stronger warnings + specific failure patterns from learnings DB.
 */
function _buildDangerOverride(type, pct, stats, typeData) {
  let warning = `\n🚨 AUTO-TUNED DANGER: ${type.toUpperCase()} workers have a ${pct}% success rate (${stats.failures} failures out of ${stats.total} total, based on ${stats.total} workers). This type has a pattern of failures that you MUST avoid.`;

  if (typeData.failedTasks.length > 0) {
    warning += `\nPrevious workers failed on these tasks: ${typeData.failedTasks.join('; ')}.`;
  }

  if (typeData.keywords.length > 0) {
    warning += `\nCommon failure patterns: ${typeData.keywords.join(', ')}.`;
  }

  warning += '\nBEFORE STARTING: 1) Verify the task is achievable with available tools. 2) Check for blockers (permissions, missing deps). 3) Commit after every meaningful change. 4) Signal in_progress within 3 minutes. 5) If stuck after 3 attempts, signal blocked immediately.';

  return warning;
}

/**
 * Build CRITICAL tier override (<80% success rate).
 * Strongest warnings with exact failure quotes.
 */
function _buildCriticalOverride(type, pct, stats, typeData) {
  let warning = `\n🔴 CRITICAL AUTO-TUNED ALERT: ${type.toUpperCase()} workers have a ${pct}% success rate (${stats.failures} failures out of ${stats.total} total, based on ${stats.total} workers). MORE THAN 1 IN 5 WORKERS OF THIS TYPE FAIL.`;

  if (typeData.quotes.length > 0) {
    warning += '\nPrevious workers failed because:';
    for (const quote of typeData.quotes) {
      warning += `\n  - "${quote}"`;
    }
    warning += '\nAvoid these exact mistakes.';
  }

  if (typeData.failedTasks.length > 0) {
    warning += `\nFailed task examples: ${typeData.failedTasks.join('; ')}.`;
  }

  warning += '\nMANDATORY PRECAUTIONS: 1) Read ALL relevant files before making changes. 2) Verify environment and permissions FIRST. 3) Make smallest possible change, test, commit. 4) Signal in_progress within 2 minutes. 5) If ANYTHING seems wrong, signal blocked — do NOT push through blindly.';

  return warning;
}

/**
 * Remove overrides for worker types that have recovered above the warning threshold.
 */
function _cleanRecoveredOverrides(analysis) {
  const overrides = _readOverrides();
  let changed = false;

  for (const type of Object.keys(overrides.overrides)) {
    const stats = analysis.successRates[type];
    if (stats && stats.total >= MIN_SAMPLE_SIZE && stats.rate >= THRESHOLD_WARNING) {
      // Check uptime is also normal
      const uptimeAnomaly = analysis.uptimeAnomalies.find(a => a.type === type);
      if (!uptimeAnomaly) {
        delete overrides.overrides[type];
        changed = true;
        console.log(`[AutoTuner] Removed override: ${type.toUpperCase()} recovered above ${(THRESHOLD_WARNING * 100).toFixed(0)}% threshold`);
      }
    }
  }

  if (changed) {
    overrides.version = (overrides.version || 0) + 1;
    overrides.updatedAt = new Date().toISOString();
    _writeOverrides(overrides);
  }
}

// ============================================
// TEMPLATE OVERRIDES (file I/O)
// ============================================

function _readOverrides() {
  try {
    if (existsSync(OVERRIDES_PATH)) {
      return JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
    }
  } catch {
    // Fall through to default
  }
  return { version: 0, updatedAt: null, overrides: {} };
}

function _writeOverrides(data) {
  try {
    writeFileSync(OVERRIDES_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.log(`[AutoTuner] Failed to write overrides: ${err.message}`);
  }
}

// ============================================
// PROPOSAL MANAGEMENT
// ============================================

export function getProposals() {
  return proposals;
}

export function approveProposal(id) {
  const proposal = proposals.find(p => p.id === id);
  if (!proposal) return null;
  proposal.status = 'approved';
  proposal.approvedAt = new Date().toISOString();
  return proposal;
}

export function rejectProposal(id) {
  const proposal = proposals.find(p => p.id === id);
  if (!proposal) return null;
  proposal.status = 'rejected';
  proposal.rejectedAt = new Date().toISOString();
  return proposal;
}

// ============================================
// PUBLIC API
// ============================================

export function getLatestAnalysis() {
  return latestAnalysis;
}

export function getOverrides() {
  return _readOverrides();
}

/**
 * Trigger an analysis run (debounced). Call this when new learnings data arrives
 * to enable event-driven analysis instead of just polling.
 */
export function triggerAnalysis() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    try {
      runAnalysis();
      console.log('[InsightAnalyzer] Event-driven analysis completed');
    } catch (err) {
      console.log(`[InsightAnalyzer] Event-driven analysis failed: ${err.message}`);
    }
  }, DEBOUNCE_MS);
  if (debounceTimer.unref) debounceTimer.unref();
}

// ============================================
// LIFECYCLE
// ============================================

export function startInsightAnalyzer() {
  console.log('[InsightAnalyzer] Starting insight analyzer (10-min interval + event-driven)');

  // Run initial analysis immediately
  try {
    runAnalysis();
  } catch (err) {
    console.log(`[InsightAnalyzer] Initial analysis failed: ${err.message}`);
  }

  // Schedule recurring analysis
  analysisInterval = setInterval(() => {
    try {
      runAnalysis();
    } catch (err) {
      console.log(`[InsightAnalyzer] Scheduled analysis failed: ${err.message}`);
    }
  }, ANALYSIS_INTERVAL_MS);

  // Don't keep the process alive just for this interval
  if (analysisInterval.unref) {
    analysisInterval.unref();
  }
}

export function stopInsightAnalyzer() {
  if (analysisInterval) {
    clearInterval(analysisInterval);
    analysisInterval = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  console.log('[InsightAnalyzer] Stopped');
}
