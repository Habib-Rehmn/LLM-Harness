# Context and service semantics

Forge exposes `ForgeContext` as its public lifecycle and dependency-injection boundary. Cordis is
the underlying host, but plugins depend only on contracts from `@forge/kernel-contracts`.

## Scopes

- `createForgeContext()` creates the root scope.
- `scope({ name, parentPlugin })` creates a child whose lifetime is owned by its parent.
- A child inherits services through its ancestry. Siblings cannot see one another's services.
- Disposing a parent disposes descendants first, newest child first. Registrations within each
  scope are then disposed in reverse registration order.
- Disposal is idempotent. Every other operation on a disposed context fails with
  `CONTEXT_DISPOSED`.

## Service tokens

Tokens carry a stable service identifier and one of two cardinalities:

```ts
const logger = serviceToken<Logger>('forge.logger');
const tools = serviceToken<Tool>('forge.tools', 'multiple');
```

An identifier has one cardinality throughout a context tree. Reusing the identifier with a
different cardinality fails with `SERVICE_CONFLICT`.

### Exclusive services

- At most one active provider may exist in a scope.
- A child provider shadows the nearest inherited provider.
- Removing the child provider reveals the inherited provider again.
- `get()` throws `MISSING_SERVICE` when unresolved; `optional()` returns `undefined`.

### Multi-provider services

- A scope may register any number of providers.
- Resolution returns an immutable snapshot ordered from root to leaf and then by registration
  order within each scope.
- `get()` throws `MISSING_SERVICE` when no providers exist; `optional()` returns an empty array.

`provide()` returns an idempotent disposable that removes only that provider. Scope disposal also
owns and removes every provider registered in that scope.

## Diagnostics

`inspectServices()` returns the active scope and provider graph with stable scope and registration
IDs. It intentionally omits service values so credentials or other plugin state cannot leak into
diagnostic output. The inspection describes the complete context tree and is available from any
live scope.
