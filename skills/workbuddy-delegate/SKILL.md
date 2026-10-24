---
name: workbuddy-delegate
description: Guide OMP in proposing, formulating, confirming, and reviewing delegated WorkBuddy tasks. Load when the user asks for WorkBuddy by name, or wants an office deliverable (.docx, .pptx, formatted report), a Tencent-product action, or design/research work produced by WorkBuddy rather than in this process.
---

# WorkBuddy delegation

**You are the OMP-side agent. WorkBuddy is a different application.** Any reasoning about "what the worker sees" here is about a separate desktop process, not about this session. If you catch yourself concluding that you *are* the WorkBuddy worker, that is a misreading: the worker runs in WorkBuddy's own window, and the only way to reach it is `wb_task`. Reading `.wb-bridge/` internals is not a substitute for delegating, and does not tell you anything the tools do not.

Use WorkBuddy for a self-contained professional task that benefits from its native office, research, design or connected-product capabilities. Keep repository engineering, Git operations and local test automation in OMP.

When the user names WorkBuddy, or asks for a deliverable this process does not produce well (a real `.pptx`, a formatted business report), that request is the delegation trigger: formulate the goal and call `wb_task` instead of assembling the file locally with whatever libraries happen to be installed.

## What this build does

The scope is narrow on purpose: **OMP attaches to WorkBuddy desktop sessions the user prepared.** The user opens native conversations in the WorkBuddy desktop for that project, makes sure the desktop is serving them, and binds the project once. OMP then assigns each new logical task its own unused prepared session.

- **Now:** the bridge picks among the WorkBuddy sessions already enrolled in the authorized project, and a session is reached over the ACP endpoint the desktop opens while it serves that workspace. There is no session-creation path in the source, no tool parameter for one, and no command for one.
- **Not in scope:** automatic supply of a conversation, waking an endpoint that is not being served, starting an engine on the user's behalf, or clearing an existing session's context. If a task needs a session the project does not have, the honest report is that the user prepares another same-project conversation in the desktop, and the round waits with that reason.

Do not invent a provisioning call, a creation parameter or a wake command, and do not describe a conversation as obtained for the user when it was not. When the user asks whether the bridge can create or wake a session, answer with the current boundary, not with a future plan.

Automatic supply and reliable wake were dropped from the current scope. If WorkBuddy later publishes an official entry point that suits other Agent products, that is a separate 3.0 evaluation with its own product and release decision, and it is not something to prebuild now.

Two distinctions worth keeping straight: a task's context is not a worker (the context is durable, the worker is a run resource WorkBuddy acquires and releases on its own schedule), and project enrollment is not work approval (enrolling a project authorises the project, approving a task authorises that piece of work, and only a human grants either).

## Overlapping capabilities: ask, don't silently decide

OMP ships skills for several formats WorkBuddy also produces (`.docx`, `.pdf`, `.md`, `.csv`, `.xlsx`). For those, "the user asked for a Word report" does **not** mean "delegate": both sides can do it, and the two outcomes differ — WorkBuddy spends a desktop session and its quota, OMP's route gives up WorkBuddy's office pipeline.

The prompt is conditional on a flag **you** set. When the user's own message asked for WorkBuddy (by name, or by naming a product WorkBuddy owns), pass `requestedByUser: true`. Only then does `wb_task` raise the two-option prompt for an overlapping deliverable:

- **"Send it to WorkBuddy"** — the round is staged and dispatched as usual.
- **"Keep it in this session"** — nothing is staged, no lock is taken, and the tool returns `details.workflow = "local"`. You then do the work yourself with OMP's own skills.
- **Dismissed** — nothing was chosen and nothing was delegated: `details.workflow = "undecided"`.

Consequences to respect:

1. **Set `requestedByUser: true` whenever the user named WorkBuddy.** Leaving it unset means the user is never asked — the tool treats the delegation as your own suggestion and runs it. That is correct for a delegation you propose yourself, and wrong for one they asked for.
2. Do **not** pre-empt the question by deciding on the user's behalf once the prompt is due. Answer it honestly and follow the answer.
3. On a `"local"` answer, complete the task here. Do not retry `wb_task` for the same deliverable, and do not describe the work as "pending in WorkBuddy".
4. On `"undecided"`, **ask the user which side should produce it** and call the tool again only if they pick WorkBuddy. Do not treat a dismissal as "do it locally": nothing was decided.
5. Deliverables only WorkBuddy produces (`.pptx` and the connected-product actions) raise no prompt — delegate those directly, with or without the flag.

The flag is your own account of the conversation; the tool cannot verify the user's words. Report it accurately rather than using it to avoid or force the prompt.

This is a hard rule, not a preference: the prompt exists because the choice is the user's, and a model that answers it for them is taking a decision it was not given.

OMP scopes the work, prepares materials and checks the result. WorkBuddy chooses and runs its native workflow. The bridge transfers authorized facts and manages execution; do not turn it into a document-writing or product-operation executor.

## Choose and scope the work

- Explain why WB fits this task; the user may keep it in OMP.
- If work is already running directly in WB, do not submit another copy or automatically adopt it.
- Use professional intent and concrete acceptance conditions, not a sequence of bridge-specific business steps. Load [native-capabilities.md](references/native-capabilities.md) only for the relevant domain.
- Capability references are a catalog, not evidence of an available connector. Check the actual WB connection, account and permission prerequisites before promising a Tencent-product action.

Pass `wb_task` a `goal` containing:

- `objective`: the intended professional outcome and formats.
- `context`: necessary facts only; never full conversation history, credentials or model reasoning.
- `constraints`: boundaries on materials, outputs and actions.
- `acceptance`: observable business checks, including required values or operating behavior.
- `externalActions`: exact required external targets, operations and parameters; empty when none are needed.

Provide project-contained regular `inputFiles` and declared `expectedOutputs`. The bridge freezes material hashes for the authorized round. A changed source is a new material version, not permission to reuse an old review.

## Authorization and target

The first delegation needs real human approval of the goal, materials, target and scope. Never manufacture approval in tool arguments. An enabled project or a generated file does not authorize external creation, modification, sending or publishing.

Authorize the project session pool once through `/wb bind`. The bridge persists that project choice and restores it on OMP startup, automatically enrolling all verified WB sessions in the same canonical project, including authorized subdirectories. Foreign or ambiguous sessions are excluded; enrollment sends no business prompt and grants no task or native permission.

Before the first delegation, the user prepares the conversations: native conversations opened in the WorkBuddy desktop for that project, with the desktop actually serving them. Depending on the desktop's state, that means opening the conversation or sending it a message there. Preparing conversations and binding the project are two separate steps, and the bridge only does the second one. A conversation prepared later is enrolled without another binding dialog.

Enrollment is one authorization fact; approving a piece of work is another. Neither implies the other, and neither grants a native step permission.

Different logical tasks use different WB sessions and may run concurrently when their scopes are compatible. Supplemental and correction rounds stay pinned to the original task session across restarts. Completion releases an execution hold, not the session's task association: never reuse another task's context automatically.

When no eligible session is free, preserve the queued task and report the actual reason and per-session blockers. Busy or offline unused eligible sessions mean a temporary availability wait; a newly verified unused matching session can also unblock it. If all eligible contexts have already carried another task, the project has no spare context: the user prepares another same-project conversation in the desktop, and it is enrolled without a new binding dialog. Say that plainly instead of implying the bridge obtained one. Unknown execution state and ownership conflicts require resolving the reported safety blocker; do not promise that becoming idle will clear them.

Three limits hold however a session comes into play:

- Do not clear a context, switch a pinned task, or bypass busy/unknown execution.
- A task's context is not a worker. The context is durable; the worker is a run resource WorkBuddy acquires and releases on its own schedule. A context outliving its worker is normal, not a defect to repair.
- The bridge does not create or activate WorkBuddy conversations or provision their runtime resources. It never hands a used context to an unrelated task.

Newly available eligible sessions are enrolled without another project-binding dialog.

Three authorizations are separate, and none implies another: enrolling a project, approving one piece of work, and approving one native step. Keep them separate in what you report. When a task needs a session the project does not have, say what the user has to prepare rather than implying the bridge obtained one on the user's behalf.

WB's native permission request is separate from work authorization: only a human's explicit **Approve once** may grant it. Dismissal, timeout, missing UI or an unparseable request means refusal.

## Follow through

Default to follow-through until committed results have been inspected. A task ID, queued state or WB success message is not the final deliverable.

- Keep the foreground delivery intent when a wait expires, is interrupted, or the user sends another message. None of those cancels WB or selects background mode.
- Continue ordinary conversation while the bridge tracks the task. Handle its result/recovery message when it arrives; do not require the user to repeatedly query status.
- Use `wb_status` for a specific inspection or recovery question, not a manual polling loop.
- Switch to background only after an explicit user choice through the bridge's background control. Completion or failure still needs a final report; pending results remain recoverable for the originating OMP session.
- Use `wb_cancel` only for explicit cancellation of an authorized, owned task. A cancelled local result does not prove the remote turn has stopped.

## Recovering a round whose owner died

A round can be stranded when the OMP process that owned it dies: the WorkBuddy session stays held, and a prompt that may already have been sent leaves the round quarantined. Recovery is a human operation on the bridge's own commands, `/wb repair` and `/wb release`.

- The originating session still repairs its own round the ordinary way, with no extra dialog. A *different* current OMP session may also recover it, and the original session's own transcript is not needed for that. Do not claim a round is unrecoverable because the originating session is gone.
- The original owner's registration must have ended and its registered process must no longer exist in the operating system. An inactive row alone is not proof; an active original registration, a still-live or possibly-reused PID, or a live successor of the originating OMP session blocks another operator's recovery.
- When a *different* operator recovers the round, `/wb repair` first tries the ordinary path and, once that refuses, shows one confirmation dialog naming the task and round together with the exact subject — project root, task, round, request id, attempt id, WorkBuddy session, original owner session and generation, the original owner's process id and whether it is gone, the recorded result status and the manifest digest. `/wb release` keeps its existing select → end-evidence → confirm flow, and its confirmation also names the original owner, the request id, the attempt id and the committed receipt digest. Headless operation, a declined, failed or timed-out dialog, and an answer arriving after a session switch or shutdown cannot authorize a recovery commit or a hold release. There is no standing grant and no way for you to supply one.
- The consent is one-shot and bound to that exact subject: a changed attempt, session, owner, manifest, recorded outcome, revision or receipt digest invalidates the recovery commit and cannot release a hold. Receipt IO already in progress may leave an unconfirmed local file; that file grants no authority. No auto-reconfirm, no replay.
- `/wb repair` rebuilds the failed receipt from the outcome the queue already recorded and the manifest the human already approved. It sends nothing to WorkBuddy, contacts no WorkBuddy session and replays nothing.
- The rebuilt receipt still names the original owner, the original approved manifest, the original recorded first outcome and the original WorkBuddy session — the receipt describes the execution, and the execution belonged to the original owner. The recovering operator is recorded in the project's queue row instead, in the same transaction that commits the receipt. A later supplemental or correction round still returns to the original WorkBuddy conversation.
- A repaired receipt is a local fact, not proof that the WorkBuddy turn ended. A possibly-sent round stays quarantined after a successful repair; only the separate human end-verification in `/wb release` clears it, and that release requires a committed, digest-confirmed receipt as well.

The human makes every decision here. Never answer a recovery confirmation on their behalf, never treat an earlier approval as covering a later operation, and never fabricate the original OMP identity. When the user has actually authorized a recovery, you may still help by running the approved command, telling them what each step will do, and reporting what the bridge says — but the confirmations themselves stay theirs.

When a user asks you about a stranded round, tell them which of the two commands applies and what the bridge reports about it. The diagnostic surfaces do name the recovery path and that a human operator may act once the original owner's process is provably gone, so the original session is not the only route; they remain read-only and do not repair or release anything themselves. Do not describe a quarantined round as released until a human actually released it.

## Inspect current results

Read the actual artifact paths returned by the bridge. Open office files in a suitable reader/viewer, run runnable output in isolation, and compare business values and required behavior against the original acceptance conditions. For product actions, verify the actual target and operation result; a description file does not prove the action happened.

Record the inspection through the queue-authoritative `wb_review` tool with the current artifact hashes, one finding per original acceptance criterion, and the evidence you actually used. A wrong hash, a missing criterion or a verdict that contradicts a finding is refused rather than stored. Do not use the removed `work_publish` protocol: the bridge records your review, it does not perform the inspection for you.

`completed` means the worker ended and declared files were found. Commit, review and acceptance are separate facts. Changed or missing bytes invalidate the effective old acceptance; inspect and review the new version rather than reusing old hashes. Keep partial results and unverified product actions labeled accurately.

## One bounded quality correction

When actual inspection finds the original result inadequate, submit `wb_review` with verdict `changes_requested` and at least one failed criterion. That verdict starts the **same task's** next round automatically within its original authorization. The total automatic quality-correction allowance is **one per delegation**, shared across rounds, artifacts and restarts; the bridge spends it when the correction prompt is armed, so a retry cannot grant a second one.

The correction re-validates the current materials, target and authorization before it is staged or sent, and it preserves the original objective, constraints and acceptance conditions — only the context gains the precise defects. A new objective, expanded read/write scope, a new external action, or a task that already approved external actions requires a fresh human decision instead.

Never correct an unknown execution, bypass an exhausted allowance with a new task ID, or treat transport failure as permission to resend. After the correction, inspect again. If it still fails, the allowance is exhausted, or materials/permissions are missing, preserve the work and report the concrete blocker and required decision.

## Final delivery

Return openable artifact references and the checks actually performed. Distinguish accepted output, partial work, unverified actions, storage failure and unresolved execution. Notification sent is not consumer receipt; WB self-report is not acceptance.
