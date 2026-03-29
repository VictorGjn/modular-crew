/**
 * FactBus — Append-only shared fact store for agent teams.
 *
 * Design:
 *   - Facts keyed by composite (key, source):
 *       require('implementation_status')           → all sources
 *       require('implementation_status', 'backend') → filtered
 *   - Append-only log per key with monotonic version tracking
 *   - Async require() with check-then-watch pattern
 *   - Reactive per-key subscriptions with teardown
 *   - Deep-copy snapshots via structuredClone
 *   - No transactions needed — immutable append log
 *
 * Thread safety:
 *   JS is single-threaded, but async interleaving exists between awaits.
 *   The check-then-watch in require() is safe because both the store lookup
 *   and the subscription setup execute synchronously — no await gap where
 *   a publish could slip through unobserved.
 */

import type { Fact, FactStatus, TraceEvent } from '../types.js';

// ── Event Map ────────────────────────────────────────────────────────────────

export interface FactBusEventMap {
  'fact.publish':  { fact: Fact; version: number };
  'fact.conflict': { existing: Fact; incoming: Fact; key: string };
  'fact.require':  { key: string; source?: string; resolved: boolean };
  'fact.timeout':  { key: string; source?: string; timeoutMs: number };
}

/** Union of all bus-level event names. */
export type FactBusEvents = keyof FactBusEventMap;

// ── Subscriber type ──────────────────────────────────────────────────────────

/** Callback invoked on every publish to a subscribed key. */
export type FactSubscriber = (fact: Fact) => void;

/** Typed listener for bus-level events. */
type EventListener<K extends FactBusEvents> = (data: FactBusEventMap[K]) => void;

// ── Error Types ──────────────────────────────────────────────────────────────

/** Thrown by requireWithTimeout when the deadline elapses. */
export class FactTimeoutError extends Error {
  public readonly key: string;
  public readonly source: string | undefined;
  public readonly timeoutMs: number;

  constructor(key: string, source: string | undefined, timeoutMs: number) {
    const src = source ? ` from source '${source}'` : '';
    super(`Fact '${key}'${src} not published within ${timeoutMs}ms`);
    this.name = 'FactTimeoutError';
    this.key = key;
    this.source = source;
    this.timeoutMs = timeoutMs;
  }
}

// ── FactBus ──────────────────────────────────────────────────────────────────

export class FactBus {

  /** Append-only store: factKey → Fact[] (ordered by insertion). */
  private readonly store = new Map<string, Fact[]>();

  /** Per-key reactive subscribers. */
  private readonly subs = new Map<string, Set<FactSubscriber>>();

  /** Bus-level event listeners keyed by event name. */
  private readonly eventListeners = new Map<FactBusEvents, Set<Function>>();

  /** Monotonically increasing version — bumped on every individual fact write. */
  private _version = 0;

  // ────────────────────────────────────────────────────────────────────────────
  // publish
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Append one or more facts to the store.
   *
   * Each fact is frozen on write — the log is immutable once written.
   * Subscribers and bus-level listeners fire synchronously per fact.
   */
  publish(facts: Fact | Fact[]): void {
    const batch = Array.isArray(facts) ? facts : [facts];

    for (const raw of batch) {
      this._version++;

      // Freeze a defensive copy — callers cannot mutate the log
      const fact: Fact = Object.freeze({
        ...raw,
        timestamp: raw.timestamp ?? Date.now(),
      });

      let entries = this.store.get(fact.key);
      if (!entries) {
        entries = [];
        this.store.set(fact.key, entries);
      }
      entries.push(fact);

      // Bus-level event
      this.emit('fact.publish', { fact, version: this._version });

      // Conflict detection: same key, different value, different source
      this.detectConflicts(fact, entries);

      // Per-key subscribers — snapshot the Set so unsubscribe inside cb is safe
      const keySubs = this.subs.get(fact.key);
      if (keySubs) {
        for (const cb of [...keySubs]) {
          cb(fact);
        }
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // require  (async check-then-watch)
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Returns all facts for `key`, optionally filtered by `source`.
   *
   * - If matching facts exist → resolves immediately.
   * - If not → subscribes and resolves on the first matching publish.
   *
   * The synchronous check + subscribe guarantees no publish can slip
   * through unobserved (no await gap between the two operations).
   */
  require(key: string, source?: string): Promise<Fact[]> {
    // ① Synchronous check
    const existing = this.lookup(key, source);

    this.emit('fact.require', { key, source, resolved: existing.length > 0 });

    if (existing.length > 0) {
      return Promise.resolve(existing);
    }

    // ② Subscribe — still synchronous, no interleaving gap
    return new Promise<Fact[]>((resolve) => {
      const unsub = this.subscribe(key, () => {
        const facts = this.lookup(key, source);
        if (facts.length > 0) {
          unsub();
          resolve(facts);
        }
      });
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // requireWithTimeout
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Like `require()`, but rejects with `FactTimeoutError` if `timeoutMs`
   * elapses before any matching fact is published.
   *
   * Properly cleans up subscriptions and timers on both the resolve and
   * reject paths — no leaks.
   */
  requireWithTimeout(
    key: string,
    timeoutMs: number,
    source?: string,
  ): Promise<Fact[]> {
    // Fast path — already available
    const existing = this.lookup(key, source);
    if (existing.length > 0) {
      return Promise.resolve(existing);
    }

    return new Promise<Fact[]>((resolve, reject) => {
      let settled = false;

      const unsub = this.subscribe(key, () => {
        if (settled) return;
        const facts = this.lookup(key, source);
        if (facts.length > 0) {
          settled = true;
          clearTimeout(timer);
          unsub();
          resolve(facts);
        }
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsub();
        this.emit('fact.timeout', { key, source, timeoutMs });
        reject(new FactTimeoutError(key, source, timeoutMs));
      }, timeoutMs);
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // requireAll
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Wait for every key in `keys` to have at least one published fact,
   * then return a Map of key → Fact[].
   *
   * Each key resolves independently via require() — parallel wait, not serial.
   */
  async requireAll(keys: string[]): Promise<Map<string, Fact[]>> {
    const entries = await Promise.all(
      keys.map(async (key): Promise<[string, Fact[]]> => [key, await this.require(key)]),
    );
    return new Map(entries);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // getLatest
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Returns the most recently published fact for `key`
   * (optionally from a specific `source`).
   *
   * Non-blocking — returns `undefined` if nothing matches.
   */
  getLatest(key: string, source?: string): Fact | undefined {
    const entries = this.store.get(key);
    if (!entries || entries.length === 0) return undefined;

    if (source === undefined) {
      return entries[entries.length - 1];
    }

    // Walk backwards for the latest matching source
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].source === source) return entries[i];
    }
    return undefined;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // subscribe / unsubscribe
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Register a callback invoked on every publish to `key`.
   * Returns a teardown function that removes the subscription.
   */
  subscribe(key: string, callback: FactSubscriber): () => void {
    let set = this.subs.get(key);
    if (!set) {
      set = new Set();
      this.subs.set(key, set);
    }
    set.add(callback);

    // Teardown
    return () => {
      set!.delete(callback);
      if (set!.size === 0) {
        this.subs.delete(key);
      }
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // snapshot
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Returns a deep copy of the entire fact store.
   * Safe to mutate — changes do not affect the bus.
   */
  snapshot(): Map<string, Fact[]> {
    return structuredClone(this.store);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // conflicts
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Returns pairs of facts where different sources disagree on the value
   * for the same key. Only the latest fact per source is compared.
   *
   * Example: backend publishes `implementation_status = "done"`,
   * frontend publishes `implementation_status = "blocked"` → conflict.
   */
  conflicts(): Array<[Fact, Fact]> {
    const pairs: Array<[Fact, Fact]> = [];

    for (const entries of this.store.values()) {
      // Build latest-per-source for this key
      const latestBySource = new Map<string, Fact>();
      for (const f of entries) {
        latestBySource.set(f.source, f);
      }

      // Pairwise comparison across sources
      const sources = [...latestBySource.values()];
      for (let i = 0; i < sources.length; i++) {
        for (let j = i + 1; j < sources.length; j++) {
          if (sources[i].value !== sources[j].value) {
            pairs.push([sources[i], sources[j]]);
          }
        }
      }
    }

    return pairs;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // size / version
  // ────────────────────────────────────────────────────────────────────────────

  /** Total number of individual facts across all keys. */
  get size(): number {
    let n = 0;
    for (const entries of this.store.values()) {
      n += entries.length;
    }
    return n;
  }

  /** Global version counter — bumped on every individual fact write. */
  get version(): number {
    return this._version;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // clear
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Reset the bus: clears all facts, subscribers, and version counter.
   * Bus-level event listeners are intentionally preserved — call off() to remove.
   */
  clear(): void {
    this.store.clear();
    this.subs.clear();
    this._version = 0;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // on / off  (bus-level events)
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Listen for bus-level events (publish, conflict, require, timeout).
   * Returns a teardown function that removes the listener.
   */
  on<K extends FactBusEvents>(
    event: K,
    listener: EventListener<K>,
  ): () => void {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(listener as Function);

    return () => {
      set!.delete(listener as Function);
      if (set!.size === 0) {
        this.eventListeners.delete(event);
      }
    };
  }

  /** Remove all listeners for a specific event, or all events if omitted. */
  off(event?: FactBusEvents): void {
    if (event) {
      this.eventListeners.delete(event);
    } else {
      this.eventListeners.clear();
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Look up facts by key, optionally filtered by source.
   * Always returns a new array (safe to return to callers).
   */
  private lookup(key: string, source?: string): Fact[] {
    const entries = this.store.get(key);
    if (!entries || entries.length === 0) return [];
    if (source === undefined) return [...entries];
    return entries.filter((f) => f.source === source);
  }

  /**
   * Emit a conflict event for each other source whose latest value
   * for the same key differs from the incoming fact.
   */
  private detectConflicts(incoming: Fact, allForKey: readonly Fact[]): void {
    const latestByOther = new Map<string, Fact>();
    for (const f of allForKey) {
      if (f !== incoming && f.source !== incoming.source) {
        latestByOther.set(f.source, f);
      }
    }

    for (const existing of latestByOther.values()) {
      if (existing.value !== incoming.value) {
        this.emit('fact.conflict', { existing, incoming, key: incoming.key });
      }
    }
  }

  /** Dispatch a bus-level event to all registered listeners. */
  private emit<K extends FactBusEvents>(event: K, data: FactBusEventMap[K]): void {
    const set = this.eventListeners.get(event);
    if (!set || set.size === 0) return;
    // Snapshot the set — listeners may remove themselves during dispatch
    for (const fn of [...set]) {
      (fn as EventListener<K>)(data);
    }
  }
}
