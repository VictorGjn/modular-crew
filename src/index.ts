/**
 * modular-crew — Public API
 *
 * Two export surfaces:
 *   import { compileTeam, FactBus, ... } from 'modular-crew'       // full framework
 *   import { ContextRouter, ... } from 'modular-crew/context'      // standalone context engine
 */

// ── Types (re-export everything) ─────────────────────────────────────────────
export * from './types.js';

// ── Core components ──────────────────────────────────────────────────────────
export { FactBus } from './facts/fact-bus.js';
export { ContextRouter } from './context/router.js';
export { RunStore } from './store/run-store.js';

// ── Compiler ─────────────────────────────────────────────────────────────────
export { compileTeam, buildAgentPrompt, extractFacts } from './compiler/inngest-compiler.js';
export { parseTeamFile, validateTeam, topoSort } from './compiler/team-parser.js';

// ── Studio Providers ─────────────────────────────────────────────────────────
export { PatchbayProvider } from './studio/patchbay.js';
export { MockProvider } from './studio/mock.js';
