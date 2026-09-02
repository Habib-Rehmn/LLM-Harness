# Day 4 completion record

Date: 2026-09-02

## Deliverables

- `@forge/kernel-plugin-loader` package with discovery, validation, planning, activation, disable,
  unload, and full disposal operations.
- Ajv Draft 2020-12 runtime validation against the canonical `forge-plugin.json` schema.
- Strict semantic-version validation and required/optional service range resolution.
- Deterministic dependency ordering, cycle detection, missing requirement detection, and exclusive
  provider conflict checks.
- Package/folder identity checks plus lexical and realpath entrypoint containment.
- Runtime manifest equality and declared-versus-actual service verification.
- Mounted plugin contexts that combine root-visible services with scoped lifecycle ownership.
- Atomic activation rollback, reverse unload, dependent cascade, and disposal error aggregation.
- Fail-closed handling for process-runtime plugins pending the isolated host.
- Deterministic fixtures covering valid loading, malformed manifests, incompatible APIs/ranges,
  cycles, duplicate providers, missing dependencies, entrypoint escape, and partial setup failure.

## Day 4 gate

Valid fixture plugins activate in deterministic provider-before-consumer order and consume services
across plugin scopes. Malformed, cyclic, incompatible, conflicting, and escaping fixtures fail
before entrypoint execution. Failed setup unwinds all effects and services, and provider unload
cascades through consumers without leaked registrations.

## Deferred intentionally

- Ordered bundles, profiles, layered configuration, and diagnostics CLI: Day 5.
- Out-of-process plugin execution: Day 19.
- Marketplace discovery, remote installation, and trust UX: post-v0.1.
