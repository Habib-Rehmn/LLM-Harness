# ADR-0001: TypeScript and Cordis foundation

- Status: accepted for v0.1
- Date: 2026-08-26

## Context

Forge needs a plugin-first host with typed services, scoped contexts, events, dependency-aware
plugins, reversible effects, and reliable disposal. The 20-day v0.1 schedule does not allow those
mechanics to be designed and hardened entirely from scratch.

DeepSeek Harness demonstrates the target composition style on Cordis. Cordis 4.0.1 exposes the
required primitives and supports Node.js as the host runtime.

## Decision

Use TypeScript on Node.js 22.19+ and pin `@deepseek-ai/cordis` 4.0.1 for v0.1. Cordis remains behind
Forge-owned contracts and adapters:

- external plugins depend on Forge packages, not Cordis;
- the Forge host controls manifest validation and dependency policy;
- managed security denies remain outside replaceable plugin decisions;
- persisted Forge events use Forge schemas rather than Cordis internals;
- a future Cordis upgrade or replacement must preserve Forge's versioned public contracts.

The initial toolchain uses pnpm, TypeScript project references, Vitest, and Biome.

## Evidence

`examples/cordis-lifecycle` verifies:

- a plugin can register and expose a service;
- typed events are delivered while the plugin is active;
- lifecycle effects are visible for diagnostics;
- effect disposers run in reverse registration order;
- service and event registrations disappear after disposal.

## Consequences

Forge can reach a plugin-first vertical slice faster and inherit proven lifecycle mechanics. The
cost is a framework dependency and an adapter layer that Forge must maintain. Direct Cordis types
must not leak into third-party Forge plugin APIs.

Changing the host language, exposing Cordis as the public API, or replacing Cordis requires a new
ADR and a revised implementation schedule.
