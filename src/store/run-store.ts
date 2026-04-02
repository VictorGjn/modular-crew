/**
 * modular-crew — SQLite Run Store
 *
 * Persistent storage for run history, step execution state, facts, and trace events.
 * Uses better-sqlite3 (synchronous, WAL mode) for fast, reliable local persistence.
 *
 * DB location: .crew/runs.db in project directory (configurable via constructor).
 */

import Database from './compat-db.js';
import { ulid } from 'ulid';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Fact, TraceEvent } from '../types.js';

// ── Row Types ────────────────────────────────────────────────────────────────

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
  step_count: number;
}

export interface ResumableState {
  succeededSteps: string[];
  facts: FactRow[];
}

const DEFAULT_DB_PATH = '.crew/runs.db';

const STEP_MUTABLE = new Set([
  'status', 'agent_id', 'attempt', 'started_at', 'completed_at',
  'input', 'output', 'error', 'tokens_in', 'tokens_out', 'cost_usd', 'duration_ms',
]);

// ── RunStore ─────────────────────────────────────────────────────────────────

export class RunStore {
  readonly db: any;
  private _stmtCache = new Map<string, any>();

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this._createTables();
  }

  close(): void { this.db.close(); }

  // ── Run Methods ──────────────────────────────────────────────────────────

  createRun(teamFile: string, teamName: string, task: string): string {
    const id = ulid();
    this.db.prepare(`
      INSERT INTO runs (id, team_file, team_name, task, status, started_at, total_tokens, total_cost_usd)
      VALUES (@id, @team_file, @team_name, @task, 'pending', @started_at, 0, 0.0)
    `).run({ id, team_file: teamFile, team_name: teamName, task, started_at: new Date().toISOString() });
    return id;
  }

  updateRunStatus(runId: string, status: string, error?: string): void {
    this.db.prepare(`UPDATE runs SET status = @status, error = @error WHERE id = @id`)
      .run({ id: runId, status, error: error ?? null });
  }

  completeRun(runId: string, status: string, totals: { tokens: number; cost: number }): void {
    this.db.prepare(`
      UPDATE runs SET status = @status, completed_at = @completed_at, total_tokens = @total_tokens, total_cost_usd = @total_cost_usd WHERE id = @id
    `).run({ id: runId, status, completed_at: new Date().toISOString(), total_tokens: totals.tokens, total_cost_usd: totals.cost });
  }

  getRun(runId: string): RunRow | null {
    return (this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as RunRow | undefined) ?? null;
  }

  listRuns(limit: number = 50): RunSummary[] {
    return this.db.prepare(`
      SELECT r.*, (SELECT COUNT(*) FROM steps s WHERE s.run_id = r.id) AS step_count
      FROM runs r ORDER BY r.started_at DESC LIMIT ?
    `).all(limit) as RunSummary[];
  }

  // ── Step Methods ─────────────────────────────────────────────────────────

  createStep(runId: string, stepId: string, agentId?: string): void {
    this.db.prepare(`
      INSERT INTO steps (id, run_id, step_id, agent_id, status, attempt, tokens_in, tokens_out, cost_usd, duration_ms)
      VALUES (@id, @run_id, @step_id, @agent_id, 'pending', 1, 0, 0, 0.0, 0)
    `).run({ id: ulid(), run_id: runId, step_id: stepId, agent_id: agentId ?? null });
  }

  updateStep(runId: string, stepId: string, patch: Partial<StepRow>): void {
    const keys = Object.keys(patch).filter(k => STEP_MUTABLE.has(k));
    if (keys.length === 0) return;

    const cacheKey = keys.sort().join(',');
    let stmt = this._stmtCache.get(cacheKey);
    if (!stmt) {
      const setClauses = keys.map(k => `${k} = @${k}`).join(', ');
      stmt = this.db.prepare(`UPDATE steps SET ${setClauses} WHERE run_id = @run_id AND step_id = @step_id`);
      this._stmtCache.set(cacheKey, stmt);
    }

    const params: Record<string, unknown> = { run_id: runId, step_id: stepId };
    for (const k of keys) params[k] = (patch as Record<string, unknown>)[k] ?? null;
    stmt.run(params);
  }

  getRunSteps(runId: string): StepRow[] {
    return this.db.prepare(`SELECT * FROM steps WHERE run_id = ? ORDER BY id ASC`).all(runId) as StepRow[];
  }

  // ── Fact Methods ─────────────────────────────────────────────────────────

  publishFact(runId: string, stepId: string, fact: Fact): number {
    let supersedesId: number | null = null;
    if (fact.supersedes) {
      const row = this.db.prepare(`SELECT id FROM facts WHERE run_id = @run_id AND key = @key ORDER BY id DESC LIMIT 1`)
        .get({ run_id: runId, key: fact.supersedes }) as { id: number } | undefined;
      supersedesId = row?.id ?? null;
    }

    const info = this.db.prepare(`
      INSERT INTO facts (run_id, step_id, key, value, type, source, confidence, published_at, supersedes)
      VALUES (@run_id, @step_id, @key, @value, @type, @source, @confidence, @published_at, @supersedes)
    `).run({
      run_id: runId, step_id: stepId, key: fact.key, value: fact.value,
      type: fact.status ?? 'provisional', source: fact.source, confidence: 1.0,
      published_at: new Date(fact.timestamp).toISOString(), supersedes: supersedesId,
    });

    return Number(info.lastInsertRowid);
  }

  getRunFacts(runId: string): FactRow[] {
    return this.db.prepare(`SELECT * FROM facts WHERE run_id = ? ORDER BY id ASC`).all(runId) as FactRow[];
  }

  // ── Event Methods ────────────────────────────────────────────────────────

  appendEvent(runId: string, event: TraceEvent): void {
    this.db.prepare(`
      INSERT INTO events (run_id, step_id, type, data, timestamp)
      VALUES (@run_id, @step_id, @type, @data, @timestamp)
    `).run({
      run_id: runId, step_id: event.stepId ?? null, type: event.type,
      data: JSON.stringify(event.data), timestamp: new Date(event.timestamp).toISOString(),
    });
  }

  // ── Resume Support ───────────────────────────────────────────────────────

  getResumableState(runId: string): ResumableState {
    const succeededSteps = (
      this.db.prepare(`SELECT step_id FROM steps WHERE run_id = ? AND status = 'succeeded'`).all(runId) as Array<{ step_id: string }>
    ).map(r => r.step_id);
    return { succeededSteps, facts: this.getRunFacts(runId) };
  }

  // ── Schema ───────────────────────────────────────────────────────────────

  private _createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, team_file TEXT NOT NULL, team_name TEXT NOT NULL,
        task TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT NOT NULL, completed_at TEXT,
        total_tokens INTEGER NOT NULL DEFAULT 0, total_cost_usd REAL NOT NULL DEFAULT 0.0,
        error TEXT, metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL, agent_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending', attempt INTEGER NOT NULL DEFAULT 1,
        started_at TEXT, completed_at TEXT, input TEXT, output TEXT, error TEXT,
        tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0.0, duration_ms INTEGER NOT NULL DEFAULT 0,
        UNIQUE (run_id, step_id)
      );
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'provisional', source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0, published_at TEXT NOT NULL,
        supersedes INTEGER REFERENCES facts(id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step_id TEXT, type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}', timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id);
      CREATE INDEX IF NOT EXISTS idx_facts_run ON facts(run_id);
      CREATE INDEX IF NOT EXISTS idx_facts_run_key ON facts(run_id, key);
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
    `);
  }
}
