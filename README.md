# omp-wb-bridge

[English](README.md) | [中文](README.zh-CN.md)

`omp-wb-bridge` is an OMP-native extension that links OMP to a WorkBuddy desktop session.

The division of labour is straightforward: repository code editing, refactoring, and terminal builds stay in OMP; authoring Word documents, generating slide decks, crunching spreadsheets, and producing marketing visuals or video storyboards run in WorkBuddy. Work started directly by humans inside WorkBuddy can also be synchronized back to OMP for direct inspection and integration.

Both sides share a local project directory and three stdio-based MCP tools. No background daemon processes, no secondary planners, and no proprietary memory systems.

---

## Commands & Tools

### 1. Terminal Management Commands (`/wb`)

| Command | Purpose |
|---|---|
| `/wb bind` | Pick and bind the current project to a dedicated WorkBuddy desktop session. |
| `/wb status` | Show the bound session, worker health, and tasks currently active in this process. |
| `/wb send <requestId>` | Confirm and submit a frozen task draft (for headless CLI sessions). |
| `/wb release <workId>` | Explicitly unlock an orphaned or blocked file scope. |
| `/wb setup` | Safely configure MCP connection entries in `.omp/mcp.json` and `~/.workbuddy/mcp.json`, and deploy the collaboration skill. |

### 2. OMP Host Tools

| Tool | Purpose |
|---|---|
| `wb_task` | Submit a delegation round with an `objective` and concrete `acceptance` criteria. Prompts for human confirmation before dispatch; external side-effects (e.g. emails, cloud writes, deployments) trigger a separate point-of-risk confirmation. |
| `wb_status` | Poll execution progress, accumulated round text, and verified artifact files (with file types, byte sizes, and SHA-256 hashes). |
| `wb_cancel` | Cancel an active task owned by this process. Waits for the worker to report turn completion before closing the socket to prevent queued deadlocks. |
| `wb_tasks` | Paginated listing of persisted delegation records, newest first. Strictly read-only. |
| `wb_doctor` | Read-only inspection of the binding, local file lock, and worker health endpoints without touching any files. |

### 3. Shared MCP Tools (`src/mcp.ts`)

Ran via standard stdio (`bun src/mcp.ts --project <root> --agent <omp|workbuddy>`):

| MCP Tool | Purpose |
|---|---|
| `project_context` | Inspect active work items, claimed scopes, current milestones, and review verdicts across both agents. |
| `work_claim` | Declare read/write path scopes before modifying business files to prevent concurrent write collisions. |
| `work_publish` | Record milestones, published deliverables, or submit review opinions (with artifact hash verification). |

### 4. Packaged Skills

- **`skills/omp-wb-collaboration/SKILL.md`**: Common collaboration rules for both agents (inspect before claiming, claim before editing, hash deliverables, release upon completion).
- **`skills/workbuddy-delegate/SKILL.md`**: Guide for OMP on evaluating division of labour and formulating testable acceptance conditions.
- **`skills/workbuddy-delegate/references/native-capabilities.md`**: Concrete inputs and minimum acceptance criteria across 19 specialized native domains (reports, slide decks, posters, prototypes, scheduled tasks, etc.).
- **Automatic Discovery**: Implements OMP's `resources_discover` hook so both skills are discovered whether loading via package directory or via `-e src/index.ts`.

---

## Collaboration & Execution Flow

```mermaid
sequenceDiagram
    autonumber
    participant User as Human User / OMP UI
    participant OMP as OMP (src/index.ts)
    participant Tasks as Task Store (tasks.ts)
    participant Collab as Collab Store (collaboration.ts)
    participant MCP as MCP stdio (src/mcp.ts)
    participant WB as WorkBuddy Desktop

    Note over User, OMP: 1. Formulation & Confirmation
    OMP->>OMP: Hash input snapshots and freeze draft slot
    OMP->>User: Selection dialog (Submit this round / Keep in OMP / Cancel)
    User-->>OMP: "Submit this round" (or /wb send <requestId>)
    opt Contains external actions (publish/deploy/cloud_write)
        OMP->>User: Explicit confirmation dialog for external actions
        User-->>OMP: Approve one-time execution
    end

    Note over OMP, Collab: 2. Setup & Scope Reservation
    OMP->>Tasks: prepareTask (validate binding, write brief.md and v2 receipt)
    OMP->>Collab: claimWork (reserve input read scope and round outputs write scope)
    Collab-->>OMP: Confirm no collision (overlap aborts with failed receipt)

    Note over OMP, WB: 3. Execution & Checkpoint Synchronization
    OMP->>WB: Connect ACP and stream full intent text
    loop During execution
        WB->>MCP: work_publish (report phase milestones and outputs)
        OMP->>MCP: project_context (pull minimal summaries on demand)
    end
    WB-->>OMP: end_turn (stop reason and message reply)

    Note over OMP, Collab: 4. Artifact Validation & Terminal Commit
    OMP->>Tasks: collectArtifacts (scan round outputs, compute SHA-256 and bytes)
    OMP->>Tasks: writeTask (commit terminal receipt with rounds[] array)
    OMP->>Collab: releaseWork (release scope on clean completion; mark blocked on failure)
    OMP->>Tasks: releaseTask (unlink active.lock)

    Note over User, WB: 5. Consumer Inspection & Review
    OMP->>OMP: Open files with native tools, verify against acceptance criteria
    OMP->>MCP: work_publish (record hash-bound review: accepted / changes_requested)
```

---

## Directory Layout

All generated runtime files remain inside `.wb-bridge/` in the project root:

```text
.wb-bridge/
  binding.json                      Bound WorkBuddy session identity (version 1)
  active.lock                       Single-task project lock (one active delegated run at a time)
  collaboration.lock                Short metadata lock held only during atomic record updates
  collaboration/
    <workId>.json                   Collaborative work records across OMP and WorkBuddy
  tasks/<taskId>/
    receipt.json                    v2 task receipt containing sequential rounds[] array
    rounds/<roundNumber>/
      brief.md                      Rendered instruction brief for this round
      inputs/                       Input file snapshots provided for this round
      outputs/                      Deliverables produced by WorkBuddy for this round
  workbuddy/<workId>/
    outputs/                        Outputs directory allocated for WorkBuddy native tasks
```

---

## Safety Guarantees

1. **Human Confirmation Before Submission**:
   - Model tools cannot self-authorize. Parameters like `approved: true` or natural-language claims of consent are ignored.
   - If inputs are modified concurrently while a draft is frozen, SHA-256 mismatch aborts the dispatch and requests re-confirmation.
   - Actions touching external networks, cloud resources, or cron schedules require separate dialog authorization.
2. **Fail-Closed Permission Model**:
   - WorkBuddy permission prompts require an explicit human **Approve once** choice. Dismissing, timeouts, or headless runs deny automatically.
3. **Tree-Level Scope Isolation**:
   - Programmatic path checks prevent concurrent write collisions. Overlapping writes or write-over-read abort immediately with `WB_SCOPE_CONFLICT`.
4. **Real File & Hash Verification**:
   - `completed` means the turn finished and files exist on disk; it does not indicate the content is correct.
   - Reviews require verifying actual SHA-256 hashes of deliverables. Modifying a file after publication throws `WB_ARTIFACT_CHANGED`.
5. **Configuration Protection (`/wb setup`)**:
   - When updating `.omp/mcp.json` or `~/.workbuddy/mcp.json`, only `ENOENT` allows creating a fresh configuration.
   - Syntax errors, non-object roots, or conflicting foreign entries halt with an error, leaving files byte-identical without overwriting unrelated tools.
6. **Zero Credential Persistence**:
   - Session tokens, loopback ports, model internal thoughts (`agent_thought_chunk`), and raw conversation logs are never written to disk.

---

## Development & Testing

### Prerequisites
- **Bun 1.4+**
- Local WorkBuddy desktop application (version 5.8.2+) with ACP enabled.

### Test Commands
```bash
bun install
bun test
bun run typecheck
```

- `bun test`: Runs 185+ offline behavioral tests covering multi-round storage, lock contention, HTTP/SSE transport, permission gates, and dual-client MCP interaction.
- `bun run typecheck`: Strict `tsc --noEmit` check with zero diagnostics.

### Loading Extension into OMP
```bash
# Recommended: load from package directory for full skill discovery
omp --cwd /path/to/your/project -e /path/to/omp-wb-bridge

# Configure local MCP integration in this project
/wb setup
```
