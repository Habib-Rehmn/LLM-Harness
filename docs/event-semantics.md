# Event, waterfall, and decision semantics

Forge exposes typed live events through `ForgeContext`. Cordis supplies the internal dispatcher,
while `@forge/kernel-contracts` owns the public tokens, listener types, cancellation behavior, and
security invariants.

Live events are process-local extension points. They are not durable session events and are not
automatically persisted.

## Typed event tokens

One event identifier has one dispatch kind throughout a context tree:

```ts
const notice = broadcastEvent<Notice>('agent.notice');
const resolver = serialEvent<Request, Handler>('tools.resolve');
const execution = waterfallEvent<Request, Result>('tools.execute');
const policy = decisionEvent<Request>('tools.pre-execute');
```

Using the same identifier with a different kind fails with `EVENT_CONFLICT`.

Listeners are visible across the live root context tree so independently scoped plugins can hook
the same runtime events. Ownership remains scoped: disposing a plugin context removes all of its
listeners without affecting other plugins.

## Dispatch modes

### Broadcast

`broadcast()` starts listeners in registration order and awaits them concurrently. Every listener
runs even if another fails. One or more failures are reported as an `AggregateError` after all
listeners settle. Use broadcasts for observation, not mutation of an authoritative result.

### Serial

`serial()` awaits listeners in deterministic order and returns the first result other than
`undefined`. This means `false`, `null`, zero, and an empty string are valid answers. A listener
returning `undefined` delegates to the next listener.

### Waterfall

`waterfall()` composes listeners around a required terminal action. A listener calls `next()` to
delegate and may inspect or transform its result. Not calling `next()` replaces or vetoes the rest
of the chain. Calling `next()` more than once fails with `EVENT_NEXT_CALLED_MULTIPLE`.

### Monotonic decisions

`decide()` is a security-oriented waterfall with the ordered decisions:

```text
allow < ask < deny
```

`delegate` explicitly requests the next decision. `allow` and `ask` also delegate automatically
when the listener did not call `next()`, ensuring a permissive hook cannot skip a stricter hook.
When a listener wraps `next()`, Forge returns the stricter of its decision and the downstream
decision. `deny` is terminal and may short-circuit safely.

## Ordering, cancellation, and cleanup

Listeners use registration order by default. `{ prepend: true }` inserts a listener at the front
of its event chain. The order is exposed without payloads or callbacks through `inspectEvents()`.

Every dispatch accepts a `ForgeCancellation`. Forge checks cancellation before and after listener
and terminal execution, and passes the same token into each callback for cooperative cancellation
during long-running work.

Listener registration returns an idempotent disposable. Registrations and ordinary effects share
scope ownership and reverse-order cleanup. Cleanup continues after an individual disposer fails;
the context then reports `CONTEXT_DISPOSE_FAILED` with the aggregated failure count.
