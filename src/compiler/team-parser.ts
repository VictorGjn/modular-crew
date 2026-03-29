/**
 * modular-crew — Team Parser & Validator
 *
 * Reads YAML team files, validates them against the Zod schema, and performs
 * static analysis: DAG cycle detection, fact consistency, condition checks,
 * and topological sort for execution order.
 *
 * Zero network calls. All validation runs in <100ms.
 */

import { readFileSync } from 'node:fs';
import {
  parseDocument,
  type Document,
  type LineCounter,
  LineCounter as LC,
} from 'yaml';
import { ZodError } from 'zod';
import {
  TeamDefinition,
  type FlowStep,
  type Condition,
} from '../types.js';

// ── Error Types ──────────────────────────────────────────────────────────────

export class ParseError extends Error {
  readonly filePath: string;
  readonly line?: number;

  constructor(message: string, filePath: string, line?: number) {
    const loc = line != null ? `:${line}` : '';
    super(`${filePath}${loc}: ${message}`);
    this.name = 'ParseError';
    this.filePath = filePath;
    this.line = line;
  }
}

// ── Validation Result Types ──────────────────────────────────────────────────

export interface ValidationError {
  code: string;    // E001–E005
  message: string;
  stepId?: string;
  line?: number;
  suggestion?: string;
}

export interface ValidationWarning {
  code: string;    // W001–W002
  message: string;
  stepId?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  executionOrder: string[];
}

// ── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parse a YAML team file from disk, validate against TeamDefinition schema,
 * and return a typed TeamDefinition.
 *
 * Throws `ParseError` with file path, line number (when available), and a
 * clear human-readable message.
 */
export function parseTeamFile(filePath: string): TeamDefinition {
  // 1. Read raw file
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err: any) {
    throw new ParseError(
      `Cannot read file: ${err.code === 'ENOENT' ? 'file not found' : err.message}`,
      filePath,
    );
  }

  // 2. Parse YAML with line tracking
  const lineCounter = new LC();
  let doc: Document;
  try {
    doc = parseDocument(raw, { lineCounter });
  } catch (err: any) {
    // yaml parse errors typically include offset; convert to line
    const line = err.linePos?.[0]?.line ?? extractLineFromOffset(raw, err.offset);
    throw new ParseError(
      `YAML syntax error: ${err.message}`,
      filePath,
      line,
    );
  }

  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    const line = first.linePos?.[0]?.line;
    throw new ParseError(
      `YAML parse error: ${first.message}`,
      filePath,
      line,
    );
  }

  const plain = doc.toJSON();
  if (plain == null || typeof plain !== 'object') {
    throw new ParseError('File is empty or does not contain a YAML mapping', filePath);
  }

  // 3. Validate against Zod schema
  const result = TeamDefinition.safeParse(plain);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue.path.join('.');
    const line = resolveZodLine(doc, firstIssue.path, lineCounter);
    throw new ParseError(
      `Validation error at '${path}': ${firstIssue.message}`,
      filePath,
      line,
    );
  }

  return result.data;
}

// ── Validate ─────────────────────────────────────────────────────────────────

/**
 * Static analysis of a parsed TeamDefinition. No network calls, runs in <100ms.
 *
 * Checks:
 *  - E001 Circular dependency in flow
 *  - E002 Unresolved fact dependency (requires X but nobody publishes X)
 *  - E003 Step has both 'agent' and 'parallel'
 *  - E004 Retry references non-existent step
 *  - E005 Condition references unknown fact
 *  - W001 Orphan published fact (nobody requires it)
 *  - W002 Studio ref used but no studio: block defined
 *
 * Also produces a topological execution order (reusable by the compiler).
 */
export function validateTeam(team: TeamDefinition): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const flow = team.flow;
  const stepIds = Object.keys(flow);

  // ── Collect all publishes & requires ──────────────────────────────────────

  const allPublished = new Map<string, string[]>(); // factKey → [stepIds]
  const allRequired = new Map<string, string[]>();  // factKey → [stepIds]

  for (const stepId of stepIds) {
    const step = flow[stepId];

    // Top-level publishes/requires
    for (const key of step.publishes ?? []) {
      pushMap(allPublished, key, stepId);
    }
    for (const key of step.requires ?? []) {
      pushMap(allRequired, key, stepId);
    }

    // Parallel branch publishes/requires
    if (step.parallel) {
      for (const [branchId, branch] of Object.entries(step.parallel)) {
        for (const key of branch.publishes ?? []) {
          pushMap(allPublished, key, `${stepId}.${branchId}`);
        }
        for (const key of branch.requires ?? []) {
          pushMap(allRequired, key, `${stepId}.${branchId}`);
        }
      }
    }
  }

  const publishedKeys = new Set(allPublished.keys());
  const requiredKeys = new Set(allRequired.keys());

  // ── E003: agent + parallel mutual exclusivity ─────────────────────────────

  for (const stepId of stepIds) {
    const step = flow[stepId];
    if (step.agent != null && step.parallel != null) {
      errors.push({
        code: 'E003',
        message: `Step '${stepId}' defines both 'agent' and 'parallel'. Use one or the other.`,
        stepId,
        suggestion: `Split into separate steps, or use 'parallel' with multiple branches.`,
      });
    }
  }

  // ── E004: Retry references non-existent step ─────────────────────────────

  for (const stepId of stepIds) {
    const step = flow[stepId];
    if (step.retry && !flow[step.retry.step]) {
      errors.push({
        code: 'E004',
        message: `Step '${stepId}' retry.step references '${step.retry.step}', which does not exist in flow.`,
        stepId,
        suggestion: `Check the step name. Available steps: ${stepIds.join(', ')}`,
      });
    }
  }

  // ── E001: Circular dependency detection ───────────────────────────────────
  // Build adjacency from 'after' edges. Retry back-edges (explicit loops) are
  // excluded — they are intentional and handled at runtime.

  const retryBackEdges = new Set<string>();
  for (const stepId of stepIds) {
    const step = flow[stepId];
    if (step.retry) {
      retryBackEdges.add(`${stepId}->${step.retry.step}`);
    }
  }

  const adj = buildAdjacency(flow, retryBackEdges);
  const cycle = detectCycle(adj, stepIds);
  if (cycle) {
    errors.push({
      code: 'E001',
      message: `Circular dependency detected: ${cycle.join(' → ')}`,
      stepId: cycle[0],
      suggestion: `Break the cycle by removing an 'after' dependency, or use retry.step for intentional loops.`,
    });
  }

  // ── E002: Unresolved fact dependencies ────────────────────────────────────

  for (const [factKey, consumers] of allRequired) {
    if (!publishedKeys.has(factKey)) {
      for (const consumer of consumers) {
        // consumer may be "stepId" or "stepId.branchId"
        const stepId = consumer.split('.')[0];
        errors.push({
          code: 'E002',
          message: `'${consumer}' requires fact '${factKey}', but no step publishes it.`,
          stepId,
          suggestion: `Add '${factKey}' to the 'publishes' list of the step that produces it.`,
        });
      }
    }
  }

  // ── E005: Condition references unknown fact ───────────────────────────────

  for (const stepId of stepIds) {
    const step = flow[stepId];
    if (step.when == null) continue;

    const referencedFacts = extractConditionVars(step.when);
    for (const varName of referencedFacts) {
      if (!publishedKeys.has(varName)) {
        errors.push({
          code: 'E005',
          message: `Condition in step '${stepId}' references '${varName}', which is not published by any step.`,
          stepId,
          suggestion: `Ensure a preceding step publishes '${varName}', or fix the condition expression.`,
        });
      }
    }
  }

  // ── W001: Orphan published facts ──────────────────────────────────────────

  for (const [factKey, publishers] of allPublished) {
    if (!requiredKeys.has(factKey)) {
      for (const publisher of publishers) {
        const stepId = publisher.split('.')[0];
        warnings.push({
          code: 'W001',
          message: `Step '${publisher}' publishes '${factKey}' but no step requires it.`,
          stepId,
        });
      }
    }
  }

  // ── W002: Studio ref without studio block ─────────────────────────────────

  for (const stepId of stepIds) {
    const step = flow[stepId];
    const refs = collectStudioRefs(step);
    if (refs.length > 0 && !team.studio) {
      for (const ref of refs) {
        warnings.push({
          code: 'W002',
          message: `Step '${stepId}' uses studio ref '${ref}' but no 'studio' block is defined.`,
          stepId,
        });
      }
    }
  }

  // ── Topological sort (produces execution order) ───────────────────────────

  let executionOrder: string[] = [];
  if (!cycle) {
    executionOrder = topoSort(flow);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    executionOrder,
  };
}

// ── Topological Sort ─────────────────────────────────────────────────────────

/**
 * Kahn's algorithm topological sort on flow steps. Retry back-edges are excluded
 * so intentional loops don't prevent sorting. Returns step IDs in dependency
 * order (steps with no dependencies first).
 *
 * Throws if graph contains a cycle (use validateTeam first to get diagnostics).
 */
export function topoSort(flow: Record<string, FlowStep>): string[] {
  const stepIds = Object.keys(flow);

  // Collect retry back-edges to exclude
  const retryBackEdges = new Set<string>();
  for (const stepId of stepIds) {
    const step = flow[stepId];
    if (step.retry) {
      retryBackEdges.add(`${stepId}->${step.retry.step}`);
    }
  }

  // Build in-degree map and adjacency (forward edges only)
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dependency → [steps that depend on it]

  for (const id of stepIds) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }

  for (const stepId of stepIds) {
    const step = flow[stepId];
    const deps = normalizeAfter(step.after);
    for (const dep of deps) {
      if (!flow[dep]) continue; // skip invalid refs (E004 catches these)
      const edgeKey = `${stepId}->${dep}`;
      if (retryBackEdges.has(edgeKey)) continue; // intentional loop
      inDegree.set(stepId, (inDegree.get(stepId) ?? 0) + 1);
      dependents.get(dep)!.push(stepId);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  // Sort initial queue for deterministic output
  queue.sort();

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);

    for (const dependent of dependents.get(current) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) {
        // Insert sorted to keep deterministic order
        insertSorted(queue, dependent);
      }
    }
  }

  if (sorted.length !== stepIds.length) {
    // Cycle exists — return what we have (validateTeam gives better diagnostics)
    const stuck = stepIds.filter(id => !sorted.includes(id));
    throw new Error(`Cycle detected involving steps: ${stuck.join(', ')}`);
  }

  return sorted;
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/** Normalize `after` field to always be an array of step IDs. */
function normalizeAfter(after: string | string[] | undefined): string[] {
  if (after == null) return [];
  return Array.isArray(after) ? after : [after];
}

/** Build adjacency list (stepId → set of dependencies). Excludes retry back-edges. */
function buildAdjacency(
  flow: Record<string, FlowStep>,
  retryBackEdges: Set<string>,
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const stepId of Object.keys(flow)) {
    const deps = normalizeAfter(flow[stepId].after).filter(dep => {
      const edgeKey = `${stepId}->${dep}`;
      return !retryBackEdges.has(edgeKey);
    });
    adj.set(stepId, deps);
  }
  return adj;
}

/**
 * DFS cycle detection. Returns the cycle path if found, null otherwise.
 * Uses three-color marking: white (unvisited), gray (in stack), black (done).
 */
function detectCycle(
  adj: Map<string, string[]>,
  stepIds: string[],
): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  for (const id of stepIds) {
    color.set(id, WHITE);
  }

  for (const startId of stepIds) {
    if (color.get(startId) !== WHITE) continue;

    const stack: string[] = [startId];
    parent.set(startId, null);

    while (stack.length > 0) {
      const node = stack[stack.length - 1];

      if (color.get(node) === WHITE) {
        color.set(node, GRAY);
        const neighbors = adj.get(node) ?? [];
        for (const neighbor of neighbors) {
          if (!adj.has(neighbor)) continue; // skip non-existent steps
          if (color.get(neighbor) === GRAY) {
            // Found cycle — reconstruct path
            return reconstructCycle(parent, node, neighbor);
          }
          if (color.get(neighbor) === WHITE) {
            parent.set(neighbor, node);
            stack.push(neighbor);
          }
        }
      } else {
        // Backtrack
        color.set(node, BLACK);
        stack.pop();
      }
    }
  }

  return null;
}

/** Reconstruct cycle path from parent map. */
function reconstructCycle(
  parent: Map<string, string | null>,
  from: string,
  to: string,
): string[] {
  const path: string[] = [to];
  let current: string | null = from;
  while (current != null && current !== to) {
    path.push(current);
    current = parent.get(current) ?? null;
  }
  path.push(to);
  return path.reverse();
}

/**
 * Extract variable names referenced in a condition.
 *
 * For structured conditions: returns [condition.fact].
 * For string expressions: extracts identifiers that aren't JS keywords/literals,
 * matching the variables that expr-eval would expect from the fact bus.
 */
function extractConditionVars(cond: Condition): string[] {
  if (typeof cond === 'object' && 'fact' in cond) {
    return [cond.fact];
  }

  if (typeof cond === 'string') {
    // Extract identifiers from expr-eval expression.
    // Remove string literals first to avoid false matches.
    const cleaned = cond.replace(/'[^']*'|"[^"]*"/g, '');
    const identifiers = cleaned.match(/[a-zA-Z_][a-zA-Z0-9_.]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*/g) ?? [];

    // Filter out known expr-eval keywords, operators, and literals
    const reserved = new Set([
      'true', 'false', 'null', 'undefined',
      'and', 'or', 'not', 'in',
      'if', 'then', 'else',
      'abs', 'ceil', 'floor', 'round', 'min', 'max', 'sqrt',
      'length', 'concat', 'indexOf', 'join', 'split',
    ]);

    const vars = new Set<string>();
    for (const id of identifiers) {
      // Take the root identifier (before any dots) for fact key matching
      const root = id.split('.')[0];
      if (!reserved.has(root)) {
        vars.add(root);
      }
    }
    return [...vars];
  }

  return [];
}

/**
 * Collect all studio:// agent refs from a flow step (including parallel branches).
 */
function collectStudioRefs(step: FlowStep): string[] {
  const refs: string[] = [];

  if (typeof step.agent === 'string' && step.agent.startsWith('studio://')) {
    refs.push(step.agent);
  }

  if (step.parallel) {
    for (const branch of Object.values(step.parallel)) {
      if (typeof branch.agent === 'string' && branch.agent.startsWith('studio://')) {
        refs.push(branch.agent);
      }
    }
  }

  return refs;
}

/**
 * Attempt to resolve a Zod validation error path to a YAML line number.
 * Walks the YAML document AST using the Zod issue path segments.
 */
function resolveZodLine(
  doc: Document,
  path: (string | number)[],
  lineCounter: LineCounter,
): number | undefined {
  try {
    let node: any = doc.contents;
    for (const segment of path) {
      if (node == null) return undefined;
      if (typeof segment === 'number') {
        // Array index
        node = (node as any).items?.[segment];
      } else {
        // Map key
        if (node.items) {
          const pair = (node as any).items.find(
            (item: any) => item.key?.value === segment || item.key === segment,
          );
          node = pair?.value;
        } else {
          return undefined;
        }
      }
    }
    if (node?.range?.[0] != null) {
      const pos = lineCounter.linePos(node.range[0]);
      return pos.line;
    }
  } catch {
    // Best-effort — line number is nice-to-have
  }
  return undefined;
}

/** Convert a byte offset to a 1-based line number. */
function extractLineFromOffset(raw: string, offset?: number): number | undefined {
  if (offset == null) return undefined;
  let line = 1;
  for (let i = 0; i < offset && i < raw.length; i++) {
    if (raw[i] === '\n') line++;
  }
  return line;
}

/** Push into a Map<K, V[]>. */
function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/** Insert a string into an already-sorted array, maintaining sort order. */
function insertSorted(arr: string[], value: string): void {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, value);
}
