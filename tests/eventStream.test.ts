import { describe, it, expect } from 'vitest';
import { TurnEventEmitter } from '../src/trace/eventStream.js';
import type { StreamEvent } from '../src/trace/eventStream.js';

describe('TurnEventEmitter', () => {
  it('emits turn lifecycle events', () => {
    const emitter = new TurnEventEmitter();
    const events: StreamEvent[] = [];
    emitter.on(e => events.push(e));

    emitter.emitTurnStart('run1', 'step1', 'agent1', 1);
    emitter.emitToolsMatched('run1', 'step1', 'agent1', ['FileRead', 'BashTool']);
    emitter.emitToolsDenied('run1', 'step1', 'agent1', [{ tool: 'BashTool', reason: 'blocked' }]);
    emitter.emitContextPacked('run1', 'step1', 'agent1', 7500, 8000);
    emitter.emitDelta('run1', 'step1', 'agent1', 'Processing...');
    emitter.emitTurnEnd('run1', 'step1', 'agent1', 'completed', { tokensIn: 500, tokensOut: 200 });

    expect(events).toHaveLength(6);
    expect(events.map(e => e.type)).toEqual([
      'turn.start', 'turn.tools_matched', 'turn.tools_denied',
      'turn.context_packed', 'turn.delta', 'turn.end',
    ]);
  });

  it('unsubscribe works', () => {
    const emitter = new TurnEventEmitter();
    const events: StreamEvent[] = [];
    const unsub = emitter.on(e => events.push(e));
    emitter.emitTurnStart('r', 's', 'a', 1);
    unsub();
    emitter.emitTurnStart('r', 's', 'a', 2);
    expect(events).toHaveLength(1);
  });

  it('converts to TraceEvent format', () => {
    const emitter = new TurnEventEmitter();
    const events: StreamEvent[] = [];
    emitter.on(e => events.push(e));
    emitter.emitTurnEnd('r', 's', 'a', 'max_budget_reached', { tokensIn: 100, tokensOut: 50 });
    const trace = TurnEventEmitter.toTraceEvent(events[0]);
    expect(trace.type).toBe('step.end');
    expect(trace.data.streamType).toBe('turn.end');
  });
});
