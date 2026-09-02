# Plugin manifest and loader semantics

`@forge/kernel-plugin-loader` discovers, validates, orders, activates, disables, and unloads Forge
plugins. Discovery and dependency planning never import plugin code.

## Discovery and validation

`discoverPlugins()` accepts explicit plugin directories, manifest paths, workspace/package roots,
and scoped-package roots. Candidate ordering is deterministic.

Before an entrypoint can execute, the loader verifies:

- Draft 2020-12 `forge-plugin.json` structure with Ajv;
- exact Forge API compatibility;
- strict plugin and service identifiers;
- valid plugin versions and service dependency ranges using semantic versioning;
- no unresolved `${...}` or `{{...}}` placeholders;
- folder and optional `package.json` name agreement with the manifest;
- an existing entrypoint contained within the plugin directory, including after symlink resolution;
- no unknown v1 properties outside the namespaced `extensions` object.

At activation time, the module's exported manifest must match `forge-plugin.json`. The services a
plugin actually registers must exactly match its `provides` declaration. These checks prevent a
package from passing static discovery and then presenting a different runtime identity or hidden
capabilities.

## Dependency graph

Each `provides` service has the provider plugin's version. A `requires` range must have a compatible
provider; an absent `optional` service adds no edge. Externally bootstrapped services and their
versions can be supplied through `externalServices`.

Services are exclusive unless their identifier is listed in `multiProviderServices`. Duplicate
exclusive providers fail during planning, before code execution. Compatible providers create
provider-to-consumer edges. Kahn topological sorting chooses ready plugins lexicographically, giving
the same activation order for the same manifests regardless of discovery order. Cycles, missing
requirements, and incompatible ranges fail before importing entrypoints.

## Activation and lifecycle

The public lifecycle operations are:

```text
discover -> resolve -> activate
load                         # discover + resolve + activate
disable / enable
unload / unloadAll / dispose
```

Every plugin receives a mounted context. Its declared services publish into the root service
namespace so sibling plugins can consume them, while providers, listeners, and effects remain
owned by that plugin context. Ordinary child scopes retain their Day 2 isolation behavior.

Activation is atomic for a plan. If import, manifest comparison, setup, or declaration verification
fails, Forge disposes the failing context and all plugins activated by that call in reverse order.
Cleanup continues after individual disposal failures and reports an aggregate.

Unloading a provider also unloads its active transitive consumers in reverse activation order.
Disabling performs the same safe cascade and prevents the plugin from entering later resolved
plans until re-enabled.

Only `trusted` plugins execute in-process. A `process` manifest can be discovered and planned but
activation fails before import until the isolated plugin host is implemented on Day 19.
