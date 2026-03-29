/**
 * modular-crew — SQLite Run Store
 *
 * Persistent storage for run history, step execution state, facts, and trace events.
 * Uses better-sqlite3 (synchronous, WAL mode) for fast, reliable local persistence.
 *
 * DB location: .crew/runs.db in project directory (configurable via constructor).
 */

import Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Fact, TraceEvent } from '../types.js';

// ── Row Types (DB ↔ Application boundary) ────────────────────────────────────

export interface RunRow {
  id: string;
  team_file: string;
  team_name: string;
  task: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  total_tokens: number;
  total_cost_usd: number;
  error: string | null;
  metadata: string | null;
}

export interface StepRow {
  id: string;
  run_id: string;
  step_id: string;
  agent_id: string | null;
  status: string;
  attempt: number;
  started_at: string | null;
  completed_at: string | null;
  input: string | null;
  output: string | null;
  error: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number;
}

export interface FactRow {
  id: number;
  run_id: string;
  step_id: string;
  key: string;
  value: string;
  type: string;
  source: string;
  confidence: number;
  published_at: string;
  supersedes: number | null;
}

export interface EventRow {
  id: number;
  run_id: string;
  step_id: string | null;
  type: string;
  data: string;
  timestamp: string;
}

export interface RunSummary {
  id: string;
  team_file: string;
  team_name: string;
  task: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  total_tokens: number;
  total_cost_usd: number;
  error: string | null;
  step_count: number;
}

export interface ResumableState {
  succeededSteps: string[];
  facts: FactRow[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = '.crew/runs.db';

/** Columns that updateStep() is allowed to mutate. */
const STEP_MUTABLE = new Set([
  'status', 'agent_id', 'attempt', 'started_at', 'completed_at',
  'input', 'output', 'error', 'tokens_in', 'tokens_out', 'cost_usd', 'duration_ms',
]);

// ── RunStore ─────────────────────────────────────────────────────────────────

export class RunStore {
  readonly db: Database.Database;

  // ── Prepared statements (hot path) ──────────────────────────────────────

  private readonly _insertRun: Database.Statement;
  private readonly _updateRunStatus: Database.Statement;
  private readonly _completeRun: Database.Statement;
  private readonly _insertStep: Database.Statement;
  private readonly _insertFact: Database.Statement;
  private readonly _findLatestFact: Database.Statement;
  private readonly _insertEvent: Database.Statement;
  private readonly _getRun: Database.Statement;
  private readonly _getRunSteps: Database.Statement;
  private readonly _getRunFacts: Database.Statement;
  private readonly _getSucceededSteps: Database.Statement;
  private readonly _listRuns: Database.Statement;

  /** Cache for dynamically-built UPDATE steps statements, keyed by sorted column set. */
  private readonly _updateStepCache = new Map<string, Database.Statement>();

  // ── Lifecycle ───────────────────────────────────────────────────────────

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this._createTables();

    // ── Runs ──────────────────────────────────────────────────────────────

    this._insertRun = this.db.prepare(`
      INSERT INTO runs (id, team_file, team_name, task, status, started_at, total_tokens, total_cost_usd)
      VALUES (@id, @team_file, @team_name, @task, 'pending', @started_at, 0, 0.0)
    `);

    this._updateRunStatus = this.db.prepare(`
      UPDATE runs SET status = @status, error = @error WHERE id = @id
    `);

    this._completeRun = this.db.prepare(`
      UPDATE runs
      SET status = @status,
          completed_at = @completed_at,
          total_tokens = @total_tokens,
          total_cost_usd = @total_cost_usd
      WHERE id = @id
    `);

    // ── Steps ─────────────────────────────────────────────────────────────

    this._insertStep = this.db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, status, attempt, tokens_in, tokens_out, cost_usd, duration_ms)
      VALUES (@id, @run_id, @step_id, @agent_id, 'pending', 1, 0, 0, 0.0, 0)
    `);

    // ── Facts ─────────────────────────────────────────────────────────────

    this._insertFact = this.db.prepare(`
      INSERT INTO facts (run_id, step_id, key, value, type, source, confidence, published_at, supersedes)
      VALUES (@run_id, @step_id, @key, @value, @type, @source, @confidence, @published_at, @supersedes)
    `);

    this._findLatestFact = this.db.prepare(
      `SELECT id FROM facts WHERE run_id = @run_id AND key = @key ORDER BY id DESC LIMIT 1`,
    );

    // ── Events ────────────────────────────────────────────────────────────

    this._insertEvent = this.db.prepare(`
      INSERT INTO events (run_id, step_id, type, data, timestamp)
      VALUES (@run_id, @step_id, @type, @data, @timestamp)
    `);

    // ── Queries ───────────────────────────────────────────────────────────

    this._getRun = this.db.prepare(`SELECT * FROM runs WHERE id = ?`);

    this._getRunSteps = this.db.prepare(
      `SELECT * FROM steps WHERE run_id = ? ORDER BY id ASC`,
    );

    this._getRunFacts = this.db.prepare(
      `SELECT * FROM facts WHERE run_id = ? ORDER BY id ASC`,
    );

    this._getSucceededSteps = this.db.prepare(
      `SELECT step_id FROM steps WHERE run_id = ? AND status = 'succeeded'`,
    );

    this._listRuns = this.db.prepare(`
      SELECT r.*,
             (SELECT COUNT(*) FROM steps s WHERE s.run_id = r.id) AS step_count
      FROM runs r
      ORDER BY r.started_at DESC
      LIMIT ?
    `);
  }

  /** Cleanly close the database connection. */
  close(): void {
    this.db.close();
  }

  // ── Run Methods ─────────────────────────────────────────────────────────

  /** Create a new run record. Returns the generated ULID. */
  createRun(teamFile: string, teamName: string, task: string): string {
    const id = ulid();
    this._insertRun.run({
      id,
      team_file: teamFile,
      team_name: teamName,
      task,
      started_at: new Date().toISOString(),
    });
    return id;
  }

  /** Update run status (and optionally set error). */
  updateRunStatus(runId: string, status: string, error?: string): void {
    this._updateRunStatus.run({
      id: runId,
      status,
      error: error ?? null,
    });
  }

  /** Mark run as completed with final totals. */
  completeRun(
    runId: string,
    status: string,
    totals: { tokens: number; cost: number },
  ): void {
    this._completeRun.run({
      id: runId,
      status,
      completed_at: new Date().toISOString(),
      total_tokens: totals.tokens,
      total_cost_usd: totals.cost,
    });
  }

  /** Fetch a single run by ID. */
  getRun(runId: string): RunRow | null {
    return (this._getRun.get(runId) as RunRow | undefined) ?? null;
  }

  /** List recent runs with step counts. */
  listRuns(limit: number = 50): RunSummary[] {
    return this._listRuns.all(limit) as RunSummary[];
  }

  // ── Step Methods ────────────────────────────────────────────────────────

  /** Register a new step for a run. */
  createStep(runId: string, stepId: string, agentId?: string): void {
    this._insertStep.run({
      id: ulid(),
      run_id: runId,
      step_id: stepId,
      agent_id: agentId ?? null,
    });
  }

  /**
   * Partially update a step row. Only whitelisted columns are written.
   * Builds and caches a prepared statement per unique column-set for performance.
   */
  updateStep(runId: string, stepId: string, patch: Partial<StepRow>): void {
    const keys = Object.keys(patch)
      .filter((k) => STEP_MUTABLE.has(k))
      .sort();

    if (keys.length === 0) return;

    const cacheKey = keys.join(',');
    let stmt = this._updateStepCache.get(cacheKey);

    if (!stmt) {
      const setClauses = keys.map((k) => `${k} = @${k}`).join(', ');
      stmt = this.db.prepare(
        `UPDATE steps SET ${setClauses} WHERE run_id = @run_id AND step_id = @step_id`,
      );
      this._updateStepCache.set(cacheKey, stmt);
    }

    const params: Record<string, unknown> = { run_id: runId, step_id: stepId };
    for (const k of keys) {
      params[k] = (patch as Record<string, unknown>)[k] ?? null;
    }

    stmt.run(params);
  }

  /** Get all steps for a run, ordered chronologically (by ULID). */
  getRunSteps(runId: string): StepRow[] {
    return this._getRunSteps.all(runId) as StepRow[];
  }

  // ── Fact Methods ────────────────────────────────────────────────────────

  /**
   * Persist a fact published by a step. Returns the auto-generated fact ID.
   *
   * If `fact.supersedes` names a key, the latest fact with that key in
   * the same run is resolved to an integer FK.
   */
  publishFact(runId: string, stepId: string, fact: Fact): number {
    let supersedesId: number | null = null;

    if (fact.supersedes) {
      const row = this._findLatestFact.get({
        run_id: runId,
        key: fact.supersedes,
      }) as { id: number } | undefined;
      supersedesId = row?.id ?? null;
    }

    const result = this._insertFact.run({
      run_id: runId,
      step_id: stepId,
      key: fact.key,
      value: fact.value,
      type: fact.status ?? 'provisional',
      source: fact.source,
      confidence: 1.0,
      published_at: new Date(fact.timestamp).toISOString(),
      supersedes: supersedesId,
    });

    return Number(result.lastInsertRowid);
  }

  /** Get all facts for a run, ordered by insertion. */
  getRunFacts(runId: string): FactRow[] {
    return this._getRunFacts.all(runId) as FactRow[];
  }

  // ── Event Methods ───────────────────────────────────────────────────────

  /** Append a trace event to the run log. */
  appendEvent(runId: string, event: TraceEvent): void {
    this._insertEvent.run({
      run_id: runId,
      step_id: event.stepId ?? null,
      type: event.type,
      data: JSON.stringify(event.data),
      timestamp: new Date(event.timestamp).toISOString(),
    });
  }

  // ── Resume Support ──────────────────────────────────────────────────────

  /**
   * Build the minimal state needed to resume a partially-completed run.
   * Returns step IDs that already succeeded (skip them) and all published facts.
   */
  getResumableState(runId: string): ResumableState {
    const succeededSteps = (
      this._getSucceededSteps.all(runId) as Array<{ step_id: string }>
    ).map((r) => r.step_id);

    const facts = this.getRunFacts(runId);

    return { succeededSteps, facts };
  }

  // ── Schema ──────────────────────────────────────────────────────────────

  private _createTables(): void {
    this.db.exec(`
      -- ── Runs ──────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS runs (
        id              TEXT    PRIMARY KEY,
        team_file       TEXT    NOT NULL,
        team_name       TEXT    NOT NULL,
        task            TEXT    NOT NULL,
        status          TEXT    NOT NULL DEFAULT 'pending',
        started_at      TEXT    NOT NULL,
        completed_at    TEXT,
        total_tokens    INTEGER NOT NULL DEFAULT 0,
        total_cost_usd  REAL    NOT NULL DEFAULT 0.0,
        error           TEXT,
        metadata        TEXT
      );

      -- ── Steps ─────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS steps (
        id              TEXT    PRIMARY KEY,
        run_id          TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_id         TEXT    NOT NULL,
        agent_id        TEXT,
        status          TEXT    NOT NULL DEFAULT 'pending',
        attempt         INTEGER NOT NULL DEFAULT 1,
        started_at      TEXT,
        completed_at    TEXT,
        input           TEXT,
        output          TEXT,
        error           TEXT,
        tokens_in       INTEGER NOT NULL DEFAULT 0,
        tokens_out      INTEGER NOT NULL DEFAULT 0,
        cost_usd        REAL    NOT NULL DEFAULT 0.0,
        duration_ms     INTEGER NOT NULL DEFAULT 0,
        UNIQUE (run_id, step_id)
      );

      -- ── Facts ─────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS facts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_id         TEXT    NOT NULL,
        key             TEXT    NOT NULL,
        value           TEXT    NOT NULL,
        type            TEXT    NOT NULL DEFAULT 'provisional',
        source          TEXT    NOT NULL,
        confidence      REAL    NOT NULL DEFAULT 1.0,
        published_at    TEXT    NOT NULL,
        supersedes      INTEGER REFERENCES facts(id)
      );

      -- ── Events ────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_id         TEXT,
        type            TEXT    NOT NULL,
        data            TEXT    NOT NULL DEFAULT '{}',
        timestamp       TEXT    NOT NULL
      );

      -- ── Indexes ───────────────────────────────────────────────────────────
      CREATE INDEX IF NOT EXISTS idx_steps_run       ON steps  (run_id);
      CREATE INDEX IF NOT EXISTS idx_facts_run       ON facts  (run_id);
      CREATE INDEX IF NOT EXISTS idx_facts_run_key   ON facts  (run_id, key);
      CREATE INDEX IF NOT EXISTS idx_events_run      ON events (run_id);
      CREATE INDEX IF NOT EXISTS idx_events_run_type ON events (run_id, type);
      CREATE INDEX IF NOT EXISTS idx_runs_status     ON runs   (status);
      CREATE INDEX IF NOT EXISTS idx_runs_started    ON runs   (started_at DESC);
    `);
  }
}
