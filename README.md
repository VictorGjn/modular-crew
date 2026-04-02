# modular-crew

> ⚠️ **This repo has moved to the [modular monorepo](https://github.com/VictorGjn/modular).**
>
> The crew CLI and runtime now live at `apps/crew/` in the unified monorepo.

## New location

**Repo**: [github.com/VictorGjn/modular](https://github.com/VictorGjn/modular)  
**Path**: `apps/crew/`

## Why?

Crew and Studio (modular-patchbay) share significant code — types, providers, worktree manager, context engine, agent harness. The monorepo eliminates duplication via shared packages:

| Package | What's shared |
|---------|---------------|
| `@modular/core` | Types, Zod schemas, DepthLevel, Fact, Agent types |
| `@modular/providers` | StudioProvider interface, MockProvider |
| `@modular/worktree` | Git worktree isolation (was literally forked) |
| `@modular/context` | SystemPromptBuilder, ReactiveCompaction, ContextCollapse |
| `@modular/harness` | FactBus, Mailbox, HookRunner, BudgetGuard, Presets |
| `@modular/ui` | Shared design tokens (crew UI coming) |

## Quick start (new repo)

```bash
git clone https://github.com/VictorGjn/modular.git
cd modular
bun install
bun run build
cd apps/crew && bun run dev
```

This repo is archived. All new development happens in the monorepo.
