# Day 17 — Context compaction, memory, and telemetry

Completed on 2026-09-21.

## Delivered

- `@forge/memory-core` with deterministic priority-ordered context lanes and token budgets.
- Content-addressed artifact storage and UTF-8-safe output trimming that keeps full output retrievable.
- Structured conversation compaction with retained recent turns, decisions, latest test state, source
  sequences, resumable context, and per-hour anti-thrashing limits.
- Concise JSONL project-memory records with workspace provenance and explicit supersession history.
- JSONL traces for token use, tools, approvals, context, errors, and lifecycle events.
- Trace inspection plus deterministic replay records that are explicitly marked `executed: false`.

## Gate evidence

The focused suite builds a 30-entry session, compacts through the expected sequence, preserves its
decision and test state, resumes the six retained entries, and rejects a second compaction inside
the configured window. Separate tests cover artifact retrieval, memory conflict history, trace
inspection, and side-effect-free replay.
