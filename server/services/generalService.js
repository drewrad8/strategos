/**
 * General Service - CC-DC-DE Command Structure
 *
 * Implements military-inspired command hierarchy:
 * - Centralized Command (CC): Strategic objectives, commander's intent
 * - Distributed Control (DC): Domain supervisors, authority delegation
 * - Decentralized Execution (DE): Worker autonomy within boundaries
 *
 * Based on research: 12-military-command-structures.md, 12-ai-delegation-orchestration.md
 */

import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// ENUMS & CONSTANTS
// ============================================================================

export const CommandLevel = {
  STRATEGIC: 'strategic',    // User/System - defines objectives
  OPERATIONAL: 'operational', // Supervisors - translates to operations
  TACTICAL: 'tactical',      // Workers - executes specific missions
  ENGAGEMENT: 'engagement'   // Individual tasks - direct action
};

export const AutonomyLevel = {
  WEAPONS_HOLD: 1,    // Must confirm every action
  WEAPONS_TIGHT: 2,   // Act only on whitelisted actions
  WEAPONS_FREE: 3,    // Act within intent, report exceptions (DEFAULT)
  FULL_AUTONOMY: 4    // Independent operation, periodic check-in
};

export const DomainType = {
  S2_INTELLIGENCE: 's2-intelligence',  // Research, analysis, information gathering
  S3_OPERATIONS: 's3-operations',       // Coding, implementation, execution
  S4_LOGISTICS: 's4-logistics',         // Testing, deployment, infrastructure
  S6_COMMUNICATIONS: 's6-communications' // Integration, API coordination
};

export const MissionStatus = {
  PLANNING: 'planning',
  BRIEFING: 'briefing',
  EXECUTING: 'executing',
  VERIFYING: 'verifying',
  COMPLETE: 'complete',
  FAILED: 'failed',
  ABORTED: 'aborted'
};

export const EscalationTrigger = {
  IMMEDIATE: 'immediate',   // Safety, unrecoverable errors, budget exhaustion
  PRIORITY: 'priority',     // Plan deviation, new dependencies, low confidence
  ROUTINE: 'routine'        // Completion, checkpoints, status updates
};

// OODA Loop phases
export const OODAPhase = {
  OBSERVE: 'observe',   // Gather current state
  ORIENT: 'orient',     // Interpret through context
  DECIDE: 'decide',     // Select course of action
  ACT: 'act'           // Execute decision
};

// ============================================================================
// COMMANDER'S INTENT
// ============================================================================

/**
 * Commander's Intent - The most critical element of Mission Command
 * Communicates: Purpose, Key Tasks, End State, Risk Tolerance
 */
export class CommandersIntent {
  constructor({
    purpose = '',
    keyTasks = [],
    endState = '',
    riskTolerance = 'moderate',
    constraints = [],
    freedoms = []
  }) {
    this.purpose = purpose;           // Why we are doing this
    this.keyTasks = keyTasks;         // Essential actions that must occur
    this.endState = endState;         // What success looks like
    this.riskTolerance = riskTolerance; // 'low', 'moderate', 'high'
    this.constraints = constraints;   // Things we must NOT do
    this.freedoms = freedoms;         // Areas where agent has discretion
  }

  /**
   * Generate intent statement in military format
   */
  toStatement() {
    return `In order to ${this.purpose}, we will ${this.keyTasks.join(', ')} ` +
           `to achieve ${this.endState} while accepting ${this.riskTolerance} risk.`;
  }

  /**
   * Generate XML context for worker injection
   */
  toXML() {
    return `<commanders_intent>
  <purpose>${this.purpose}</purpose>
  <key_tasks>
${this.keyTasks.map(t => `    <task>${t}</task>`).join('\n')}
  </key_tasks>
  <end_state>${this.endState}</end_state>
  <risk_tolerance>${this.riskTolerance}</risk_tolerance>
  <constraints>
${this.constraints.map(c => `    <constraint>${c}</constraint>`).join('\n')}
  </constraints>
  <freedoms>
${this.freedoms.map(f => `    <freedom>${f}</freedom>`).join('\n')}
  </freedoms>
</commanders_intent>`;
  }

  static fromTask(task, projectPath) {
    // Parse a task string into commander's intent
    return new CommandersIntent({
      purpose: task,
      keyTasks: ['Complete the assigned task', 'Verify results before completion'],
      endState: 'Task successfully completed and verified',
      riskTolerance: 'moderate',
      constraints: [
        'Do not modify files outside project directory',
        'Do not skip verification steps',
        'Escalate when confidence below 70%'
      ],
      freedoms: [
        'Choose implementation approach',
        'Select appropriate tools',
        'Determine subtask ordering'
      ]
    });
  }
}

// ============================================================================
// MISSION ORDER (OPORD)
// ============================================================================

/**
 * Mission Order - Structured task assignment based on military OPORD format
 */
export class MissionOrder {
  constructor({
    missionId = uuidv4(),
    situation = {},
    mission = '',
    intent = null,
    execution = {},
    sustainment = {},
    commandAndSignal = {}
  }) {
    this.missionId = missionId;
    this.createdAt = new Date().toISOString();
    this.status = MissionStatus.PLANNING;

    // 1. SITUATION
    this.situation = {
      background: situation.background || '',
      dependencies: situation.dependencies || [],
      constraints: situation.constraints || [],
      currentState: situation.currentState || {}
    };

    // 2. MISSION (one sentence: WHO, WHAT, WHERE, WHEN, WHY)
    this.mission = mission;

    // 3. COMMANDER'S INTENT
    this.intent = intent instanceof CommandersIntent
      ? intent
      : new CommandersIntent(intent || {});

    // 4. EXECUTION
    this.execution = {
      concept: execution.concept || '',
      tasks: execution.tasks || [],
      coordination: execution.coordination || []
    };

    // 5. SUSTAINMENT
    this.sustainment = {
      resources: sustainment.resources || [],
      support: sustainment.support || {}
    };

    // 6. COMMAND AND SIGNAL
    this.commandAndSignal = {
      reporting: commandAndSignal.reporting || [],
      escalation: commandAndSignal.escalation || [],
      communication: commandAndSignal.communication || {}
    };

    // Tracking
    this.assignedWorkers = [];
    this.progress = {
      completedTasks: [],
      currentPhase: null,
      percentComplete: 0
    };
  }

  toXML() {
    return `<mission_order id="${this.missionId}">
  <situation>
    <background>${this.situation.background}</background>
    <dependencies>
${this.situation.dependencies.map(d => `      <dependency>${d}</dependency>`).join('\n')}
    </dependencies>
    <constraints>
${this.situation.constraints.map(c => `      <constraint>${c}</constraint>`).join('\n')}
    </constraints>
  </situation>

  <mission>${this.mission}</mission>

  ${this.intent.toXML()}

  <execution>
    <concept>${this.execution.concept}</concept>
    <tasks>
${this.execution.tasks.map((t, i) => `      <task priority="${i + 1}">${t}</task>`).join('\n')}
    </tasks>
    <coordination>
${this.execution.coordination.map(c => `      <item>${c}</item>`).join('\n')}
    </coordination>
  </execution>

  <sustainment>
    <resources>
${this.sustainment.resources.map(r => `      <resource>${r}</resource>`).join('\n')}
    </resources>
  </sustainment>

  <command_and_signal>
    <reporting>
${this.commandAndSignal.reporting.map(r => `      <requirement>${r}</requirement>`).join('\n')}
    </reporting>
    <escalation>
${this.commandAndSignal.escalation.map(e => `      <trigger>${e}</trigger>`).join('\n')}
    </escalation>
  </command_and_signal>
</mission_order>`;
  }
}

// ============================================================================
// OODA LOOP IMPLEMENTATION
// ============================================================================

/**
 * OODA Loop - Observe, Orient, Decide, Act decision cycle
 * Based on Boyd's military doctrine for competitive advantage through faster cycles
 */
export class OODALoop {
  constructor(agentId, context = {}) {
    this.agentId = agentId;
    this.context = context;
    this.phase = OODAPhase.OBSERVE;
    this.cycleCount = 0;
    this.history = [];
    this.experience = []; // Learn from past cycles
  }

  /**
   * OBSERVE: Gather current state from environment
   */
  async observe(sensors = {}) {
    this.phase = OODAPhase.OBSERVE;

    const observations = {
      timestamp: new Date().toISOString(),
      environment: sensors.environment || {},
      workerStates: sensors.workerStates || [],
      taskQueue: sensors.taskQueue || [],
      errors: sensors.errors || [],
      metrics: sensors.metrics || {}
    };

    this.history.push({
      phase: OODAPhase.OBSERVE,
      data: observations,
      timestamp: observations.timestamp
    });

    return observations;
  }

  /**
   * ORIENT: Interpret observations through context and experience
   * Boyd considered this the most critical phase
   */
  async orient(observations) {
    this.phase = OODAPhase.ORIENT;

    // Orientation factors (Boyd's model):
    // - Genetic heritage (model training) - represented by base capabilities
    // - Cultural traditions (system prompt) - represented by context
    // - Previous experience - represented by experience array
    // - Analysis/synthesis - explicit reasoning

    const orientation = {
      timestamp: new Date().toISOString(),
      situation: this.analyzeSituation(observations),
      threats: this.identifyThreats(observations),
      opportunities: this.identifyOpportunities(observations),
      recommendations: this.synthesizeRecommendations(observations),
      confidence: this.calculateConfidence(observations)
    };

    this.history.push({
      phase: OODAPhase.ORIENT,
      data: orientation,
      timestamp: orientation.timestamp
    });

    return orientation;
  }

  /**
   * DECIDE: Select course of action based on orientation
   */
  async decide(orientation) {
    this.phase = OODAPhase.DECIDE;

    const decision = {
      timestamp: new Date().toISOString(),
      selectedAction: null,
      alternatives: [],
      rationale: '',
      riskLevel: 'moderate',
      requiresEscalation: false
    };

    // Determine best action based on orientation
    if (orientation.threats.length > 0 && orientation.confidence < 0.7) {
      decision.selectedAction = 'escalate';
      decision.requiresEscalation = true;
      decision.rationale = 'Low confidence with active threats';
    } else if (orientation.opportunities.length > 0) {
      decision.selectedAction = 'execute_opportunity';
      decision.rationale = 'Opportunities identified with acceptable risk';
    } else if (orientation.situation.needsAttention) {
      decision.selectedAction = 'intervene';
      decision.rationale = 'Situation requires attention';
    } else {
      decision.selectedAction = 'maintain';
      decision.rationale = 'Situation stable, continue current course';
    }

    this.history.push({
      phase: OODAPhase.DECIDE,
      data: decision,
      timestamp: decision.timestamp
    });

    return decision;
  }

  /**
   * ACT: Execute the decision
   */
  async act(decision, executor = null) {
    this.phase = OODAPhase.ACT;

    const action = {
      timestamp: new Date().toISOString(),
      decision: decision.selectedAction,
      executed: false,
      result: null,
      error: null
    };

    try {
      if (executor && typeof executor === 'function') {
        action.result = await executor(decision);
        action.executed = true;
      }
    } catch (error) {
      action.error = error.message;
    }

    // Update experience for learning
    this.experience.push({
      cycleNumber: this.cycleCount,
      decision: decision.selectedAction,
      success: action.executed && !action.error,
      timestamp: action.timestamp
    });

    this.history.push({
      phase: OODAPhase.ACT,
      data: action,
      timestamp: action.timestamp
    });

    this.cycleCount++;
    this.phase = OODAPhase.OBSERVE; // Reset for next cycle

    return action;
  }

  // Helper methods for orientation phase
  analyzeSituation(obs) {
    return {
      activeWorkers: obs.workerStates?.filter(w => w.status === 'working').length || 0,
      pendingTasks: obs.taskQueue?.length || 0,
      errorRate: obs.errors?.length > 0 ? obs.errors.length / (obs.workerStates?.length || 1) : 0,
      needsAttention: obs.errors?.length > 0 || false
    };
  }

  identifyThreats(obs) {
    const threats = [];
    if (obs.errors?.length > 3) threats.push({ type: 'high_error_rate', severity: 'high' });
    if (obs.metrics?.memoryUsage > 0.9) threats.push({ type: 'resource_exhaustion', severity: 'medium' });
    return threats;
  }

  identifyOpportunities(obs) {
    const opportunities = [];
    if (obs.taskQueue?.length > 0 && obs.workerStates?.filter(w => w.status === 'idle').length > 0) {
      opportunities.push({ type: 'idle_workers', action: 'assign_tasks' });
    }
    return opportunities;
  }

  synthesizeRecommendations(obs) {
    const recs = [];
    const situation = this.analyzeSituation(obs);
    if (situation.errorRate > 0.2) recs.push('Investigate error causes');
    if (situation.pendingTasks > situation.activeWorkers * 2) recs.push('Consider spawning more workers');
    return recs;
  }

  calculateConfidence(obs) {
    // Simple confidence calculation based on data quality
    let confidence = 1.0;
    if (!obs.workerStates?.length) confidence -= 0.3;
    if (obs.errors?.length > 0) confidence -= 0.1 * Math.min(obs.errors.length, 3);
    return Math.max(0, confidence);
  }

  /**
   * Run a complete OODA cycle
   */
  async runCycle(sensors = {}, executor = null) {
    const observations = await this.observe(sensors);
    const orientation = await this.orient(observations);
    const decision = await this.decide(orientation);
    const action = await this.act(decision, executor);

    return {
      cycleNumber: this.cycleCount,
      observations,
      orientation,
      decision,
      action
    };
  }

  getMetrics() {
    return {
      agentId: this.agentId,
      totalCycles: this.cycleCount,
      currentPhase: this.phase,
      successRate: this.experience.filter(e => e.success).length / Math.max(this.experience.length, 1),
      historyLength: this.history.length
    };
  }
}

// ============================================================================
// DOMAIN SUPERVISOR (Distributed Control)
// ============================================================================

/**
 * Domain Supervisor - Manages a specific domain/function area
 * Based on military S1-S6 staff structure
 */
export class DomainSupervisor {
  constructor({
    domain,
    maxWorkers = 5,
    capabilities = [],
    workerManager = null
  }) {
    this.id = uuidv4();
    this.domain = domain;
    this.maxWorkers = maxWorkers;
    this.capabilities = capabilities;
    this.workerManager = workerManager;
    this.assignedWorkers = new Map();
    this.taskQueue = [];
    this.oodaLoop = new OODALoop(`supervisor-${domain}`, { domain });
  }

  /**
   * Determine if this supervisor can handle a task type
   */
  canHandle(taskType) {
    const domainMappings = {
      [DomainType.S2_INTELLIGENCE]: ['research', 'analysis', 'investigate', 'document'],
      [DomainType.S3_OPERATIONS]: ['implement', 'code', 'refactor', 'fix', 'create'],
      [DomainType.S4_LOGISTICS]: ['test', 'deploy', 'build', 'lint', 'verify'],
      [DomainType.S6_COMMUNICATIONS]: ['integrate', 'api', 'coordinate', 'connect']
    };

    const keywords = domainMappings[this.domain] || [];
    const taskLower = taskType.toLowerCase();
    return keywords.some(kw => taskLower.includes(kw));
  }

  /**
   * Route a task to an appropriate worker
   */
  async assignTask(task, intent) {
    // Check span of control
    if (this.assignedWorkers.size >= this.maxWorkers) {
      return {
        success: false,
        reason: 'max_workers_reached',
        suggestion: 'Queue task or escalate'
      };
    }

    // If workerManager available, spawn worker
    if (this.workerManager) {
      const worker = await this.workerManager.spawnWorker({
        projectPath: task.projectPath,
        task: task.description,
        label: `${this.domain}:${task.label || 'task'}`,
        context: {
          domain: this.domain,
          supervisorId: this.id,
          intent: intent?.toXML() || ''
        }
      });

      if (worker) {
        this.assignedWorkers.set(worker.id, {
          worker,
          task,
          assignedAt: new Date().toISOString(),
          status: 'active'
        });

        return {
          success: true,
          workerId: worker.id,
          supervisorId: this.id,
          domain: this.domain
        };
      }
    }

    // Queue for later assignment
    this.taskQueue.push({ task, intent, queuedAt: new Date().toISOString() });
    return {
      success: false,
      reason: 'queued',
      queuePosition: this.taskQueue.length
    };
  }

  /**
   * Check status of all assigned workers
   */
  getStatus() {
    return {
      supervisorId: this.id,
      domain: this.domain,
      activeWorkers: this.assignedWorkers.size,
      maxWorkers: this.maxWorkers,
      queueDepth: this.taskQueue.length,
      workers: Array.from(this.assignedWorkers.entries()).map(([id, data]) => ({
        id,
        status: data.status,
        task: data.task.description?.substring(0, 100),
        assignedAt: data.assignedAt
      }))
    };
  }

  /**
   * Worker completed task
   */
  workerCompleted(workerId, result) {
    const assignment = this.assignedWorkers.get(workerId);
    if (assignment) {
      assignment.status = 'completed';
      assignment.result = result;
      assignment.completedAt = new Date().toISOString();
    }
    // Don't remove - keep for history/metrics
  }

  /**
   * Worker failed
   */
  workerFailed(workerId, error) {
    const assignment = this.assignedWorkers.get(workerId);
    if (assignment) {
      assignment.status = 'failed';
      assignment.error = error;
      assignment.failedAt = new Date().toISOString();
    }
  }
}

// ============================================================================
// GENERAL SERVICE (Main CC-DC-DE Implementation)
// ============================================================================

export class GeneralService {
  constructor({
    workerManager = null,
    io = null,
    verificationService = null,
    selfOptimizeService = null
  }) {
    this.workerManager = workerManager;
    this.io = io;
    this.verificationService = verificationService;
    this.selfOptimizeService = selfOptimizeService;

    // CC Layer - Active missions
    this.missions = new Map();

    // DC Layer - Domain supervisors
    this.supervisors = new Map();
    this.initializeSupervisors();

    // DE Layer - OODA loop for orchestrator
    this.orchestratorOODA = new OODALoop('general-orchestrator');

    // Metrics
    this.metrics = {
      missionsCreated: 0,
      missionsCompleted: 0,
      missionsFailed: 0,
      tasksRouted: 0,
      escalations: 0,
      oodaCycles: 0
    };
  }

  /**
   * Initialize domain supervisors (S2-S6 structure)
   */
  initializeSupervisors() {
    // S2 - Intelligence (Research, Analysis)
    this.supervisors.set(DomainType.S2_INTELLIGENCE, new DomainSupervisor({
      domain: DomainType.S2_INTELLIGENCE,
      maxWorkers: 5,
      capabilities: ['research', 'analysis', 'investigation', 'documentation'],
      workerManager: this.workerManager
    }));

    // S3 - Operations (Coding, Implementation)
    this.supervisors.set(DomainType.S3_OPERATIONS, new DomainSupervisor({
      domain: DomainType.S3_OPERATIONS,
      maxWorkers: 5,
      capabilities: ['implementation', 'coding', 'refactoring', 'fixing'],
      workerManager: this.workerManager
    }));

    // S4 - Logistics (Testing, Deployment)
    this.supervisors.set(DomainType.S4_LOGISTICS, new DomainSupervisor({
      domain: DomainType.S4_LOGISTICS,
      maxWorkers: 4,
      capabilities: ['testing', 'deployment', 'building', 'verification'],
      workerManager: this.workerManager
    }));

    // S6 - Communications (Integration)
    this.supervisors.set(DomainType.S6_COMMUNICATIONS, new DomainSupervisor({
      domain: DomainType.S6_COMMUNICATIONS,
      maxWorkers: 3,
      capabilities: ['integration', 'api', 'coordination'],
      workerManager: this.workerManager
    }));
  }

  /**
   * Set worker manager (for late binding when loaded from routes)
   */
  setWorkerManager(workerManager) {
    this.workerManager = workerManager;
    // Update supervisors
    for (const supervisor of this.supervisors.values()) {
      supervisor.workerManager = workerManager;
    }
  }

  // ========================================================================
  // CENTRALIZED COMMAND (CC) - Strategic Layer
  // ========================================================================

  /**
   * Create a new mission with commander's intent
   * This is the CC layer entry point
   */
  createMission({
    task,
    projectPath,
    intent = null,
    autonomyLevel = AutonomyLevel.WEAPONS_FREE
  }) {
    // Create commander's intent from task if not provided
    const commandersIntent = intent instanceof CommandersIntent
      ? intent
      : CommandersIntent.fromTask(task, projectPath);

    // Create mission order
    const missionOrder = new MissionOrder({
      mission: task,
      intent: commandersIntent,
      situation: {
        background: `Task requested for project: ${projectPath}`,
        constraints: commandersIntent.constraints
      },
      execution: {
        concept: `Execute task with ${AutonomyLevel[autonomyLevel]} autonomy level`,
        tasks: commandersIntent.keyTasks
      },
      commandAndSignal: {
        reporting: ['Report progress on task completion', 'Report any blockers'],
        escalation: [
          'Escalate if confidence below 70%',
          'Escalate if task scope unclear',
          'Escalate on repeated failures'
        ]
      }
    });

    // Store mission
    this.missions.set(missionOrder.missionId, {
      order: missionOrder,
      projectPath,
      autonomyLevel,
      createdAt: new Date().toISOString(),
      status: MissionStatus.PLANNING
    });

    this.metrics.missionsCreated++;

    // Emit mission created event
    if (this.io) {
      this.io.emit('mission:created', {
        missionId: missionOrder.missionId,
        task,
        projectPath,
        status: MissionStatus.PLANNING
      });
    }

    return {
      missionId: missionOrder.missionId,
      order: missionOrder,
      intent: commandersIntent,
      status: MissionStatus.PLANNING
    };
  }

  /**
   * Execute a mission - routes to appropriate supervisors
   */
  async executeMission(missionId) {
    const missionData = this.missions.get(missionId);
    if (!missionData) {
      throw new Error(`Mission not found: ${missionId}`);
    }

    missionData.status = MissionStatus.EXECUTING;
    missionData.order.status = MissionStatus.EXECUTING;

    // Determine which domain should handle this mission
    const domain = this.routeToDomain(missionData.order.mission);

    // Get supervisor
    const supervisor = this.supervisors.get(domain);
    if (!supervisor) {
      throw new Error(`No supervisor for domain: ${domain}`);
    }

    // Create task for supervisor
    const task = {
      projectPath: missionData.projectPath,
      description: missionData.order.mission,
      label: `mission-${missionId.substring(0, 8)}`,
      missionId
    };

    // Assign task through DC layer
    const result = await supervisor.assignTask(task, missionData.order.intent);

    this.metrics.tasksRouted++;

    // Update mission with assigned worker
    if (result.success) {
      missionData.order.assignedWorkers.push(result.workerId);
    }

    if (this.io) {
      this.io.emit('mission:executing', {
        missionId,
        domain,
        workerId: result.workerId,
        success: result.success
      });
    }

    return {
      missionId,
      domain,
      ...result
    };
  }

  /**
   * Route a task description to appropriate domain
   */
  routeToDomain(taskDescription) {
    const taskLower = taskDescription.toLowerCase();

    // Check each supervisor for capability match
    for (const [domain, supervisor] of this.supervisors) {
      if (supervisor.canHandle(taskDescription)) {
        return domain;
      }
    }

    // Default to S3 Operations for general tasks
    return DomainType.S3_OPERATIONS;
  }

  /**
   * Get mission status
   */
  getMission(missionId) {
    const missionData = this.missions.get(missionId);
    if (!missionData) {
      return null;
    }

    return {
      missionId,
      status: missionData.status,
      order: missionData.order,
      projectPath: missionData.projectPath,
      autonomyLevel: missionData.autonomyLevel,
      createdAt: missionData.createdAt
    };
  }

  /**
   * Complete a mission
   */
  completeMission(missionId, result) {
    const missionData = this.missions.get(missionId);
    if (!missionData) {
      return false;
    }

    missionData.status = MissionStatus.COMPLETE;
    missionData.order.status = MissionStatus.COMPLETE;
    missionData.completedAt = new Date().toISOString();
    missionData.result = result;

    this.metrics.missionsCompleted++;

    if (this.io) {
      this.io.emit('mission:complete', { missionId, result });
    }

    return true;
  }

  /**
   * Fail a mission
   */
  failMission(missionId, error) {
    const missionData = this.missions.get(missionId);
    if (!missionData) {
      return false;
    }

    missionData.status = MissionStatus.FAILED;
    missionData.order.status = MissionStatus.FAILED;
    missionData.failedAt = new Date().toISOString();
    missionData.error = error;

    this.metrics.missionsFailed++;

    if (this.io) {
      this.io.emit('mission:failed', { missionId, error });
    }

    return true;
  }

  // ========================================================================
  // DISTRIBUTED CONTROL (DC) - Operational Layer
  // ========================================================================

  /**
   * Get status of all supervisors
   */
  getSupervisorStatus() {
    const statuses = {};
    for (const [domain, supervisor] of this.supervisors) {
      statuses[domain] = supervisor.getStatus();
    }
    return statuses;
  }

  /**
   * Get specific supervisor
   */
  getSupervisor(domain) {
    return this.supervisors.get(domain);
  }

  /**
   * Reassign a task to a different domain
   */
  async reassignTask(workerId, fromDomain, toDomain) {
    const fromSupervisor = this.supervisors.get(fromDomain);
    const toSupervisor = this.supervisors.get(toDomain);

    if (!fromSupervisor || !toSupervisor) {
      throw new Error('Invalid domain specified');
    }

    const assignment = fromSupervisor.assignedWorkers.get(workerId);
    if (!assignment) {
      throw new Error('Worker not found in source domain');
    }

    // Mark as reassigned in source
    assignment.status = 'reassigned';

    // Assign to new domain
    return await toSupervisor.assignTask(assignment.task, assignment.intent);
  }

  // ========================================================================
  // DECENTRALIZED EXECUTION (DE) - Tactical Layer
  // ========================================================================

  /**
   * Run orchestrator OODA cycle - monitors and directs system
   */
  async runOODACycle() {
    // Gather sensor data
    const sensors = {
      environment: {
        activeMissions: this.missions.size,
        timestamp: new Date().toISOString()
      },
      workerStates: [],
      taskQueue: [],
      errors: [],
      metrics: this.metrics
    };

    // Collect from supervisors
    for (const supervisor of this.supervisors.values()) {
      const status = supervisor.getStatus();
      sensors.workerStates.push(...status.workers);
      sensors.taskQueue.push(...supervisor.taskQueue);
    }

    // Execute OODA cycle
    const cycle = await this.orchestratorOODA.runCycle(sensors, async (decision) => {
      // Execute based on decision
      switch (decision.selectedAction) {
        case 'escalate':
          this.metrics.escalations++;
          if (this.io) {
            this.io.emit('orchestrator:escalation', {
              reason: decision.rationale,
              timestamp: new Date().toISOString()
            });
          }
          break;
        case 'execute_opportunity':
          // Could trigger auto-assignment of queued tasks
          break;
        case 'intervene':
          // Could trigger recovery actions
          break;
        default:
          // maintain - no action needed
          break;
      }
      return { executed: true };
    });

    this.metrics.oodaCycles++;

    return cycle;
  }

  /**
   * Handle worker completion event
   */
  onWorkerComplete(workerId, result) {
    // Find which supervisor owns this worker
    for (const supervisor of this.supervisors.values()) {
      if (supervisor.assignedWorkers.has(workerId)) {
        supervisor.workerCompleted(workerId, result);

        // Find associated mission
        const assignment = supervisor.assignedWorkers.get(workerId);
        if (assignment?.task?.missionId) {
          this.completeMission(assignment.task.missionId, result);
        }
        break;
      }
    }
  }

  /**
   * Handle worker failure event
   */
  onWorkerFailed(workerId, error) {
    for (const supervisor of this.supervisors.values()) {
      if (supervisor.assignedWorkers.has(workerId)) {
        supervisor.workerFailed(workerId, error);

        const assignment = supervisor.assignedWorkers.get(workerId);
        if (assignment?.task?.missionId) {
          this.failMission(assignment.task.missionId, error);
        }
        break;
      }
    }
  }

  // ========================================================================
  // METRICS & STATUS
  // ========================================================================

  /**
   * Get comprehensive system status
   */
  getSystemStatus() {
    return {
      cc: {
        activeMissions: this.missions.size,
        missionsByStatus: this.getMissionsByStatus()
      },
      dc: {
        supervisors: this.getSupervisorStatus(),
        totalCapacity: this.getTotalCapacity()
      },
      de: {
        oodaMetrics: this.orchestratorOODA.getMetrics()
      },
      metrics: this.metrics
    };
  }

  getMissionsByStatus() {
    const counts = {};
    for (const [, mission] of this.missions) {
      counts[mission.status] = (counts[mission.status] || 0) + 1;
    }
    return counts;
  }

  getTotalCapacity() {
    let active = 0;
    let max = 0;
    for (const supervisor of this.supervisors.values()) {
      active += supervisor.assignedWorkers.size;
      max += supervisor.maxWorkers;
    }
    return { active, max, utilization: max > 0 ? active / max : 0 };
  }

  getMetrics() {
    return {
      ...this.metrics,
      activeMissions: this.missions.size,
      supervisorCount: this.supervisors.size,
      capacity: this.getTotalCapacity()
    };
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

export function createGeneralService(options = {}) {
  return new GeneralService(options);
}

export default GeneralService;
