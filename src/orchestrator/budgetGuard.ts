/**
 * Budget Guard — claw-code pattern: Token Budget Dual-Stop.
 * Two stop conditions: max_turns + max_budget with projected usage check
 * BEFORE committing to a turn. Prevents runaway costs.
 */

import type { Budget } from '../types.js';
import { estimateCost } from '../types.js';

export type BudgetStopReason = 'ok' | 'max_turns_reached' | 'max_budget_reached' | 'max_cost_reached';

export interface BudgetSnapshot {
  turnsUsed: number;
  maxTurns: number;
  tokensUsed: number;
  maxTokens: number | null;
  costUsed: number;
  maxCost: number | null;
  projectedTurnTokens: number;
}

export class BudgetGuard {
  private turnsUsed = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  private costUsed = 0;

  constructor(
    private maxTurns: number,
    private budget: Budget | null,
    private model: string,
  ) {}

  /** Check BEFORE starting a turn — returns stop reason if budget would be exceeded */
  checkBeforeTurn(projectedInputTokens: number = 0, projectedOutputTokens: number = 0): BudgetStopReason {
    if (this.turnsUsed >= this.maxTurns) return 'max_turns_reached';

    if (this.budget?.maxTokens) {
      const projected = this.tokensIn + this.tokensOut + projectedInputTokens + projectedOutputTokens;
      if (projected > this.budget.maxTokens) return 'max_budget_reached';
    }

    if (this.budget?.maxCost) {
      const projectedCost = this.costUsed + estimateCost(this.model, projectedInputTokens, projectedOutputTokens);
      if (projectedCost > this.budget.maxCost) return 'max_cost_reached';
    }

    return 'ok';
  }

  /** Record a completed turn */
  recordTurn(tokensIn: number, tokensOut: number): void {
    this.turnsUsed++;
    this.tokensIn += tokensIn;
    this.tokensOut += tokensOut;
    this.costUsed += estimateCost(this.model, tokensIn, tokensOut);
  }

  snapshot(): BudgetSnapshot {
    return {
      turnsUsed: this.turnsUsed,
      maxTurns: this.maxTurns,
      tokensUsed: this.tokensIn + this.tokensOut,
      maxTokens: this.budget?.maxTokens ?? null,
      costUsed: this.costUsed,
      maxCost: this.budget?.maxCost ?? null,
      projectedTurnTokens: 0,
    };
  }

  isExhausted(): boolean {
    return this.checkBeforeTurn() !== 'ok';
  }

  remainingTurns(): number {
    return Math.max(0, this.maxTurns - this.turnsUsed);
  }

  remainingTokens(): number | null {
    if (!this.budget?.maxTokens) return null;
    return Math.max(0, this.budget.maxTokens - this.tokensIn - this.tokensOut);
  }
}
