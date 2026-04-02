/**
 * Event Stream — claw-code pattern: Streaming Event Audit.
 * Structured SSE events documenting what context was injected, which tools
 * matched, what was denied, and why execution stopped. Transparency = trust.
 *
 * Extends the existing TraceEvent system with turn-level streaming events.
 */

import type { TraceEvent, TraceEventType } from '../types.js';

export type StreamEventType =
  | 'turn.start'           // new agent turn begins
  | 'turn.tools_matched'   // tools selected for this turn
  | 'turn.tools_denied'    // tools blocked by permission filter
  | 'turn.context_packed'  // context assembled with token count
  | 'turn.delta'           // incremental output text
  | 'turn.end';            // turn complete with usage + stop reason

export interface StreamEvent {
  type: StreamEventType;
  timestamp: number;
  runId: string;
  stepId: string;
  agentId: string;
  data: Record<string, unknown>;
}

export type StopReason = 'completed' | 'max_turns_reached' | 'max_budget_reached' | 'tool_denied' | 'error';

export class TurnEventEmitter {
  private listeners: Array<(event: StreamEvent) => void> = [];

  on(listener: (event: StreamEvent) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  emit(event: StreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  emitTurnStart(runId: string, stepId: string, agentId: string, turnNumber: number): void {
    this.emit({ type: 'turn.start', timestamp: Date.now(), runId, stepId, agentId, data: { turnNumber } });
  }

  emitToolsMatched(runId: string, stepId: string, agentId: string, tools: string[]): void {
    this.emit({ type: 'turn.tools_matched', timestamp: Date.now(), runId, stepId, agentId, data: { tools, count: tools.length } });
  }

  emitToolsDenied(runId: string, stepId: string, agentId: string, denied: Array<{ tool: string; reason: string }>): void {
    this.emit({ type: 'turn.tools_denied', timestamp: Date.now(), runId, stepId, agentId, data: { denied, count: denied.length } });
  }

  emitContextPacked(runId: string, stepId: string, agentId: string, tokenCount: number, budget: number): void {
    this.emit({ type: 'turn.context_packed', timestamp: Date.now(), runId, stepId, agentId, data: { tokenCount, budget, utilization: budget > 0 ? (tokenCount / budget * 100).toFixed(1) + '%' : 'N/A' } });
  }

  emitDelta(runId: string, stepId: string, agentId: string, text: string): void {
    this.emit({ type: 'turn.delta', timestamp: Date.now(), runId, stepId, agentId, data: { text } });
  }

  emitTurnEnd(runId: string, stepId: string, agentId: string, stopReason: StopReason, usage: { tokensIn: number; tokensOut: number; costUsd?: number }): void {
    this.emit({ type: 'turn.end', timestamp: Date.now(), runId, stepId, agentId, data: { stopReason, ...usage } });
  }

  /** Convert stream events to existing TraceEvent format for persistence */
  static toTraceEvent(event: StreamEvent): TraceEvent {
    const typeMap: Record<StreamEventType, TraceEventType> = {
      'turn.start': 'step.start',
      'turn.tools_matched': 'context.pack',
      'turn.tools_denied': 'context.pack',
      'turn.context_packed': 'context.pack',
      'turn.delta': 'step.start',
      'turn.end': 'step.end',
    };
    return {
      timestamp: event.timestamp,
      runId: event.runId,
      stepId: event.stepId,
      agentId: event.agentId,
      type: typeMap[event.type] ?? 'step.start',
      data: { streamType: event.type, ...event.data },
    };
  }
}
