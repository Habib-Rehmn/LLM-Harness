# Forge

Forge is a plugin-first, model-agnostic coding agent runtime. The current repository is at Day 8
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
packages/llm/core/            canonical model protocol, registry, capabilities, and fake provider
packages/providers/openai-compatible/ OpenAI-compatible streaming provider plugin
packages/providers/ollama/    Ollama discovery and streaming provider plugin
packages/providers/custom-http/ configurable JSON, NDJSON, and SSE provider plugin
packages/session/core/        durable session protocol, replay, projection, and stores
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
| `corepack pnpm forge models list` | Discover models and print capability profiles |
| `corepack pnpm forge models test ollama/<model>` | Run a bounded provider conformance probe |

## Status

Days 1–8 establish the microkernel, configuration, durable sessions, canonical LLM service, and
initial provider plugins. OpenAI-compatible, Ollama, custom HTTP, and deterministic fake providers
share one streamed event contract with explicit capability degradation, cancellation, timeout,
usage, Unicode, and tool-call handling. The CLI can discover and test configured models.
