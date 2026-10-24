# Live WorkBuddy acceptance smoke

This is the maintainer's end-to-end acceptance procedure. It exercises the real
bridge against a real WorkBuddy desktop session and a disposable project, and it
is the only procedure here that proves native execution.

**Running it needs its own explicit authorization.** The 2026-10-23 experiments
were stopped and the user revoked the remaining allowance, so this runbook does
not come with a budget: each live run needs a fresh decision, and the cancelled
allowance is not restored by anything written here.

Do not run it for ordinary tasks, and never point it at a repository with real
work in it.

The runbook has three parts, and they answer different questions:

- **Part 1 — history: the supply probe (2026-10-22).** A read-only inspection of
  what the installed build exposed for third-party native-session supply. It is
  kept as a record of what was checked and what it showed. It is not a step to
  run now, and continuing that probing is not part of the current scope.
- **Part 2 — the current verified path.** Delegation over the ACP endpoint the
  desktop opens while it serves the workspace, into sessions the user prepared
  in the desktop. This is what works today, and what the recorded results at
  the end of this file describe.
- **Part 3 — the user-prepared session path.** The acceptance for the scope as
  it now stands: the bridge attaches to what the user prepared, and it never
  creates, activates, wakes or clears a session on the user's behalf. Part 2
  passing is not Part 3 passing, and Part 1 is not evidence for either.

## Prerequisites

- WorkBuddy desktop installed, with the ability to open a folder as a workspace.
- A human at the keyboard for the whole run. Every approval is a human decision.
- Native conversations the human prepared in that desktop for the project, with
  the desktop actually serving them.
- OMP loaded with this extension package, using a **package-directory** entry so
  the packaged skill is discoverable:

  ```sh
  omp --cwd <smoke-project> --no-extensions -e <repository-root>
  ```

  `-e <repository-root>/src/index.ts` also works for the tools themselves, but a
  file entrypoint has no sibling `skills/` directory to scan, so this skill will
  not be discovered in that mode. That difference is expected, not a defect.

## Part 1 — History: the supply probe (2026-10-22)

**This part is a record, not a step to run.** On 2026-10-22 the user authorized
one read-only inspection of the installed desktop build to see whether a
third-party route to native-session supply existed. The result was recorded and
is kept here for traceability. Automatic supply and reliable wake were later
dropped from the current scope, so nothing here authorizes continuing that
probing.

The original question was whether the upgrade had a supported third-party
contract for native conversation creation and wake-up. The recorded answer was
**contract not confirmed**, and the bridge kept using the local ACP endpoint it
discovers.

For anyone reading this later, the criteria that were applied were:

A route is supported when WorkBuddy documents or licenses it for third-party
use, and it can be exercised without any of these:

- a private pipe, socket or IPC surface the vendor does not document;
- impersonating the desktop host or forging its identity;
- extracting tokens, tickets or other credentials from local storage;
- a reverse-engineered internal method the vendor has not exposed.

A CLI or cloud execution backend is a **different backend**, not a native desktop
conversation. It is not a substitute for the native path, and a run that falls
back to it has not demonstrated native execution.

### 1.1 What the inspection covered

Read-only. No session was created, no adapter installed, no account or
permission setting changed, no prompt sent.

For the installed desktop build, the inspection established:

- whether a third-party surface exposes conversation creation with an arbitrary
  project directory;
- whether the desktop's in-app guest bridge accepts the method that would
  perform it, or rejects it because the method is not in its exposure list;
- whether the officially published agent SDK drives the desktop's native
  conversations or a separate headless CLI.

The known finding from that inspection: the in-app guest bridge rejects
unlisted methods with a `HOST_ONLY` denial, and a dynamic proxy can spell the
call without that making it authorized. The published platform surface offered
no conversation creation with an arbitrary project directory. The outcome is
recorded in "Observed results" below.

### 1.2 The boundary the bridge keeps

The bridge reaches WorkBuddy over the local ACP endpoint it discovers. That is
the only route, and it depends on the desktop currently serving the workspace.

The bridge does not reach around the boundary. No private pipe, no host
impersonation, no credential scraping, and no silent fallback to a CLI or cloud
route reported as a native session. An unavailable native path is reported as a
blocker with the missing item named.

### 1.3 The endpoint only exists while the desktop serves the workspace

A WorkBuddy session's ACP endpoint is opened on demand and reclaimed when its
worker rotates or the app restarts. Before expecting a delegation to send
anything, confirm there is something to attach to:

```sh
# A record whose cwd is the smoke project AND a url/endpoint, whose port is live
ls ~/.workbuddy/sessions; netstat -ano -p tcp | grep LISTENING | grep 127.0.0.1
```

`WB_SESSION_NOT_RUNNING` from `wb_task` means no worker is currently serving the
selected task session. The saved project binding can remain valid. Open the
matching project/session in the desktop, then inspect the existing task's send
and recovery state before deciding how to continue. Do not change its UUID or
resubmit an execution whose outcome is unknown.

The same rule explains why a stale log line is dangerous: `~/.workbuddy/logs`
keeps `Worker registered with endpoint:` lines forever. Discovery therefore only
trusts a logged endpoint whose port still accepts a connection, and pairs a
recovered port only with the session record whose process owns that socket.

This is a property of the current desktop build. The bridge attaches to what
the desktop is serving; it does not wake an endpoint that is not being served.

## Part 2 — the current verified path

### 2.1 Create an isolated project

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
2. Have the human prepare at least two independent existing conversations for
   the core multi-session scenario. Every additional unrelated permission or
   cancellation task needs another unassigned conversation; ended task contexts
   are not recycled. The bridge only selects among conversations that already
   exist and never creates, activates or resets one.
3. Make sure the desktop is actually serving those conversations. Depending on
   the desktop's state, that means opening the conversation or sending it a
   message there. A conversation that exists but is not being served has no live
   ACP endpoint, and the round will wait with that reason.
4. Start OMP against the same directory and run `/wb bind` once, confirming the
   project session pool. The project choice persists across OMP restarts.
5. Obtain concrete authorization for the selected scenarios before sending
   anything. Do not execute every example automatically or use a new task ID to
   widen the authorization for this run.

### 2.2 Delegate the data task

Delegate through the `workbuddy-delegate` skill:

```text
wb_task({
  goal: {
    objective: "Summarize the attached sales data in Markdown with a by-month table and a by-product table.",
    context: "Month totals must be January 300 and February 150; product totals must be A 250 and B 200.",
    constraints: ["Do not modify the input file."],
    acceptance: [
      "The by-month table shows January 300 and February 150",
      "The by-product table shows A 250 and B 200",
      "input/sales.csv is unchanged"
    ]
  },
  inputFiles: ["input/sales.csv"],
  expectedOutputs: ["sales-summary.md"]
})
```

The tool waits for the durable commit by default (a 30-second window) and returns
the committed view. Do not start a polling loop: if the wait ended early, use
`wb_status` once for that specific question — an input message or a timeout only
ends the wait, and the round keeps running.

Check, by reading the actual file:

- the by-month totals are January 300 and February 150;
- the by-product totals are A 250 and B 200;
- `input/sales.csv` is unchanged.

Also confirm the receipt reached a terminal state, the round's hold was released
(`wb_doctor` shows no execution hold for it), and the artifact path is inside the
task's `outputs/`. A filename alone proves nothing.

Then review it, which is what makes the result reviewable at all:

```text
wb_review({
  taskId: "<the taskId>",
  verdict: "accepted",
  findings: [
    { criterion: "The by-month table shows January 300 and February 150", status: "passed", note: "read the table", evidence: ["opened sales-summary.md"] },
    { criterion: "The by-product table shows A 250 and B 200", status: "passed", note: "read the table", evidence: ["opened sales-summary.md"] },
    { criterion: "input/sales.csv is unchanged", status: "passed", note: "same digest as the snapshot", evidence: ["sha256 of input/sales.csv"] }
  ],
  artifacts: [{ path: "<round outputs>/sales-summary.md", sha256: "<its current digest>" }]
})
```

A wrong hash, a missing criterion or a verdict that contradicts a finding is
refused rather than stored. Rewriting the file afterwards makes the acceptance
ineffective while keeping the history.

#### Independent tasks and context exhaustion

While the sales task is still running, submit a second authorized, unrelated
task against the same project. The long-task scenario below can serve as that
second task; do not submit it again in section 2.4. Verify different selected WB
UUIDs and overlapping running intervals, not just two task IDs. Check that each
actual output belongs to its task and that ending/cancelling one does not stop
the other.

After both contexts have been used, a new unrelated task must wait if no
unassigned session remains. Its reason should explain the missing independent
context, not silently queue it for later reuse of either ended session. The
human may open another same-project conversation; it is enrolled without a new
project-binding dialog. Only send this additional task if it is included in the
authorization for this run.

Read that reason literally, and read the per-session blockers beside it. A
reason that says every eligible session has already carried another task is
exhaustion: the project has no spare context left, and the human prepares
another same-project conversation in the desktop. It is enrolled without a new
project-binding dialog. Do not describe a manually opened conversation as one
the bridge obtained.

Busy or offline unused eligible sessions mean a temporary availability wait; a
newly verified unused matching session can also unblock it. Read the
per-session blockers beside a mixed reason rather than assuming they are all busy
or offline. Unknown execution state and ownership conflicts are safety blockers:
becoming idle does not clear them. Do not mistake temporary unavailability for
context exhaustion, or a safety blocker for an ordinary busy wait.


### 2.3 Permission probe (may not trigger)

In another unassigned conversation, ask for a step that requires a provider approval:

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

#### Known reason it may not trigger: `bypassPermissions`

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

### 2.4 Cancellation of a long task

Use a separate unassigned conversation. If this task was already started alongside
the sales task, continue that same task here rather than submitting it again:

```text
Write the single word READY into partial.txt in your outputs directory, then run
a shell command that waits 60 seconds. Do not modify anything else.
```

The word `READY` here is the task's own content — a file the worker has to
write, followed by a long wait that gives the cancellation something to
interrupt. It is not an activation passphrase, and nothing in the product reads
it as one. Keep it as written so the historical result below stays comparable.

The human approves whatever the step requires. While it runs:

1. Confirm `wb_status` reports `running` and that `partial.txt` exists.
2. Call `wb_cancel` for that task.

Then confirm:

- the final status is `cancelled`;
- `partial.txt` was kept with its content;
- the receipt is committed; the round's hold and scope are released only when a
  resolved outcome proves the turn ended, otherwise they remain quarantined;
  a quarantined round is cleared by a human through `/wb release`, never by
  the bridge deciding on its own;
- the WorkBuddy app and both task sessions remain alive, and the unrelated task
  can continue independently;
- a late `end_turn` did not turn the result into `completed`.

### 2.5 Restart and query history

Restart OMP normally, against the same temporary project with the same package
load:

1. The saved project pool restores without another `/wb bind` dialog. Existing
   offline members remain listed without being called runnable; same-project
   conversations opened since the first binding are enrolled automatically.
2. `wb_tasks` finds both the completed and the cancelled task.
3. `wb_status` on each shows `ownedByCurrentProcess: false` — the historical view.
4. Their recorded WB targets are still distinct and the artifacts remain
   readable. A supplemental/correction round, if separately included in the
   authorization for this run, returns to that task's original WB conversation.

Never hand-edit a receipt to manufacture a result, and never stop another worker
to make a state convenient.

#### Operator recovery of a stranded round

A round stranded by a dead owner is recovered by a human through `/wb repair`
and `/wb release`. This smoke has not exercised that scenario yet, so record it
as unexercised rather than passed. The dead owner is the original OMP process,
not a WorkBuddy worker, so a stranded round can be produced without touching a
worker at all: the controlled tests use a naturally exited short-lived process
standing in for the original owner. Walking the real path needs the same
ingredients — an original owner that has genuinely exited, plus explicit human
recovery and end observations — not a killed worker.

When you do walk it by hand, hold to these observations:

- The originating session repairs its own round the ordinary way, with no
  extra dialog. A different operator's `/wb repair` first tries that path and,
  once it refuses, shows one confirmation dialog naming the task and round
  together with the exact subject — project root, request id, attempt id, the
  WorkBuddy session, the original owner session and generation, the original
  owner's process id and whether it is gone, the recorded result status and the
  manifest digest.
- The consent is bound to that subject. Change the round between the dialog and
  the commit and neither a recovery commit nor a hold release is authorized.
  Receipt IO already in progress may leave an unconfirmed local file; that
  file grants no authority.
- After the repair the round is committed but still quarantined: a local
  receipt is not proof that the WorkBuddy turn stopped.
- `/wb release` asks for the end observation and then a confirmation for that
  same exact round, and only then clears the hold. It needs a committed,
  digest-confirmed receipt as well.
- The rebuilt receipt keeps the original owner, the original approved manifest,
  the original recorded first outcome and the original WB session; a
  supplemental round still returns to the same conversation. The recovering
  operator is recorded in the project's queue row, not in the receipt.
- With no UI, with the dialog dismissed, or with an answer that arrives after a
  session switch, neither command may commit recovery or release a hold.

## Part 3 — the user-prepared session path

This part is the acceptance for the scope as it now stands. It exercises the
boundary the bridge keeps: the user prepares native conversations in the
WorkBuddy desktop, the bridge attaches to what is there, and the bridge never
creates, activates, wakes or clears a session on the user's behalf.

**It needs its own authorization.** The 2026-10-23 experiments were stopped and
the remaining allowance was revoked, so a live run of this part needs a fresh
decision. Running Part 2 does not substitute for it, and a passing Part 2 run
must not be reported as a passing Part 3 run. Record each scenario with its
actual state.

The order below is the order of dependency. Each step assumes the previous one
passed.

### 3.1 The user prepares the sessions

The human opens native conversations in the WorkBuddy desktop for the project
and makes sure the desktop is serving them. Depending on the desktop's state,
that means opening the conversation or sending it a message there. Then the
project is bound once with `/wb bind`.

Check:

- the prepared conversations are enrolled after the binding, each with its own
  identity and working directory inside the authorized project root;
- a conversation prepared after the binding is enrolled without another
  binding dialog;
- the enrollment sends no business prompt and grants no task or native
  permission;
- a conversation belonging to another project, or with an ambiguous identity, is
  excluded.

Identity comes from the WorkBuddy process, the session UUID, the real request
and the artifact path together. The agent's own account of itself, a client
info string, a fixture or the existence of a file proves nothing.

### 3.2 Two prepared conversations, two tasks

With two prepared conversations and no prior task on either, submit two
unrelated new logical tasks with compatible scopes.

Check:

- the two tasks ran in two distinct native conversations, each with its own
  identity;
- current-turn execution events demonstrate an actual overlap; replayed history
  from loading a session is not evidence that the new turns ran concurrently;
- each output landed in its own task's `outputs/` directory;
- ending or cancelling one task leaves the other running;
- the bridge did not create or activate a conversation or provision a replacement
  runtime: no conversation appeared that the human did not prepare, and no
  session outside the authorized project root was touched.

### 3.3 No usable session, and the wait reason

Submit a new logical task when every eligible session has already carried
another task, and separately when the eligible sessions are merely busy or
offline.

Check:

- the task queues instead of running, and the reason names the actual cause:
  no spare context versus temporary unavailability;
- a busy or offline unused eligible session is a temporary wait, and a newly
  verified unused matching session unblocks it;
- the task never starts against a session that already carried an unrelated
  task;
- the bridge did not create a conversation, activate one, or clear a context to
  get unblocked;
- an unknown execution state or a project-ownership conflict is reported as a
  safety blocker and does not clear when the session becomes idle.

### 3.4 Supplemental work returns to the original conversation

For a completed task, add material or trigger the one correction.

Check:

- the round runs in the task's original conversation;
- no second conversation was involved;
- the recorded session identity is unchanged.

### 3.5 Cancel, refuse, and lose contact

Three branches, each with an explicable outcome:

- **Cancel** — cancelling one task leaves the other conversation alive, the
  cancelled task's receipt is committed, and its hold is released only on a
  resolved outcome.
- **Permission refusal** — a denied native step is not executed, no standing
  grant appears, and the task reports the refusal.
- **Lost contact** — when the bridge cannot reach the worker, it does not resend
  the prompt and does not move the work to another conversation. The task
  reports an unknown execution and keeps the hold.

If the desktop-served conversation raises no native permission request, record
the refusal branch as untriggered, not passed. Do not start an independent CLI
worker or change permission settings to manufacture that desktop-path evidence.

### 3.6 No duplicate send

Repeat the same logical task's request, restart OMP mid-flight, and race two
requests for one task.

Check:

- one conversation serves the logical task;
- the prompt is sent exactly once;
- the recorded target identity is stable across the restart.

### 3.7 Artifacts, receipts and restart

Check:

- the delivery reference points at the file that actually exists;
- the receipt reached a terminal state and names the real WorkBuddy session;
- after closing and reopening the front end, the project selection is still
  there, and an unfinished task keeps its conversation affinity without a
  second context appearing.

### 3.8 Sign-off rule

The current scope is not signed off while any scenario above is `not runnable`,
`untriggered` or `blocked`. Record each one with its actual state and the
evidence behind it. A documented blocker is not a pass.

## What this proves, and what it does not

A passing Part 2 run proves the live path works: discovery, binding, delegation,
approval routing, cancellation, artifact containment and history recall, against
a real desktop agent.

It does not prove the ACP handshake is compatible in every WorkBuddy version, and
`wb_doctor` never claims it does — compatibility is proven only when a real
delegation connects. Record any scenario that did not trigger (for example a
provider that raises no approval) as untriggered rather than passed, and keep the
offline regression results as the evidence for those paths. Operator recovery of
a stranded round is still unexercised here: until it is walked with a genuinely
exited original owner and explicit human recovery and end observations, this
runbook cannot claim it.

Part 2 also proves nothing about session supply. It exercises sessions the human
prepared, which is the current scope. Part 3 is the acceptance for that scope,
and it needs its own authorization before it is run.

## Observed results

#### Part 1 — 2026-10-22 (history)

Read-only inspection of the installed WorkBuddy 5.8.3 desktop build and the
published WorkBuddy platform documentation. No session was created, no adapter
installed, no account or permission setting changed, no prompt sent, and no
native call made.

| Check | Outcome |
| --- | --- |
| Third-party surface offering conversation creation with an arbitrary project directory | **Not found.** The published platform surface does not offer it. |
| In-app guest bridge accepting a conversation-creation method | **Refused.** Unlisted methods are rejected with a `HOST_ONLY` denial; a dynamic proxy can spell the call without that making it authorized. |
| Official agent SDK | Drives a separate headless CLI, not the desktop's native conversations. A different execution backend, not a substitute. |

Result: **contract not confirmed**. The bridge keeps using the local ACP
endpoint it discovers, and no provisioning path is available. This is the
recorded outcome of that probe; the current scope does not depend on re-running
it.

#### Part 2 — 2026-10-14

One real run against a live WorkBuddy desktop (session `<redacted-session-id>`,
WorkBuddy 5.8.2) on a disposable project:

| Step | Outcome |
| --- | --- |
| 1. Isolated project + human `/wb bind` | Binding written for the smoke cwd; no other project touched. |
| 2. Sales delegation | `completed`. `sales-summary.md` contained by-month 300/150 and by-Product A 250 / B 200; `input/sales.csv` byte-identical afterwards. |
| 3. Permission probe | **Not triggered.** The session runs `--permission-mode bypassPermissions`, so the worker raised no approval and the shell step simply ran — its file still landed inside the task's own `outputs/`. Recorded as untriggered; the offline deny/abort/standing-grant suite remains the fail-closed evidence. |
| 4. Cancellation | `cancelled` while the 60s wait was still running (`partial.txt` written at 19:21:19, terminal receipt committed at 19:22:05). `partial.txt` was kept with its content and the desktop app stayed alive. The cancelled state was not overwritten afterwards. This run predates the queue rewrite, so its "lock" wording refers to the retired `active.lock`; the current equivalent is the committed cancellation receipt releasing the round's hold. |
| 5. Restart and history | Recall was exercised against these live receipts through the real tool code in a fresh process (not through an OMP UI restart): `wb_tasks` returned all four tasks newest-first with no warnings, and `wb_status` reported the cancelled task with `ownedByCurrentProcess: false` plus its real artifact path. |

#### Finding: the cancelled turn never reported its end

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

#### Part 3 — not run under the current scope

Part 3 has not been run since it was rewritten for the user-prepared session
path. The 2026-10-23 experiments were stopped and the remaining allowance was
revoked, so a live run needs a fresh authorization. Record every scenario as
**not run**, not as passed, and replace this line with the real results when a
run happens.

The earlier Part 3 in this file — the new-contract acceptance for an
entry point reachable without manual chat-opening and for automatic
conversation supply — was removed with that scope on 2026-10-23. Its scenarios
are not carried forward, and none of them counts as verified.
