# Forge

Forge is a plugin-first, model-agnostic coding agent runtime. The current repository is at Day 5
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
packages/kernel/config/      bundles, profiles, layered patches, provenance, and diagnostics
packages/kernel/plugin-loader/ manifest validation, dependency graph, and lifecycle host
apps/cli/                    Forge command-line entrypoint
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
| `corepack pnpm forge --profile terminal --dump-config` | Print redacted effective configuration |
| `corepack pnpm forge config doctor` | Validate configuration and print diagnostics |

## Status

Days 1–5 establish the contracts, framework foundation, scoped services/events, deterministic
plugin loading, and layered profile configuration with redacted diagnostics. Durable session
protocol and persistence are the Day 6 deliverable.
