#!/usr/bin/env bun

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTeamFile, validateTeam, topoSort } from '../src/compiler/team-parser.js';
import { FactBus } from '../src/facts/fact-bus.js';
import { MockProvider } from '../src/studio/mock.js';
import { RunStore } from '../src/store/run-store.js';
import type { TeamDefinition, Fact, StepResult } from '../src/types.js';
import { estimateCost } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));

const program = new Command();

program
  .name('crew')
  .description('Orchestrate multi-agent workflows from a single YAML file')
  .version(pkg.version, '-V, --version');

// ── validate ─────────────────────────────────────────────

program
  .command('validate')
  .description('Validate a crew YAML file')
  .argument('<file>', 'Path to crew YAML file')
  .action((file: string) => {
    const resolved = resolve(file);
    try {
      const team = parseTeamFile(resolved);
      const result = validateTeam(team);

      if (result.errors.length > 0) {
        console.log(chalk.red.bold('\n  Validation failed\n'));
        for (const err of result.errors) {
          console.log(chalk.red(`  ${err.code}: ${err.message}`));
          if (err.suggestion) console.log(chalk.gray(`         ${err.suggestion}`));
        }
      }
      for (const warn of result.warnings) {
        console.log(chalk.yellow(`  ${warn.code}: ${warn.message}`));
      }
      if (result.valid) {
        console.log(chalk.green.bold(`\n  ✓ Valid`));
        console.log(chalk.gray(`  Team: ${team.name}`));
        console.log(chalk.gray(`  Steps: ${Object.keys(team.flow).length}`));
        console.log(chalk.gray(`  Execution order: ${result.executionOrder.join(' → ')}`));
      }
      console.log();
      process.exit(result.valid ? 0 : 1);
    } catch (err: any) {
      console.log(chalk.red(`\n  Parse error: ${err.message}\n`));
      process.exit(1);
    }
  });

// ── plan ─────────────────────────────────────────────────

program
  .command('plan')
  .description('Show execution plan without running')
  .argument('<file>', 'Path to crew YAML file')
  .option('--task <task>', 'Task description')
  .action((file: string, opts: { task?: string }) => {
    const resolved = resolve(file);
    try {
      const team = parseTeamFile(resolved);
      const validation = validateTeam(team);
      if (!validation.valid) {
        console.log(chalk.red('\n  Validation errors found. Run `crew validate` for details.\n'));
        process.exit(1);
      }

      const defaults = team.defaults;
      console.log(chalk.bold.cyan(`\n  ⚡ ${team.name}`));
      if (team.description) console.log(chalk.gray(`  ${team.description}`));
      console.log(chalk.gray(`  Model: ${defaults?.model ?? 'default'} | Budget: ${team.budget?.maxCost ? `$${team.budget.maxCost}` : 'unlimited'}`));
      if (opts.task) console.log(chalk.white(`  Task: ${opts.task}`));
      console.log();

      console.log(chalk.bold('  Execution order:\n'));
      for (const stepId of validation.executionOrder) {
        const step = team.flow[stepId];
        const isParallel = !!step.parallel;
        const hasCondition = !!step.when;
        const depth = step.context?.depth ?? 'detail';

        let agentLabel = '';
        if (step.agent) {
          agentLabel = typeof step.agent === 'string' ? step.agent : '(inline)';
        } else if (isParallel) {
          const branches = Object.keys(step.parallel!);
          agentLabel = `parallel: ${branches.join(', ')}`;
        }

        const condLabel = hasCondition ? chalk.yellow(' (conditional)') : '';
        const depthLabel = chalk.dim(`[${depth}]`);

        console.log(`  ${chalk.green('▸')} ${chalk.bold(stepId)} ${chalk.gray(agentLabel)} ${depthLabel}${condLabel}`);

        if (step.publishes?.length) {
          console.log(chalk.gray(`    publishes: ${step.publishes.join(', ')}`));
        }
        if (step.requires?.length) {
          console.log(chalk.gray(`    requires: ${step.requires.join(', ')}`));
        }
        if (step.retry) {
          console.log(chalk.yellow(`    retry → ${step.retry.step} (max ${step.retry.maxAttempts})`));
        }
      }
      console.log();
    } catch (err: any) {
      console.log(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// ── run ──────────────────────────────────────────────────

program
  .command('run')
  .description('Execute a crew workflow')
  .argument('<file>', 'Path to crew YAML file')
  .option('--task <task>', 'Task description')
  .option('--mock', 'Run with mock LLM responses', false)
  .option('--budget <amount>', 'Max cost in USD')
  .option('-v, --verbose', 'Verbose output', false)
  .action(async (file: string, opts: { task?: string; mock: boolean; budget?: string; verbose: boolean }) => {
    const resolved = resolve(file);

    // 1. Parse & validate
    let team: TeamDefinition;
    try {
      team = parseTeamFile(resolved);
    } catch (err: any) {
      console.log(chalk.red(`\n  Parse error: ${err.message}\n`));
      process.exit(1);
    }

    const validation = validateTeam(team);
    if (!validation.valid) {
      console.log(chalk.red('\n  Validation errors:'));
      for (const err of validation.errors) {
        console.log(chalk.red(`    ${err.code}: ${err.message}`));
      }
      console.log();
      process.exit(1);
    }

    const task = opts.task ?? 'Default task';
    const budgetMax = opts.budget ? parseFloat(opts.budget) : team.budget?.maxCost ?? Infinity;
    const defaults = team.defaults ?? {} as NonNullable<TeamDefinition['defaults']>;
    const model = (defaults as any).model ?? 'claude-sonnet-4-20250514';

    // 2. Init components
    const factBus = new FactBus();
    const store = new RunStore('.crew/runs.db');
    const runId = store.createRun(resolved, team.name, task);
    store.updateRunStatus(runId, 'running');

    let provider: import('../src/types.js').StudioProvider;
    if (opts.mock) {
      provider = new MockProvider();
    } else {
      console.log(chalk.red('\n  Non-mock mode requires a Studio. Use --mock for now.\n'));
      process.exit(1);
    }

    // 3. Header
    console.log(chalk.bold.cyan(`\n  ⚡ ${team.name}`));
    console.log(chalk.gray(`  Task: ${task}`));
    console.log(chalk.gray(`  Mode: ${opts.mock ? 'mock' : 'live'} | Model: ${model} | Budget: ${budgetMax === Infinity ? 'unlimited' : `$${budgetMax}`}`));
    console.log(chalk.gray(`  Run: ${runId}`));
    console.log();

    // 4. Execute steps in topo order
    let totalCost = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    const stepOutputs = new Map<string, string>();

    for (const stepId of validation.executionOrder) {
      const step = team.flow[stepId];
      const start = Date.now();
      store.createStep(runId, stepId);

      // Check condition
      if (step.when) {
        const condMet = evaluateSimpleCondition(step.when, factBus);
        if (!condMet) {
          const dur = Date.now() - start;
          console.log(`  ${chalk.dim('⊘')} ${chalk.dim(stepId)} ${chalk.dim('skipped')} ${chalk.dim(`(condition not met)`)} ${chalk.dim(`${dur}ms`)}`);
          store.updateStep(runId, stepId, { status: 'skipped', duration_ms: dur });
          continue;
        }
      }

      // Resolve agent(s)
      if (step.parallel) {
        // Parallel execution
        const branches = Object.entries(step.parallel);
        const branchLabel = branches.map(([k]) => k).join(', ');
        process.stdout.write(`  ${chalk.blue('◼')} ${chalk.bold(stepId)} ${chalk.gray(`parallel: ${branchLabel}`)} `);

        const branchResults = await Promise.allSettled(
          branches.map(async ([branchId, branch]) => {
            const agentRef = branch.agent;
            const agent = typeof agentRef === 'string'
              ? await provider.resolveAgent(agentRef)
              : { id: branchId, name: branchId, systemPrompt: agentRef.system, model: agentRef.model ?? model, maxTurns: agentRef.maxTurns ?? 15 };

            const input = buildPrompt(task, branch.requires ?? [], factBus, branch.publishes ?? []);
            let output = '';
            let tokIn = 0, tokOut = 0;

            for await (const event of provider.executeAgent(agent, input)) {
              if (event.type === 'text') output += String(event.data);
              if (event.tokensIn) tokIn += event.tokensIn;
              if (event.tokensOut) tokOut += event.tokensOut;
            }

            // Extract and publish facts
            for (const key of branch.publishes ?? []) {
              const fact: Fact = {
                key,
                value: extractFactValue(output, key),
                source: branchId,
                timestamp: Date.now(),
                status: 'final',
              };
              factBus.publish([fact]);
              store.publishFact(runId, stepId, fact);
            }

            return { branchId, output, tokIn, tokOut };
          })
        );

        const dur = Date.now() - start;
        let stepTokIn = 0, stepTokOut = 0;
        let allOk = true;

        for (const r of branchResults) {
          if (r.status === 'fulfilled') {
            stepTokIn += r.value.tokIn;
            stepTokOut += r.value.tokOut;
            stepOutputs.set(`${stepId}.${r.value.branchId}`, r.value.output);
          } else {
            allOk = false;
          }
        }

        const cost = estimateCost(model, stepTokIn, stepTokOut);
        totalCost += cost;
        totalTokensIn += stepTokIn;
        totalTokensOut += stepTokOut;

        store.updateStep(runId, stepId, {
          status: allOk ? 'succeeded' : 'failed',
          completed_at: new Date().toISOString(),
          tokens_in: stepTokIn,
          tokens_out: stepTokOut,
          cost_usd: cost,
          duration_ms: dur,
        });

        console.log(
          `${allOk ? chalk.green('✓') : chalk.red('✗')} ${chalk.dim(`${(dur / 1000).toFixed(1)}s`)} ${chalk.dim(`${stepTokIn + stepTokOut} tok`)} ${chalk.dim(`$${cost.toFixed(3)}`)}`
        );

      } else if (step.agent) {
        // Single agent
        const agentRef = step.agent;
        const agent = typeof agentRef === 'string'
          ? await provider.resolveAgent(agentRef)
          : { id: stepId, name: stepId, systemPrompt: agentRef.system, model: agentRef.model ?? model, maxTurns: agentRef.maxTurns ?? 15 };

        process.stdout.write(`  ${chalk.blue('◼')} ${chalk.bold(stepId)} ${chalk.gray(agent.name)} `);

        const input = buildPrompt(task, step.requires ?? [], factBus, step.publishes ?? []);
        let output = '';
        let tokIn = 0, tokOut = 0;

        for await (const event of provider.executeAgent(agent, input)) {
          if (event.type === 'text') output += String(event.data);
          if (event.tokensIn) tokIn += event.tokensIn;
          if (event.tokensOut) tokOut += event.tokensOut;
        }

        const dur = Date.now() - start;
        const cost = estimateCost(model, tokIn, tokOut);
        totalCost += cost;
        totalTokensIn += tokIn;
        totalTokensOut += tokOut;
        stepOutputs.set(stepId, output);

        // Publish facts
        for (const key of step.publishes ?? []) {
          const fact: Fact = {
            key,
            value: extractFactValue(output, key),
            source: stepId,
            timestamp: Date.now(),
            status: 'final',
          };
          factBus.publish([fact]);
          store.publishFact(runId, stepId, fact);
        }

        store.updateStep(runId, stepId, {
          status: 'succeeded',
          completed_at: new Date().toISOString(),
          output,
          tokens_in: tokIn,
          tokens_out: tokOut,
          cost_usd: cost,
          duration_ms: dur,
        });

        console.log(
          `${chalk.green('✓')} ${chalk.dim(`${(dur / 1000).toFixed(1)}s`)} ${chalk.dim(`${tokIn + tokOut} tok`)} ${chalk.dim(`$${cost.toFixed(3)}`)}`
        );

        if (opts.verbose && output) {
          const preview = output.slice(0, 200).replace(/\n/g, ' ');
          console.log(chalk.gray(`    ${preview}${output.length > 200 ? '...' : ''}`));
        }
      }

      // Budget check
      if (totalCost > budgetMax) {
        console.log(chalk.red.bold(`\n  ⚠ Budget exceeded: $${totalCost.toFixed(3)} > $${budgetMax}`));
        store.completeRun(runId, 'budget_exceeded', { tokens: totalTokensIn + totalTokensOut, cost: totalCost });
        process.exit(1);
      }
    }

    // 5. Summary
    store.completeRun(runId, 'succeeded', { tokens: totalTokensIn + totalTokensOut, cost: totalCost });

    console.log(chalk.bold.cyan('\n  ─── Summary ─────────────────────────────'));
    console.log(`  Status: ${chalk.green('✓ completed')}`);
    console.log(`  Steps: ${validation.executionOrder.length}`);
    console.log(`  Facts: ${factBus.size}`);
    console.log(`  Tokens: ${totalTokensIn} in / ${totalTokensOut} out`);
    console.log(`  Cost: $${totalCost.toFixed(3)}`);
    console.log(`  Run ID: ${runId}`);
    console.log();

    // Print fact bus state
    if (factBus.size > 0) {
      console.log(chalk.bold.cyan('  ─── Fact Bus ────────────────────────────'));
      const snap = factBus.snapshot();
      for (const [key, versions] of snap) {
        const latest = versions[versions.length - 1];
        const preview = latest.value.slice(0, 80).replace(/\n/g, ' ');
        console.log(`  ${chalk.green(key)} ${chalk.gray(`(${latest.source})`)} ${chalk.dim(preview)}${latest.value.length > 80 ? '...' : ''}`);
      }
      console.log();
    }

    store.close();
  });

// ── agents ───────────────────────────────────────────────

program
  .command('agents')
  .description('List agents defined in a crew file')
  .argument('<file>', 'Path to crew YAML file')
  .action((file: string) => {
    const resolved = resolve(file);
    try {
      const team = parseTeamFile(resolved);
      console.log(chalk.bold.cyan(`\n  ⚡ ${team.name} — Agents\n`));

      for (const [stepId, step] of Object.entries(team.flow)) {
        if (step.agent) {
          const label = typeof step.agent === 'string' ? step.agent : '(inline)';
          const model = typeof step.agent === 'object' ? step.agent.model : undefined;
          console.log(`  ${chalk.green('▸')} ${chalk.bold(stepId)} ${chalk.gray(label)} ${model ? chalk.dim(`[${model}]`) : ''}`);
        }
        if (step.parallel) {
          for (const [branchId, branch] of Object.entries(step.parallel)) {
            const label = typeof branch.agent === 'string' ? branch.agent : '(inline)';
            const model = typeof branch.agent === 'object' ? branch.agent.model : undefined;
            console.log(`  ${chalk.green('▸')} ${chalk.bold(`${stepId}.${branchId}`)} ${chalk.gray(label)} ${model ? chalk.dim(`[${model}]`) : ''}`);
          }
        }
      }
      console.log();
    } catch (err: any) {
      console.log(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// ── Helpers ──────────────────────────────────────────────

function buildPrompt(task: string, requires: string[], factBus: FactBus, publishes: string[]): string {
  let prompt = `## Task\n${task}\n`;

  if (requires.length > 0) {
    prompt += '\n## Facts from Previous Steps\n';
    for (const key of requires) {
      const latest = factBus.getLatest(key);
      if (latest) {
        prompt += `### ${key} (from: ${latest.source})\n${latest.value}\n\n`;
      }
    }
  }

  if (publishes.length > 0) {
    prompt += '\n## Your Deliverables\nPublish the following facts when done:\n';
    for (const key of publishes) {
      prompt += `- ${key}\n`;
    }
  }

  return prompt;
}

function extractFactValue(output: string, key: string): string {
  // Try to find a section headed by the key
  const patterns = [
    new RegExp(`### ${key}\\n([\\s\\S]*?)(?=###|$)`, 'i'),
    new RegExp(`\\[FACT:${key}\\]([\\s\\S]*?)\\[/FACT\\]`, 'i'),
    new RegExp(`${key}:\\s*(.+)`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  // Fallback: first 500 chars of output
  return output.slice(0, 500).trim() || `(${key}: no structured output found)`;
}

function evaluateSimpleCondition(cond: any, factBus: FactBus): boolean {
  if (typeof cond === 'object' && 'fact' in cond) {
    const latest = factBus.getLatest(cond.fact);
    if (!latest) return false;
    if (cond.equals != null) return latest.value === cond.equals;
    if (cond.not != null) return latest.value !== cond.not;
    if (cond.contains != null) return latest.value.includes(cond.contains);
    return true;
  }
  // String conditions: for mock mode, just return true
  return true;
}

program.parse();
