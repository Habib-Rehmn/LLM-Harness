# Sandbox and interfaces

Days 15 and 16 add operating-system enforcement and two user-facing drivers for the same runtime
session.

## Linux sandbox

`@forge/sandbox-linux` implements the production Linux backend with Bubblewrap and `prlimit`.
Availability checks require Linux, executable Bubblewrap and `prlimit` installations, and a
successful user-namespace probe. Required mode fails closed when any prerequisite is unavailable;
there is no silent unsandboxed fallback.

The launch wrapper creates a new session and namespaces, mounts the host read-only, replaces home
and root directories with private temporary filesystems, binds only the selected workspace for
persistent writes, and rebinds `.git` and `.forge` read-only. `/tmp` is private and ephemeral.
Network is unshared unless explicitly enabled. Address-space, CPU-time, process-count, and
open-file ceilings apply to the command and all descendants. `--die-with-parent` and namespace
inheritance keep descendant processes inside the same boundary.

`ProcessManager` accepts the sandbox through a small launch-plan interface and can require one.
This keeps policy and enforcement separate: Day 14 decides whether an action is permitted, while
Day 15 constrains what the resulting process can actually reach.

External container or remote isolation is represented by an explicit declaration describing its
workspace mount and network contract. A declaration never masquerades as locally enforced
isolation.

## Shared interface session

`@forge/interfaces-core` defines one stream of message, plan, tool, output, diff, budget, approval,
status, and error events. Both interfaces consume the same `InterfaceSession`, including its
command and cancellation methods.

The terminal renderer supports `/mode`, `/status`, `/context`, `/diff`, `/permissions`, `/compact`,
`/fork`, `/cancel`, and `/exit`. Approval events may call an interactive approval callback and are
resolved through the normal permissions command.

`HeadlessExecutor` and `forge exec` support `text`, `json`, and `jsonl`. Headless approval behavior
is explicitly `error` or `deny`; it never requests input or waits indefinitely. Stable exit codes
are:

- `0`: success
- `1`: runtime failure
- `2`: invalid usage
- `3`: approval required
- `4`: runtime unavailable
- `130`: cancelled

Tests demonstrate both interfaces driving the shared session protocol and exercise every terminal
command. Sandbox fixtures verify launch restrictions, protected paths, host escape prevention,
resource limits, required-backend failure, and external declarations.
