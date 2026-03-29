/**
 * MockProvider — In-memory StudioProvider for --mock mode.
 *
 * Returns canned responses with simulated latency. Used for:
 *   - Offline development / testing without a running patchbay instance
 *   - CI/CD pipelines
 *   - Demos and dry-runs
 *
 * Every method is deterministic (given the same inputs) except for
 * timestamps and the simulated delay in executeAgent.
 */

import type {
  StudioProvider,
  ResolvedAgent,
  AgentRunEvent,
  DepthLevel,
  ContextSpec,
} from '../types.js';

// ── Configuration ────────────────────────────────────────────────────────────

export interface MockProviderOptions {
  /** Simulated delay between streamed text chunks (ms). Default: 50 */
  chunkDelay?: number;
  /** Simulated word count for mock agent output. Default: 80 */
  wordCount?: number;
  /** Default model to assign to mock-resolved agents. Default: 'mock-model' */
  defaultModel?: string;
  /** Whether to include mock facts in the done event. Default: true */
  emitFacts?: boolean;
}

const DEFAULTS: Required<MockProviderOptions> = {
  chunkDelay: 50,
  wordCount: 80,
  defaultModel: 'mock-model',
  emitFacts: true,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip the studio protocol prefix from an agent ref. */
function refToId(ref: string): string {
  return ref.replace(/^studio:\/\/agents\//, '');
}

/** Delay that respects AbortSignal. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

// ── Canned output generator ──────────────────────────────────────────────────

function generateMockOutput(agentName: string, input: string, wordCount: number): string {
  const summary = input.length > 120 ? input.slice(0, 120) + '…' : input;
  const lines = [
    `## ${agentName} — Mock Output`,
    '',
    `**Task**: ${summary}`,
    '',
    `This is a simulated response from the mock provider. ` +
    `In production, agent \`${agentName}\` would process the task through modular-patchbay ` +
    `with full context routing and depth-packed knowledge.`,
    '',
    '### Analysis',
    '',
    `The agent analyzed the task and produced the following observations:`,
    '',
    `1. The input was received and parsed successfully.`,
    `2. Context sources would be resolved via the graph engine.`,
    `3. The depth-packed context would be assembled per the context spec.`,
    `4. The agent would iterate through its reasoning loop.`,
    '',
    '### Recommendations',
    '',
    `- Proceed with the proposed approach.`,
    `- Review the generated artifacts for completeness.`,
    `- Validate against the original requirements.`,
    '',
    `*[Mock output — ${wordCount} words target | agent: ${agentName}]*`,
  ];

  return lines.join('\n');
}

/** Split text into chunks roughly sized like SSE fragments. */
function chunkText(text: string, maxChunkWords: number = 8): string[] {
  const words = text.split(/(\s+)/);
  const chunks: string[] = [];
  let current = '';
  let wordCount = 0;

  for (const token of words) {
    current += token;
    if (/\S/.test(token)) wordCount++;

    if (wordCount >= maxChunkWords) {
      chunks.push(current);
      current = '';
      wordCount = 0;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class MockProvider implements StudioProvider {
  private readonly chunkDelay: number;
  private readonly wordCount: number;
  private readonly defaultModel: string;
  private readonly emitFacts: boolean;

  /** Track all calls for test assertions. */
  public readonly calls: {
    resolveAgent: Array<{ ref: string }>;
    executeAgent: Array<{ agent: ResolvedAgent; input: string }>;
    packContext: Array<{ sources: string[]; depth: DepthLevel; tokenBudget: number }>;
  } = {
    resolveAgent: [],
    executeAgent: [],
    packContext: [],
  };

  constructor(options: MockProviderOptions = {}) {
    this.chunkDelay = options.chunkDelay ?? DEFAULTS.chunkDelay;
    this.wordCount = options.wordCount ?? DEFAULTS.wordCount;
    this.defaultModel = options.defaultModel ?? DEFAULTS.defaultModel;
    this.emitFacts = options.emitFacts ?? DEFAULTS.emitFacts;
  }

  // ── StudioProvider interface ─────────────────────────────────────────────

  /**
   * Resolve a ref to a mock agent. The ref string becomes the agent name.
   * No network call — always succeeds immediately.
   */
  async resolveAgent(ref: string): Promise<ResolvedAgent> {
    this.calls.resolveAgent.push({ ref });

    const id = refToId(ref);

    return {
      id,
      name: id,
      systemPrompt: `You are ${id}, a mock agent. Respond helpfully to the task.`,
      model: this.defaultModel,
      tools: [],
      maxTurns: 15,
    };
  }

  /**
   * Simulate agent execution by streaming canned text output with
   * realistic event shapes and simulated latency.
   *
   * Event sequence: thinking → text (chunked) → fact? → done
   */
  async *executeAgent(
    agent: ResolvedAgent,
    input: string,
    signal?: AbortSignal,
  ): AsyncIterable<AgentRunEvent> {
    this.calls.executeAgent.push({ agent, input });

    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    // 1. Thinking event
    yield {
      type: 'thinking',
      data: `[${agent.name}] Analyzing task…`,
    };

    await delay(this.chunkDelay * 2, signal);

    // 2. Stream text in chunks
    const fullOutput = generateMockOutput(agent.name, input, this.wordCount);
    const chunks = chunkText(fullOutput);
    let totalChars = 0;

    for (const chunk of chunks) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }

      totalChars += chunk.length;

      yield {
        type: 'text',
        data: chunk,
      };

      await delay(this.chunkDelay, signal);
    }

    // 3. Optional fact event
    if (this.emitFacts) {
      yield {
        type: 'fact',
        data: {
          key: `${agent.name}_status`,
          value: 'completed',
          source: agent.name,
          timestamp: Date.now(),
          status: 'final',
        },
      };
    }

    // 4. Done event with mock token counts
    const mockTokensIn = Math.ceil(input.length / 4);
    const mockTokensOut = Math.ceil(totalChars / 4);

    yield {
      type: 'done',
      data: {
        output: fullOutput,
        tokensIn: mockTokensIn,
        tokensOut: mockTokensOut,
      },
      tokensIn: mockTokensIn,
      tokensOut: mockTokensOut,
    };
  }

  /**
   * Return a mock context string. No network call.
   * Format includes metadata so downstream steps can trace it was mocked.
   */
  async packContext(
    sources: string[],
    depth: DepthLevel,
    tokenBudget: number,
    traversal?: ContextSpec['traversal'],
  ): Promise<string> {
    this.calls.packContext.push({ sources, depth, tokenBudget });

    const sourceList = sources.length > 0 ? sources.join(', ') : '(none)';
    const traversalInfo = traversal
      ? ` | traversal: imports=${traversal.followImports ?? true}, tests=${traversal.followTests ?? false}, docs=${traversal.followDocs ?? true}`
      : '';

    return [
      `[Mock context at ${depth} depth for sources: ${sourceList}]`,
      `[Token budget: ${tokenBudget}${traversalInfo}]`,
      '',
      `# Context (mock)`,
      '',
      `The following context would be assembled by the patchbay graph engine`,
      `from ${sources.length} source(s) at **${depth}** depth within a budget`,
      `of ${tokenBudget.toLocaleString()} tokens.`,
      '',
      ...sources.map((s, i) => `${i + 1}. \`${s}\` — resolved at ${depth} depth`),
    ].join('\n');
  }

  /**
   * Always available — no server to check.
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  // ── Test utilities ───────────────────────────────────────────────────────

  /** Reset recorded calls (useful between tests). */
  resetCalls(): void {
    this.calls.resolveAgent.length = 0;
    this.calls.executeAgent.length = 0;
    this.calls.packContext.length = 0;
  }
}
