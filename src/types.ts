/**
 * modular-crew — Core Type Definitions
 *
 * Every component depends on these types. Changes here ripple everywhere.
 * Design principles:
 *   - Zod schemas are the source of truth (runtime validation + TS types)
 *   - YAML format uses the unified flow-first layout (no separate agents section)
 *   - Fact bus is simplified: key/value/source/status (no epistemic typing in v1)
 *   - StepExecutor uses explicit FSM states
 */

import { z } from 'zod';

// ── Depth Levels (from patchbay's 5-level system) ────────────────────────────

export const DepthLevel = z.enum(['full', 'detail', 'summary', 'headlines', 'mention']);
export type DepthLevel = z.infer<typeof DepthLevel>;

// Token ratios per depth (used for cost estimation)
export const DEPTH_TOKEN_RATIOS: Record<DepthLevel, number> = {
  full: 1.0,
  detail: 0.75,
  summary: 0.5,
  headlines: 0.25,
  mention: 0.1,
};

// ── Context Spec ─────────────────────────────────────────────────────────────

export const ContextSpec = z.object({
  depth: DepthLevel.default('detail'),
  sources: z.array(z.string()).optional(),         // studio://, repo://, step.output refs
  tokenBudget: z.number().positive().optional(),
  adaptiveRetrieval: z.boolean().default(false),
  traversal: z.object({
    followImports: z.boolean().default(true),
    followTests: z.boolean().default(false),
    followDocs: z.boolean().default(true),
  }).optional(),
});
export type ContextSpec = z.infer<typeof ContextSpec>;

// ── Agent Definition (inline or ref) ─────────────────────────────────────────

export const InlineAgent = z.object({
  model: z.string().optional(),                    // overrides defaults
  system: z.string(),                              // system prompt
  tools: z.array(z.string()).optional(),           // MCP tool names
  maxTurns: z.number().positive().optional(),
  maxOutputTokens: z.number().positive().optional(),
  tokenBudget: z.number().positive().optional(),
});
export type InlineAgent = z.infer<typeof InlineAgent>;

export const AgentRef = z.union([
  z.string(),                                      // shorthand: "studio://agents/architect-v2"
  InlineAgent,                                     // full inline definition
]);
export type AgentRef = z.infer<typeof AgentRef>;

// ── Conditions (structured, no eval) ─────────────────────────────────────────

export const StructuredCondition = z.object({
  fact: z.string(),
  equals: z.string().optional(),
  not: z.string().optional(),
  gt: z.number().optional(),
  lt: z.number().optional(),
  contains: z.string().optional(),
});

export const Condition = z.union([
  z.string(),                                      // expr-eval expression (sandboxed)
  StructuredCondition,                             // structured condition
]);
export type Condition = z.infer<typeof Condition>;

// ── Flow Steps ───────────────────────────────────────────────────────────────

export const ParallelBranch = z.object({
  agent: AgentRef,
  requires: z.array(z.string()).optional(),
  context: ContextSpec.optional(),
  publishes: z.array(z.string()).optional(),
  role: z.string().optional(),                     // role override for this step
});
export type ParallelBranch = z.infer<typeof ParallelBranch>;

export const FlowStep = z.object({
  // Single agent step
  agent: AgentRef.optional(),
  role: z.string().optional(),

  // Parallel step (mutually exclusive with agent)
  parallel: z.record(z.string(), ParallelBranch).optional(),

  // Dependencies
  after: z.union([z.string(), z.array(z.string())]).optional(),
  requires: z.array(z.string()).optional(),
  publishes: z.array(z.string()).optional(),

  // Context routing
  context: ContextSpec.optional(),

  // Conditions and loops
  when: Condition.optional(),
  retry: z.object({
    step: z.string(),                              // which step to loop back to
    maxAttempts: z.number().positive().default(2),
    onMaxAttempts: z.enum(['fail', 'proceed', 'human']).default('fail'),
  }).optional(),

  // Human-in-the-loop
  approval: z.boolean().default(false),

  // Timeouts
  timeout: z.number().positive().optional(),       // ms, per step
});
export type FlowStep = z.infer<typeof FlowStep>;

// ── Budget ───────────────────────────────────────────────────────────────────

export const Budget = z.object({
  maxCost: z.number().positive().optional(),       // USD
  maxTokens: z.number().positive().optional(),     // total across all agents
});
export type Budget = z.infer<typeof Budget>;

// ── Team Definition (the root YAML schema) ───────────────────────────────────

export const TeamDefinition = z.object({
  $schema: z.string().optional(),
  version: z.literal(1).default(1),
  name: z.string(),
  description: z.string().optional(),

  // Studio connection (optional — not required for inline agents)
  studio: z.object({
    url: z.string().url(),
    apiVersion: z.string().default('v1'),
  }).optional(),

  // Defaults
  defaults: z.object({
    provider: z.string().default('anthropic'),
    model: z.string().default('claude-sonnet-4-20250514'),
    maxTurns: z.number().positive().default(15),
    tokenBudget: z.number().positive().default(50000),
    maxOutputTokens: z.number().positive().default(4000),
    stepTimeout: z.number().positive().default(300000),  // 5 min
  }).optional(),

  // Budget controls
  budget: Budget.optional(),

  // The flow (unified: agents + topology in one place)
  flow: z.record(z.string(), FlowStep),
});
export type TeamDefinition = z.infer<typeof TeamDefinition>;

// ── Facts (simplified for v1) ────────────────────────────────────────────────

export const FactStatus = z.enum(['provisional', 'final']);
export type FactStatus = z.infer<typeof FactStatus>;

export interface Fact {
  key: string;
  value: string;
  source: string;                // agentId that published
  timestamp: number;
  status: FactStatus;
  supersedes?: string;           // fact ID being replaced
  tags?: string[];
  tokenCount?: number;           // tracked for budget
}

// ── Step Execution States (FSM) ──────────────────────────────────────────────

export const StepState = z.enum([
  'pending',       // not yet evaluated
  'ready',         // dependencies met, waiting to run
  'running',       // agent executing
  'succeeded',     // completed successfully
  'failed',        // error (may retry)
  'retrying',      // retry in progress
  'cancelled',     // externally cancelled
  'timed_out',     // exceeded timeout
  'skipped',       // condition evaluated false
  'waiting_human', // paused for human approval
]);
export type StepState = z.infer<typeof StepState>;

export interface StepResult {
  stepId: string;
  agentId?: string;
  state: StepState;
  attempt: number;
  output?: string;
  facts: Fact[];
  error?: string;
  startedAt?: number;
  completedAt?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
  contextTokens?: number;        // how many tokens the context router packed
}

// ── Run State ────────────────────────────────────────────────────────────────

export const RunStatus = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'budget_exceeded',
]);
export type RunStatus = z.infer<typeof RunStatus>;

export interface RunState {
  id: string;                    // ULID
  teamFile: string;
  teamName: string;
  task: string;
  status: RunStatus;
  steps: Map<string, StepResult>;
  facts: Fact[];
  startedAt: number;
  completedAt?: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  loopCounts: Map<string, number>;
  error?: string;
}

// ── Trace Events ─────────────────────────────────────────────────────────────

export type TraceEventType =
  | 'run.start' | 'run.end'
  | 'step.ready' | 'step.start' | 'step.end' | 'step.error' | 'step.retry' | 'step.skip'
  | 'step.waiting_human' | 'step.human_approved'
  | 'fact.publish' | 'fact.require' | 'fact.conflict'
  | 'condition.eval'
  | 'loop.iteration'
  | 'context.pack'
  | 'budget.warning' | 'budget.exceeded';

export interface TraceEvent {
  timestamp: number;
  runId: string;
  stepId?: string;
  agentId?: string;
  type: TraceEventType;
  data: Record<string, unknown>;
  durationMs?: number;
}

// ── Studio Provider (interface for decoupling from patchbay) ─────────────────

export interface ResolvedAgent {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  tools?: string[];
  maxTurns: number;
  maxOutputTokens?: number;
}

export interface AgentRunEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'text' | 'fact' | 'done' | 'error';
  data: unknown;
  tokensIn?: number;
  tokensOut?: number;
}

export interface StudioProvider {
  resolveAgent(ref: string): Promise<ResolvedAgent>;
  executeAgent(
    agent: ResolvedAgent,
    input: string,
    signal?: AbortSignal,
  ): AsyncIterable<AgentRunEvent>;
  packContext(
    sources: string[],
    depth: DepthLevel,
    tokenBudget: number,
    traversal?: ContextSpec['traversal'],
  ): Promise<string>;
  isAvailable(): Promise<boolean>;
}

// ── Model Pricing (for cost estimation) ──────────────────────────────────────

export interface ModelPricing {
  inputPerMillion: number;     // USD per 1M input tokens
  outputPerMillion: number;    // USD per 1M output tokens
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-20250514': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-haiku-4-20250514': { inputPerMillion: 0.80, outputPerMillion: 4 },
  'claude-opus-4-20250514': { inputPerMillion: 15, outputPerMillion: 75 },
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'gpt-4.1': { inputPerMillion: 2, outputPerMillion: 8 },
  'gpt-4.1-mini': { inputPerMillion: 0.4, outputPerMillion: 1.6 },
};

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (tokensIn / 1_000_000) * pricing.inputPerMillion
       + (tokensOut / 1_000_000) * pricing.outputPerMillion;
}
