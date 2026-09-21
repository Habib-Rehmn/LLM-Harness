# Forge

Forge is a plugin-first, model-agnostic coding agent runtime. The current repository is at Day 18
of the private implementation plan.

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
packages/agent/core/          bounded agent loop, modes, inbox steering, retry, and cancellation
packages/editor/core/         conflict-checked transactional edits, diffs, and turn checkpoints
packages/tools/core/          schema-driven tool registry and guarded execution pipeline
packages/process/core/        bounded subprocess, PTY, background handle, shell, and Git tools
packages/policy/core/         immutable deny-first policies and scoped approval grants
packages/sandbox/linux/       fail-closed Bubblewrap isolation and external sandbox declarations
packages/interfaces/core/     shared streaming terminal and headless execution interfaces
packages/memory/core/         context lanes, artifacts, compaction, memory, and trace replay
packages/extensions/core/     MCP stdio, lifecycle hooks, and on-demand skill plugins
packages/providers/openai-compatible/ OpenAI-compatible streaming provider plugin
packages/providers/ollama/    Ollama discovery and streaming provider plugin
packages/providers/custom-http/ configurable JSON, NDJSON, and SSE provider plugin
packages/session/core/        durable session protocol, replay, projection, and stores
packages/repository/context/  safe repository inventory, search, reads, maps, and context assembly
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

Days 1–18 establish the microkernel, configuration, durable sessions, canonical LLM service,
provider plugins, bounded coding-agent loop, guarded tool runtime, repository context layer,
transactional editor, and process runtime.
The agent supports ask/plan/code/review modes, queued follow-ups, live steering, cancellation,
retries, and hard iteration/time/token/tool limits. Tools are discoverable, JSON-Schema validated,
policy guarded, normalized, and safely scheduled. Repository context excludes ignored, secret,
binary, oversized, and symlinked files while providing deterministic inventory, glob, search,
bounded reads, symbol maps, caching, and token-budgeted prompt sections.

Edits are UTF-8, canonical-path checked, symlink defended, hash-conflict checked, atomically
written, checkpointed by turn, and rollback-safe against later direct edits. Process tools separate
argv from explicit shell execution, filter environments, redact and bound output, support PTY and
background input handles, and terminate descendant process groups on timeout or cancellation.

The immutable security root evaluates tool, path, command, network, origin, risk, capability, mode,
and external-side-effect rules with deny-first precedence. Read-only and workspace profiles fail
closed, every decision identifies its exact matching rule, and approvals are restricted to their
declared session or workspace scope without the ability to override a deny.

Linux commands can run through a required Bubblewrap backend with workspace-only persistent
writes, protected metadata, network default-deny, resource ceilings, and inherited subprocess
isolation. Terminal and headless clients consume one streaming session protocol; `forge exec`
supports text, JSON, and JSONL output with stable non-interactive exit behavior.

Long sessions use priority-ordered context lanes, content-addressed artifacts, bounded output,
rate-limited structured compaction, auditable project memory, and side-effect-free trace replay.
MCP stdio tools are namespaced and enter the normal guarded tool pipeline, including schema
validation, policy, timeout, output limiting, and origin reporting. Lifecycle hooks have typed
decisions and fail-closed timeouts; skill metadata is searchable while full instructions are loaded
only on demand. Hook and skill contribution plugins unregister cleanly with their plugin scope.
