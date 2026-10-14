# Repository Guidelines

## Project Overview

`omp-workbuddy-bridge` is an OMP-native extension that delegates research, office-document, and design tasks to an existing WorkBuddy desktop session. OMP orchestrates tasks and human approvals; WorkBuddy performs the real work. Results are the worker's reply and files actually produced on disk, not simulated deliverables.

## Architecture & Data Flow

- **Layering:** `src/index.ts` owns OMP registration and task orchestration. It uses `src/desktop-client.ts` for discovery/attachment and `src/tasks.ts` for filesystem state. The desktop client uses `src/acp-http.ts` for transport; shared contracts live in `src/types.ts`.
- **Binding:** `/wb bind` offers verified sessions for explicit selection. Discovery checks session metadata, logs, worker probes, and canonical project paths. Attachment must match the bound session UUID and ACP protocol version; it resumes/loads an existing session, never creates or silently selects one.
- **Task flow:** `wb_task` validates inputs, acquires the project lock, snapshots files, writes a brief/receipt, attaches, and starts an asynchronous prompt turn. It returns a `taskId` immediately. Stream updates supply reply/progress; `wb_status` reads state and artifact paths; `wb_cancel` cancels only tasks owned by this OMP process. Supplying a finished `taskId` to `wb_task` requests a supplementary turn.
- **Read-only surfaces:** `wb_tasks` lists the persisted index (`readTaskIndex`) with status filtering and paging, overlaying this process's live task state; `wb_doctor` reports the binding, the task lock and the bound worker's health. Both are strictly read-only and never attach: doctor inspects through three GET probes (`/api/v1/health`, `/api/v1/info`, `/api/v1/sessions/live`) and reports `protocolVerified: false` unconditionally. Endpoints it cannot identify are summarised in a single finding rather than one warning per socket, so unrelated WorkBuddy services cannot bury the real result. A bound worker whose auxiliary probes require a token legitimately reports `auth_required` — the credential lives only in the ACP connect path.
- **Delegation skill:** `skills/workbuddy-delegate/` ships the delegation workflow plus `references/live-smoke.md` (maintainer live acceptance). OMP discovers it only when the **package directory** is loaded, because `omp-plugins` scans `<root>/skills`; a file entrypoint has no sibling tree.
- **State ownership:** active sessions, abort controllers, approval decisions, and connection credentials stay in a process-local map. Durable state lives under `<project>/.wb-bridge/`: `binding.json`, `active.lock`, and `tasks/<taskId>/{brief.md,inputs/,outputs/,receipt.json}`. A dead owner is interrupted, not automatically adopted or replayed.

Preserve these architectural invariants:

- One active task per project; persist the terminal receipt **before** releasing its matching lock. First terminal state wins, including cancellation racing completion. Every terminal path commits through the single-flight `finalizeTask`, so a late success, second cancellation or shutdown joins the existing promise instead of writing again.
- A task's terminal commit reports `WB_STORAGE_ERROR` when the receipt write or the lock release fails. The worker's own outcome stays intact, the lock is never released on an unproven write, and the task is kept in the map (never shown as running) so the failure stays visible. A live owner's lock is never reaped; only a provably dead owner with a readable receipt is, and its orphan is marked interrupted first.
- `completed` requires `end_turn`, no worker error, and every declared `expectedOutputs` file. Preserve partial work on interruption; do not silently resend prompts.
- Permissions fail closed. Only an explicit human **Approve once** choice may grant a step; no standing grants, headless auto-approval, or permissive fallback for malformed requests. The dialog receives the task's abort signal, and a decision returned after the task stopped is refused. `awaitingApproval` is derived from the set of dialogs currently open *and* the task still being undecided, so a late-closing dialog cannot resurrect the waiting state on a decided or retained task.
- A cancellation keeps its connection open for a bounded window (`CANCEL_SETTLE_MS`) so the worker can report the cancelled turn's end before the socket closes. `session/cancel` is one-way, so closing immediately leaves the worker believing a turn is in flight and later prompts queue behind it forever. The wait is bounded (`settlesWithin`) so a silent worker cannot hold a cancellation open, and it waits on the task's `turnEnded` signal — never on `settled`, which would deadlock against the commit it is running inside.
- Contact only credential-free `http://127.0.0.1:<port>` endpoints and reject redirects. Close/cancel releases this connection, never terminates WorkBuddy or unrelated sessions.
- Inputs must be regular files whose canonical paths stay inside the project. Outputs and artifact scans stay inside the task's `outputs/`, including through symlinks. Validate task UUIDs before filesystem access.
- Never persist connection tokens, environment secrets, conversation history, or model reasoning. `agent_thought_chunk` updates are deliberately ignored.

## Key Directories

- `src/`: extension, task store, desktop discovery/session client, HTTP transport, and contracts; no separate frontend or server application.
- `test/`: offline behavioral tests grouped by filesystem, discovery, ACP transport, and approval/lifecycle seams.
- `skills/workbuddy-delegate/`: the packaged delegation skill (`SKILL.md`) and its `references/live-smoke.md` maintainer runbook; discovered only through the package directory.
- `smoke-workspace/input/`: manual live-integration input, including `sales.csv`; not a unit-test fixture directory.
- `.wb-bridge/` and `.workbuddy/`: generated bridge state/deliverables and WorkBuddy memory. Keep them out of source edits; never hand-edit receipts to manufacture success or delete live state during cleanup.
- There is no dedicated scripts directory; development scripts are in `package.json`.

## Development Commands

Run from the repository root:

```sh
bun install
bun test
bun run typecheck

# Focus on one seam while developing
bun test test/tasks.test.ts
bun test test/acp-http.test.ts test/desktop-client-acp.test.ts

# Load the extension in an OMP session for a target project
omp --cwd /path/to/project -e /path/to/omp-workbuddy-bridge/src/index.ts
```

`typecheck` runs `tsc --noEmit` over both `src/` and `test/`. There is no build, lint, format, dev, or start script: OMP loads TypeScript directly. For persistent loading, use the existing OMP configuration's `extensions` array rather than introducing a second launch mechanism.

## Code Conventions & Common Patterns

- Match existing TypeScript style: tabs, double quotes, semicolons, and trailing commas. Use camelCase functions/variables, PascalCase types/classes, and uppercase snake-case constants; multiword filenames are kebab-case.
- Use ESM, extensionless relative imports such as `./tasks`, and `import type` for erased imports. Strict typing and `noUncheckedIndexedAccess` require guarding absent array/map entries and parsing external values from `unknown`.
- Keep shared wire/state types and `WB_ERROR_CODE` in `src/types.ts`. Task/client layers use coded domain errors (`WbTaskError`, `WbError`); transport uses `AcpHttpError` with HTTP-status context. Translate failures at the host boundary into structured tool results with `details.error`/`isError`, rather than leaking raw exceptions.
- Prefer `async`/`await`, explicit `AbortSignal` propagation, and tracked stream lifetimes. Clear timers/listeners and close owned resources. Best-effort cleanup catches should not hide primary operation failures.
- **Transport sequencing matters:** the prompt POST's SSE response stays open throughout the turn and can carry permission requests. `AcpHttpTransport.#send` starts draining in the background; awaiting the entire response body would deadlock approvals. Do not replace this custom transport with the SDK's generic HTTP stream without proving protocol compatibility.
- Reuse existing injection seams: `activate(pi, BridgeOverrides)` for host orchestration; `DiscoveryOptions`/`ConnectOptions` for directories, probe deadlines, and endpoint lookup. Do not add global mutable configuration or a DI framework.
- Keep per-task state inside `activate()` and durability/locking inside `tasks.ts`. Use the existing atomic writes, canonical-path checks, and terminal-state helpers instead of parallel implementations. Document non-obvious protocol/lifecycle constraints where they are enforced.
- Tool parameter schemas use the host's `pi.zod`; follow that convention rather than creating a separate validation stack.

## Important Files

| File | Useful entry points / reason to consult |
| --- | --- |
| `src/index.ts` | Default `activate`, `BridgeOverrides`, tool registration (`wb_task`/`wb_status`/`wb_cancel`/`wb_tasks`/`wb_doctor`), single-flight `finalizeTask`, `toTaskView`, permission parsing/presentation, shutdown handling. |
| `src/desktop-client.ts` | `discover`, `connect`, `inspectWorkers` (GET-only), `listWorkerEndpoints`, `collectDiscoveredCandidates`, discovery options, resume/load negotiation, WorkBuddy interruption extensions. |
| `src/acp-http.ts` | `connectAcpHttp`, `AcpHttpTransport`, handshake headers, SSE framing, connection-only release. Read the protocol explanation at the top before transport changes. |
| `src/tasks.ts` | `prepareTask`, `readTaskIndex`, `readTaskLock`, `isPidAlive`, binding/receipt IO, lock ownership, `collectArtifacts`, `releaseTask`. |
| `src/types.ts` | `Binding`, `TaskReceipt`, `TaskLock`, `TaskView`, `StoredTaskSummary`, `WorkerInspection`, desktop interfaces, `WB_ERROR_CODE`. |
| `package.json`, `bun.lock`, `tsconfig.json` | OMP entry declaration, pinned dependencies, Bun lockfile, strict no-emit compiler configuration. |
| `README.md` | Supported installation, loading, user workflow, and safety guarantees. |
| `skills/workbuddy-delegate/SKILL.md` | Delegation workflow the agent follows; `references/live-smoke.md` holds the isolated live acceptance runbook. |
| `omp-workbuddy-bridge-plan.md` | Historical design and manual smoke procedure; some API/approval details are stale. Cross-check against source and current tests before relying on it. |

## Runtime/Tooling Preferences

- Use **Bun 1.4+** and the existing `bun.lock`; do not substitute Node/npm or generate a competing lockfile. The implementation uses Bun process APIs and tests use `bun:test`/`Bun.serve`.
- This is a private ESNext/ESM TypeScript extension, not a compiled distribution. The ACP SDK, Zod, OMP development dependency, Bun types, and TypeScript are pinned in `package.json`.
- Live execution requires WorkBuddy desktop exposing compatible ACP and a dedicated session authorized for the same canonical project folder. A desktop-held writer is reported as `WB_BUSY`; do not work around ownership checks.
- Discovery defaults to `~/.workbuddy/sessions` and `~/.workbuddy/logs`. Home resolution uses `USERPROFILE`, `HOME`, then `os.homedir()`. The socket-recovery fallback uses Windows `netstat`/`tasklist` and is skipped on other platforms; no `.env` configuration layer exists.

## Testing & QA

- Use Bun's built-in runner (`bun:test`), `describe`/`it`/`expect`, and behavioral names in `test/*.test.ts`. Run the affected suite during development, then `bun test` and `bun run typecheck` before delivery.
- Choose the existing seam: `test/tasks.test.ts` for real filesystem/locking behavior and the history index; `test/desktop-client.test.ts` for discovery and GET-only `inspectWorkers`; `test/desktop-client-acp.test.ts` for session lifecycle; `test/acp-http.test.ts` for HTTP/SSE details; `test/approval.test.ts` for host approvals, terminal commits, storage failures and the `wb_tasks`/`wb_doctor` tools through `BridgeOverrides`.
- Keep tests offline and isolated: use `mkdtemp` plus `realpath`, clean up in `afterEach`/`finally`, serve fixtures with `Bun.serve({ hostname: "127.0.0.1", port: 0 })`, and override discovery directories and `locateEndpoints`. Never probe a real worker, the user's home state, or fixed ports from unit tests.
- Two capability guards exist because Windows often blocks plain symlinks: `symlinkTest` for file symlinks and `directoryLinkTest` for directory links (junctions, which Windows usually allows). Use `directoryLinkTest` when a test only needs to redirect a directory.
- For a dead-owner case, spawn a short process (`Bun.spawn([process.execPath, "-e", "process.exit(0)"])`) and await `exited` rather than guessing a free PID. Liveness treats any non-`ESRCH` failure as alive, so EPERM-style uncertainty is deliberately unreachable by a fabricated PID.
- Assert observable outcomes: error codes, receipt transitions, contained artifacts, cancellation races, and permission decisions. Guard symlink tests when the host lacks permission; explicitly release/fail held prompt turns in the approval harness.
- No coverage threshold or coverage script is configured. Optional inspection: `bun test --coverage`; prioritize the safety boundaries above over an invented percentage target.
- For live integration changes, separately load OMP and WorkBuddy against a disposable project, explicitly `/wb bind`, delegate a task with declared outputs, inspect `wb_status` and the actual files, and exercise denial/cancellation when affected. This requires the desktop prerequisite and human approvals; offline tests do not prove native execution. Do not repurpose existing runtime receipts as test fixtures.
