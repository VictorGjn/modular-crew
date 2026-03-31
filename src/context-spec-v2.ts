/**
 * Context Spec v2 — Full context engineering model
 *
 * Extends the v1 ContextSpec (depth + flat sources) with:
 * - Per-source depth, knowledge type, and token budget
 * - Resolution modes (keyword, semantic, graph, semantic+graph)
 * - Knowledge type priority for budget allocation
 * - Extended traversal (follow Notion relations, max hops)
 *
 * Backward compatible: v1 YAML with `depth: detail` still works.
 * v2 YAML uses typed sources for per-source context engineering.
 */

import { z } from 'zod';

// ── Depth Levels (unchanged from v1) ─────────────────────────────────────────

export const DepthLevel = z.enum(['full', 'detail', 'summary', 'headlines', 'mention']);
export type DepthLevel = z.infer<typeof DepthLevel>;

export const DEPTH_TOKEN_RATIOS: Record<DepthLevel, number> = {
  full: 1.0,
  detail: 0.40,    // Corrected: headings + first paragraphs = ~40%, not 75%
  summary: 0.20,   // Corrected: headings + first sentences = ~20%
  headlines: 0.08,  // Heading tree only
  mention: 0.03,    // Path + token count
};

// ── Knowledge Types (from context-engineering skill) ─────────────────────────

export const KnowledgeType = z.enum([
  'ground_truth',  // Source code, schemas, API docs, shipped PRDs
  'framework',     // Architecture docs, guidelines, conventions, OKRs
  'evidence',      // Research, benchmarks, competitive intel, signal aggregations
  'signal',        // Meeting notes, user feedback, email threads
  'hypothesis',    // Plans, proposals, RFCs, draft PRDs
  'artifact',      // READMEs, changelogs, generated outputs, dashboards
]);
export type KnowledgeType = z.infer<typeof KnowledgeType>;

// At equal relevance, higher priority types keep better depth when budget is tight
export const KNOWLEDGE_PRIORITY: Record<KnowledgeType, number> = {
  ground_truth: 6,
  framework: 5,
  evidence: 4,
  signal: 3,
  hypothesis: 2,
  artifact: 1,
};

// ── Resolution Modes ─────────────────────────────────────────────────────────

export const ResolutionMode = z.enum([
  'keyword',         // Stem/path matching. Fast, free. Good for known sources.
  'semantic',        // Hybrid keyword + embedding similarity. Bridges vocabulary gaps.
  'graph',           // Follow imports/deps/relations from entry points. Structural.
  'semantic_graph',  // Semantic entry points → graph traversal. Full discovery.
]);
export type ResolutionMode = z.infer<typeof ResolutionMode>;

// ── Source Declaration (v2: per-source depth + type + budget) ────────────────

export const SourceDecl = z.union([
  z.string(),               // Simple URI: "step://new_signals", "notion://2fb15f7a..."
  z.object({
    uri: z.string(),        // Source URI (see URI scheme below)
    depth: DepthLevel.optional(),           // Override default depth for this source
    knowledgeType: KnowledgeType.optional(), // Classification for budget allocation
    maxTokens: z.number().positive().optional(),  // Hard token cap for this source
  }),
]);
export type SourceDecl = z.infer<typeof SourceDecl>;

/**
 * Source URI schemes:
 *   step://{stepName}          — fact bus output from a previous step
 *   notion://{database_id}     — Notion database (query all or filtered)
 *   notion://{page_id}         — Specific Notion page
 *   file://{path}              — Local file or directory
 *   repo://{owner}/{repo}      — GitHub repo (requires indexing)
 *   cache://{skill}/{file}     — Cached data from a skill
 *   studio://{agent_id}        — Agent from patchbay studio library
 */

// ── Context Spec v2 ──────────────────────────────────────────────────────────

export const ContextSpec = z.object({
  // Default depth for sources without explicit depth
  depth: DepthLevel.default('detail'),

  // Typed sources with per-source config (v2)
  // Falls back to v1 behavior (flat string list) for backward compat
  sources: z.array(SourceDecl).optional(),

  // Total token budget for all context combined
  tokenBudget: z.number().positive().optional(),

  // How to resolve entry points into the source graph
  resolution: ResolutionMode.default('keyword'),

  // Post-generation hedging detection: if agent output contains uncertainty markers
  // ("I think", "probably", "not sure"), extract queries from uncertain sections,
  // fetch additional context, and re-run the agent with enriched context.
  adaptiveRetrieval: z.boolean().default(false),

  // Knowledge type priority filter: when budget is tight, sources of these types
  // get promoted (better depth), others get demoted (lower depth or excluded).
  // Order matters: first type gets highest priority.
  knowledgePriority: z.array(KnowledgeType).optional(),

  // Graph traversal configuration
  traversal: z.object({
    followImports: z.boolean().default(true),     // Code: follow import/require chains
    followTests: z.boolean().default(false),       // Code: include test files for imported modules
    followDocs: z.boolean().default(true),         // Cross-type: include docs that reference sources
    followRelations: z.boolean().default(false),   // Notion: follow relation properties between DBs
    maxHops: z.number().positive().default(2),     // Max traversal depth from entry points
  }).optional(),
});
export type ContextSpec = z.infer<typeof ContextSpec>;
