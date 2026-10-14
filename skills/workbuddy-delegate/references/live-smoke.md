# Live WorkBuddy acceptance smoke

This is the maintainer's end-to-end acceptance procedure. It exercises the real
bridge against a real WorkBuddy desktop session and a disposable project, and it
is the only procedure here that proves native execution.

Do not run it for ordinary tasks, and never point it at a repository with real
work in it.

## Prerequisites

- WorkBuddy desktop installed, with the ability to open a folder as a workspace.
- A human at the keyboard for the whole run. Every approval is a human decision.
- OMP loaded with this extension package, using a **package-directory** entry so
  the packaged skill is discoverable:

  ```sh
  omp --cwd <smoke-project> --no-extensions -e <repository-root>
  ```

  `-e <repository-root>/src/index.ts` also works for the five tools, but a file
  entrypoint has no sibling `skills/` directory to scan, so this skill will not
  be discovered in that mode. That difference is expected, not a defect.

## 1. Create an isolated project

In a system temporary directory, create a fresh `wb-live-smoke-*` project with
this exact input. Do not reuse `smoke-workspace/`, and do not run inside this
repository.

`input/sales.csv`:

```csv
month,product,revenue
2026-01,A,100
2026-01,B,200
2026-02,A,150
```

Then:

1. Open that directory in WorkBuddy desktop.
2. Have the human create (or open) the dedicated session reserved for OMP
   delegation, and confirm only its working directory — no file modifications.
3. Start OMP against the same directory and run `/wb bind`, choosing that
   cwd/session. The bridge never selects a session on its own.

## 2. Delegate the data task

Delegate through the `workbuddy-delegate` skill:

```text
wb_task({
  prompt: "Summarize the attached sales data in Markdown with a by-month table and a by-product table. Month totals must be January 300 and February 150; product totals must be A 250 and B 200. Do not modify the input file.",
  inputFiles: ["input/sales.csv"],
  expectedOutputs: ["sales-summary.md"]
})
```

Then poll `wb_status` with `waitMs: 20000` until the task is terminal, and record
the real taskId and status.

Check, by reading the actual file:

- the by-month totals are January 300 and February 150;
- the by-product totals are A 250 and B 200;
- `input/sales.csv` is unchanged.

Also confirm the receipt reached a terminal state, the lock was released, and the
artifact path is inside the task's `outputs/`. A filename alone proves nothing.

## 3. Permission probe (may not trigger)

In the dedicated session, ask for a step that requires a provider approval:

```text
Run the shell command: echo hello > permission-probe.txt
(write permission-probe.txt into your outputs directory using a shell command).
Do not modify anything outside the outputs directory.
```

When the approval appears, the human must choose **Deny**. Then confirm:

- the refused step did not execute;
- no `permission-probe.txt` was produced by that step;
- no standing grant was created and no path around the denial exists.

If the provider does not raise an approval for this step, record that the
scenario did not trigger. Do **not** claim it passed, and do not change host
security settings to force a dialog. The offline permission tests (one-time
grant only, refusal on dismissal, refusal after cancellation, no standing grant)
remain the evidence for that behavior.

### Known reason it may not trigger: `bypassPermissions`

WorkBuddy sessions are frequently started with
`--permission-mode bypassPermissions` (visible in the session's startup log under
`~/.workbuddy/logs/<date>/`). In that mode the worker never emits an
`interruption_request` for a shell command at all, so the bridge is never asked
to decide and no dialog appears — the step simply runs. That is the desktop's own
configuration, not a bridge defect: the bridge can only answer requests the
worker raises.

A real run on 2026-10-14 confirmed exactly this: the probe completed, the file
appeared inside the task's `outputs/`, and the session log showed
`permission-mode=bypassPermissions`. Recorded as **not triggered**, with the
offline deny/abort/standing-grant tests as the evidence for fail-closed
behavior.

To exercise the live dialog, the session must be started in a mode that asks —
for example `--permission-mode default` — and that is a deliberate change to the
desktop session's launch configuration, which this runbook does not make for you.

## 4. Cancellation of a long task

In the same dedicated session:

```text
Write the single word READY into partial.txt in your outputs directory, then run
a shell command that waits 60 seconds. Do not modify anything else.
```

The human approves whatever the step requires. While it runs:

1. Confirm `wb_status` reports `running` and that `partial.txt` exists.
2. Call `wb_cancel` for that task.

Then confirm:

- the final status is `cancelled`;
- `partial.txt` was kept with its content;
- the lock was released;
- the WorkBuddy app and the bound session are both still alive;
- a late `end_turn` did not turn the result into `completed`.

## 5. Restart and query history

Restart OMP normally, against the same temporary project with the same package
load:

1. `wb_tasks` finds both the completed and the cancelled task.
2. `wb_status` on each shows `ownedByCurrentProcess: false` — the historical view.
3. The artifacts are still readable at their reported paths.

Never hand-edit a receipt to manufacture a result, and never stop another worker
to make a state convenient.

## What this proves, and what it does not

A passing run proves the live path works: discovery, binding, delegation,
approval routing, cancellation, artifact containment and history recall, against
a real desktop agent.

It does not prove the ACP handshake is compatible in every WorkBuddy version, and
`wb_doctor` never claims it does — compatibility is proven only when a real
delegation connects. Record any scenario that did not trigger (for example a
provider that raises no approval) as untriggered rather than passed, and keep the
offline regression results as the evidence for those paths.

## Observed results, 2026-10-14

One real run against a live WorkBuddy desktop (session `<redacted-session-id>`,
WorkBuddy 5.8.2) on a disposable project:

| Step | Outcome |
| --- | --- |
| 1. Isolated project + human `/wb bind` | Binding written for the smoke cwd; no other project touched. |
| 2. Sales delegation | `completed`. `sales-summary.md` contained by-month 300/150 and by-Product A 250 / B 200; `input/sales.csv` byte-identical afterwards. |
| 3. Permission probe | **Not triggered.** The session runs `--permission-mode bypassPermissions`, so the worker raised no approval and the shell step simply ran — its file still landed inside the task's own `outputs/`. Recorded as untriggered; the offline deny/abort/standing-grant suite remains the fail-closed evidence. |
| 4. Cancellation | `cancelled` while the 60s wait was still running (`partial.txt` written at 19:21:19, terminal receipt committed at 19:22:05). `partial.txt` was kept with its content, the lock was released, and the desktop app stayed alive. The cancelled state was not overwritten afterwards. |
| 5. Restart and history | Recall was exercised against these live receipts through the real tool code in a fresh process (not through an OMP UI restart): `wb_tasks` returned all four tasks newest-first with no warnings, and `wb_status` reported the cancelled task with `ownedByCurrentProcess: false` plus its real artifact path. |

### Finding: the cancelled turn never reported its end

The same run exposed a real defect, visible after the fact in the worker's own
conversation log. Turns that ended on their own recorded a `session_end` event;
the cancelled turn recorded none, and the log then stayed silent. The worker
therefore still believed a turn was in flight, and a prompt sent later was
accepted into its queue but never dequeued — the desktop showed "thinking"
indefinitely.

Cause: `session/cancel` is a one-way notification, and the client closed its
connection immediately afterwards. The worker had no chance to wind the turn
down, so no terminal event was ever emitted.

Fix: a cancellation now holds its connection open for a bounded window
(`CANCEL_SETTLE_MS`, 5s) so the worker can report the turn's end, then releases
it regardless — a wedged worker cannot hold a cancellation open. Covered by two
regression tests (worker reports the end → close after it; worker stays silent →
close on the bound).

Scope: this prevents the client from *causing* the wedge. It cannot un-wedge a
session that is already in that state — for those, stop the turn or reopen the
session in the WorkBuddy desktop.

Containment held throughout: every produced file stayed inside its task's
`outputs/` directory, and no stray file appeared elsewhere in the project.
