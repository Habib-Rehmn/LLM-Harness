# Policy and approvals

Day 14 adds `@forge/policy-core`, the immutable authorization root used before any tool executes.
It is deliberately separate from the platform sandbox: policy explains what Forge intends to
permit, while the Day 15 sandbox will enforce operating-system boundaries if a tool is compromised.

## Rules and precedence

A policy is cloned and deeply frozen when its guard is constructed. Rules may match tool names,
agent modes, risk, origin, read-only status, capabilities, canonical workspace paths and access
type, argv executables, explicit shell patterns, HTTP(S) hosts, and external side effects.

Evaluation always follows the same security lattice:

1. Invalid paths, symlinks, traversal, absolute escapes, malformed URLs, credential-bearing URLs,
   and non-HTTP(S) URLs fail closed.
2. Any matching `deny` wins, regardless of registration order or matching allows/asks.
3. Every matching `ask` must have a valid scoped grant.
4. A matching `allow` permits the call only when no stricter result exists.
5. If nothing matches, the explicit policy default applies.

Every result includes the winning rule ID, its description, and match evidence. This survives in
the tool pipeline's authoritative result, making allow, approval, and denial decisions auditable.

## Approval broker

An ask decision creates an approval request with the rule, tool, session, and workspace identity.
Grants bind one rule and a tool pattern to either one session or one workspace and may expire. A
grant only resolves an ask; it is never consulted to override a deny. A grant from another session
or workspace has no effect.

## Managed profiles

`READ_ONLY_POLICY` denies every state-changing tool and external side effect, allowing only local
inspection. `WORKSPACE_POLICY` denies writes to `.git` and `.forge`, asks for explicit shell use,
external effects, and destructive tools, allows ordinary local workspace operations, and defaults
to deny.

The policy plugin publishes exclusive guard and approval-broker services. Since Forge registers
plugin services at the managed root and exclusive services reject duplicates, child scopes cannot
replace the security root. The guard also owns a frozen private policy copy, so later mutation of
the source policy cannot widen it.

Tests exercise the complete matching matrix, deny-first conflicts, session/workspace grants,
default approvals, source-mutation attempts, deny-override attempts, traversal, absolute paths,
symlink paths, malformed URLs, and protocol restrictions.
