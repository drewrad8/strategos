import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import * as sqliteVec from 'sqlite-vec';

/**
 * Memory types for classification
 */
export const MemoryTypes = {
  SEMANTIC: 'semantic',      // Facts, concepts, definitions
  EPISODIC: 'episodic',      // Events, experiences, specific occurrences
  PROCEDURAL: 'procedural',  // How-to knowledge, workflows, procedures
  PREFERENCE: 'preference'   // User preferences, behavioral patterns
};

/**
 * Relationship types between memories
 */
export const RelationshipTypes = {
  RELATED_TO: 'related_to',
  SUPERSEDES: 'supersedes',
  DERIVED_FROM: 'derived_from',
  CONTRADICTS: 'contradicts',
  SUPPORTS: 'supports',
  PART_OF: 'part_of'
};

/**
 * MemoryManager - Persistent knowledge storage with decay and retrieval
 *
 * Implements a three-tier hierarchical memory system with:
 * - Temporal decay for importance
 * - Importance-based pruning
 * - Memory consolidation for similar entries
 * - Relationship tracking between memories
 */
export class MemoryManager {
  /**
   * Create a new MemoryManager instance
   * @param {string} dbPath - Path to SQLite database file
   * @param {Object} options - Configuration options
   * @param {number} options.decayRate - Decay rate per hour (default: 0.995)
   * @param {number} options.importanceThreshold - Prune memories below this (default: 0.1)
   * @param {number} options.consolidationInterval - Consolidation interval in ms (default: 3600000)
   * @param {number} options.similarityThreshold - Threshold for consolidation (default: 0.85)
   */
  constructor(dbPath, options = {}) {
    this.options = {
      decayRate: 0.995,
      importanceThreshold: 0.1,
      consolidationInterval: 3600000, // 1 hour
      similarityThreshold: 0.85,
      ...options
    };

    // Ensure directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.dbPath = dbPath;
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent performance
    this.db.pragma('journal_mode = WAL');

    // Load sqlite-vec extension for vector search
    sqliteVec.load(this.db);
    this.vectorDimension = options.vectorDimension || 384; // Default for all-MiniLM-L6-v2

    this._initializeTables();
    this._initializeVectorTable();
    this._prepareStatements();

    // Track consolidation timer
    this.consolidationTimer = null;
  }

  /**
   * Initialize database tables
   * @private
   */
  _initializeTables() {
    this.db.exec(`
      -- Core memories table
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL DEFAULT 0.5,
        confidence REAL DEFAULT 1.0,
        decay_rate REAL DEFAULT 0.995,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accessed_at TEXT,
        access_count INTEGER DEFAULT 0,
        project_id TEXT,
        worker_id TEXT,
        task_id TEXT,
        source TEXT,
        tags TEXT
      );

      -- Memory relationships table
      CREATE TABLE IF NOT EXISTS memory_relationships (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        strength REAL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id, relationship_type),
        FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
      );

      -- Indexes for efficient queries
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
      CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id);
      CREATE INDEX IF NOT EXISTS idx_memories_worker_id ON memories(worker_id);
      CREATE INDEX IF NOT EXISTS idx_memories_task_id ON memories(task_id);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_accessed_at ON memories(accessed_at);
      CREATE INDEX IF NOT EXISTS idx_relationships_source ON memory_relationships(source_id);
      CREATE INDEX IF NOT EXISTS idx_relationships_target ON memory_relationships(target_id);
    `);
  }

  /**
   * Initialize vector search table using sqlite-vec
   * @private
   */
  _initializeVectorTable() {
    try {
      // Create virtual table for vector embeddings
      // Uses vec0 from sqlite-vec for efficient similarity search
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding FLOAT[${this.vectorDimension}]
        );
      `);
    } catch (err) {
      // Table might already exist with different dimension - that's ok
      if (!err.message.includes('already exists')) {
        console.warn('[MemoryManager] Vector table warning:', err.message);
      }
    }
  }

  /**
   * Prepare SQL statements for performance
   * @private
   */
  _prepareStatements() {
    this._stmts = {
      insertMemory: this.db.prepare(`
        INSERT INTO memories (
          id, type, content, importance, confidence, decay_rate,
          created_at, updated_at, accessed_at, access_count,
          project_id, worker_id, task_id, source, tags
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),

      updateMemory: this.db.prepare(`
        UPDATE memories SET
          content = ?, importance = ?, confidence = ?,
          updated_at = ?, tags = ?
        WHERE id = ?
      `),

      getMemoryById: this.db.prepare(`
        SELECT * FROM memories WHERE id = ?
      `),

      deleteMemory: this.db.prepare(`
        DELETE FROM memories WHERE id = ?
      `),

      updateAccessedAt: this.db.prepare(`
        UPDATE memories SET
          accessed_at = ?,
          access_count = access_count + 1
        WHERE id = ?
      `),

      updateImportance: this.db.prepare(`
        UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?
      `),

      getAllMemories: this.db.prepare(`
        SELECT * FROM memories ORDER BY importance DESC
      `),

      getMemoriesByType: this.db.prepare(`
        SELECT * FROM memories WHERE type = ? ORDER BY importance DESC
      `),

      getMemoriesByProject: this.db.prepare(`
        SELECT * FROM memories WHERE project_id = ? ORDER BY importance DESC
      `),

      getMemoriesAboveThreshold: this.db.prepare(`
        SELECT * FROM memories WHERE importance >= ? ORDER BY importance DESC
      `),

      deleteMemoriesBelowThreshold: this.db.prepare(`
        DELETE FROM memories WHERE importance < ?
      `),

      insertRelationship: this.db.prepare(`
        INSERT OR REPLACE INTO memory_relationships (
          source_id, target_id, relationship_type, strength, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `),

      getRelationshipsBySource: this.db.prepare(`
        SELECT * FROM memory_relationships WHERE source_id = ?
      `),

      getRelationshipsByTarget: this.db.prepare(`
        SELECT * FROM memory_relationships WHERE target_id = ?
      `),

      deleteRelationshipsByMemory: this.db.prepare(`
        DELETE FROM memory_relationships
        WHERE source_id = ? OR target_id = ?
      `),

      countMemories: this.db.prepare(`
        SELECT COUNT(*) as count FROM memories
      `),

      countRelationships: this.db.prepare(`
        SELECT COUNT(*) as count FROM memory_relationships
      `)
    };
  }

  /**
   * Store a new memory
   * @param {Object} memory - Memory object to store
   * @param {string} memory.type - Memory type (semantic, episodic, procedural, preference)
   * @param {string} memory.content - Memory content
   * @param {number} [memory.importance=0.5] - Importance score (0-1)
   * @param {number} [memory.confidence=1.0] - Confidence score (0-1)
   * @param {number} [memory.decayRate] - Custom decay rate (uses default if not specified)
   * @param {string} [memory.projectId] - Associated project ID
   * @param {string} [memory.workerId] - Associated worker ID
   * @param {string} [memory.taskId] - Associated task ID
   * @param {string} [memory.source] - Source of the memory
   * @param {string[]} [memory.tags] - Tags for categorization
   * @param {Object[]} [memory.relationships] - Relationships to other memories
   * @returns {string} Memory ID
   */
  store(memory) {
    const id = randomUUID();
    const now = new Date().toISOString();

    const type = memory.type || MemoryTypes.SEMANTIC;
    const importance = memory.importance ?? 0.5;
    const confidence = memory.confidence ?? 1.0;
    const decayRate = memory.decayRate ?? this.options.decayRate;
    const tags = memory.tags ? JSON.stringify(memory.tags) : null;

    try {
      this._stmts.insertMemory.run(
        id,
        type,
        memory.content,
        importance,
        confidence,
        decayRate,
        now,                    // created_at
        now,                    // updated_at
        now,                    // accessed_at
        0,                      // access_count
        memory.projectId || null,
        memory.workerId || null,
        memory.taskId || null,
        memory.source || null,
        tags
      );

      // Store relationships if provided
      if (memory.relationships && Array.isArray(memory.relationships)) {
        for (const rel of memory.relationships) {
          this.addRelationship(id, rel.targetId, rel.type, rel.strength);
        }
      }

      return id;
    } catch (err) {
      console.error('[MemoryManager] Failed to store memory:', err.message);
      throw err;
    }
  }

  /**
   * Retrieve relevant memories based on query
   * @param {Object} query - Query parameters
   * @param {string} [query.content] - Content to search for (substring match)
   * @param {string} [query.type] - Filter by memory type
   * @param {string} [query.projectId] - Filter by project ID
   * @param {string} [query.workerId] - Filter by worker ID
   * @param {string} [query.taskId] - Filter by task ID
   * @param {string[]} [query.tags] - Filter by tags (any match)
   * @param {Object} [options] - Retrieval options
   * @param {number} [options.limit=10] - Maximum memories to return
   * @param {number} [options.minImportance=0] - Minimum importance threshold
   * @param {boolean} [options.includeRelated=false] - Include related memories
   * @param {boolean} [options.updateAccess=true] - Update access timestamp
   * @returns {Object[]} Array of matching memories
   */
  retrieve(query = {}, options = {}) {
    const {
      limit = 10,
      minImportance = 0,
      includeRelated = false,
      updateAccess = true
    } = options;

    try {
      // Build dynamic query
      let sql = 'SELECT * FROM memories WHERE 1=1';
      const params = [];

      if (query.type) {
        sql += ' AND type = ?';
        params.push(query.type);
      }

      if (query.projectId) {
        sql += ' AND project_id = ?';
        params.push(query.projectId);
      }

      if (query.workerId) {
        sql += ' AND worker_id = ?';
        params.push(query.workerId);
      }

      if (query.taskId) {
        sql += ' AND task_id = ?';
        params.push(query.taskId);
      }

      if (query.content) {
        sql += ' AND content LIKE ?';
        params.push(`%${query.content}%`);
      }

      if (minImportance > 0) {
        sql += ' AND importance >= ?';
        params.push(minImportance);
      }

      sql += ' ORDER BY importance DESC, accessed_at DESC LIMIT ?';
      params.push(limit);

      const stmt = this.db.prepare(sql);
      let memories = stmt.all(...params);

      // Filter by tags if specified
      if (query.tags && query.tags.length > 0) {
        memories = memories.filter(mem => {
          if (!mem.tags) return false;
          const memTags = JSON.parse(mem.tags);
          return query.tags.some(tag => memTags.includes(tag));
        });
      }

      // Parse tags JSON for each memory
      memories = memories.map(mem => ({
        ...mem,
        tags: mem.tags ? JSON.parse(mem.tags) : []
      }));

      // Update access timestamps
      if (updateAccess && memories.length > 0) {
        const now = new Date().toISOString();
        for (const mem of memories) {
          this._stmts.updateAccessedAt.run(now, mem.id);
        }
      }

      // Include related memories if requested
      if (includeRelated && memories.length > 0) {
        const relatedIds = new Set();
        for (const mem of memories) {
          const relationships = this._stmts.getRelationshipsBySource.all(mem.id);
          for (const rel of relationships) {
            relatedIds.add(rel.target_id);
          }
        }

        // Fetch related memories not already in result
        const memoryIds = new Set(memories.map(m => m.id));
        for (const relId of relatedIds) {
          if (!memoryIds.has(relId)) {
            const relatedMem = this._stmts.getMemoryById.get(relId);
            if (relatedMem) {
              relatedMem.tags = relatedMem.tags ? JSON.parse(relatedMem.tags) : [];
              relatedMem._isRelated = true;
              memories.push(relatedMem);
            }
          }
        }
      }

      return memories;
    } catch (err) {
      console.error('[MemoryManager] Failed to retrieve memories:', err.message);
      throw err;
    }
  }

  /**
   * Get a single memory by ID
   * @param {string} id - Memory ID
   * @param {boolean} updateAccess - Whether to update access timestamp
   * @returns {Object|null} Memory object or null if not found
   */
  getById(id, updateAccess = true) {
    try {
      const memory = this._stmts.getMemoryById.get(id);
      if (!memory) return null;

      if (updateAccess) {
        const now = new Date().toISOString();
        this._stmts.updateAccessedAt.run(now, id);
      }

      return {
        ...memory,
        tags: memory.tags ? JSON.parse(memory.tags) : []
      };
    } catch (err) {
      console.error('[MemoryManager] Failed to get memory by ID:', err.message);
      throw err;
    }
  }

  /**
   * Update an existing memory
   * @param {string} id - Memory ID
   * @param {Object} updates - Fields to update
   * @returns {boolean} Success status
   */
  update(id, updates) {
    try {
      const existing = this._stmts.getMemoryById.get(id);
      if (!existing) return false;

      const now = new Date().toISOString();
      const content = updates.content ?? existing.content;
      const importance = updates.importance ?? existing.importance;
      const confidence = updates.confidence ?? existing.confidence;
      const tags = updates.tags
        ? JSON.stringify(updates.tags)
        : existing.tags;

      this._stmts.updateMemory.run(
        content, importance, confidence, now, tags, id
      );

      return true;
    } catch (err) {
      console.error('[MemoryManager] Failed to update memory:', err.message);
      throw err;
    }
  }

  /**
   * Delete a memory
   * @param {string} id - Memory ID
   * @returns {boolean} Success status
   */
  delete(id) {
    try {
      // Delete relationships first
      this._stmts.deleteRelationshipsByMemory.run(id, id);

      const result = this._stmts.deleteMemory.run(id);
      return result.changes > 0;
    } catch (err) {
      console.error('[MemoryManager] Failed to delete memory:', err.message);
      throw err;
    }
  }

  /**
   * Add a relationship between memories
   * @param {string} sourceId - Source memory ID
   * @param {string} targetId - Target memory ID
   * @param {string} relationshipType - Type of relationship
   * @param {number} strength - Relationship strength (0-1)
   * @returns {boolean} Success status
   */
  addRelationship(sourceId, targetId, relationshipType, strength = 1.0) {
    try {
      const now = new Date().toISOString();
      this._stmts.insertRelationship.run(
        sourceId, targetId, relationshipType, strength, now
      );
      return true;
    } catch (err) {
      console.error('[MemoryManager] Failed to add relationship:', err.message);
      throw err;
    }
  }

  /**
   * Get relationships for a memory
   * @param {string} memoryId - Memory ID
   * @returns {Object} Object with outgoing and incoming relationships
   */
  getRelationships(memoryId) {
    try {
      const outgoing = this._stmts.getRelationshipsBySource.all(memoryId);
      const incoming = this._stmts.getRelationshipsByTarget.all(memoryId);
      return { outgoing, incoming };
    } catch (err) {
      console.error('[MemoryManager] Failed to get relationships:', err.message);
      throw err;
    }
  }

  /**
   * Apply temporal decay to all memories
   * Decay formula: importance = importance * (decayRate ^ hoursElapsed)
   * @returns {Object} Decay statistics
   */
  applyDecay() {
    try {
      const now = new Date();
      const memories = this._stmts.getAllMemories.all();
      let decayed = 0;
      let unchanged = 0;

      for (const mem of memories) {
        const accessedAt = mem.accessed_at
          ? new Date(mem.accessed_at)
          : new Date(mem.created_at);

        const hoursElapsed = (now - accessedAt) / (1000 * 60 * 60);

        if (hoursElapsed > 0) {
          const decayRate = mem.decay_rate || this.options.decayRate;
          const newImportance = mem.importance * Math.pow(decayRate, hoursElapsed);

          // Only update if there's meaningful change
          if (Math.abs(newImportance - mem.importance) > 0.0001) {
            this._stmts.updateImportance.run(
              newImportance,
              now.toISOString(),
              mem.id
            );
            decayed++;
          } else {
            unchanged++;
          }
        } else {
          unchanged++;
        }
      }

      return { decayed, unchanged, total: memories.length };
    } catch (err) {
      console.error('[MemoryManager] Failed to apply decay:', err.message);
      throw err;
    }
  }

  /**
   * Consolidate similar memories
   * Groups memories with similar content and merges them
   * The oldest memory in each cluster is preserved (by created_at)
   * @param {Object} options - Consolidation options
   * @param {number} options.similarityThreshold - Minimum similarity for merging (default: 0.85)
   * @returns {Object} Consolidation statistics
   */
  consolidate(options = {}) {
    const { similarityThreshold = this.options.similarityThreshold } = options;

    try {
      // Sort by created_at ASC so oldest memory is processed first and preserved
      const memories = this.db.prepare(
        'SELECT * FROM memories ORDER BY created_at ASC'
      ).all();
      const consolidated = [];
      const used = new Set();
      let mergeCount = 0;

      for (let i = 0; i < memories.length; i++) {
        if (used.has(memories[i].id)) continue;

        const cluster = [memories[i]];

        for (let j = i + 1; j < memories.length; j++) {
          if (used.has(memories[j].id)) continue;

          // Check if same type and project
          if (memories[i].type !== memories[j].type) continue;
          if (memories[i].project_id !== memories[j].project_id) continue;

          // Calculate simple content similarity (Jaccard on words)
          const similarity = this._calculateSimilarity(
            memories[i].content,
            memories[j].content
          );

          if (similarity >= similarityThreshold) {
            cluster.push(memories[j]);
            used.add(memories[j].id);
          }
        }

        if (cluster.length > 1) {
          // Merge cluster
          this._mergeMemories(cluster);
          mergeCount += cluster.length - 1;
        }

        used.add(memories[i].id);
        consolidated.push(memories[i]);
      }

      return {
        originalCount: memories.length,
        consolidatedCount: consolidated.length,
        mergedCount: mergeCount
      };
    } catch (err) {
      console.error('[MemoryManager] Failed to consolidate memories:', err.message);
      throw err;
    }
  }

  /**
   * Calculate simple word-based similarity between two texts
   * @private
   */
  _calculateSimilarity(text1, text2) {
    const words1 = new Set(text1.toLowerCase().split(/\s+/));
    const words2 = new Set(text2.toLowerCase().split(/\s+/));

    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size; // Jaccard similarity
  }

  /**
   * Merge a cluster of similar memories into the first one
   * @private
   */
  _mergeMemories(cluster) {
    if (cluster.length < 2) return;

    const primary = cluster[0];
    const now = new Date().toISOString();

    // Combine content (unique sentences)
    const allContent = cluster.map(m => m.content);
    const uniqueSentences = [...new Set(
      allContent.flatMap(c => c.split(/[.!?]+/).map(s => s.trim()).filter(Boolean))
    )];
    const mergedContent = uniqueSentences.join('. ') + '.';

    // Take highest importance
    const maxImportance = Math.max(...cluster.map(m => m.importance));

    // Merge all tags
    const allTags = new Set();
    for (const mem of cluster) {
      if (mem.tags) {
        const tags = typeof mem.tags === 'string' ? JSON.parse(mem.tags) : mem.tags;
        tags.forEach(t => allTags.add(t));
      }
    }

    // Update primary memory
    this._stmts.updateMemory.run(
      mergedContent,
      maxImportance,
      primary.confidence,
      now,
      JSON.stringify([...allTags]),
      primary.id
    );

    // Transfer relationships and delete merged memories
    for (let i = 1; i < cluster.length; i++) {
      const mem = cluster[i];

      // Transfer outgoing relationships to primary
      const outgoing = this._stmts.getRelationshipsBySource.all(mem.id);
      for (const rel of outgoing) {
        this.addRelationship(primary.id, rel.target_id, rel.relationship_type, rel.strength);
      }

      // Transfer incoming relationships to primary
      const incoming = this._stmts.getRelationshipsByTarget.all(mem.id);
      for (const rel of incoming) {
        this.addRelationship(rel.source_id, primary.id, rel.relationship_type, rel.strength);
      }

      // Delete the merged memory
      this.delete(mem.id);
    }
  }

  /**
   * Prune memories below importance threshold
   * @param {Object} options - Prune options
   * @param {number} options.threshold - Importance threshold (default from options)
   * @param {boolean} options.archive - Whether to archive before deleting (not implemented)
   * @returns {Object} Prune statistics
   */
  prune(options = {}) {
    const { threshold = this.options.importanceThreshold } = options;

    try {
      // Get count before pruning
      const beforeCount = this._stmts.countMemories.get().count;

      // Get memories to prune (for relationship cleanup)
      const toPrune = this.db.prepare(
        'SELECT id FROM memories WHERE importance < ?'
      ).all(threshold);

      // Delete relationships for pruned memories
      for (const mem of toPrune) {
        this._stmts.deleteRelationshipsByMemory.run(mem.id, mem.id);
      }

      // Delete memories below threshold
      const result = this._stmts.deleteMemoriesBelowThreshold.run(threshold);

      const afterCount = this._stmts.countMemories.get().count;

      return {
        prunedCount: result.changes,
        beforeCount,
        afterCount,
        threshold
      };
    } catch (err) {
      console.error('[MemoryManager] Failed to prune memories:', err.message);
      throw err;
    }
  }

  /**
   * Reinforce a memory (increase importance and reset decay)
   * @param {string} id - Memory ID
   * @param {number} boost - Amount to boost importance (default: 0.1)
   * @returns {boolean} Success status
   */
  reinforce(id, boost = 0.1) {
    try {
      const memory = this._stmts.getMemoryById.get(id);
      if (!memory) return false;

      const now = new Date().toISOString();
      const newImportance = Math.min(1.0, memory.importance + boost);

      this._stmts.updateImportance.run(newImportance, now, id);
      this._stmts.updateAccessedAt.run(now, id);

      return true;
    } catch (err) {
      console.error('[MemoryManager] Failed to reinforce memory:', err.message);
      throw err;
    }
  }

  /**
   * Get statistics about the memory store
   * @returns {Object} Statistics
   */
  getStats() {
    try {
      const memoryCount = this._stmts.countMemories.get().count;
      const relationshipCount = this._stmts.countRelationships.get().count;

      // Count by type
      const byType = {};
      for (const type of Object.values(MemoryTypes)) {
        const count = this.db.prepare(
          'SELECT COUNT(*) as count FROM memories WHERE type = ?'
        ).get(type).count;
        byType[type] = count;
      }

      // Importance distribution
      const avgImportance = this.db.prepare(
        'SELECT AVG(importance) as avg FROM memories'
      ).get().avg || 0;

      const belowThreshold = this.db.prepare(
        'SELECT COUNT(*) as count FROM memories WHERE importance < ?'
      ).get(this.options.importanceThreshold).count;

      // Database size
      let dbSize = 0;
      try {
        dbSize = fs.statSync(this.dbPath).size;
      } catch {
        // File might not exist yet
      }

      return {
        totalMemories: memoryCount,
        totalRelationships: relationshipCount,
        byType,
        averageImportance: avgImportance,
        belowPruneThreshold: belowThreshold,
        importanceThreshold: this.options.importanceThreshold,
        decayRate: this.options.decayRate,
        databaseSizeBytes: dbSize,
        databaseSizeMB: (dbSize / 1024 / 1024).toFixed(2)
      };
    } catch (err) {
      console.error('[MemoryManager] Failed to get stats:', err.message);
      throw err;
    }
  }

  // ============================================
  // Vector Search Methods (sqlite-vec)
  // ============================================

  /**
   * Store a vector embedding for a memory
   * @param {string} memoryId - ID of the memory
   * @param {number[]} embedding - Vector embedding (array of floats)
   * @returns {boolean} Success status
   */
  storeEmbedding(memoryId, embedding) {
    if (!embedding || embedding.length !== this.vectorDimension) {
      throw new Error(`Embedding must have ${this.vectorDimension} dimensions, got ${embedding?.length || 0}`);
    }

    try {
      // Convert to Float32Array for sqlite-vec
      const vecData = new Float32Array(embedding);

      // Delete existing embedding if present
      this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(memoryId);

      // Insert new embedding
      this.db.prepare(`
        INSERT INTO memory_embeddings (memory_id, embedding)
        VALUES (?, ?)
      `).run(memoryId, vecData);

      return true;
    } catch (err) {
      console.error('[MemoryManager] Failed to store embedding:', err.message);
      throw err;
    }
  }

  /**
   * Search memories by vector similarity
   * @param {number[]} queryEmbedding - Query vector embedding
   * @param {Object} options - Search options
   * @param {number} [options.limit=10] - Maximum results to return
   * @param {number} [options.minSimilarity=0.5] - Minimum similarity threshold (0-1)
   * @param {string} [options.type] - Filter by memory type
   * @param {string} [options.projectId] - Filter by project ID
   * @returns {Object[]} Matching memories with similarity scores
   */
  searchByVector(queryEmbedding, options = {}) {
    const { limit = 10, minSimilarity = 0.5, type, projectId } = options;

    if (!queryEmbedding || queryEmbedding.length !== this.vectorDimension) {
      throw new Error(`Query embedding must have ${this.vectorDimension} dimensions`);
    }

    try {
      const vecData = new Float32Array(queryEmbedding);

      // Query vector search with distance calculation
      // vec0 returns distance (lower = more similar), so we convert to similarity
      let query = `
        SELECT
          me.memory_id,
          me.distance,
          m.*
        FROM memory_embeddings me
        JOIN memories m ON me.memory_id = m.id
        WHERE me.embedding MATCH ?
          AND k = ?
      `;

      const params = [vecData, limit * 2]; // Get extra results for filtering

      const results = this.db.prepare(query).all(...params);

      // Convert distance to similarity and filter
      // sqlite-vec uses L2 distance, convert to cosine-like similarity: 1 / (1 + distance)
      return results
        .map(row => {
          const similarity = 1 / (1 + row.distance);
          return {
            ...row,
            similarity,
            tags: row.tags ? JSON.parse(row.tags) : null
          };
        })
        .filter(row => {
          if (row.similarity < minSimilarity) return false;
          if (type && row.type !== type) return false;
          if (projectId && row.project_id !== projectId) return false;
          return true;
        })
        .slice(0, limit);
    } catch (err) {
      console.error('[MemoryManager] Failed to search by vector:', err.message);
      throw err;
    }
  }

  /**
   * Get embedding for a memory
   * @param {string} memoryId - Memory ID
   * @returns {number[]|null} Embedding array or null if not found
   */
  getEmbedding(memoryId) {
    try {
      const row = this.db.prepare(
        'SELECT embedding FROM memory_embeddings WHERE memory_id = ?'
      ).get(memoryId);

      if (!row) return null;

      // Convert Float32Array back to regular array
      return Array.from(new Float32Array(row.embedding));
    } catch (err) {
      console.error('[MemoryManager] Failed to get embedding:', err.message);
      return null;
    }
  }

  /**
   * Delete embedding for a memory
   * @param {string} memoryId - Memory ID
   * @returns {boolean} True if deleted
   */
  deleteEmbedding(memoryId) {
    try {
      const result = this.db.prepare(
        'DELETE FROM memory_embeddings WHERE memory_id = ?'
      ).run(memoryId);
      return result.changes > 0;
    } catch (err) {
      console.error('[MemoryManager] Failed to delete embedding:', err.message);
      return false;
    }
  }

  /**
   * Get count of memories with embeddings
   * @returns {number} Count of embeddings
   */
  getEmbeddingCount() {
    try {
      const row = this.db.prepare(
        'SELECT COUNT(*) as count FROM memory_embeddings'
      ).get();
      return row?.count || 0;
    } catch (err) {
      console.error('[MemoryManager] Failed to count embeddings:', err.message);
      return 0;
    }
  }

  /**
   * Start automatic consolidation timer
   */
  startAutoConsolidation() {
    if (this.consolidationTimer) {
      clearInterval(this.consolidationTimer);
    }

    this.consolidationTimer = setInterval(() => {
      this.applyDecay();
      this.consolidate();
      this.prune();
    }, this.options.consolidationInterval);
  }

  /**
   * Stop automatic consolidation timer
   */
  stopAutoConsolidation() {
    if (this.consolidationTimer) {
      clearInterval(this.consolidationTimer);
      this.consolidationTimer = null;
    }
  }

  /**
   * Close the database connection
   */
  close() {
    this.stopAutoConsolidation();
    if (this.db) {
      this.db.close();
    }
  }

  /**
   * Clear all memories (for testing)
   */
  clear() {
    try {
      this.db.exec('DELETE FROM memory_relationships');
      this.db.exec('DELETE FROM memory_embeddings');
      this.db.exec('DELETE FROM memories');
      return true;
    } catch (err) {
      console.error('[MemoryManager] Failed to clear memories:', err.message);
      throw err;
    }
  }
}

export default MemoryManager;
