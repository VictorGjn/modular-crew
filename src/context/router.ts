/**
 * @modular/context-engine — Context Router
 *
 * The core differentiator: builds depth-packed context for each agent step
 * by orchestrating source resolution, provider packing, fact serialization,
 * and prompt assembly.
 *
 * Source URI schemes:
 *   studio://knowledge/<id>   → knowledge base sources (packed by provider)
 *   repo://<url>              → git repository context (packed by provider)
 *   step.<stepId>             → output facts from a previous step
 *   step.output:<stepId>      → alias for step.<stepId>
 *
 * Fallback: if provider.packContext fails (patchbay unavailable),
 * raw fact values are used as context with a console warning.
 */

import { encode } from 'gpt-tokenizer';
import type {
  ContextSpec,
  DepthLevel,
  Fact,
  StudioProvider,
} from '../types.js';

// ── Result Type ───────────────────────────────────────────────────────────────

export interface ContextResult {
  /** Full assembled prompt (task + context + facts + deliverables) */
  prompt: string;
  /** Total token count of the assembled prompt */
  tokenCount: number;
  /** Tokens consumed by the packed context section */
  contextTokens: number;
  /** Tokens consumed by the serialized facts section */
  factTokens: number;
  /** Source URIs that were resolved */
  sources: string[];
  /** Depth level used for packing */
  depth: DepthLevel;
}

// ── Source Classification ─────────────────────────────────────────────────────

interface ClassifiedSources {
  /** studio:// and repo:// URIs → sent to provider.packContext */
  packable: string[];
  /** step.output:<stepId> or step.<stepId> → resolved from fact bus */
  stepRefs: string[];
  /** Unrecognized URIs (logged, not fatal) */
  unknown: string[];
}

function classifySources(sources: string[]): ClassifiedSources {
  const packable: string[] = [];
  const stepRefs: string[] = [];
  const unknown: string[] = [];

  for (const src of sources) {
    if (src.startsWith('studio://') || src.startsWith('repo://')) {
      packable.push(src);
    } else if (src.startsWith('step.') || src.startsWith('step:')) {
      stepRefs.push(src);
    } else {
      unknown.push(src);
    }
  }

  if (unknown.length > 0) {
    console.warn(
      `[context-router] Unrecognized source URIs (ignored): ${unknown.join(', ')}`,
    );
  }

  return { packable, stepRefs, unknown };
}

/**
 * Extract a step ID from a step reference URI.
 *
 * Supported formats:
 *   step.output:<stepId>   → stepId
 *   step.<stepId>.output   → stepId
 *   step.<stepId>          → stepId
 */
function parseStepRef(ref: string): string {
  if (ref.startsWith('step.output:')) {
    return ref.slice('step.output:'.length);
  }
  const stripped = ref.replace(/^step\./, '').replace(/\.output$/, '');
  return stripped;
}

// ── Fact Serialization ────────────────────────────────────────────────────────

/**
 * Serialize facts into structured markdown, grouped by source agent/step.
 * Final facts are rendered first; provisional facts are marked.
 * Superseded facts are excluded.
 */
function serializeFacts(facts: Fact[]): string {
  if (facts.length === 0) return '_No facts published yet._';

  // Deduplicate: if a fact supersedes another, drop the superseded one
  const superseded = new Set(
    facts.filter(f => f.supersedes).map(f => f.supersedes!),
  );
  const active = facts.filter(f => !superseded.has(f.key));

  // Group by source step/agent
  const grouped = new Map<string, Fact[]>();
  for (const f of active) {
    const group = grouped.get(f.source) ?? [];
    group.push(f);
    grouped.set(f.source, group);
  }

  const sections: string[] = [];
  for (const [source, group] of grouped) {
    // Sort: final facts first, then by timestamp ascending
    const sorted = group.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'final' ? -1 : 1;
      return a.timestamp - b.timestamp;
    });

    const lines = sorted.map(f => {
      const badge = f.status === 'provisional' ? ' _(provisional)_' : '';
      const tags = f.tags?.length ? ` [${f.tags.join(', ')}]` : '';
      return `- **${f.key}**: ${f.value}${badge}${tags}`;
    });

    sections.push(`### From: ${source}\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}

// ── Step Output Resolution ────────────────────────────────────────────────────

/**
 * Resolve step.output references by pulling matching facts from the bus.
 * Returns a markdown section per referenced step.
 */
function resolveStepOutputs(stepRefs: string[], facts: Fact[]): string {
  if (stepRefs.length === 0) return '';

  const sections: string[] = [];

  for (const ref of stepRefs) {
    const stepId = parseStepRef(ref);
    const stepFacts = facts.filter(f => f.source === stepId);

    if (stepFacts.length > 0) {
      const lines = stepFacts.map(f => {
        const badge = f.status === 'provisional' ? ' _(provisional)_' : '';
        return `- **${f.key}**: ${f.value}${badge}`;
      });
      sections.push(`### Output from step: ${stepId}\n${lines.join('\n')}`);
    } else {
      sections.push(
        `### Output from step: ${stepId}\n_No output available (step may not have run yet)._`,
      );
    }
  }

  return sections.join('\n\n');
}

// ── Context Router ────────────────────────────────────────────────────────────

export class ContextRouter {
  private provider: StudioProvider;

  constructor(provider: StudioProvider) {
    this.provider = provider;
  }

  /**
   * Build depth-packed context for a step execution.
   *
   * Pipeline:
   *  1. Classify sources → packable (studio/repo) vs step refs
   *  2. Call provider.packContext for external sources
   *  3. Resolve step.output refs from the fact bus
   *  4. Serialize all relevant facts
   *  5. Assemble full prompt (task + context + facts + deliverables)
   *  6. Count tokens with gpt-tokenizer
   *
   * @param stepId    - Current step identifier (for logging/tracing)
   * @param spec      - Context specification from the flow step
   * @param facts     - All facts currently on the bus
   * @param task      - The top-level task description
   * @param publishes - Fact keys this step is expected to publish
   */
  async buildContext(
    stepId: string,
    spec: ContextSpec,
    facts: Fact[],
    task: string,
    publishes: string[] = [],
  ): Promise<ContextResult> {
    const depth: DepthLevel = spec.depth ?? 'detail';
    const sources = spec.sources ?? [];
    const tokenBudget = spec.tokenBudget ?? 50_000;

    const classified = classifySources(sources);

    // ── 1. Pack external context via provider ──────────────────────────────
    let packedContext = '';
    let usedFallback = false;

    if (classified.packable.length > 0) {
      try {
        packedContext = await this.provider.packContext(
          classified.packable,
          depth,
          tokenBudget,
          spec.traversal,
        );
      } catch (err) {
        console.warn(
          `[context-router] packContext failed for step "${stepId}", ` +
          `falling back to fact-only context: ${err instanceof Error ? err.message : String(err)}`,
        );
        usedFallback = true;
      }
    }

    // ── 2. Resolve step.output references from fact bus ────────────────────
    const stepOutputContext = resolveStepOutputs(classified.stepRefs, facts);
    if (stepOutputContext) {
      packedContext = packedContext
        ? `${packedContext}\n\n${stepOutputContext}`
        : stepOutputContext;
    }

    // ── 3. Fallback: if packContext failed and no step outputs, use raw facts
    if (usedFallback && !packedContext) {
      packedContext = this.buildFallbackContext(facts);
    }

    // ── 4. Token accounting ────────────────────────────────────────────────
    const contextTokens = this.estimateTokens(packedContext);
    const factText = serializeFacts(facts);
    const factTokens = this.estimateTokens(factText);

    // ── 5. Assemble prompt ─────────────────────────────────────────────────
    const prompt = this.buildPrompt(task, packedContext, facts, publishes);
    const tokenCount = this.estimateTokens(prompt);

    return {
      prompt,
      tokenCount,
      contextTokens,
      factTokens,
      sources: [...classified.packable, ...classified.stepRefs],
      depth,
    };
  }

  /**
   * Assemble the full user message sent to the agent.
   *
   * Layout:
   *   ## Task          — what the agent needs to do
   *   ## Context       — depth-packed knowledge from sources
   *   ## Facts         — structured outputs from previous steps
   *   ## Deliverables  — fact keys this step MUST publish
   */
  buildPrompt(
    task: string,
    packedContext: string,
    facts: Fact[],
    publishes: string[] = [],
  ): string {
    const sections: string[] = [];

    // ── Task
    sections.push(`## Task\n${task}`);

    // ── Context (only if non-empty)
    if (packedContext) {
      sections.push(`## Context\n${packedContext}`);
    }

    // ── Facts from previous steps
    const factText = serializeFacts(facts);
    sections.push(`## Facts from Previous Steps\n${factText}`);

    // ── Deliverables (only if step publishes facts)
    if (publishes.length > 0) {
      const items = publishes.map(p => `- \`${p}\``).join('\n');
      sections.push(
        `## Your Deliverables\nYou MUST publish the following facts when done:\n${items}`,
      );
    }

    return sections.join('\n\n');
  }

  /**
   * Estimate token count using gpt-tokenizer (cl100k_base encoding).
   * Returns 0 for empty/null input.
   */
  estimateTokens(text: string): number {
    if (!text) return 0;
    return encode(text).length;
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Build fallback context when provider.packContext is unavailable.
   * Extracts all final fact values as a flat context block.
   */
  private buildFallbackContext(facts: Fact[]): string {
    const finalFacts = facts.filter(f => f.status === 'final');
    if (finalFacts.length === 0) return '';

    const lines = finalFacts.map(
      f => `**${f.key}** (from ${f.source}): ${f.value}`,
    );
    return `> _Context assembled from fact bus (provider unavailable)_\n\n${lines.join('\n\n')}`;
  }
}
