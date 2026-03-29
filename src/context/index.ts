/**
 * @modular/context-engine — Public API
 *
 * Extractable module that handles depth-aware context packing for agent teams.
 * Importable as:
 *   import { ContextRouter } from 'modular-crew/context'
 *
 * Provides:
 *   - ContextRouter   — builds depth-packed prompts per step
 *   - ContextResult   — return type with token accounting
 *   - ContextSpec     — Zod schema + type for context configuration
 *   - DepthLevel      — the 5-level depth enum (full → mention)
 *   - DEPTH_TOKEN_RATIOS — token budget multipliers per depth level
 */

export { ContextRouter } from './router.js';
export type { ContextResult } from './router.js';

// Re-export context-related types from the core type system
export { DepthLevel, DEPTH_TOKEN_RATIOS, ContextSpec } from '../types.js';
export type { Fact, StudioProvider } from '../types.js';
