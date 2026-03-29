# modular-crew

> Declarative agent teams with DAG execution and context routing.
> **Define what each agent *knows*, not just what it *does*.**

```
crew run team.yaml --task "Build two-factor authentication"
```

## Why modular-crew?

Every multi-agent framework gives all agents the same context. That's wasteful and hurts quality.

modular-crew gives each agent **only the context it needs** — the architect gets headlines, the developer gets full source code, the reviewer gets summaries. Same team, **3-5x fewer tokens, better output**.

| | CrewAI | LangGraph | modular-crew |
|--|--------|-----------|-------------|
| Define agents | YAML | Code only | **YAML** |
| Define flow | Code (Crew+Flow) | Code (StateGraph) | **YAML DAG** |
| Context per agent | Same for all | Same for all | **Depth-routed** |
| Token efficiency | Flat | Flat | **3-5x savings** |
| Cost visibility | None | None | **Built-in** |
| Execution engine | Custom | Pregel | **Inngest** (durable) |

## Quick Start

```bash
npm install -g modular-crew

# Create a new team
crew init my-crew
cd my-crew

# Preview the execution plan (no tokens spent)
crew plan --task "Build a login page"

# Try it with mock responses (no API keys needed)
crew run --task "Build a login page" --mock

# Run for real
crew run --task "Build a login page"
```

## team.yaml

```yaml
$schema: https://modular-crew.dev/schema/team.v1.json
version: 1
name: dev-crew
description: Full-stack feature delivery team

defaults:
  model: claude-sonnet-4-20250514
  maxTurns: 15
  tokenBudget: 50000

budget:
  maxCost: 2.00

flow:
  design:
    agent:
      system: |
        You are a senior software architect. Analyze the task and produce:
        1. A technical design with component boundaries
        2. API contracts (endpoints, DTOs, error codes)
        3. A task breakdown for implementation
    context:
      depth: full
      sources: [spec]
    publishes: [api_contract, task_graph]

  implement:
    after: design
    parallel:
      backend:
        agent:
          system: "You implement backend services. Follow the API contracts exactly."
          model: claude-sonnet-4-20250514
        requires: [api_contract, task_graph]
        context: { depth: detail }
        publishes: [backend_status, test_results]
      frontend:
        agent:
          system: "You implement frontend components consuming the backend API."
          model: claude-sonnet-4-20250514
        requires: [api_contract, task_graph]
        context: { depth: detail }
        publishes: [frontend_status]

  review:
    agent:
      system: "You review code for contract compliance, error handling, and test coverage."
      model: claude-haiku-4-20250514
    after: implement
    requires: [backend_status, frontend_status, api_contract]
    context: { depth: summary }
    publishes: [review_verdict, review_feedback]

  revise:
    after: review
    when:
      fact: review_verdict
      not: approved
    parallel:
      backend:
        agent:
          system: "Fix the issues identified in the review."
        requires: [review_feedback]
        publishes: [backend_status]
      frontend:
        agent:
          system: "Fix the issues identified in the review."
        requires: [review_feedback]
        publishes: [frontend_status]
    retry:
      step: review
      maxAttempts: 2
      onMaxAttempts: fail
```

## How It Works

```
crew run team.yaml --task "Add two-factor auth"
     │
     ▼
┌─ Parse & Validate ─────────────────────────┐
│  YAML → Zod validation → DAG check         │
│  Fact dependency graph → cycle detection    │
└────────────┬───────────────────────────────┘
             │
┌────────────▼───────────────────────────────┐
│  design (architect)                         │
│  context: FULL depth → headlines + code     │
│  → publishes: api_contract, task_graph      │
└────────────┬───────────────────────────────┘
             │
     ┌───────┴───────┐
     │               │
┌────▼────┐   ┌──────▼──────┐
│ backend │   │  frontend   │  (parallel)
│ DETAIL  │   │  DETAIL     │  depth-packed per role
└────┬────┘   └──────┬──────┘
     └───────┬───────┘
             │
┌────────────▼───────────────────────────────┐
│  review (reviewer)                          │
│  context: SUMMARY depth → signatures only   │
│  model: haiku (fast + cheap)                │
│  → verdict: approved | changes_requested    │
└────────────┬───────────────────────────────┘
             │ if verdict ≠ approved → loop
             ▼
          ✅ DONE
```

## Key Concepts

### Context Routing (the differentiator)

Each agent receives context at a different **depth level**:

| Depth | Tokens | Content |
|-------|--------|---------|
| `full` | 100% | Complete source code |
| `detail` | 75% | Signatures + docstrings |
| `summary` | 50% | Signatures only |
| `headlines` | 25% | Section/export names |
| `mention` | 10% | Just file paths |

The architect gets `full` context to understand the big picture. The reviewer gets `summary` — enough to check contracts without drowning in implementation details. **Same token budget, 3-5x more relevant information per agent.**

### Fact Bus

Agents communicate through typed facts with `requires`/`publishes` contracts:

```yaml
publishes: [api_contract, task_graph]  # this agent produces these
requires: [api_contract]                # this agent needs these before starting
```

Facts flow automatically through the DAG. No agent runs until its required facts are available.

### Inngest-Powered Execution

modular-crew compiles your YAML into [Inngest](https://www.inngest.com/) functions, giving you:
- **Durable execution** — survives crashes, resumes from failure
- **Built-in retry** — transient errors auto-retry with backoff
- **Human-in-the-loop** — `approval: true` pauses for human review
- **Observability** — full execution trace in Inngest dashboard

## CLI Reference

| Command | Description |
|---------|-------------|
| `crew init [name]` | Scaffold a new team from a template |
| `crew validate [file]` | Check YAML syntax + DAG structure (offline, <100ms) |
| `crew plan [file] --task "..."` | Preview execution plan + cost estimate |
| `crew run [file] --task "..."` | Execute the team |
| `crew run --mock` | Run with simulated responses (no API keys) |
| `crew run --budget 2.00` | Hard cost limit in USD |
| `crew doctor` | Check Studio + provider connectivity |
| `crew show [run-id]` | Inspect past run output + facts + trace |
| `crew agents` | List available agents in Studio |

## Architecture

```
modular-crew/
├── src/
│   ├── context/        # @modular/context-engine (extractable)
│   │   ├── router.ts   # Depth-packed context assembly
│   │   └── index.ts    # Public exports
│   ├── compiler/       # YAML → Inngest
│   │   ├── team-parser.ts      # Parse + validate
│   │   └── inngest-compiler.ts # Compile to Inngest functions
│   ├── facts/
│   │   └── fact-bus.ts # Typed fact store with pub/sub
│   ├── store/
│   │   └── run-store.ts # SQLite persistence
│   └── studio/
│       ├── patchbay.ts  # HTTP client for modular-patchbay
│       └── mock.ts      # Mock provider for testing
├── bin/crew.ts          # CLI
└── templates/           # Starter team.yaml files
```

The **context engine** (`src/context/`) is designed to be extractable as `@modular/context-engine` — use it standalone with any framework (CrewAI, LangGraph, etc.).

## Requirements

- Node.js 18+
- [Inngest Dev Server](https://www.inngest.com/docs/local-development) (for local runs)
- [modular-patchbay](https://github.com/VictorGjn/modular-patchbay) (optional — for context routing from Studio)

## License

MIT
