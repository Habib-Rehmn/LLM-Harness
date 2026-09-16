# Repository context

Day 11 adds `@forge/repository-context`, a read-only repository intelligence plugin designed to
feed relevant code into an agent without exposing the entire workspace.

## Safety boundary

Each configured root is canonicalized and assigned a stable ID. Traversal skips symlinks and
applies Forge defaults, root `.gitignore`, profile ignores, and secret-name exclusions. Binary
extensions, NUL-detected content, and oversized files are excluded before indexing. Reads accept
only normalized root-relative paths and only return files that passed the index policy.

The plugin publishes four safe official tools through the shared guarded pipeline:

- `repository.list`
- `repository.glob`
- `repository.search_text`
- `repository.read_file`

All output and reads are bounded, and cancellation propagates from the tool pipeline into
filesystem traversal.

## Index and prompt context

The index stores content hashes, language hints, simple cross-language symbols, and imports. It
reuses entries while file size and modification time are unchanged, refreshes modified files, and
supports explicit full or path-scoped invalidation.

Repository maps rank paths and symbols against the current query, use deterministic tie-breaking,
and stop at a caller-provided token budget. `ContextAssembler` combines repository maps with other
scoped context providers by priority, charges headings and separators to the same budget, and
truncates the last included section when necessary.

Fixture tests prove that relevant source files and symbols fit within budget while ignored files,
secrets, binaries, oversized content, external symlinks, and path escapes never enter context.
