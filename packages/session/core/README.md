# Session core

`@forge/session-core` is the canonical conversation protocol and persistence layer. Every
thread is an append-only stream of versioned events; thread, turn, step, and item records are
projections rebuilt from that stream.

The package provides interchangeable in-memory and JSONL stores. JSONL writes contain one
complete event per line and are synced by default. On replay, an incomplete final line is
treated as an interrupted append and truncated. Invalid complete lines, sequence gaps, illegal
state transitions, and cross-thread references are reported as corruption rather than skipped.

`projectModelHistory` deterministically derives provider-visible input from completed user,
assistant, tool-call, tool-result, and compaction items. UI-only plans, warnings, file changes,
command metadata, checkpoint restores, and reasoning summaries remain in the durable transcript
but are not sent to the model. A compaction replaces history only through its recorded sequence
boundary.

The schema version is `forge.session/v1`. Future changes must retain a reader for v1 and migrate
events into the current in-memory representation; existing logs are never rewritten in place.
Configuration snapshots should contain secret references (for example `env:MODEL_TOKEN`), never
resolved credentials.
