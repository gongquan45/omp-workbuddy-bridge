---
name: workbuddy-delegate
description: Guide OMP in proposing, formulating, confirming, and reviewing delegated WorkBuddy tasks across specialized native capability domains.
---

# WorkBuddy Delegation Skill (v2)

Use this skill when a user request benefits from WorkBuddy's native specialized strengths (office documents, presentations, deep research, graphic design, multimedia, or isolated prototyping) rather than direct in-repository engineering in OMP.

## 1. Division of Labour Decision

Before delegating, evaluate which agent is best suited:
- **Keep in OMP**: Core repository code edits, git operations, local unit test runs, and CLI workflow automation.
- **Suggest WorkBuddy Delegation**: Office documents (`.docx`, `.pptx`, `.xlsx`), marketing/visual graphics, standalone video/audio generation, deep market/technical research requiring dedicated web tooling, or self-contained sandboxed prototypes.
- **User Native Initiation**: Tasks already initiated directly by the user in WorkBuddy. OMP inspects and collaborates via `project_context` without re-delegating through `wb_task`.

Provide a clear professional rationale to the user explaining why WorkBuddy is recommended.

## 2. Formulating the Delegation Goal

Formulate the task using the v2 `TaskGoal` schema:
- `objective`: Concise statement of professional intent and required deliverable formats.
- `context`: Minimal background context needed for execution. Do not paste full conversation history or secrets.
- `constraints`: Specific boundaries (e.g. "Do not modify source files", "Use 16:9 aspect ratio").
- `acceptance`: Non-empty list of concrete observable acceptance conditions (e.g. "Slide 1 totals must equal 450", "Output must be a valid .pptx file").
- `externalActions`: Explicit list of any required side-effects (`publish`, `deploy`, `cloud_write`, `schedule`). Keep empty if no external side-effects are needed.

Reference `references/native-capabilities.md` for domain-specific acceptance criteria across the nineteen native capability scenes.

## 3. Human Confirmation Flow

1. Call `wb_task({ goal: ..., inputFiles: [...], expectedOutputs: [...] })`.
2. The bridge freezes a draft and prompts the human user via dialog with options:
   - `Submit this round`: Explicit authorization to proceed.
   - `Keep in OMP`: Retains the task in OMP without execution.
   - `Cancel`: Cancels the delegation attempt.
3. If `hasUI` is false, the bridge returns `WB_CONSENT_REQUIRED` with a `requestId`. The user confirms via the host command `/wb send <requestId>`.
4. If `externalActions` are declared, a separate confirmation is prompted: `Approve these exact actions once` vs `Do not run external actions`.

Never attempt to bypass human consent or fabricate user authorization strings.

## 4. Execution & Artifact Verification

1. Poll status using `wb_status({ taskId, waitMs: 20000 })`.
2. Inspect produced deliverables in the round's `outputsDir`.
3. Open and verify real artifact files against the brief's acceptance criteria using appropriate native viewers/readers.
4. Publish review feedback using the collaboration MCP tool `work_publish` with exact artifact SHA-256 hashes and verdict (`accepted`, `changes_requested`, or `unverified`).
5. `completed` status indicates worker completion and file presence; content validity is established only by human or consumer verification.
