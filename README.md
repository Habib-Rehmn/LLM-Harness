# Forge

Forge is a plugin-first, model-agnostic coding agent runtime. The current repository is at Day 1
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
examples/contract-plugin/    compile-time Forge plugin example
examples/cordis-lifecycle/   executable Cordis lifecycle/scoping spike
schemas/                     versioned JSON Schemas
docs/adr/                    architecture decisions
```

The Day 1 Cordis spike verifies the specific framework behavior Forge intends to wrap: scoped
services, typed events, tracked effects, reverse-order cleanup, and automatic removal of plugin
registrations after disposal.

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

Day 1 establishes contracts and proves framework feasibility. It does not yet load manifests or
provide the production Forge context facade; those are Day 2–4 deliverables.
