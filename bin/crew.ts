#!/usr/bin/env bun

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTeamFile, validateTeam } from '../src/compiler/team-parser.js';
import { FactBus } from '../src/facts/fact-bus.js';
import { MockProvider } from '../src/studio/mock.js';
import { RunStore } from '../src/store/run-store.js';
import type { TeamDefinition, Fact } from '../src/types.js';
import { estimateCost, DEPTH_TOKEN_RATIOS } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));
const TEMPLATES_DIR = resolve(__dirname, '..', 'templates');

const program = new Command();

program
  .name('crew')
  .description('Orchestrate multi-agent workflows from a single YAML file')
  .version(pkg.version, '-V, --version');

// ── init ─────────────────────────────────────────────────

program
  .command('init')
  .description('Scaffold a new crew project')
  .argument('<name>', 'Project name')
  .option('-t, --template <template>', 'Template to use', 'minimal')
  .action((name: string, opts: { template: string }) => {
    const projectDir = resolve(name);

    if (existsSync(projectDir)) {
      console.log(chalk.red(`\n  Directory '${name}' already exists.\n`));
      process.exit(1);
    }

    // Check template exists
    const templateFile = join(TEMPLATES_DIR, `${opts.template}.yaml`);
    if (!existsSync(templateFile)) {
      const available = ['minimal', 'dev-crew'];
      console.log(chalk.red(`\n  Template '${opts.template}' not found.`));
      console.log(chalk.gray(`  Available: ${available.join(', ')}\n`));
      process.exit(1);
    }

    // Create project structure
    mkdirSync(join(projectDir, '.crew'), { recursive: true });

    // Copy template as team.yaml
    const templateContent = readFileSync(templateFile, 'utf-8');
    const patchedContent = templateContent.replace(
      /^name: .+$/m,
      `name: ${name}`
    );
    writeFileSync(join(projectDir, 'team.yaml'), patchedContent);

    // Create a .gitignore
    writeFileSync(join(projectDir, '.gitignore'), '.crew/\nnode_modules/\n');

    console.log(chalk.green.bold(`\n  ✓ Created ${name}/`));
    console.log(chalk.gray(`  Template: ${opts.template}`));
    console.log();
    console.log(chalk.bold('  Next steps:'));
    console.log(chalk.cyan(`    cd ${name}`));
    console.log(chalk.cyan(`    crew validate team.yaml`));
    console.log(chalk.cyan(`    crew plan team.yaml --task "Your task here"`));
    console.log(chalk.cyan(`    crew run team.yaml --task "Your task here" --mock`));
    console.log();
  });

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

// ── diff (the killer command) ────────────────────────────

program
  .command('diff')
  .description('Show what context each agent would receive (the demo)')
  .argument('<file>', 'Path to crew YAML file')
  .option('--task <task>', 'Task description')
  .action((file: string, opts: { task?: string }) => {
    const resolved = resolve(file);
    try {
      const team = parseTeamFile(resolved);
      const validation = validateTeam(team);
      if (!validation.valid) {
        console.log(chalk.red('\n  Validation errors. Run `crew validate` first.\n'));
        process.exit(1);
      }

      const defaultBudget = team.defaults?.tokenBudget ?? 50000;
      const defaultModel = team.defaults?.model ?? 'claude-sonnet-4-20250514';

      console.log(chalk.bold.cyan(`\n  ⚡ ${team.name} — Context Diff\n`));
      if (opts.task) console.log(chalk.gray(`  Task: ${opts.task}\n`));

      let totalTokensEstimate = 0;
      let totalCostEstimate = 0;

      // Flat context baseline (what other frameworks do)
      const flatTokens = defaultBudget;

      console.log(chalk.bold('  Per-agent context allocation:\n'));

      // Header
      console.log(chalk.dim('  Step               Agent           Depth      Tokens     Cost       Sources'));
      console.log(chalk.dim('  ' + '─'.repeat(85)));

      for (const stepId of validation.executionOrder) {
        const step = team.flow[stepId];

        const printRow = (label: string, agentName: string, depth: string, budget: number, model: string, sources: string[]) => {
          const ratio = DEPTH_TOKEN_RATIOS[depth as keyof typeof DEPTH_TOKEN_RATIOS] ?? 1;
          const effectiveTokens = Math.round(budget * ratio);
          const cost = estimateCost(model, effectiveTokens, 2000); // estimate 2k output
          totalTokensEstimate += effectiveTokens;
          totalCostEstimate += cost;

          const depthColor = depth === 'full' ? chalk.red : depth === 'detail' ? chalk.yellow : depth === 'summary' ? chalk.green : chalk.dim;
          const srcList = sources.length > 0 ? sources.slice(0, 3).join(', ') : '(task only)';

          console.log(
            `  ${chalk.bold(label.padEnd(18))} ${chalk.gray(agentName.padEnd(15))} ` +
            `${depthColor(depth.padEnd(10))} ${String(effectiveTokens).padStart(7)} tok ` +
            `${chalk.dim(`$${cost.toFixed(3)}`.padStart(8))}  ${chalk.gray(srcList)}`
          );
        };

        if (step.agent) {
          const agentName = typeof step.agent === 'string'
            ? step.agent.replace('studio://agents/', '')
            : '(inline)';
          const depth = step.context?.depth ?? 'detail';
          const budget = (typeof step.agent === 'object' ? step.agent.tokenBudget : undefined) ?? defaultBudget;
          const model = (typeof step.agent === 'object' ? step.agent.model : undefined) ?? defaultModel;
          printRow(stepId, agentName, depth, budget, model, step.context?.sources ?? []);
        }

        if (step.parallel) {
          for (const [branchId, branch] of Object.entries(step.parallel)) {
            const agentName = typeof branch.agent === 'string'
              ? branch.agent.replace('studio://agents/', '')
              : '(inline)';
            const depth = branch.context?.depth ?? step.context?.depth ?? 'detail';
            const budget = (typeof branch.agent === 'object' ? branch.agent.tokenBudget : undefined) ?? defaultBudget;
            const model = (typeof branch.agent === 'object' ? branch.agent.model : undefined) ?? defaultModel;
            printRow(`${stepId}.${branchId}`, agentName, depth, budget, model, branch.context?.sources ?? step.context?.sources ?? []);
          }
        }
      }

      // Flat baseline for comparison
      const agentCount = validation.executionOrder.reduce((n, stepId) => {
        const step = team.flow[stepId];
        if (step.parallel) return n + Object.keys(step.parallel).length;
        if (step.agent) return n + 1;
        return n;
      }, 0);
      const flatTotal = agentCount * flatTokens;
      const flatCost = estimateCost(defaultModel, flatTotal, agentCount * 2000);

      console.log(chalk.dim('  ' + '─'.repeat(85)));

      // Summary
      console.log(chalk.bold(`\n  Depth-routed:  ${totalTokensEstimate.toLocaleString()} tokens   $${totalCostEstimate.toFixed(3)}`));
      console.log(chalk.dim(`  Flat baseline: ${flatTotal.toLocaleString()} tokens   $${flatCost.toFixed(3)}  (same context to every agent)`));

      const savings = flatTotal > 0 ? Math.round((1 - totalTokensEstimate / flatTotal) * 100) : 0;
      const ratio = flatTotal > 0 ? (flatTotal / totalTokensEstimate).toFixed(1) : '?';

      if (savings > 0) {
        console.log(chalk.green.bold(`\n  ↓ ${savings}% fewer tokens (${ratio}x more efficient)`));
        console.log(chalk.green(`  ↓ $${(flatCost - totalCostEstimate).toFixed(3)} saved per run`));
      }
      console.log();
    } catch (err: any) {
      console.log(chalk.red(`\n  Error: ${err.message}\n`));
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
          agentLabel = `parallel: ${Object.keys(step.parallel!).join(', ')}`;
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
      for (const err of validation.errors) console.log(chalk.red(`    ${err.code}: ${err.message}`));
      console.log();
      process.exit(1);
    }

    const task = opts.task ?? 'Default task';
    const budgetMax = opts.budget ? parseFloat(opts.budget) : team.budget?.maxCost ?? Infinity;
    const model = (team.defaults as any)?.model ?? 'claude-sonnet-4-20250514';

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

    console.log(chalk.bold.cyan(`\n  ⚡ ${team.name}`));
    console.log(chalk.gray(`  Task: ${task}`));
    console.log(chalk.gray(`  Mode: ${opts.mock ? 'mock' : 'live'} | Model: ${model} | Budget: ${budgetMax === Infinity ? 'unlimited' : `$${budgetMax}`}`));
    console.log(chalk.gray(`  Run: ${runId}`));
    console.log();

    let totalCost = 0, totalTokensIn = 0, totalTokensOut = 0;

    for (const stepId of validation.executionOrder) {
      const step = team.flow[stepId];
      const start = Date.now();
      store.createStep(runId, stepId);

      if (step.when) {
        const condMet = evaluateSimpleCondition(step.when, factBus);
        if (!condMet) {
          const dur = Date.now() - start;
          console.log(`  ${chalk.dim('⊘')} ${chalk.dim(stepId)} ${chalk.dim('skipped (condition)')}`);
          store.updateStep(runId, stepId, { status: 'skipped', duration_ms: dur });
          continue;
        }
      }

      if (step.parallel) {
        const branches = Object.entries(step.parallel);
        process.stdout.write(`  ${chalk.blue('◼')} ${chalk.bold(stepId)} ${chalk.gray(`parallel: ${branches.map(([k]) => k).join(', ')}`)} `);

        const results = await Promise.allSettled(
          branches.map(async ([branchId, branch]) => {
            const agent = typeof branch.agent === 'string'
              ? await provider.resolveAgent(branch.agent)
              : { id: branchId, name: branchId, systemPrompt: branch.agent.system, model: branch.agent.model ?? model, maxTurns: branch.agent.maxTurns ?? 15 };

            const input = buildPrompt(task, branch.requires ?? [], factBus, branch.publishes ?? []);
            let output = '', tokIn = 0, tokOut = 0;
            for await (const ev of provider.executeAgent(agent, input)) {
              if (ev.type === 'text') output += String(ev.data);
              if (ev.tokensIn) tokIn += ev.tokensIn;
              if (ev.tokensOut) tokOut += ev.tokensOut;
            }
            for (const key of branch.publishes ?? []) {
              const fact: Fact = { key, value: extractFactValue(output, key), source: branchId, timestamp: Date.now(), status: 'final' };
              factBus.publish([fact]);
              store.publishFact(runId, stepId, fact);
            }
            return { branchId, output, tokIn, tokOut };
          })
        );

        const dur = Date.now() - start;
        let sIn = 0, sOut = 0, ok = true;
        for (const r of results) {
          if (r.status === 'fulfilled') { sIn += r.value.tokIn; sOut += r.value.tokOut; }
          else ok = false;
        }
        const cost = estimateCost(model, sIn, sOut);
        totalCost += cost; totalTokensIn += sIn; totalTokensOut += sOut;
        store.updateStep(runId, stepId, { status: ok ? 'succeeded' : 'failed', completed_at: new Date().toISOString(), tokens_in: sIn, tokens_out: sOut, cost_usd: cost, duration_ms: dur });
        console.log(`${ok ? chalk.green('✓') : chalk.red('✗')} ${chalk.dim(`${(dur/1000).toFixed(1)}s`)} ${chalk.dim(`${sIn+sOut} tok`)} ${chalk.dim(`$${cost.toFixed(3)}`)}`);

      } else if (step.agent) {
        const agent = typeof step.agent === 'string'
          ? await provider.resolveAgent(step.agent)
          : { id: stepId, name: stepId, systemPrompt: step.agent.system, model: step.agent.model ?? model, maxTurns: step.agent.maxTurns ?? 15 };

        process.stdout.write(`  ${chalk.blue('◼')} ${chalk.bold(stepId)} ${chalk.gray(agent.name)} `);

        const input = buildPrompt(task, step.requires ?? [], factBus, step.publishes ?? []);
        let output = '', tokIn = 0, tokOut = 0;
        for await (const ev of provider.executeAgent(agent, input)) {
          if (ev.type === 'text') output += String(ev.data);
          if (ev.tokensIn) tokIn += ev.tokensIn;
          if (ev.tokensOut) tokOut += ev.tokensOut;
        }

        const dur = Date.now() - start;
        const cost = estimateCost(model, tokIn, tokOut);
        totalCost += cost; totalTokensIn += tokIn; totalTokensOut += tokOut;

        for (const key of step.publishes ?? []) {
          const fact: Fact = { key, value: extractFactValue(output, key), source: stepId, timestamp: Date.now(), status: 'final' };
          factBus.publish([fact]);
          store.publishFact(runId, stepId, fact);
        }

        store.updateStep(runId, stepId, { status: 'succeeded', completed_at: new Date().toISOString(), output, tokens_in: tokIn, tokens_out: tokOut, cost_usd: cost, duration_ms: dur });
        console.log(`${chalk.green('✓')} ${chalk.dim(`${(dur/1000).toFixed(1)}s`)} ${chalk.dim(`${tokIn+tokOut} tok`)} ${chalk.dim(`$${cost.toFixed(3)}`)}`);

        if (opts.verbose && output) {
          console.log(chalk.gray(`    ${output.slice(0, 200).replace(/\n/g, ' ')}${output.length > 200 ? '...' : ''}`));
        }
      }

      if (totalCost > budgetMax) {
        console.log(chalk.red.bold(`\n  Budget exceeded: $${totalCost.toFixed(3)} > $${budgetMax}`));
        store.completeRun(runId, 'budget_exceeded', { tokens: totalTokensIn + totalTokensOut, cost: totalCost });
        process.exit(1);
      }
    }

    store.completeRun(runId, 'succeeded', { tokens: totalTokensIn + totalTokensOut, cost: totalCost });

    console.log(chalk.bold.cyan('\n  ─── Summary ─────────────────────────────'));
    console.log(`  Status: ${chalk.green('✓ completed')}`);
    console.log(`  Steps: ${validation.executionOrder.length} | Facts: ${factBus.size}`);
    console.log(`  Tokens: ${totalTokensIn} in / ${totalTokensOut} out`);
    console.log(`  Cost: $${totalCost.toFixed(3)}`);
    console.log(`  Run: ${runId}\n`);

    if (factBus.size > 0) {
      console.log(chalk.bold.cyan('  ─── Fact Bus ────────────────────────────'));
      for (const [key, versions] of factBus.snapshot()) {
        const latest = versions[versions.length - 1];
        const preview = latest.value.slice(0, 70).replace(/\n/g, ' ');
        console.log(`  ${chalk.green(key)} ${chalk.gray(`(${latest.source})`)} ${chalk.dim(preview)}${latest.value.length > 70 ? '...' : ''}`);
      }
      console.log();
    }
    store.close();
  });

// ── doctor ───────────────────────────────────────────────

program
  .command('doctor')
  .description('Check environment and connectivity')
  .option('--studio <url>', 'Studio URL to check')
  .action(async (opts: { studio?: string }) => {
    console.log(chalk.bold.cyan('\n  ⚡ crew doctor\n'));

    // Bun version
    const bunVersion = process.versions?.bun ?? 'unknown';
    console.log(`  ${chalk.green('✓')} Bun ${bunVersion}`);

    // Templates
    const templatesExist = existsSync(TEMPLATES_DIR);
    console.log(`  ${templatesExist ? chalk.green('✓') : chalk.red('✗')} Templates directory ${templatesExist ? 'found' : 'missing'}`);

    // SQLite
    try {
      const testStore = new RunStore('/tmp/.crew-doctor-test/runs.db');
      testStore.close();
      console.log(`  ${chalk.green('✓')} SQLite (bun:sqlite) working`);
    } catch (e: any) {
      console.log(`  ${chalk.red('✗')} SQLite: ${e.message}`);
    }

    // Studio connectivity
    if (opts.studio) {
      try {
        const res = await fetch(`${opts.studio}/api/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          console.log(`  ${chalk.green('✓')} Studio reachable at ${opts.studio}`);
        } else {
          console.log(`  ${chalk.red('✗')} Studio returned ${res.status} at ${opts.studio}`);
        }
      } catch (e: any) {
        console.log(`  ${chalk.red('✗')} Studio unreachable at ${opts.studio}: ${e.message}`);
        console.log(chalk.gray(`         Is modular-patchbay running? Try: cd modular-patchbay && npm run dev`));
      }
    } else {
      console.log(`  ${chalk.dim('○')} Studio: not checked (use --studio <url>)`);
    }

    console.log();
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
          const m = typeof step.agent === 'object' ? step.agent.model : undefined;
          console.log(`  ${chalk.green('▸')} ${chalk.bold(stepId)} ${chalk.gray(label)} ${m ? chalk.dim(`[${m}]`) : ''}`);
        }
        if (step.parallel) {
          for (const [branchId, branch] of Object.entries(step.parallel)) {
            const label = typeof branch.agent === 'string' ? branch.agent : '(inline)';
            const m = typeof branch.agent === 'object' ? branch.agent.model : undefined;
            console.log(`  ${chalk.green('▸')} ${chalk.bold(`${stepId}.${branchId}`)} ${chalk.gray(label)} ${m ? chalk.dim(`[${m}]`) : ''}`);
          }
        }
      }
      console.log();
    } catch (err: any) {
      console.log(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// ── show ─────────────────────────────────────────────────

program
  .command('show')
  .description('Inspect a past run')
  .argument('<runId>', 'Run ID or "last"')
  .option('--facts', 'Show facts', false)
  .action((runId: string, opts: { facts: boolean }) => {
    const store = new RunStore('.crew/runs.db');

    let targetId = runId;
    if (runId === 'last') {
      const runs = store.listRuns(1);
      if (runs.length === 0) {
        console.log(chalk.red('\n  No runs found.\n'));
        store.close();
        process.exit(1);
      }
      targetId = runs[0].id;
    }

    const run = store.getRun(targetId);
    if (!run) {
      console.log(chalk.red(`\n  Run '${targetId}' not found.\n`));
      store.close();
      process.exit(1);
    }

    const steps = store.getRunSteps(targetId);
    const statusIcon = run.status === 'succeeded' ? chalk.green('✓') : run.status === 'failed' ? chalk.red('✗') : chalk.yellow('◼');

    console.log(chalk.bold.cyan(`\n  ⚡ Run ${run.id}`));
    console.log(chalk.gray(`  Team: ${run.team_name} | Status: ${run.status}`));
    console.log(chalk.gray(`  Task: ${run.task}`));
    console.log(chalk.gray(`  Cost: $${run.total_cost_usd.toFixed(3)} | Tokens: ${run.total_tokens}`));
    console.log(chalk.gray(`  Started: ${run.started_at}${run.completed_at ? ` | Completed: ${run.completed_at}` : ''}`));
    console.log();

    for (const step of steps) {
      const icon = step.status === 'succeeded' ? chalk.green('✓') : step.status === 'skipped' ? chalk.dim('⊘') : step.status === 'failed' ? chalk.red('✗') : chalk.blue('◼');
      console.log(`  ${icon} ${chalk.bold(step.step_id)} ${chalk.dim(`${step.duration_ms}ms`)} ${chalk.dim(`${step.tokens_in + step.tokens_out} tok`)} ${chalk.dim(`$${step.cost_usd.toFixed(3)}`)}`);
    }

    if (opts.facts) {
      const facts = store.getRunFacts(targetId);
      if (facts.length > 0) {
        console.log(chalk.bold.cyan('\n  ─── Facts ─────────────────────────────'));
        for (const f of facts) {
          const preview = f.value.slice(0, 70).replace(/\n/g, ' ');
          console.log(`  ${chalk.green(f.key)} ${chalk.gray(`(${f.source})`)} ${chalk.dim(preview)}${f.value.length > 70 ? '...' : ''}`);
        }
      }
    }
    console.log();
    store.close();
  });

// ── Helpers ──────────────────────────────────────────────

function buildPrompt(task: string, requires: string[], factBus: FactBus, publishes: string[]): string {
  let prompt = `## Task\n${task}\n`;
  if (requires.length > 0) {
    prompt += '\n## Facts from Previous Steps\n';
    for (const key of requires) {
      const latest = factBus.getLatest(key);
      if (latest) prompt += `### ${key} (from: ${latest.source})\n${latest.value}\n\n`;
    }
  }
  if (publishes.length > 0) {
    prompt += '\n## Your Deliverables\nPublish the following facts when done:\n';
    for (const key of publishes) prompt += `- ${key}\n`;
  }
  return prompt;
}

function extractFactValue(output: string, key: string): string {
  const patterns = [
    new RegExp(`### ${key}\\n([\\s\\S]*?)(?=###|$)`, 'i'),
    new RegExp(`\\[FACT:${key}\\]([\\s\\S]*?)\\[/FACT\\]`, 'i'),
    new RegExp(`${key}:\\s*(.+)`, 'i'),
  ];
  for (const p of patterns) { const m = output.match(p); if (m?.[1]?.trim()) return m[1].trim(); }
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
  return true;
}

program.parse();
