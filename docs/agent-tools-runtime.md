# Agent and tool runtime

Days 9 and 10 add the execution core that turns Forge's provider, session, and plugin contracts
into a bounded coding-agent loop.

## Agent loop

`@forge/agent-core` implements the default prompt → model request → tool execution → observation →
next-step cycle. Every run persists through the session store and projects durable history back to
the canonical LLM protocol. `AgentRegistry` makes agent factories replaceable through scoped
plugins instead of coupling the CLI to one implementation.

The default factory supports:

- `ask`, `plan`, `code`, and `review` modes with mode-specific tool restrictions;
- serialized follow-ups, active-turn steering, and explicit cancellation;
- transient provider retries with abort-aware backoff;
- iteration, duration, input/output token, tool-call, tool-result, and retry budgets;
- repeated identical tool-call/result detection to stop unproductive loops; and
- native, constrained-JSON, and opt-in prompted tool protocols based on model capabilities.

The agent owns orchestration, while providers own model transport, sessions own durable history,
and the tool pipeline owns execution policy. This separation keeps alternative agents and custom
LLMs pluggable.

## Tool lifecycle

`@forge/tools-core` gives each tool a versioned definition containing JSON Schemas, capabilities,
risk, read-only/idempotent flags, timeout, output limits, origin, and discovery visibility. The
registry compiles schemas once and exposes only tools permitted by the active mode or restriction.
Lazy tools become visible through keyword discovery without placing every definition in every
model request.

Execution follows one authoritative pipeline:

1. Resolve the registered definition and validate arguments.
2. Run pre-execution hooks without allowing tool identity changes.
3. Ask the policy guard for allow, deny, or approval-required.
4. Apply wrappers and execute with cancellation and timeout signals.
5. Validate and normalize output, artifacts, timing, truncation, origin, and errors.
6. Run post-execution hooks and record the final result.

Adjacent read-only calls may execute concurrently. State-changing calls create ordering barriers
and execute serially, so parallelism cannot reorder mutations.

Tests cover completion, follow-ups, steering, cancellation, transient recovery, every agent mode,
limit termination, repeated-call protection, discovery, restrictions, success/failure alignment,
Unicode truncation, artifacts, timeouts, and batch ordering.
