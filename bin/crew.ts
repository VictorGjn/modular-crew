#!/usr/bin/env node

// ─────────────────────────────────────────────────────────
// crew.ts — CLI entry point for modular-crew
//
// Commands:
//   init       Scaffold a new crew project
//   validate   Check a crew YAML for schema errors
//   plan       Show the execution plan without running
//   run        Execute a crew against a task
//   doctor     Check environment + connectivity
//   show       Inspect a completed or in-progress run
//   agents     List agents defined in a crew file
// ─────────────────────────────────────────────────────────

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Version from package.json ────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf-8")
);
const VERSION = pkg.version ?? "0.0.0";

// ── Helpers ──────────────────────────────────────────────

function header(text: string): void {
  console.log(chalk.bold.cyan(`\n⚡ ${text}\n`));
}

function info(label: string, value: string): void {
  console.log(`  ${chalk.gray(label + ":")} ${value}`);
}

function stub(command: string, details: Record<string, unknown>): void {
  header(`crew ${command}`);
  for (const [k, v] of Object.entries(details)) {
    if (v !== undefined && v !== false) {
      info(k, String(v));
    }
  }
  console.log(
    chalk.yellow("\n  ⏳ Not yet implemented — this is a stub.\n")
  );
}

// ── Program ──────────────────────────────────────────────

const program = new Command();

program
  .name("crew")
  .description("Orchestrate multi-agent workflows from a single YAML file")
  .version(VERSION, "-V, --version", "Show the crew CLI version");

// ── init ─────────────────────────────────────────────────

program
  .command("init")
  .description("Scaffold a new crew project")
  .argument("<name>", "Project name")
  .option("-t, --template <template>", "Template to use", "minimal")
  .action((name: string, opts: { template: string }) => {
    stub("init", {
      project: name,
      template: opts.template,
      action: `Would create ./${name}/team.yaml from template '${opts.template}'`,
    });
    // TODO:
    // 1. mkdir -p <name>
    // 2. Copy templates/<template>.yaml → <name>/team.yaml
    // 3. Create <name>/package.json with crew dependency
    // 4. Print next-steps instructions
  });

// ── validate ─────────────────────────────────────────────

program
  .command("validate")
  .description("Validate a crew YAML file against the schema")
  .argument("<file>", "Path to crew YAML file")
  .action((file: string) => {
    const resolved = resolve(file);
    stub("validate", {
      file: resolved,
      action: "Would parse YAML, resolve $schema, and report errors",
    });
    // TODO:
    // 1. Read and parse YAML
    // 2. Load JSON Schema from $schema ref (or bundled)
    // 3. Validate with ajv
    // 4. Check DAG for cycles in flow.after references
    // 5. Verify all `requires` facts are published by upstream steps
    // 6. Report errors or print ✅
  });

// ── plan ─────────────────────────────────────────────────

program
  .command("plan")
  .description("Show the execution plan without running anything")
  .argument("<file>", "Path to crew YAML file")
  .option("--task <task>", "Task description to plan against")
  .option("--show-context", "Include context resolution details", false)
  .action((file: string, opts: { task?: string; showContext: boolean }) => {
    const resolved = resolve(file);
    stub("plan", {
      file: resolved,
      task: opts.task ?? "(interactive prompt)",
      showContext: opts.showContext,
      action: "Would resolve DAG, topological-sort steps, and print execution order",
    });
    // TODO:
    // 1. Parse & validate YAML
    // 2. Build DAG from flow.after + flow.requires
    // 3. Topological sort
    // 4. Print execution order with parallel groups
    // 5. If --show-context, print context.sources resolution for each step
    // 6. Estimate token budget per step
  });

// ── run ──────────────────────────────────────────────────

program
  .command("run")
  .description("Execute a crew workflow")
  .argument("<file>", "Path to crew YAML file")
  .option("--task <task>", "Task description (or read from stdin)")
  .option("--mock", "Dry-run with mock LLM responses", false)
  .option("--budget <amount>", "Override max cost in USD")
  .option("-v, --verbose", "Verbose output", false)
  .option("--json", "Output results as JSON", false)
  .option("--resume <runId>", "Resume a previously interrupted run")
  .action(
    (
      file: string,
      opts: {
        task?: string;
        mock: boolean;
        budget?: string;
        verbose: boolean;
        json: boolean;
        resume?: string;
      }
    ) => {
      const resolved = resolve(file);

      if (opts.resume) {
        stub("run --resume", {
          file: resolved,
          resumeFrom: opts.resume,
          action: "Would reload run state and continue from last completed step",
        });
        return;
      }

      const spinner = ora({
        text: chalk.dim("Parsing crew definition..."),
        spinner: "dots",
      }).start();

      // Simulate brief parse
      setTimeout(() => {
        spinner.succeed(chalk.green("Crew definition parsed"));

        stub("run", {
          file: resolved,
          task: opts.task ?? "(would prompt interactively)",
          mock: opts.mock,
          budget: opts.budget ? `$${opts.budget}` : "(from YAML defaults)",
          verbose: opts.verbose,
          json: opts.json,
          action: "Would execute flow DAG step-by-step with real LLM calls",
        });

        // TODO:
        // 1. Parse & validate YAML
        // 2. Resolve task (from --task, stdin, or interactive prompt)
        // 3. Build execution plan (DAG topological sort)
        // 4. For each step (respecting parallel groups):
        //    a. Resolve context (depth + sources)
        //    b. Build agent prompt (system + context + task)
        //    c. Call LLM (or mock)
        //    d. Extract published facts from response
        //    e. Evaluate `when` conditions for next steps
        //    f. Handle retry loops
        // 5. Enforce budget.maxCost and budget.maxTokens
        // 6. Persist run state for --resume
        // 7. Output results (human-readable or --json)
      }, 300);
    }
  );

// ── doctor ───────────────────────────────────────────────

program
  .command("doctor")
  .description("Check environment, dependencies, and API connectivity")
  .option("--studio <url>", "Check connectivity to Studio instance")
  .action((opts: { studio?: string }) => {
    stub("doctor", {
      studio: opts.studio ?? "(no Studio URL provided)",
      checks: [
        "Node.js version",
        "YAML parser available",
        "API key configured",
        "Schema files present",
        opts.studio ? "Studio connectivity" : null,
      ]
        .filter(Boolean)
        .join(", "),
      action: "Would verify runtime environment and API connectivity",
    });
    // TODO:
    // 1. Check Node.js version >= 20
    // 2. Verify crew schema files exist
    // 3. Check ANTHROPIC_API_KEY (or configured provider key)
    // 4. Ping LLM API with a minimal request
    // 5. If --studio, check Studio WebSocket connectivity
    // 6. Report ✅ / ❌ for each check
  });

// ── show ─────────────────────────────────────────────────

program
  .command("show")
  .description("Inspect a completed or in-progress run")
  .argument("<runId>", 'Run ID or "last" for most recent')
  .option("--agent <name>", "Show only a specific agent's output")
  .option("--facts", "Show the fact store state", false)
  .option("--trace", "Show full LLM request/response trace", false)
  .action(
    (
      runId: string,
      opts: { agent?: string; facts: boolean; trace: boolean }
    ) => {
      const resolvedId = runId === "last" ? "(would resolve most recent run)" : runId;
      stub("show", {
        runId: resolvedId,
        agent: opts.agent,
        facts: opts.facts,
        trace: opts.trace,
        action: "Would load run state and display step results",
      });
      // TODO:
      // 1. Resolve run ID (or "last" → most recent)
      // 2. Load persisted run state from .crew/runs/<runId>/
      // 3. Display step execution timeline
      // 4. If --agent, filter to that agent's turns
      // 5. If --facts, print the fact store snapshot
      // 6. If --trace, print raw LLM request/response pairs
    }
  );

// ── agents ───────────────────────────────────────────────

program
  .command("agents")
  .description("List all agents defined in a crew file")
  .argument("<file>", "Path to crew YAML file")
  .action((file: string) => {
    const resolved = resolve(file);
    stub("agents", {
      file: resolved,
      action: "Would parse YAML and list each agent with its model, tools, and step",
    });
    // TODO:
    // 1. Parse YAML
    // 2. Walk flow steps, extract inline agent definitions
    // 3. For parallel steps, recurse into branches
    // 4. Print table: step name, model, tools[], system prompt (truncated)
  });

// ── Parse & run ──────────────────────────────────────────

program.parse();
