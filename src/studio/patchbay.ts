/**
 * PatchbayProvider — HTTP client for modular-patchbay's API.
 *
 * Implements StudioProvider to decouple the orchestrator from the concrete
 * Studio backend. Uses native fetch (Node 18+) and eventsource-parser for
 * SSE streaming from /api/run-agent.
 */

import { createParser, type EventSourceMessage } from 'eventsource-parser';
import type {
  StudioProvider,
  ResolvedAgent,
  AgentRunEvent,
  DepthLevel,
  ContextSpec,
} from '../types.js';

// ── Configuration ────────────────────────────────────────────────────────────

export interface PatchbayProviderOptions {
  /** Timeout for non-streaming requests (ms). Default: 30 000 */
  timeout?: number;
  /** Timeout for SSE stream inactivity (ms). Default: 120 000 */
  streamTimeout?: number;
  /** Max retries on transient errors (5xx, network). Default: 2 */
  retries?: number;
}

const DEFAULTS: Required<PatchbayProviderOptions> = {
  timeout: 30_000,
  streamTimeout: 120_000,
  retries: 2,
};

// Status codes that warrant a retry
const RETRYABLE_STATUS = new Set([502, 503, 504, 429]);

// ── Errors ───────────────────────────────────────────────────────────────────

export class PatchbayError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'PatchbayError';
  }
}

export class PatchbayStreamError extends PatchbayError {
  constructor(message: string) {
    super(message);
    this.name = 'PatchbayStreamError';
  }
}

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

// ── Provider ─────────────────────────────────────────────────────────────────

export class PatchbayProvider implements StudioProvider {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly streamTimeout: number;
  private readonly retries: number;

  constructor(baseUrl: string, options: PatchbayProviderOptions = {}) {
    // Normalise: strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeout = options.timeout ?? DEFAULTS.timeout;
    this.streamTimeout = options.streamTimeout ?? DEFAULTS.streamTimeout;
    this.retries = options.retries ?? DEFAULTS.retries;
  }

  // ── StudioProvider interface ─────────────────────────────────────────────

  /**
   * Resolve a studio agent ref (e.g. "studio://agents/architect-v2") to a
   * fully-hydrated ResolvedAgent by calling GET /api/agents/:id.
   */
  async resolveAgent(ref: string): Promise<ResolvedAgent> {
    const id = refToId(ref);
    const data = await this.fetchJson<PatchbayAgentResponse>(`/api/agents/${encodeURIComponent(id)}`);

    return {
      id: data.id ?? id,
      name: data.name ?? id,
      systemPrompt: data.systemPrompt ?? data.system ?? '',
      model: data.model ?? '',
      tools: data.tools,
      maxTurns: data.maxTurns ?? 15,
      maxOutputTokens: data.maxOutputTokens,
    };
  }

  /**
   * Execute an agent via POST /api/run-agent with SSE streaming.
   * Yields AgentRunEvent as they arrive. Respects AbortSignal for
   * cancellation and enforces a stream-inactivity timeout.
   */
  async *executeAgent(
    agent: ResolvedAgent,
    input: string,
    signal?: AbortSignal,
  ): AsyncIterable<AgentRunEvent> {
    const body = JSON.stringify({
      agentId: agent.id,
      task: input,
      systemPrompt: agent.systemPrompt,
      providerId: undefined,   // let server pick default
      model: agent.model,
    });

    // Use a combined AbortController so we can abort on stream timeout
    const controller = new AbortController();
    const combinedSignal = controller.signal;

    // Forward the external signal
    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      }
    }

    const response = await this.fetchRaw('/api/run-agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body,
      signal: combinedSignal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new PatchbayError(
        `run-agent returned ${response.status}: ${response.statusText}`,
        response.status,
        text,
      );
    }

    if (!response.body) {
      throw new PatchbayStreamError('Response body is null — SSE stream unavailable');
    }

    yield* this.parseSSEStream(response.body, combinedSignal, controller);
  }

  /**
   * Build depth-packed context by calling the graph traverse + pack endpoints.
   *
   * 1. POST /api/graph/traverse — resolve sources → graph nodes
   * 2. POST /api/graph/pack    — depth-pack within token budget
   */
  async packContext(
    sources: string[],
    depth: DepthLevel,
    tokenBudget: number,
    traversal?: ContextSpec['traversal'],
  ): Promise<string> {
    // Step 1: Traverse
    const traverseResult = await this.fetchJson<TraverseResponse>('/api/graph/traverse', {
      method: 'POST',
      body: JSON.stringify({
        entryPoints: sources,
        ...(traversal && {
          followImports: traversal.followImports,
          followTests: traversal.followTests,
          followDocs: traversal.followDocs,
        }),
      }),
    });

    // Step 2: Pack
    const packResult = await this.fetchJson<PackResponse>('/api/graph/pack', {
      method: 'POST',
      body: JSON.stringify({
        files: traverseResult.files ?? traverseResult.nodes ?? [],
        tokenBudget,
        depth,
      }),
    });

    return packResult.packed ?? packResult.context ?? '';
  }

  /**
   * Health check — GET /api/health. Returns true if the server responds 2xx.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.fetchRaw('/api/health', {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Fetch with retries. Retries on network errors and retryable HTTP status
   * codes (502, 503, 504, 429). Uses exponential backoff with jitter.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const response = await fetch(url, init);

        // Don't retry client errors (4xx) except 429
        if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
          return response;
        }

        if (RETRYABLE_STATUS.has(response.status) && attempt < this.retries) {
          lastError = new PatchbayError(
            `HTTP ${response.status}`,
            response.status,
            await response.text().catch(() => ''),
          );
          await this.backoff(attempt, (init.signal as AbortSignal | undefined));
          continue;
        }

        return response;
      } catch (err: unknown) {
        // Don't retry AbortError
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        if (err instanceof Error && err.name === 'AbortError') throw err;

        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < this.retries) {
          await this.backoff(attempt, (init.signal as AbortSignal | undefined));
          continue;
        }
      }
    }

    throw new PatchbayError(
      `Request failed after ${this.retries + 1} attempts: ${lastError?.message}`,
    );
  }

  /** Exponential backoff with jitter: base * 2^attempt + random jitter */
  private backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    const base = 500;
    const ms = base * 2 ** attempt + Math.random() * base;
    return delay(ms, signal);
  }

  /** Raw fetch with retry and default timeout. */
  private async fetchRaw(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> ?? {}),
    };

    // Add timeout via AbortSignal.timeout if no signal provided
    const signal = init.signal ?? AbortSignal.timeout(this.timeout);

    return this.fetchWithRetry(url, { ...init, headers, signal });
  }

  /** Fetch JSON with retry, timeout, error handling. */
  private async fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(init.headers as Record<string, string> ?? {}),
    };

    const response = await this.fetchRaw(path, { ...init, headers });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new PatchbayError(
        `${init.method ?? 'GET'} ${path} → ${response.status}: ${response.statusText}`,
        response.status,
        body,
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Parse an SSE ReadableStream into AgentRunEvents using eventsource-parser.
   *
   * Enforces a stream-inactivity timeout: if no SSE event arrives within
   * `streamTimeout` ms, the stream is aborted.
   */
  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    controller: AbortController,
  ): AsyncGenerator<AgentRunEvent> {
    // Buffer for events parsed by the callback-based parser
    const eventQueue: AgentRunEvent[] = [];
    let streamDone = false;
    let streamError: Error | undefined;

    // Resolve when a new event is enqueued or stream ends
    let notifyReady: (() => void) | undefined;
    function waitForEvent(): Promise<void> {
      return new Promise((resolve) => { notifyReady = resolve; });
    }

    // Inactivity timeout management
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const resetInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        streamError = new PatchbayStreamError(
          `SSE stream timed out after ${this.streamTimeout}ms of inactivity`,
        );
        controller.abort(streamError);
        notifyReady?.();
      }, this.streamTimeout);
    };

    // Create the SSE parser
    const parser = createParser({
      onEvent: (event: EventSourceMessage) => {
        resetInactivityTimer();

        try {
          const parsed = JSON.parse(event.data) as AgentRunEvent;
          eventQueue.push(parsed);
        } catch {
          // If the data isn't JSON, wrap it as a text event
          eventQueue.push({
            type: 'text',
            data: event.data,
          });
        }

        notifyReady?.();
      },
    });

    // Start reading the stream in the background
    const reader = body.getReader();
    const decoder = new TextDecoder();

    const readLoop = async () => {
      try {
        resetInactivityTimer();

        while (true) {
          if (signal.aborted) break;

          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          parser.feed(chunk);
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // Expected on cancellation — don't overwrite a timeout error
        } else {
          streamError = err instanceof Error ? err : new Error(String(err));
        }
      } finally {
        streamDone = true;
        if (inactivityTimer) clearTimeout(inactivityTimer);
        notifyReady?.();
      }
    };

    // Fire and forget — the read loop feeds eventQueue
    const readPromise = readLoop();

    // Yield events as they arrive
    try {
      while (true) {
        // Drain any buffered events
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!;
          yield event;

          // Stop on terminal events
          if (event.type === 'done' || event.type === 'error') {
            return;
          }
        }

        // If stream is done and no more events, exit
        if (streamDone && eventQueue.length === 0) {
          if (streamError) throw streamError;
          return;
        }

        // Wait for more events
        await waitForEvent();

        // Check for errors that occurred while waiting
        if (streamError) throw streamError;
      }
    } finally {
      // Ensure the reader is released
      if (inactivityTimer) clearTimeout(inactivityTimer);
      reader.cancel().catch(() => {});
      await readPromise.catch(() => {});
    }
  }
}

// ── Internal API response shapes ─────────────────────────────────────────────
// Loosely typed to tolerate patchbay API evolution.

interface PatchbayAgentResponse {
  id?: string;
  name?: string;
  systemPrompt?: string;
  system?: string;            // alternate field name
  model?: string;
  tools?: string[];
  maxTurns?: number;
  maxOutputTokens?: number;
  [key: string]: unknown;
}

interface TraverseResponse {
  files?: unknown[];
  nodes?: unknown[];
  [key: string]: unknown;
}

interface PackResponse {
  packed?: string;
  context?: string;
  [key: string]: unknown;
}
