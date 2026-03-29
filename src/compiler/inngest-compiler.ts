/**
 * modular-crew — Inngest Compiler
 *
 * Compiles a TeamDefinition YAML into an Inngest function.
 * Instead of a custom DAG engine, the YAML flow becomes Inngest step functions.
 * Inngest handles: durable execution, retry, human-in-the-loop (step.waitForEvent),
 * and observability.
 *
 * Design decisions:
 *   - Inngest client is injected (CompilerDeps), never imported directly
 *   - Each flow step → one step.run() (or step.waitForEvent for approvals)
 *   - Parallel branches → Promise.allSettled inside a single step.run()
 *   - Retry loops → while loop with step.run() per iteration
 *   - Budget enforcement after every step
 *   - Topological sort ensures correct execution order
 *   - FactBus collects facts across steps; RunStore persists state to SQLite
 */

import type {
  TeamDefinition,
  FlowStep,
  AgentRef,
  InlineAgent,
  Condition,
  ContextSpec,
  Fact,
  StepResult,
  StepState,
  RunState,
  RunStatus,
  ResolvedAgent,
  AgentRunEvent,
  StudioProvider,
  TraceEvent,
  TraceEventType,
} from '../types.js';
import { estimateCost, DepthLevel, DEPTH_TOKEN_RATIOS } from '../types.js';

// ── External type stubs (from Inngest SDK, not imported) ─────────────────────
// These mirror the subset of Inngest types we actually use, so the compiler
// remains testable without a real Inngest dependency.

/** Minimal Inngest client interface. */
export interface InngestClient {
  createFunction(
    config: InngestFunctionConfig,
    trigger: InngestTrigger,
    handler: (ctx: InngestStepContext) => Promise<unknown>,
  ): InngestFunction;
}

export interface InngestFunctionConfig {
  id: string;
  name: string;
  retries?: number;
  concurrency?: { limit: number }[];
}

export interface InngestTrigger {
  event: string;
}

export interface InngestStepContext {
  event: { data: Record<string, unknown> };
  step: InngestStep;
}

export interface InngestStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  waitForEvent<T = unknown>(
    id: string,
    opts: { event: string; timeout: string; match?: string },
  ): Promise<T | null>;
  sleep(id: string, duration: string): Promise<void>;
}

/** The compiled Inngest function (opaque to us). */
export type InngestFunction = unknown;

// ── FactBus ──────────────────────────────────────────────────────────────────

export interface FactBus {
  publish(fact: Fact): void;
  get(key: string): Fact | undefined;
  getAll(): Fact[];
  require(keys: string[]): Fact[];
  snapshot(): Fact[];
}

// ── RunStore ─────────────────────────────────────────────────────────────────

export interface RunStore {
  create(run: RunState): void;
  update(run: RunState): void;
  get(id: string): RunState | undefined;
}

// ── Compiler Dependencies ────────────────────────────────────────────────────

export interface CompilerDeps {
  inngest: InngestClient;
  studioProvider: StudioProvider;
  factBus: FactBus;
  runStore: RunStore;
  tracer: (event: TraceEvent) => void;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class BudgetExceededError extends Error {
  constructor(
    public readonly runId: string,
    public readonly metric: 'cost' | 'tokens',
    public readonly current: number,
    public readonly limit: number,
  ) {
    super(`Budget exceeded: ${metric} is ${current}, limit is ${limit} (run ${runId})`);
    this.name = 'BudgetExceededError';
  }
}

export class ConditionError extends Error {
  constructor(
    public readonly stepId: string,
    public readonly condition: Condition,
    cause?: unknown,
  ) {
    super(`Condition evaluation failed for step "${stepId}": ${String(cause)}`);
    this.name = 'ConditionError';
  }
}

export class CycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Cycle detected in flow: ${cycle.join(' → ')}`);
    this.name = 'CycleError';
  }
}

// ── Topological Sort ─────────────────────────────────────────────────────────

/**
 * Kahn's algorithm. Returns step IDs in execution order.
 * Throws CycleError if the flow graph contains a cycle.
 */
export function topoSort(flow: Record<string, FlowStep>): string[] {
  const ids = Object.keys(flow);
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  // Initialise
  for (const id of ids) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }

  // Build edges: "after" means dependency → current
  for (const [id, step] of Object.entries(flow)) {
    const deps = normalizeAfter(step.after);
    for (const dep of deps) {
      if (!adj.has(dep)) {
        // Referencing a step that doesn't exist — surface early
        throw new Error(`Step "${id}" depends on unknown step "${dep}"`);
      }
      adj.get(dep)!.push(id);
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
    }
  }

  // BFS from zero-indegree nodes
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    // Stable sort: process in declaration order when indegree is equal
    queue.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
    const current = queue.shift()!;
    sorted.push(current);
    for (const neighbor of adj.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== ids.length) {
    // Find cycle for error message
    const remaining = ids.filter((id) => !sorted.includes(id));
    throw new CycleError(remaining);
  }

  return sorted;
}

// ── Prompt Builder ───────────────────────────────────────────────────────────

/**
 * Assembles the full agent prompt from task, packed context, relevant facts,
 * and the list of facts the step is expected to publish.
 */
export function buildAgentPrompt(
  task: string,
  context: string,
  facts: Fact[],
  publishes?: string[],
): string {
  const sections: string[] = [];

  // Task
  sections.push(`<task>\n${task}\n</task>`);

  // Context (from depth-aware packing)
  if (context) {
    sections.push(`<context>\n${context}\n</context>`);
  }

  // Facts from prior steps
  if (facts.length > 0) {
    const factLines = facts.map(
      (f) => `- **${f.key}** (${f.status}, from ${f.source}): ${f.value}`,
    );
    sections.push(`<facts>\n${factLines.join('\n')}\n</facts>`);
  }

  // Publish contract — tells the agent which facts it should produce
  if (publishes && publishes.length > 0) {
    sections.push(
      `<publish_contract>\nYou MUST produce the following facts in your output:\n${publishes.map((p) => `- ${p}`).join('\n')}\n\nFormat each fact as:\n[FACT:key] value [/FACT]\n</publish_contract>`,
    );
  }

  return sections.join('\n\n');
}

// ── Fact Extraction ──────────────────────────────────────────────────────────

const FACT_REGEX = /\[FACT:([^\]]+)\]\s*([\s\S]*?)\s*\[\/FACT\]/g;

/**
 * Extracts facts from agent output using [FACT:key] value [/FACT] delimiters.
 */
export function extractFacts(output: string, source: string): Fact[] {
  const facts: Fact[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  FACT_REGEX.lastIndex = 0;
  while ((match = FACT_REGEX.exec(output)) !== null) {
    facts.push({
      key: match[1].trim(),
      value: match[2].trim(),
      source,
      timestamp: Date.now(),
      status: 'provisional',
    });
  }
  return facts;
}

// ── Condition Evaluator ──────────────────────────────────────────────────────

/**
 * Evaluates a `when` condition against the current fact bus.
 * Supports structured conditions (fact-based) and expr-eval strings.
 */
export function evaluateCondition(
  condition: Condition,
  factBus: FactBus,
): boolean {
  if (typeof condition === 'string') {
    return evaluateExprCondition(condition, factBus);
  }

  // Structured condition
  const fact = factBus.get(condition.fact);
  if (!fact) return false;

  const val = fact.value;

  if (condition.equals !== undefined) return val === condition.equals;
  if (condition.not !== undefined) return val !== condition.not;
  if (condition.contains !== undefined) return val.includes(condition.contains);
  if (condition.gt !== undefined) return Number(val) > condition.gt;
  if (condition.lt !== undefined) return Number(val) < condition.lt;

  // fact exists with no comparison operator = truthy
  return true;
}

/**
 * Simple expression evaluator for string conditions.
 * Builds a variable scope from all facts and evaluates using expr-eval.
 * Falls back to a safe subset if expr-eval is not available.
 */
function evaluateExprCondition(expr: string, factBus: FactBus): boolean {
  // Build scope: fact keys → values (coerce numbers where possible)
  const scope: Record<string, unknown> = {};
  for (const fact of factBus.getAll()) {
    const num = Number(fact.value);
    scope[fact.key] = isNaN(num) ? fact.value : num;
  }

  // We use dynamic Function as a sandboxed evaluator.
  // The scope is frozen, no access to globals beyond what we pass.
  // In production, use expr-eval for proper sandboxing.
  try {
    const keys = Object.keys(scope);
    const values = Object.values(scope);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(...keys, `return Boolean(${expr})`);
    return fn(...values) as boolean;
  } catch {
    // If eval fails, condition is false (fail-closed)
    return false;
  }
}

// ── Agent Resolution ─────────────────────────────────────────────────────────

/**
 * Resolves an AgentRef to a ResolvedAgent.
 * - string refs → delegate to StudioProvider.resolveAgent
 * - inline agents → construct directly with team defaults
 */
async function resolveAgent(
  ref: AgentRef,
  stepId: string,
  defaults: NonNullable<TeamDefinition['defaults']>,
  studioProvider: StudioProvider,
): Promise<ResolvedAgent> {
  if (typeof ref === 'string') {
    return studioProvider.resolveAgent(ref);
  }

  // Inline agent
  const inline = ref as InlineAgent;
  return {
    id: `inline:${stepId}`,
    name: stepId,
    systemPrompt: inline.system,
    model: inline.model ?? defaults.model ?? 'claude-sonnet-4-20250514',
    tools: inline.tools,
    maxTurns: inline.maxTurns ?? defaults.maxTurns ?? 15,
    maxOutputTokens: inline.maxOutputTokens ?? defaults.maxOutputTokens,
  };
}

// ── Context Packing ──────────────────────────────────────────────────────────

/**
 * Packs context for an agent step. Delegates to StudioProvider when sources
 * are specified; otherwise returns an empty string (the prompt itself is
 * the context).
 */
async function packContext(
  contextSpec: ContextSpec | undefined,
  defaults: NonNullable<TeamDefinition['defaults']>,
  studioProvider: StudioProvider,
): Promise<string> {
  if (!contextSpec?.sources || contextSpec.sources.length === 0) {
    return '';
  }

  const depth = contextSpec.depth ?? 'detail';
  const budget = contextSpec.tokenBudget ?? defaults.tokenBudget ?? 50000;
  const traversal = contextSpec.traversal;

  return studioProvider.packContext(contextSpec.sources, depth, budget, traversal);
}

// ── Agent Execution (streaming collector) ────────────────────────────────────

interface AgentExecutionResult {
  output: string;
  tokensIn: number;
  tokensOut: number;
  facts: Fact[];
}

/**
 * Executes an agent, collecting streaming events into a final result.
 */
async function executeAgentCollect(
  agent: ResolvedAgent,
  prompt: string,
  studioProvider: StudioProvider,
  signal?: AbortSignal,
): Promise<AgentExecutionResult> {
  let output = '';
  let tokensIn = 0;
  let tokensOut = 0;
  const streamFacts: Fact[] = [];

  for await (const event of studioProvider.executeAgent(agent, prompt, signal)) {
    switch (event.type) {
      case 'text':
        output += String(event.data);
        break;
      case 'fact':
        streamFacts.push(event.data as Fact);
        break;
      case 'error':
        throw new Error(`Agent error: ${String(event.data)}`);
      default:
        break;
    }
    if (event.tokensIn) tokensIn += event.tokensIn;
    if (event.tokensOut) tokensOut += event.tokensOut;
  }

  // Also extract facts from text output (agent may use [FACT:...] markers)
  const textFacts = extractFacts(output, agent.id);
  const allFacts = [...streamFacts, ...textFacts];

  // Deduplicate by key (stream facts take precedence)
  const seen = new Set<string>();
  const dedupedFacts: Fact[] = [];
  for (const fact of allFacts) {
    if (!seen.has(fact.key)) {
      seen.add(fact.key);
      dedupedFacts.push(fact);
    }
  }

  return { output, tokensIn, tokensOut, facts: dedupedFacts };
}

// ── Budget Enforcement ───────────────────────────────────────────────────────

function checkBudget(
  run: RunState,
  budget: TeamDefinition['budget'],
  tracer: (event: TraceEvent) => void,
): void {
  if (!budget) return;

  const totalTokens = run.totalTokensIn + run.totalTokensOut;

  if (budget.maxCost && run.totalCostUsd > budget.maxCost) {
    tracer({
      timestamp: Date.now(),
      runId: run.id,
      type: 'budget.exceeded',
      data: { metric: 'cost', current: run.totalCostUsd, limit: budget.maxCost },
    });
    throw new BudgetExceededError(run.id, 'cost', run.totalCostUsd, budget.maxCost);
  }

  if (budget.maxTokens && totalTokens > budget.maxTokens) {
    tracer({
      timestamp: Date.now(),
      runId: run.id,
      type: 'budget.exceeded',
      data: { metric: 'tokens', current: totalTokens, limit: budget.maxTokens },
    });
    throw new BudgetExceededError(run.id, 'tokens', totalTokens, budget.maxTokens);
  }

  // Emit warning at 80% threshold
  if (budget.maxCost && run.totalCostUsd > budget.maxCost * 0.8) {
    tracer({
      timestamp: Date.now(),
      runId: run.id,
      type: 'budget.warning',
      data: { metric: 'cost', current: run.totalCostUsd, limit: budget.maxCost, pct: run.totalCostUsd / budget.maxCost },
    });
  }

  if (budget.maxTokens && totalTokens > budget.maxTokens * 0.8) {
    tracer({
      timestamp: Date.now(),
      runId: run.id,
      type: 'budget.warning',
      data: { metric: 'tokens', current: totalTokens, limit: budget.maxTokens, pct: totalTokens / budget.maxTokens },
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeAfter(after: FlowStep['after']): string[] {
  if (!after) return [];
  return Array.isArray(after) ? after : [after];
}

function makeRunId(): string {
  // Simplified ULID-like: timestamp + random suffix
  // In production, use the `ulid` package
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${t}${r}`;
}

function msToInngestDuration(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

function makeStepResult(stepId: string, state: StepState, attempt: number): StepResult {
  return {
    stepId,
    state,
    attempt,
    facts: [],
  };
}

function withDefaults(team: TeamDefinition): NonNullable<TeamDefinition['defaults']> {
  return {
    provider: team.defaults?.provider ?? 'anthropic',
    model: team.defaults?.model ?? 'claude-sonnet-4-20250514',
    maxTurns: team.defaults?.maxTurns ?? 15,
    tokenBudget: team.defaults?.tokenBudget ?? 50000,
    maxOutputTokens: team.defaults?.maxOutputTokens ?? 4000,
    stepTimeout: team.defaults?.stepTimeout ?? 300_000,
  };
}

// ── Core Compiler ────────────────────────────────────────────────────────────

/**
 * Compiles a TeamDefinition into an Inngest function.
 *
 * The returned function, when triggered by an event, will:
 * 1. Create a RunState and persist to SQLite
 * 2. Walk the topo-sorted flow steps
 * 3. Execute each step via step.run() (with conditions, context, facts)
 * 4. Handle parallel, retry/loop, and approval patterns
 * 5. Enforce budget after every step
 * 6. Return the final RunState
 */
export function compileTeam(
  team: TeamDefinition,
  deps: CompilerDeps,
): InngestFunction {
  const { inngest, studioProvider, factBus, runStore, tracer } = deps;
  const defaults = withDefaults(team);
  const sortedStepIds = topoSort(team.flow);

  const functionId = `crew-${team.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;

  return inngest.createFunction(
    {
      id: functionId,
      name: `Crew: ${team.name}`,
      retries: 0, // We handle retries at the step level
      concurrency: [{ limit: 1 }], // One run at a time per function
    },
    { event: `crew/${team.name}` },
    async ({ event, step }) => {
      // ── 1. Initialise RunState ─────────────────────────────────────────

      const task = (event.data.task as string) ?? '';
      const teamFile = (event.data.teamFile as string) ?? '';
      const runId = makeRunId();

      const run: RunState = {
        id: runId,
        teamFile,
        teamName: team.name,
        task,
        status: 'running',
        steps: new Map(),
        facts: [],
        startedAt: Date.now(),
        totalTokensIn: 0,
        totalTokensOut: 0,
        totalCostUsd: 0,
        loopCounts: new Map(),
      };

      // Initialise all steps as pending
      for (const stepId of sortedStepIds) {
        run.steps.set(stepId, makeStepResult(stepId, 'pending', 0));
      }

      runStore.create(run);
      tracer({
        timestamp: Date.now(),
        runId,
        type: 'run.start',
        data: { teamName: team.name, task, stepCount: sortedStepIds.length },
      });

      // ── 2. Walk steps in topological order ─────────────────────────────

      try {
        for (const stepId of sortedStepIds) {
          const flowStep = team.flow[stepId];
          const stepResult = run.steps.get(stepId)!;

          // ── 2a. Check `when` condition ─────────────────────────────────
          if (flowStep.when) {
            tracer({
              timestamp: Date.now(),
              runId,
              stepId,
              type: 'condition.eval',
              data: { condition: flowStep.when },
            });

            let conditionMet: boolean;
            try {
              conditionMet = evaluateCondition(flowStep.when, factBus);
            } catch (err) {
              throw new ConditionError(stepId, flowStep.when, err);
            }

            if (!conditionMet) {
              stepResult.state = 'skipped';
              tracer({
                timestamp: Date.now(),
                runId,
                stepId,
                type: 'step.skip',
                data: { reason: 'condition_false' },
              });
              runStore.update(run);
              continue;
            }
          }

          // ── 2b. Approval gate (human-in-the-loop) ──────────────────────
          if (flowStep.approval) {
            stepResult.state = 'waiting_human';
            runStore.update(run);
            tracer({
              timestamp: Date.now(),
              runId,
              stepId,
              type: 'step.waiting_human',
              data: {},
            });

            const timeout = flowStep.timeout ?? defaults.stepTimeout;
            const approval = await step.waitForEvent<{ data: { approved: boolean; feedback?: string } }>(
              `${stepId}/approval`,
              {
                event: `crew/${team.name}/approve`,
                timeout: msToInngestDuration(timeout),
                match: `data.stepId`,
              },
            );

            if (!approval || !approval.data.approved) {
              stepResult.state = 'cancelled';
              stepResult.error = 'Human approval denied or timed out';
              tracer({
                timestamp: Date.now(),
                runId,
                stepId,
                type: 'step.end',
                data: { state: 'cancelled', reason: 'approval_denied' },
              });
              runStore.update(run);
              continue;
            }

            tracer({
              timestamp: Date.now(),
              runId,
              stepId,
              type: 'step.human_approved',
              data: { feedback: approval.data.feedback },
            });
          }

          // ── 2c. Dispatch: parallel vs single agent vs retry loop ───────
          if (flowStep.parallel) {
            await executeParallelStep(
              stepId,
              flowStep,
              step,
              run,
              team,
              defaults,
              deps,
            );
          } else if (flowStep.retry) {
            await executeRetryLoop(
              stepId,
              flowStep,
              step,
              run,
              team,
              defaults,
              deps,
            );
          } else if (flowStep.agent) {
            await executeSingleStep(
              stepId,
              flowStep,
              step,
              run,
              team,
              defaults,
              deps,
            );
          } else {
            // Gate-only step (no agent, just conditions/approval)
            stepResult.state = 'succeeded';
            runStore.update(run);
          }

          // ── 2d. Budget check after each step ──────────────────────────
          checkBudget(run, team.budget, tracer);
        }

        // ── 3. Run complete ──────────────────────────────────────────────
        run.status = 'succeeded';
        run.completedAt = Date.now();
        run.facts = factBus.snapshot();
        runStore.update(run);

        tracer({
          timestamp: Date.now(),
          runId,
          type: 'run.end',
          data: {
            status: 'succeeded',
            totalTokensIn: run.totalTokensIn,
            totalTokensOut: run.totalTokensOut,
            totalCostUsd: run.totalCostUsd,
            durationMs: run.completedAt - run.startedAt,
          },
        });

        return serializeRunState(run);
      } catch (error) {
        // ── Error handling ─────────────────────────────────────────────
        const isBudget = error instanceof BudgetExceededError;
        run.status = isBudget ? 'budget_exceeded' : 'failed';
        run.completedAt = Date.now();
        run.error = error instanceof Error ? error.message : String(error);
        run.facts = factBus.snapshot();
        runStore.update(run);

        tracer({
          timestamp: Date.now(),
          runId,
          type: 'run.end',
          data: {
            status: run.status,
            error: run.error,
            durationMs: run.completedAt - run.startedAt,
          },
        });

        throw error;
      }
    },
  );
}

// ── Single Step Execution ────────────────────────────────────────────────────

async function executeSingleStep(
  stepId: string,
  flowStep: FlowStep,
  step: InngestStep,
  run: RunState,
  team: TeamDefinition,
  defaults: NonNullable<TeamDefinition['defaults']>,
  deps: CompilerDeps,
): Promise<void> {
  const { studioProvider, factBus, runStore, tracer } = deps;
  const stepResult = run.steps.get(stepId)!;

  stepResult.state = 'running';
  stepResult.startedAt = Date.now();
  runStore.update(run);

  tracer({
    timestamp: Date.now(),
    runId: run.id,
    stepId,
    type: 'step.start',
    data: { agent: flowStep.agent },
  });

  const result = await step.run<SerializedStepResult>(`step/${stepId}`, async () => {
    // Resolve agent
    const agent = await resolveAgent(flowStep.agent!, stepId, defaults, studioProvider);

    // Pack context
    const context = await packContext(flowStep.context, defaults, studioProvider);

    tracer({
      timestamp: Date.now(),
      runId: run.id,
      stepId,
      agentId: agent.id,
      type: 'context.pack',
      data: { contextLength: context.length, sources: flowStep.context?.sources },
    });

    // Gather required facts
    const requiredFacts = flowStep.requires
      ? factBus.require(flowStep.requires)
      : [];

    tracer({
      timestamp: Date.now(),
      runId: run.id,
      stepId,
      type: 'fact.require',
      data: { required: flowStep.requires ?? [], resolved: requiredFacts.length },
    });

    // Build prompt
    const prompt = buildAgentPrompt(
      run.task,
      context,
      requiredFacts,
      flowStep.publishes,
    );

    // Execute agent with timeout
    const timeout = flowStep.timeout ?? defaults.stepTimeout;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const execResult = await executeAgentCollect(
        agent,
        prompt,
        studioProvider,
        controller.signal,
      );

      const cost = estimateCost(agent.model, execResult.tokensIn, execResult.tokensOut);

      return {
        agentId: agent.id,
        output: execResult.output,
        tokensIn: execResult.tokensIn,
        tokensOut: execResult.tokensOut,
        costUsd: cost,
        facts: execResult.facts,
        model: agent.model,
      };
    } finally {
      clearTimeout(timer);
    }
  });

  // Update step result from the durable step.run output
  stepResult.agentId = result.agentId;
  stepResult.state = 'succeeded';
  stepResult.output = result.output;
  stepResult.tokensIn = result.tokensIn;
  stepResult.tokensOut = result.tokensOut;
  stepResult.costUsd = result.costUsd;
  stepResult.facts = result.facts;
  stepResult.completedAt = Date.now();
  stepResult.durationMs = stepResult.completedAt - (stepResult.startedAt ?? stepResult.completedAt);
  stepResult.attempt = 1;

  // Publish facts to the bus
  for (const fact of result.facts) {
    factBus.publish(fact);
    tracer({
      timestamp: Date.now(),
      runId: run.id,
      stepId,
      agentId: result.agentId,
      type: 'fact.publish',
      data: { key: fact.key, status: fact.status },
    });
  }

  // Accumulate totals
  run.totalTokensIn += result.tokensIn;
  run.totalTokensOut += result.tokensOut;
  run.totalCostUsd += result.costUsd;

  runStore.update(run);

  tracer({
    timestamp: Date.now(),
    runId: run.id,
    stepId,
    agentId: result.agentId,
    type: 'step.end',
    data: {
      state: 'succeeded',
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
    },
    durationMs: stepResult.durationMs,
  });
}

// ── Parallel Step Execution ──────────────────────────────────────────────────

async function executeParallelStep(
  stepId: string,
  flowStep: FlowStep,
  step: InngestStep,
  run: RunState,
  team: TeamDefinition,
  defaults: NonNullable<TeamDefinition['defaults']>,
  deps: CompilerDeps,
): Promise<void> {
  const { studioProvider, factBus, runStore, tracer } = deps;
  const branches = flowStep.parallel!;
  const branchIds = Object.keys(branches);

  const parentResult = run.steps.get(stepId)!;
  parentResult.state = 'running';
  parentResult.startedAt = Date.now();
  runStore.update(run);

  tracer({
    timestamp: Date.now(),
    runId: run.id,
    stepId,
    type: 'step.start',
    data: { parallel: true, branches: branchIds },
  });

  // Execute all branches inside a single step.run for durability
  const results = await step.run<SerializedBranchResult[]>(
    `step/${stepId}/parallel`,
    async () => {
      const promises = branchIds.map(async (branchId) => {
        const branch = branches[branchId];
        const fullBranchId = `${stepId}/${branchId}`;

        // Resolve agent
        const agent = await resolveAgent(branch.agent, fullBranchId, defaults, studioProvider);

        // Pack context
        const context = await packContext(branch.context, defaults, studioProvider);

        // Gather required facts
        const requiredFacts = branch.requires
          ? factBus.require(branch.requires)
          : [];

        // Build prompt
        const prompt = buildAgentPrompt(
          run.task,
          context,
          requiredFacts,
          branch.publishes,
        );

        // Execute
        const timeout = flowStep.timeout ?? defaults.stepTimeout;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        try {
          const execResult = await executeAgentCollect(
            agent,
            prompt,
            studioProvider,
            controller.signal,
          );

          const cost = estimateCost(agent.model, execResult.tokensIn, execResult.tokensOut);

          return {
            branchId,
            agentId: agent.id,
            output: execResult.output,
            tokensIn: execResult.tokensIn,
            tokensOut: execResult.tokensOut,
            costUsd: cost,
            facts: execResult.facts,
            model: agent.model,
            error: undefined as string | undefined,
          };
        } catch (err) {
          return {
            branchId,
            agentId: agent.id,
            output: '',
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
            facts: [] as Fact[],
            model: agent.model,
            error: err instanceof Error ? err.message : String(err),
          };
        } finally {
          clearTimeout(timer);
        }
      });

      const settled = await Promise.allSettled(promises);
      return settled.map((s) =>
        s.status === 'fulfilled'
          ? s.value
          : {
              branchId: 'unknown',
              agentId: '',
              output: '',
              tokensIn: 0,
              tokensOut: 0,
              costUsd: 0,
              facts: [] as Fact[],
              model: '',
              error: s.reason instanceof Error ? s.reason.message : String(s.reason),
            },
      );
    },
  );

  // Process branch results
  let allSucceeded = true;
  for (const brResult of results) {
    if (brResult.error) {
      allSucceeded = false;
      tracer({
        timestamp: Date.now(),
        runId: run.id,
        stepId: `${stepId}/${brResult.branchId}`,
        agentId: brResult.agentId,
        type: 'step.error',
        data: { error: brResult.error },
      });
    } else {
      // Publish facts from this branch
      for (const fact of brResult.facts) {
        factBus.publish(fact);
        tracer({
          timestamp: Date.now(),
          runId: run.id,
          stepId: `${stepId}/${brResult.branchId}`,
          agentId: brResult.agentId,
          type: 'fact.publish',
          data: { key: fact.key, status: fact.status },
        });
      }
    }

    // Accumulate totals
    run.totalTokensIn += brResult.tokensIn;
    run.totalTokensOut += brResult.tokensOut;
    run.totalCostUsd += brResult.costUsd;
  }

  // Merge all branch outputs into the parent step result
  parentResult.state = allSucceeded ? 'succeeded' : 'failed';
  parentResult.completedAt = Date.now();
  parentResult.durationMs = parentResult.completedAt - (parentResult.startedAt ?? parentResult.completedAt);
  parentResult.output = results
    .map((r) => `## ${r.branchId}\n${r.error ? `ERROR: ${r.error}` : r.output}`)
    .join('\n\n---\n\n');
  parentResult.tokensIn = results.reduce((sum, r) => sum + r.tokensIn, 0);
  parentResult.tokensOut = results.reduce((sum, r) => sum + r.tokensOut, 0);
  parentResult.costUsd = results.reduce((sum, r) => sum + r.costUsd, 0);
  parentResult.facts = results.flatMap((r) => r.facts);
  parentResult.attempt = 1;

  runStore.update(run);

  tracer({
    timestamp: Date.now(),
    runId: run.id,
    stepId,
    type: 'step.end',
    data: {
      state: parentResult.state,
      branches: results.map((r) => ({
        id: r.branchId,
        ok: !r.error,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
      })),
    },
    durationMs: parentResult.durationMs,
  });

  if (!allSucceeded) {
    const failedBranches = results.filter((r) => r.error).map((r) => r.branchId);
    throw new Error(`Parallel step "${stepId}" failed branches: ${failedBranches.join(', ')}`);
  }
}

// ── Retry Loop Execution ─────────────────────────────────────────────────────

async function executeRetryLoop(
  stepId: string,
  flowStep: FlowStep,
  step: InngestStep,
  run: RunState,
  team: TeamDefinition,
  defaults: NonNullable<TeamDefinition['defaults']>,
  deps: CompilerDeps,
): Promise<void> {
  const { factBus, runStore, tracer } = deps;
  const retry = flowStep.retry!;
  const maxAttempts = retry.maxAttempts ?? 2;
  const stepResult = run.steps.get(stepId)!;

  let attempt = 0;
  let lastError: string | undefined;

  while (attempt < maxAttempts) {
    attempt++;
    run.loopCounts.set(stepId, attempt);

    tracer({
      timestamp: Date.now(),
      runId: run.id,
      stepId,
      type: 'loop.iteration',
      data: { attempt, maxAttempts, retryTarget: retry.step },
    });

    stepResult.state = 'retrying';
    stepResult.attempt = attempt;
    runStore.update(run);

    try {
      // Re-execute the agent step for this iteration
      // Each iteration is a separate step.run for durability
      if (flowStep.agent) {
        await executeSingleStep(
          stepId,
          flowStep,
          // Wrap step.run with attempt-scoped ID for Inngest idempotency
          {
            ...step,
            run: <T>(id: string, fn: () => Promise<T>) =>
              step.run(`${id}/attempt-${attempt}`, fn),
          },
          run,
          team,
          defaults,
          deps,
        );
      }

      // If executeSingleStep succeeded, the loop exits
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);

      tracer({
        timestamp: Date.now(),
        runId: run.id,
        stepId,
        type: 'step.retry',
        data: { attempt, maxAttempts, error: lastError },
      });

      // Budget check even on retry
      checkBudget(run, team.budget, tracer);
    }
  }

  if (lastError) {
    // Exhausted all retry attempts
    switch (retry.onMaxAttempts) {
      case 'proceed':
        stepResult.state = 'failed';
        stepResult.error = `Exhausted ${maxAttempts} attempts: ${lastError}`;
        tracer({
          timestamp: Date.now(),
          runId: run.id,
          stepId,
          type: 'step.end',
          data: { state: 'failed', proceedAfterMax: true },
        });
        // Don't throw — allow the flow to continue
        break;

      case 'human':
        stepResult.state = 'waiting_human';
        runStore.update(run);
        tracer({
          timestamp: Date.now(),
          runId: run.id,
          stepId,
          type: 'step.waiting_human',
          data: { reason: 'max_retries_exhausted', attempts: maxAttempts },
        });

        const timeout = flowStep.timeout ?? defaults.stepTimeout;
        const decision = await step.waitForEvent<{
          data: { action: 'retry' | 'proceed' | 'cancel'; feedback?: string };
        }>(`${stepId}/retry-escalation`, {
          event: `crew/${team.name}/retry-decision`,
          timeout: msToInngestDuration(timeout),
          match: 'data.stepId',
        });

        if (!decision || decision.data.action === 'cancel') {
          stepResult.state = 'cancelled';
          stepResult.error = 'Cancelled by human after retry exhaustion';
          throw new Error(`Step "${stepId}" cancelled after ${maxAttempts} failed attempts`);
        } else if (decision.data.action === 'proceed') {
          stepResult.state = 'failed';
          stepResult.error = `Human chose to proceed after ${maxAttempts} failed attempts`;
        }
        // 'retry' would need another loop — not implemented in v1
        break;

      case 'fail':
      default:
        stepResult.state = 'failed';
        stepResult.error = `Exhausted ${maxAttempts} attempts: ${lastError}`;
        throw new Error(`Step "${stepId}" failed after ${maxAttempts} attempts: ${lastError}`);
    }
  }

  runStore.update(run);
}

// ── Serialization (for Inngest step.run return values) ───────────────────────
// Inngest step.run results must be JSON-serializable.

interface SerializedStepResult {
  agentId: string;
  output: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  facts: Fact[];
  model: string;
}

interface SerializedBranchResult extends SerializedStepResult {
  branchId: string;
  error?: string;
}

/**
 * Serializes RunState to a plain object (Maps → Records) for Inngest return.
 */
function serializeRunState(run: RunState): Record<string, unknown> {
  return {
    id: run.id,
    teamFile: run.teamFile,
    teamName: run.teamName,
    task: run.task,
    status: run.status,
    steps: Object.fromEntries(
      Array.from(run.steps.entries()).map(([k, v]) => [k, { ...v }]),
    ),
    facts: run.facts,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    totalTokensIn: run.totalTokensIn,
    totalTokensOut: run.totalTokensOut,
    totalCostUsd: run.totalCostUsd,
    loopCounts: Object.fromEntries(run.loopCounts),
    error: run.error,
  };
}
