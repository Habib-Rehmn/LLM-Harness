# Editing and processes

Days 12 and 13 add the state-changing workspace capabilities used by the coding agent. Both are
plugins behind the shared guarded tool pipeline, so policy and approval layers can restrict them
without changing their implementations.

## Transactional editor

`@forge/editor-core` exposes structured `editor.apply_patch` and `editor.rollback` tools. Every
create, update, or delete supplies the hash observed during a repository read (`null` means the
file must not exist). A stale hash, missing replacement context, or ambiguous replacement fails as
a conflict instead of silently applying to different content.

Before a transaction writes anything, the editor:

- normalizes a root-relative path and rejects traversal or NUL bytes;
- walks path components and rejects symlinks and non-directories;
- accepts only regular UTF-8 text files; and
- verifies every expected hash, then checks again immediately before each write.

Writes use a uniquely created temporary file in the destination directory, flush it, preserve the
original permission mode, and rename it atomically. If a multi-file transaction fails, already
applied changes are restored from their before-images.

The first edit to each path in a turn records a checkpoint. File-change events carry create,
update, delete, or restore kind, before/after hashes, and a unified diff; the transaction also
returns an aggregate diff. Rollback first verifies that every path still has Forge's last hash. It
therefore restores direct edits made by Forge but refuses to overwrite later human or concurrent
changes.

## Process runtime

`@forge/process-core` supports foreground and background commands. Callers choose either an argv
array, which never invokes a shell, or an explicit shell string. Working directories must be
relative, canonical directories inside the workspace and may not traverse symlinks.

Only configured environment keys are inherited or accepted. Values associated with secret-like
keys and explicitly configured secrets are redacted before output is streamed or recorded.
Separate stdout/stderr collectors retain bounded head and tail context, enforce line limits, and
report original byte counts and truncation.

Background handles accept input, close stdin, wait, or terminate. PTY mode uses the supported
platform's util-linux `script` backend. Commands run in isolated process groups; timeout,
cancellation, and explicit kill signal the entire group and escalate after a short grace period so
descendants cannot survive unnoticed.

Official tools include `shell.run`, `shell.start`, `process.write`, `process.wait`, `process.kill`,
and narrowly defined read-only `git.status`, `git.diff`, and `git.log` operations.

The deterministic gates cover create/update/delete/conflict/symlink/encoding/rollback behavior and
interactive, PTY, background, noisy, redacted, timed-out, and descendant-process fixtures.
