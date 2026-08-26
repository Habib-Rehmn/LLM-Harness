# Day 1 completion record

Date: 2026-08-26

## Deliverables

- TypeScript/Node/pnpm workspace with pinned tools and dependencies.
- Versioned IDs, errors, cancellation, service-token, plugin, manifest, permission, context, and
  disposal contracts in `@forge/kernel-contracts`.
- Strict draft-2020-12 JSON Schema for `forge-plugin.json`.
- Contract-only example plugin with a matching manifest.
- Executable Cordis lifecycle spike and deterministic tests.
- TypeScript project-reference build, Vitest, Biome, and CI gate.
- ADR-0001 documenting the stack, boundary, evidence, and consequences.

## Day 1 gate

The day is complete when a clean install can run `corepack pnpm check` and
`corepack pnpm build`, and the contract-only example compiles.

## Deferred intentionally

- Forge context implementation: Day 2.
- Forge event/waterfall facade: Day 3.
- Runtime manifest validation and dependency resolution: Day 4.
