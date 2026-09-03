# Bundles, profiles, and layered configuration

Forge configuration is composed deterministically from identified rows rather than by editing
distributed bundles. TOML parsing uses `smol-toml`; the resolver itself accepts typed objects so it
can also be embedded by another host.

## Composition order

The low-to-high precedence order is:

```text
host defaults
  -> profile bundles in declared order
  -> user
  -> project shared
  -> project local
  -> CLI
  -> managed restrictions
```

Managed configuration is always applied last. A project or command-line overlay therefore cannot
replace a managed value. Every surviving settings leaf and plugin-row field records a source kind
and source ID in the resolved `provenance` map.

## Bundles and profiles

A bundle has a stable ID, semantic version, settings, and an ordered list of plugin rows. A profile
contains an ordered list of bundle IDs. Later bundles may replace an earlier row with the same ID;
the row keeps its position unless an explicit `after` anchor moves it.

The initial `terminal` and `headless` templates compose named but currently empty official bundles.
Their plugin rows will be populated as the corresponding runtime plugins are implemented.

## Identified row patches

A plugin row has a stable `id` independent of its package name. Layer patches support:

- `merge` (default): recursively update an existing row, or insert it when `package` is supplied;
- `replace`: replace the complete row;
- `remove`: remove an existing row;
- `after`: insert or move the row after another identified row.

Unknown keys, duplicate row IDs, missing packages, invalid ordering anchors, missing profiles or
bundles, and invalid bundle versions fail with `INVALID_CONFIG`.

Example layer:

```toml
[settings.agent]
max_iterations = 12

[[plugins]]
id = "model"
operation = "merge"
package = "@forge/model-ollama"
provides = ["forge.llm"]

[plugins.config]
model = "qwen-coder"
api_key = { secretRef = "OLLAMA_API_KEY" }
```

Default file locations are:

```text
~/.config/forge/config.toml
<workspace>/.forge/config.toml
<workspace>/.forge/config.local.toml
```

Explicit files can be selected with `--user-config`, `--project-config`, `--local-config`, and
`--managed-config`. Repeated `--set path=value` arguments form the CLI settings overlay.

## Diagnostics and redaction

`forge --profile terminal --dump-config` emits the selected profile, ordered plugins, derived
service providers, ordering reasons, and provenance. `forge config doctor` returns the same
redacted configuration plus actionable diagnostics.

Keys resembling passwords, credentials, tokens, secrets, authorization values, or API keys are
replaced with `[REDACTED]`. Secret-reference names are redacted too. Literal sensitive values cause
a doctor warning encouraging a secret reference. The resolved in-memory configuration is not
mutated by producing the diagnostic view.
