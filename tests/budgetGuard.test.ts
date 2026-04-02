import { describe, it, expect } from 'vitest';
import { BudgetGuard } from '../src/orchestrator/budgetGuard.js';

describe('BudgetGuard', () => {
  it('allows turns within budget', () => {
    const guard = new BudgetGuard(5, { maxTokens: 10000 }, 'claude-sonnet-4-20250514');
    expect(guard.checkBeforeTurn(1000, 500)).toBe('ok');
    guard.recordTurn(1000, 500);
    expect(guard.remainingTurns()).toBe(4);
  });

  it('stops at max turns', () => {
    const guard = new BudgetGuard(2, null, 'mock');
    guard.recordTurn(100, 50);
    guard.recordTurn(100, 50);
    expect(guard.checkBeforeTurn()).toBe('max_turns_reached');
    expect(guard.isExhausted()).toBe(true);
  });

  it('stops when projected tokens exceed budget', () => {
    const guard = new BudgetGuard(10, { maxTokens: 2000 }, 'mock');
    guard.recordTurn(800, 400);
    expect(guard.checkBeforeTurn(500, 500)).toBe('max_budget_reached');
    expect(guard.remainingTokens()).toBe(800);
  });

  it('stops when projected cost exceeds maxCost', () => {
    const guard = new BudgetGuard(10, { maxCost: 0.01 }, 'claude-sonnet-4-20250514');
    guard.recordTurn(1000, 500);
    // At $3/M in + $15/M out, 1000 in + 500 out = $0.003 + $0.0075 = $0.0105 already over
    expect(guard.checkBeforeTurn(1000, 500)).toBe('max_cost_reached');
  });

  it('snapshot returns current state', () => {
    const guard = new BudgetGuard(5, { maxTokens: 5000, maxCost: 0.10 }, 'claude-sonnet-4-20250514');
    guard.recordTurn(500, 200);
    const snap = guard.snapshot();
    expect(snap.turnsUsed).toBe(1);
    expect(snap.tokensUsed).toBe(700);
    expect(snap.maxTurns).toBe(5);
    expect(snap.maxTokens).toBe(5000);
  });
});
