# Forge

Forge is a plugin-first, model-agnostic coding agent runtime. The current repository is at Day 3
of the implementation plan in [project.md](./project.md).

## Prerequisites

- Node.js 22.19 or newer
- Corepack

The repository pins pnpm in `package.json`; use it through Corepack:

```sh
corepack pnpm install
corepack pnpm check
```

## Workspace

```text
packages/kernel/contracts/   versioned public kernel contracts
packages/kernel/context/     typed scoped service registry backed by Cordis
examples/contract-plugin/    compile-time Forge plugin example
examples/cordis-lifecycle/   executable Cordis lifecycle/scoping spike
examples/interception-chain/ scoped event/waterfall lifecycle example
schemas/                     versioned JSON Schemas
docs/adr/                    architecture decisions
```

The Forge context package wraps Cordis with typed root/child scopes, exclusive and multi-provider
services, typed events and waterfalls, monotonic decisions, tracked effects, cascading disposal,
and value-redacted diagnostic graphs. The original Cordis spike remains as a focused framework
compatibility test.

## Commands

| Command | Purpose |
| --- | --- |
| `corepack pnpm build` | Compile all TypeScript project references |
| `corepack pnpm typecheck` | Type-check the workspace |
| `corepack pnpm test` | Run the deterministic test suite |
| `corepack pnpm lint` | Run Biome lint rules |
| `corepack pnpm format:check` | Check formatting |
| `corepack pnpm check` | Run the complete local/CI gate |

## Status

Days 1–3 establish the contracts, framework foundation, scoped service registry, and typed live
event facade. Runtime manifest validation and plugin dependency loading begin on Day 4.
