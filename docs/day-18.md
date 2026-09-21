# Day 18 — MCP, hooks, and skills

Completed on 2026-09-21.

## Delivered

- `@forge/extensions-core` with a minimum newline-delimited JSON-RPC MCP client over `stdio`.
- Initialization, modern `tools/list` discovery, method-not-found fallback to legacy `listTools`,
  and corresponding modern/legacy calls.
- Stable server-namespaced MCP tool identities with unforgeable local `mcp` origin, capabilities,
  conservative risk defaults, and annotation mapping.
- Registration in the standard `ToolRegistry`, ensuring schema validation, policy decisions,
  cancellation, timeout, result validation, output limits, and origin reporting remain in force.
- Lifecycle hook registries and contribution plugins with typed decisions, patches, abort signals,
  bounded execution, fail-closed timeout behavior, and scoped unload.
- Skill registries and contribution plugins that search metadata without loading full bodies and
  fetch bounded instructions only when explicitly requested. File-backed skills are realpath
  checked against their declared root.

## Gate evidence

A local fixture server verifies modern discovery and legacy fallback. Its destructive MCP tool is
first denied by policy and the later allowed response proves the denied call never reached the
server. The allowed response is bounded by the normal tool pipeline. Hook and skill fixture plugins
load into inherited services, then disappear when their plugin scopes are disposed; repeated skill
loads prove instruction bodies are not retained by the registry.
