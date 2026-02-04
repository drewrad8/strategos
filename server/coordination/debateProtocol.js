/**
 * Multi-Agent Debate Protocol
 *
 * Purpose: Improve factual accuracy and reasoning through structured debate.
 *
 * Research Basis: "Improving Factuality and Reasoning in Language Models through
 * Multiagent Debate" (Du et al., ICML 2024)
 *
 * Key insights from research:
 * - Multiple LLM instances debating reduce errors by 30%
 * - Structured rounds (generate → critique → revise) improve quality
 * - Consensus through agreement correlates with correctness
 * - Diverse initial positions lead to better outcomes
 */

import { v4 as uuidv4 } from 'uuid';

// ============================================
// CONSENSUS METHODS
// ============================================

export const ConsensusMethod = {
  MAJORITY_VOTE: 'majority_vote',
  WEIGHTED_VOTE: 'weighted_vote',
  UNANIMOUS: 'unanimous',
  CONVERGENCE: 'convergence'
};

// ============================================
// DEBATE PHASES
// ============================================

export const DebatePhase = {
  INITIAL: 'initial',
  CRITIQUE: 'critique',
  REVISION: 'revision',
  FINAL: 'final'
};

// ============================================
// DEBATE PROTOCOL CLASS
// ============================================

export class DebateProtocol {
  /**
   * @param {Object} options - Configuration options
   * @param {Object} options.workerManager - Strategos worker manager
   * @param {Object} options.io - Socket.io instance for real-time events
   * @param {number} options.numAgents - Number of debate agents (default: 3)
   * @param {number} options.numRounds - Maximum debate rounds (default: 3)
   * @param {string} options.consensusMethod - How to determine consensus
   * @param {number} options.consensusThreshold - Agreement threshold (default: 0.7)
   * @param {number} options.responseTimeout - Timeout per agent response in ms (default: 60000)
   */
  constructor(options = {}) {
    this.workerManager = options.workerManager;
    this.io = options.io;
    this.numAgents = options.numAgents || 3;
    this.numRounds = options.numRounds || 3;
    this.consensusMethod = options.consensusMethod || ConsensusMethod.MAJORITY_VOTE;
    this.consensusThreshold = options.consensusThreshold || 0.7;
    this.responseTimeout = options.responseTimeout || 60000;

    // Active debates tracking
    this.activeDebates = new Map();

    // Metrics
    this.metrics = {
      debatesStarted: 0,
      debatesCompleted: 0,
      consensusReached: 0,
      averageRounds: 0,
      totalRounds: 0,
      agentSpawnFailures: 0
    };
  }

  /**
   * Run a multi-agent debate on a problem
   *
   * @param {string} problem - The problem/question to debate
   * @param {Object} context - Additional context
   * @param {string} context.projectPath - Project for worker spawning
   * @param {string} context.taskType - Type of task (factual, reasoning, code)
   * @param {string} context.additionalContext - Extra context to provide
   * @returns {Promise<DebateResult>}
   */
  async runDebate(problem, context = {}) {
    const debateId = this.generateDebateId();
    this.metrics.debatesStarted++;

    const debateState = {
      id: debateId,
      problem,
      context,
      phase: DebatePhase.INITIAL,
      round: 0,
      agents: [],
      responses: [],
      history: [],
      startTime: Date.now()
    };

    this.activeDebates.set(debateId, debateState);
    this.emitEvent('debate:start', { debateId, problem, numAgents: this.numAgents });

    try {
      // Phase 1: Spawn debate agents
      const agents = await this.spawnDebateAgents(context.projectPath, debateId);
      debateState.agents = agents;

      if (agents.length < 2) {
        throw new Error('Failed to spawn minimum required agents for debate');
      }

      // Phase 2: Initial generation - each agent produces their answer
      let responses = await this.initialGeneration(agents, problem, context);
      debateState.responses = responses;
      debateState.history.push({ round: 0, phase: DebatePhase.INITIAL, responses: [...responses] });

      // Phase 3: Debate rounds
      for (let round = 1; round <= this.numRounds; round++) {
        debateState.round = round;
        this.metrics.totalRounds++;

        // Check for early consensus
        const earlyConsensus = this.checkConsensus(responses);
        if (earlyConsensus.reached) {
          return this.finalizeDebate(debateState, responses, round, earlyConsensus);
        }

        // Critique round - each agent critiques others' positions
        debateState.phase = DebatePhase.CRITIQUE;
        const critiques = await this.critiqueRound(agents, responses, round);

        // Revision round - each agent revises based on critiques
        debateState.phase = DebatePhase.REVISION;
        responses = await this.revisionRound(agents, responses, critiques, round);
        debateState.responses = responses;

        debateState.history.push({
          round,
          critiques,
          responses: [...responses]
        });

        this.emitEvent('debate:round_complete', {
          debateId,
          round,
          positions: responses.map(r => ({
            agentId: r.agentId,
            position: r.position?.substring(0, 100),
            confidence: r.confidence
          }))
        });
      }

      // Final consensus check
      const finalConsensus = this.checkConsensus(responses);
      return this.finalizeDebate(debateState, responses, this.numRounds, finalConsensus);

    } catch (error) {
      this.emitEvent('debate:error', { debateId, error: error.message });
      this.activeDebates.delete(debateId);
      throw error;
    }
  }

  /**
   * Spawn workers to participate in debate
   */
  async spawnDebateAgents(projectPath, debateId) {
    const agents = [];

    for (let i = 0; i < this.numAgents; i++) {
      const agentLabel = `DEBATE-${debateId}: Agent ${String.fromCharCode(65 + i)}`;

      try {
        // Use headless execution if workerManager supports it
        if (this.workerManager?.runHeadless) {
          agents.push({
            id: `debate-${debateId}-${i}`,
            label: agentLabel,
            index: i,
            isHeadless: true
          });
        } else if (this.workerManager?.spawnWorker) {
          const worker = await this.workerManager.spawnWorker(
            projectPath,
            agentLabel,
            this.io,
            {
              task: {
                description: 'Participate in multi-agent debate',
                type: 'debate',
                context: `You are Agent ${String.fromCharCode(65 + i)} in a structured debate.
                         You will: (1) Generate your position, (2) Critique others' positions,
                         (3) Revise based on critiques. Be rigorous but fair.`
              },
              autoAccept: true
            }
          );

          agents.push({
            id: worker.id,
            label: agentLabel,
            index: i,
            worker,
            isHeadless: false
          });
        } else {
          // Mock agent for testing
          agents.push({
            id: `mock-${debateId}-${i}`,
            label: agentLabel,
            index: i,
            isMock: true
          });
        }
      } catch (error) {
        console.warn(`[DebateProtocol] Failed to spawn agent ${i}:`, error.message);
        this.metrics.agentSpawnFailures++;
      }
    }

    return agents;
  }

  /**
   * Initial generation phase - each agent produces their answer
   */
  async initialGeneration(agents, problem, context) {
    const prompt = this.formatInitialPrompt(problem, context);

    const responsePromises = agents.map(async (agent) => {
      try {
        const response = await this.getAgentResponse(agent, prompt, context);
        return {
          agentId: agent.id,
          agentLabel: agent.label,
          position: response,
          confidence: this.extractConfidence(response),
          round: 0
        };
      } catch (error) {
        return {
          agentId: agent.id,
          agentLabel: agent.label,
          position: null,
          confidence: 0,
          round: 0,
          error: error.message
        };
      }
    });

    return Promise.all(responsePromises);
  }

  /**
   * Critique round - each agent critiques others' positions
   */
  async critiqueRound(agents, responses, round) {
    const critiquePromises = agents.map(async (agent, i) => {
      // Get other agents' positions (exclude self)
      const otherPositions = responses
        .filter((_, j) => j !== i)
        .map((r, j) => ({
          agent: r.agentLabel || `Agent ${String.fromCharCode(65 + (j >= i ? j + 1 : j))}`,
          position: r.position
        }));

      const prompt = this.formatCritiquePrompt(otherPositions, round);

      try {
        const critiqueResponse = await this.getAgentResponse(agent, prompt, { round });
        return {
          agentId: agent.id,
          critiques: this.parseCritiques(critiqueResponse),
          rawResponse: critiqueResponse,
          round
        };
      } catch (error) {
        return {
          agentId: agent.id,
          critiques: [],
          error: error.message,
          round
        };
      }
    });

    return Promise.all(critiquePromises);
  }

  /**
   * Revision round - each agent revises based on critiques received
   */
  async revisionRound(agents, responses, critiques, round) {
    const revisionPromises = agents.map(async (agent, i) => {
      // Collect critiques directed at this agent
      const receivedCritiques = critiques
        .filter((_, j) => j !== i) // From other agents
        .flatMap(c => c.critiques)
        .filter(cr => !cr.targetAgent || cr.targetAgent === agent.label);

      const currentPosition = responses[i]?.position || '';
      const prompt = this.formatRevisionPrompt(currentPosition, receivedCritiques, round);

      try {
        const revision = await this.getAgentResponse(agent, prompt, { round });
        return {
          agentId: agent.id,
          agentLabel: agent.label,
          position: revision,
          confidence: this.extractConfidence(revision),
          round,
          previousPosition: currentPosition,
          critiquesReceived: receivedCritiques.length
        };
      } catch (error) {
        // Keep previous position on error
        return {
          ...responses[i],
          round,
          error: error.message
        };
      }
    });

    return Promise.all(revisionPromises);
  }

  /**
   * Get response from an agent
   */
  async getAgentResponse(agent, prompt, context = {}) {
    // Headless execution through workerManager
    if (agent.isHeadless && this.workerManager?.runHeadless) {
      const result = await this.workerManager.runHeadless(
        prompt,
        context.projectPath || process.cwd(),
        { timeout: this.responseTimeout }
      );
      return result.output || result;
    }

    // Real worker communication
    if (agent.worker && this.workerManager?.sendInput) {
      await this.workerManager.sendInput(agent.id, prompt);

      // Wait for response with timeout
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Agent response timeout'));
        }, this.responseTimeout);

        // Poll for output (simplified - real impl would use events)
        const checkOutput = async () => {
          try {
            const output = await this.workerManager.getWorkerOutput?.(agent.id);
            if (output && output.length > 0) {
              clearTimeout(timeout);
              resolve(output);
            } else {
              setTimeout(checkOutput, 1000);
            }
          } catch (e) {
            // Continue polling
            setTimeout(checkOutput, 1000);
          }
        };
        checkOutput();
      });
    }

    // Mock response for testing
    if (agent.isMock) {
      return this.generateMockResponse(prompt, agent, context);
    }

    throw new Error('No valid method to get agent response');
  }

  /**
   * Generate mock response for testing
   */
  generateMockResponse(prompt, agent, context) {
    const agentLetter = String.fromCharCode(65 + agent.index);

    if (prompt.includes('CRITIQUE PHASE')) {
      return `CRITIQUE OF Agent ${agentLetter === 'A' ? 'B' : 'A'}: The reasoning could be stronger.
STRENGTHS: Good initial approach
WEAKNESSES: Missing edge cases`;
    }

    if (prompt.includes('REVISION PHASE')) {
      return `REVISED POSITION: Updated answer incorporating feedback
REASONING: Considered critiques and refined position
CHANGES MADE: Addressed edge cases mentioned in critique
CONFIDENCE: 75%`;
    }

    return `POSITION: Initial position from Agent ${agentLetter}
REASONING: Based on analysis of the problem
CONFIDENCE: ${60 + agent.index * 10}%`;
  }

  /**
   * Check if consensus has been reached
   */
  checkConsensus(responses) {
    const validResponses = responses.filter(r => r.position && !r.error);

    if (validResponses.length < 2) {
      return { reached: false, reason: 'insufficient_responses' };
    }

    switch (this.consensusMethod) {
      case ConsensusMethod.MAJORITY_VOTE:
        return this.checkMajorityConsensus(validResponses);
      case ConsensusMethod.WEIGHTED_VOTE:
        return this.checkWeightedConsensus(validResponses);
      case ConsensusMethod.UNANIMOUS:
        return this.checkUnanimousConsensus(validResponses);
      case ConsensusMethod.CONVERGENCE:
        return this.checkConvergenceConsensus(validResponses);
      default:
        return this.checkMajorityConsensus(validResponses);
    }
  }

  /**
   * Check for majority consensus
   */
  checkMajorityConsensus(responses) {
    // Extract core positions
    const positions = responses.map(r => this.extractCorePosition(r.position));

    // Count position frequencies
    const positionCounts = new Map();
    for (const pos of positions) {
      positionCounts.set(pos, (positionCounts.get(pos) || 0) + 1);
    }

    // Find majority
    const threshold = Math.ceil(responses.length * this.consensusThreshold);
    for (const [position, count] of positionCounts) {
      if (count >= threshold) {
        // Find the full response for this position
        const majorityResponse = responses.find(
          r => this.extractCorePosition(r.position) === position
        );
        return {
          reached: true,
          position: majorityResponse?.position || position,
          agreement: count / responses.length,
          method: ConsensusMethod.MAJORITY_VOTE,
          supportingAgents: responses
            .filter(r => this.extractCorePosition(r.position) === position)
            .map(r => r.agentId)
        };
      }
    }

    return { reached: false, method: ConsensusMethod.MAJORITY_VOTE };
  }

  /**
   * Check for weighted consensus (by confidence)
   */
  checkWeightedConsensus(responses) {
    // Group by core position with weighted scores
    const positionScores = new Map();
    let totalWeight = 0;

    for (const response of responses) {
      const position = this.extractCorePosition(response.position);
      const weight = response.confidence || 0.5;
      totalWeight += weight;
      positionScores.set(position, (positionScores.get(position) || 0) + weight);
    }

    // Find highest weighted position
    let maxPosition = null;
    let maxScore = 0;
    for (const [position, score] of positionScores) {
      if (score > maxScore) {
        maxScore = score;
        maxPosition = position;
      }
    }

    const weightedAgreement = totalWeight > 0 ? maxScore / totalWeight : 0;

    if (weightedAgreement >= this.consensusThreshold) {
      const majorityResponse = responses.find(
        r => this.extractCorePosition(r.position) === maxPosition
      );
      return {
        reached: true,
        position: majorityResponse?.position || maxPosition,
        agreement: weightedAgreement,
        method: ConsensusMethod.WEIGHTED_VOTE
      };
    }

    return { reached: false, method: ConsensusMethod.WEIGHTED_VOTE };
  }

  /**
   * Check for unanimous consensus
   */
  checkUnanimousConsensus(responses) {
    const positions = responses.map(r => this.extractCorePosition(r.position));
    const uniquePositions = new Set(positions);

    if (uniquePositions.size === 1) {
      return {
        reached: true,
        position: responses[0].position,
        agreement: 1.0,
        method: ConsensusMethod.UNANIMOUS
      };
    }

    return { reached: false, method: ConsensusMethod.UNANIMOUS };
  }

  /**
   * Check for convergence (positions getting closer)
   */
  checkConvergenceConsensus(responses) {
    // For simplicity, check if all positions are semantically similar
    // In a full implementation, this would use embeddings
    const positions = responses.map(r => this.extractCorePosition(r.position));

    // Check pairwise similarity
    let similarPairs = 0;
    let totalPairs = 0;

    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        totalPairs++;
        if (this.arePositionsSimilar(positions[i], positions[j])) {
          similarPairs++;
        }
      }
    }

    const convergenceScore = totalPairs > 0 ? similarPairs / totalPairs : 0;

    if (convergenceScore >= this.consensusThreshold) {
      // Find most confident response as representative
      const bestResponse = responses.reduce((a, b) =>
        (a.confidence || 0) > (b.confidence || 0) ? a : b
      );
      return {
        reached: true,
        position: bestResponse.position,
        agreement: convergenceScore,
        method: ConsensusMethod.CONVERGENCE
      };
    }

    return { reached: false, method: ConsensusMethod.CONVERGENCE };
  }

  /**
   * Check if two positions are semantically similar
   */
  arePositionsSimilar(pos1, pos2) {
    // Simple word overlap check (real impl would use embeddings)
    const words1 = new Set(pos1.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const words2 = new Set(pos2.toLowerCase().split(/\s+/).filter(w => w.length > 3));

    const intersection = [...words1].filter(w => words2.has(w));
    const union = new Set([...words1, ...words2]);

    const jaccard = union.size > 0 ? intersection.length / union.size : 0;
    return jaccard > 0.3; // 30% word overlap threshold
  }

  /**
   * Finalize debate and clean up
   */
  async finalizeDebate(debateState, responses, finalRound, consensus) {
    const debateId = debateState.id;

    this.metrics.debatesCompleted++;
    if (consensus.reached) {
      this.metrics.consensusReached++;
    }

    // Update average rounds
    this.metrics.averageRounds = this.metrics.debatesCompleted > 0
      ? this.metrics.totalRounds / this.metrics.debatesCompleted
      : 0;

    // Cleanup workers if they were spawned
    for (const agent of debateState.agents) {
      if (agent.worker && this.workerManager?.killWorker) {
        try {
          await this.workerManager.killWorker(agent.id, this.io);
        } catch (e) {
          // Worker may already be gone
        }
      }
    }

    const result = {
      debateId,
      consensusReached: consensus.reached,
      finalPosition: consensus.reached
        ? consensus.position
        : this.selectBestPosition(responses),
      agreement: consensus.agreement || 0,
      rounds: finalRound,
      method: this.consensusMethod,
      allPositions: responses.map(r => ({
        agentId: r.agentId,
        agentLabel: r.agentLabel,
        position: r.position,
        confidence: r.confidence
      })),
      history: debateState.history,
      metadata: {
        duration: Date.now() - debateState.startTime,
        agentCount: debateState.agents.length,
        problem: debateState.problem
      }
    };

    this.activeDebates.delete(debateId);
    this.emitEvent('debate:complete', result);

    return result;
  }

  // ============================================
  // PROMPT FORMATTING
  // ============================================

  formatInitialPrompt(problem, context) {
    return `You are participating in a structured multi-agent debate to find the most accurate answer.

PROBLEM:
${problem}

${context.additionalContext ? `CONTEXT:\n${context.additionalContext}\n` : ''}

Instructions:
1. Analyze the problem carefully
2. Provide your position/answer
3. Include your reasoning
4. Rate your confidence (0-100%)

Format your response as:
POSITION: [Your answer]
REASONING: [Your reasoning]
CONFIDENCE: [0-100]%`;
  }

  formatCritiquePrompt(otherPositions, round) {
    const positionsText = otherPositions
      .map(p => `${p.agent}:\n${p.position}`)
      .join('\n\n---\n\n');

    return `DEBATE ROUND ${round} - CRITIQUE PHASE

Other agents have provided these positions:

${positionsText}

Instructions:
1. Identify strengths and weaknesses in each position
2. Point out logical errors or factual inaccuracies
3. Note areas of agreement
4. Be rigorous but fair

Format your critiques as:
CRITIQUE OF [Agent Name]: [Your critique]
STRENGTHS: [What they got right]
WEAKNESSES: [Issues with their position]`;
  }

  formatRevisionPrompt(currentPosition, critiques, round) {
    const critiquesText = critiques.length > 0
      ? critiques.map(c => `- ${c.content}`).join('\n')
      : 'No specific critiques received.';

    return `DEBATE ROUND ${round} - REVISION PHASE

Your current position:
${currentPosition}

Critiques received:
${critiquesText}

Instructions:
1. Consider the critiques carefully
2. Revise your position if the critiques have merit
3. Defend your position if you disagree with critiques
4. Update your confidence level

Format your response as:
REVISED POSITION: [Your updated answer]
REASONING: [Your updated reasoning]
CHANGES MADE: [What you changed and why, or why you maintained your position]
CONFIDENCE: [0-100]%`;
  }

  // ============================================
  // PARSING HELPERS
  // ============================================

  extractConfidence(response) {
    if (!response) return 0.5;
    const match = response.match(/CONFIDENCE:\s*(\d+)/i);
    return match ? parseInt(match[1]) / 100 : 0.5;
  }

  extractCorePosition(response) {
    if (!response) return '';
    const match = response.match(/(?:REVISED )?POSITION:\s*(.+?)(?:\n|REASONING|$)/is);
    return match ? match[1].trim().toLowerCase().substring(0, 200) : response.substring(0, 200).toLowerCase();
  }

  parseCritiques(critiqueText) {
    if (!critiqueText) return [];

    const critiques = [];
    const matches = critiqueText.matchAll(/CRITIQUE OF (\w+(?:\s+\w+)?):\s*(.+?)(?=CRITIQUE OF|\n\n|STRENGTHS|$)/gis);

    for (const match of matches) {
      critiques.push({
        targetAgent: match[1].trim(),
        content: match[2].trim()
      });
    }

    // Also extract strengths/weaknesses if present
    const strengthsMatch = critiqueText.match(/STRENGTHS:\s*(.+?)(?=WEAKNESSES|$)/is);
    const weaknessesMatch = critiqueText.match(/WEAKNESSES:\s*(.+?)$/is);

    if (strengthsMatch || weaknessesMatch) {
      critiques.push({
        targetAgent: 'general',
        content: critiqueText,
        strengths: strengthsMatch?.[1]?.trim(),
        weaknesses: weaknessesMatch?.[1]?.trim()
      });
    }

    return critiques.length > 0 ? critiques : [{ targetAgent: 'general', content: critiqueText }];
  }

  selectBestPosition(responses) {
    // Select highest confidence response
    const validResponses = responses.filter(r => r.position && !r.error);
    if (validResponses.length === 0) return null;

    return validResponses.reduce((best, current) =>
      (current.confidence || 0) > (best.confidence || 0) ? current : best
    ).position;
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  generateDebateId() {
    return uuidv4().slice(0, 8);
  }

  emitEvent(event, data) {
    if (this.io) {
      this.io.emit(event, data);
    }
  }

  getMetrics() {
    return { ...this.metrics };
  }

  resetMetrics() {
    this.metrics = {
      debatesStarted: 0,
      debatesCompleted: 0,
      consensusReached: 0,
      averageRounds: 0,
      totalRounds: 0,
      agentSpawnFailures: 0
    };
  }

  getActiveDebates() {
    return Array.from(this.activeDebates.values()).map(d => ({
      id: d.id,
      problem: d.problem.substring(0, 100),
      phase: d.phase,
      round: d.round,
      agentCount: d.agents.length
    }));
  }
}

export default DebateProtocol;
