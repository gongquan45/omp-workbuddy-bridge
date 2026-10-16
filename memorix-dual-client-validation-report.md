# Memorix 最小双端验证 — 全量报告

> 状态：**执行完成**（全部计划步骤已执行；2 项阻断性结论）
> runId：`843bf14b-f974-459b-aa99-bf5b10a26fe5`
> 固定候选：`memorix@1.9.10`（npm `gitHead: af2550290ca6d37c524450b4366277b211aa7402`）
> 验证根 R：`E:\Desktop\omp-wb-memorix-validation-843bf14b-f974-459b-aa99-bf5b10a26fe5`
> 真实两端：A = OMP 18.11.0（项目 P 内原生会话）；B = WorkBuddy 桌面 5.8.2（同一项目 P 内原生任务）
> 证据标注：**【真实双端】**＝来自两个真实产品；**【backend-only】**＝raw stdio 客户端；**【diagnostic-only】**＝只读诊断通道
> 报告日期：2026-10-16

---

## 1. 摘要

在一座完全隔离的验证根内，用**真实 OMP**与**真实 WorkBuddy 桌面版**同时接入同一个 Git 项目 P，通过 Memorix 1.9.10（team 档）完成了一次端到端协作验证。五个目标中：

| 目标 | 判定 |
|---|---|
| ① 同项目发现 | ✅ **PASS【真实双端】** |
| ② 有限信息同步 | ✅ **PASS【真实双端】** |
| ③ 真实产物引用 | ✅ **PASS【真实双端】** |
| ④ 职责分工（角色/依赖/唯一领取） | ⛔ **BLOCKED** —— 原生 task-ID 门禁 FAIL |
| ⑤ Agent 协作状态 | ⚠️ 部分 PASS；「最近活动时间」子项 BLOCKED |

另有 2 项须单独列的阻断性结论：

- **阻断 #1（编号门禁）**：MCP 返回的任务标识被截断为 8 位前缀，用该前缀 `claim` 必然 `Task not found`；完整 UUID 在任何原生返回面上都不可获得 → 职责、依赖、竞争三条原生链路无法闭环（【真实双端】+【backend-only】双确认）。
- **阻断 #2（长操作所有权安全）**：实测 313.098 秒无心跳后，一个**连接仍打开、本地操作未结束**的持有人被另一会话的懒清理回收（标记 inactive、任务退回 pending、文件锁删除）→ **FAIL**。

**综合判定：不能宣布可直接采用。** 可复用的是已验证子集（发现、有界事实同步、真实产物交接、身份与消息生命周期）；但「分工与所有权安全」这两个支撑面不成立。

---

## 2. 验证目标与方法

### 2.1 目标（按批准计划）

在同一项目内让两个真实 Agent 产品：
1. **自动发现**彼此（参与者、角色）；
2. **同步有限事实**（可被对端主动读取、内容与来源准确）；
3. **引用真实产物**（文件字节由两端原生的文件能力实际读写，引用元数据经共享层传递）；
4. **按职责领取任务**（角色约束、依赖门禁、唯一持有）；
5. **同步 Agent 协作状态**（active/inactive、自报阻断、最近活动）。

并附加验证：跨项目隔离反例、长操作所有权安全（stale 回收边界）。固定使用已发布的 `memorix@1.9.10`，不修改供应商、不修改桥接工程、不控制另一产品的原生工具/进程/权限。

### 2.2 方法概览

- **隔离根**：新建独立目录 R（位于当前工程之外），内含 P、Q 两个真实 Git 项目、隔离 HOME/APPDATA/TMP/DATA 目录、工具目录 T、证据目录 E。
- **环境边界启动器**：`memorix-launcher.mjs` ＋ `memorix-env.mjs`。只允许 `projectRoot ∈ {P, Q}`；服务子进程环境从零构建（只复制 `PATH/PATHEXT/SystemRoot/WINDIR/ComSpec`，再注入隔离 HOME/DATA/MODE 等），不继承模型密钥、代理、NODE_OPTIONS/NODE_PATH。stdout 专用协议流。
- **双端接入**：
  - A 端：OMP 原生会话（`omp --mode rpc`，`--no-extensions`），项目级配置文件 `P/.omp/mcp.json` 被原生识别；模型经 `xd://mcp__memorix_validate_*` 设备实际调用工具。
  - B 端：WorkBuddy 桌面版真实任务会话；MCP 接入经产品面板（**用户级** `C:\Users\FKCZ3\.workbuddy\mcp.json` ＋ 「信任」确认），接入机制详见第 7 节。
- **观察端**：raw stdio 客户端（【backend-only】）与只读 CLI（【diagnostic-only】）用于独立取证；不参与原生成功统计。

---

## 3. 环境与隔离（【backend-only】）

| 项目 | 值 | 核验 |
|---|---|---|
| 运行时 | Node v24.14.0（固定路径 `C:\Program Files\nodejs\node.exe`） | ✅ |
| 包 | `memorix@1.9.10`，bin→`dist/cli/index.js`（12.4MB） | ✅ 安装后实际版本核对 |
| 项目标识 | P=`local/project-a`，Q=`local/project-b`（共享同一 data dir） | ✅ |
| 隔离 HOME | `os.homedir()` = R\home；`config path` → `R\home\.memorix\config.toml` | ✅ |
| 隔离 DATA | `status --json` 中 `project.dataDir` = R\data | ✅ |
| 隔离 TMP | `os.tmpdir()` = R\tmp | ✅ |
| 纯净环境 | 子进程 env 仅 24 键（含 6 个 Windows 自动附加项）；无 NODE_OPTIONS/NODE_PATH/代理/密钥 | ✅ |
| 宿主 home 不受影响 | `C:\Users\FKCZ3\.memorix` 在**运行前与运行后均不存在**（前后快照对比） | ✅ |

项目配置 `memorix.toml`（P、Q 相同）：`auto_cleanup=false, sync_advisory=false, formation="fallback", git.auto_hook=false, ingest_on_commit=false, embedding.provider="off", codegraph.external_context="off", server.transport="stdio", dashboard=false`。

**服务档位**：`serve --mode team`（29 个工具，含 `team_manage/team_file_lock/team_task/team_message/memorix_poll/memorix_handoff` 与 `memorix_store/search/detail` 等）。

---

## 4. 分步结果

### 4.1 协议与工具面（步骤 3，【backend-only】）

两个独立 raw stdio 客户端（`validation-a`/`validation-b`）对接 Q：

- `initialize`（protocolVersion `2025-11-25`）→ 服务端 `memorix 1.9.10`，双方协议版本一致；
- `tools/list`：**29 个工具**，本验证所需的 9 个工具全部在位（schema 原文已存档）；
- **stdout 协议噪声 = 0 字节**；EOF 后退出码 0/0；stderr 仅含 Node `ExperimentalWarning`（可接受）；
- 工具调用（join/status/poll/create/claim/list）全部按 JSON-RPC 关联正常往返。

证据：`evidence/step3-contract-smoke.json`、`evidence/step3-transcript.json`。

### 4.2 编号门禁（阻断 #1）

**结论：FAIL —— 原生 task-ID 往返断开。**

【backend-only】实测：

```
create → "Task created: e03590c8… \"<runId>:id-canary\" [role: engineer]"
claim(taskId="e03590c8") → "[ERROR] Task not found"   (isError=true)
list  → "[ ] e03590c8… \"...\" — unassigned [engineer]"
poll  → "[ ] e03590c8… \"...\""
```

【真实双端】复核（真实 OMP 客户端，同型调用）：

```
create → "Task created: a15d9928… \"<runId>:real-client-idcanary\" [role: engineer]"
claim(taskId="a15d9928…") → "[ERROR] Task not found"
```

**根因（固定提交源码）**：
- 所有 MCP 文本响应把 task_id 截断：`task.task_id.slice(0, 8)…`（`src/server.ts` 多处以 `Task created`/`list`/`poll` 形式出现）；
- 全链路**无 `structuredContent`**（任何返回值都不携带完整 UUID）；
- `claimTask` 精确匹配：`WHERE task_id = ?`（`src/team/team-store.ts`），8 位前缀必然查无此行。

**影响**：`team_task` 的 create→claim→complete 闭环、依赖门禁（deps）、唯一领取（race）均无法在原生返回面完成 → **职责分工 BLOCKED**。按计划条款：未注入 CLI 编号、未修改源码、未伪造成功。

证据：`evidence/step3-id-canary-corrected.json`（含修正分析：初版正则曾被描述文本中的 runId（本身是 UUID）误命中，已剥离复验为「全链路不可见完整任务 ID」）、`evidence/step7-a4-real-client-idcanary.json`（真实客户端原文）。

### 4.3 真实双端接入（步骤 4）

- **A 端（OMP）**：`P/.omp/mcp.json` → `/mcp list` 显示来源 `[project]`；`/mcp test memorix-validate` → **connected (29 tools)**；真实模型调用示例（`team_manage {action:status}`）返回 `No agents registered...`（尚未 join 时的正确空态）。证据：`evidence/step4-omp-probe.json`、`evidence/step4-omp-mcp-test.json`。
- **B 端（WorkBuddy 5.8.2）**：项目级 `P/.workbuddy/mcp.json` **不会被桌面版装载**（机制详见第 7 节）；改用产品面板用户级配置 ＋ 「信任」后：daemon 日志记录 `wb:mcp:approve → setEnabled → connect`，`[MCP-AuthDiag] stdio-connected {"id":"custom-mcp:memorix-validate"}`，面板显示 **29 个工具已启用**。
- 两端共同约束：只操作 P 的合成夹具与该服务；不上传聊天历史/思考/凭据；原生权限提示均由真人决定。

### 4.4 同项目发现与有限信息同步（步骤 5）—— ✅ PASS【真实双端】

**发现（互相可见）**：
- A（OMP）join：`omp-a` / engineer / `capabilities:["implementation"]` / `instanceId=<runId>:omp-a` / **agentId `896db84c-cb20-4d8b-bbb7-465af9990b0f`**；
- B（WorkBuddy）join：`wb-b` / reviewer / `capabilities:["artifact-review"]` / `instanceId=<runId>:wb-b` / **agentId `26b5f6ab-8df6-4fe4-a439-315554a8633a`**；
- 双方 `team_manage status` 均显示：`Team: 2 active / 2 total`，且各能看到对方的名称、角色、capabilities（A 端原文：`[active] wb-b (26b5f6ab) - reviewer [artifact-review]`）；
- **重复 join 不增殖**：同 instanceId 再 join 返回同一 UUID，总数保持 2。
- 说明：角色必须显式传入（`omp`/`workbuddy` 均不在 `AGENT_TYPE_ROLE_MAP` 中，缺省会落到 engineer）。

**有界消息**：
- `broadcast` 双向短标记：`<runId>:hello-omp`、`<runId>:hello-wb`（每条 <80 字符）；
- A 端 inbox 原文：`Inbox: 1 unread / 4 total`，其中 `[info] from wb-b: …:hello-wb`（对方标记、来源准确）；B 端亦看到 A 的 hello-omp。
- 注：broadcast 会投递给发送者自身（inbox 查询 `recipient IS NULL OR recipient=?`），因此双方 inbox 都含自己的标记 —— 已按来源逐条精确归因，不混淆。

**双向事实（主动读取，非推送）**：
- A 写入 `fact-a`（observation #1：`A reports January total 300`，`topicKey` 已设，`visibility=project`）；
- B 写入 `fact-b`（observation #2：`B reports February total 150`）；
- **B 读取 A 的 fact**：`memorix_search("…:fact-a")` → `memorix_detail` → 得到准确叙述与来源；
- **A 读取 B 的 fact**：`memorix_search("…:fact-b")` → `memorix_detail(obs:2@local/project-a)` → 原文 `Narrative: …:B reports February total 150 / Facts: - February total=150`。

证据：`evidence/step5-a0-omp-join.json`、`evidence/step5-a1a-discovery.json`、`evidence/step5-a1c-dupejoin.json`、`evidence/b1-roster-after-join.json`、`evidence/b2-fact-b-search.json`、`evidence/step5-a5-factb-readback.json`、`evidence/step8-a3-status-observe.json`、`evidence/screenshots/wb-b1-join-evidence.png`。

### 4.5 真实产物与交接（步骤 6）—— ✅ PASS【真实双端】

1. **B 创建真实文件**（WorkBuddy 自身文件能力）：`P/artifacts/wb-note.md`
   - 内容：`843bf14b-f974-459b-aa99-bf5b10a26fe5: January=300; February=150\n`（64 字节，一行 + 换行）
   - `sha256 = efd6cfa23ecb47122dc56f3fc4b5ef63c434e39d1447a0eab618598e869dcb7f`
2. **B 发布交接**：`memorix_handoff {summary:"<runId>:wb-artifact", filesModified:["artifacts/wb-note.md"], concepts:["dual-client-validation"]}`（无 toAgentId = 广播；无 taskId）→ 落为 observation #3。
3. **A 读取**：A 从自身 inbox 找到该 handoff 通知 → 搜索并 detail 读取交接（含 `Files Modified: artifacts/wb-note.md`）→ 用 OMP 原生 read 读取真实文件 → 获得精确内容（逐字节一致）。
4. **A 创建真实文件**：`P/artifacts/omp-review.md`
   - 内容：`843bf14b-f974-459b-aa99-bf5b10a26fe5: reviewed wb-note; January=300; February=150\n`（82 字节）
   - `sha256 = 94f0930356bbf4ef89f378642a627ef9ebadaa7078008c6cd422da2fec6ebfdc`
5. **A 发布交接**：`<runId>:omp-review` → observation #4；**B 读回**：B 搜索到 obs#4、按 filesModified 读取 `artifacts/omp-review.md`、逐字核对内容一致。

**边界声明**：Memorix 只承载引用元数据（路径/摘要），**不传输文件字节、不校验哈希**；文件字节确由两个产品的原生文件工具实际读写（两文件均在本机磁盘取证）。运行中曾发生过一次 Computer-Use 误粘贴污染 wb-note.md 编辑器缓冲的事故，已即时按原哈希恢复（64B / `efd6cfa2…`）并以磁盘校验确认；报告如实记录该插曲，最终交付物未受影响。

证据：`evidence/wb-note-hash.txt`、`evidence/step8-a3-status-observe.json`、`evidence/step5-a5-factb-readback.json`、`evidence/screenshots/wb-final-task-state.png`。

### 4.6 职责分工（步骤 7）—— ⛔ BLOCKED

因 4.2 门禁 FAIL（raw 与真实客户端双确认），未执行真实生产分工链（角色拒绝/依赖拒绝/唯一领取）。已完成的替代取证：真实 OMP 客户端的同型 create→claim 复现了同一 FAIL（见 4.2），证明客户端没有「额外的返回面」可以解除门禁。按计划：不手工中转 CLI/SQLite 完整 UUID 来伪造领取成功。

### 4.7 生命周期与协作状态（步骤 8）—— ✅ 主项 PASS；⚠️ 时间戳子项 BLOCKED

**离开 / 恢复 / 重连（B 端，【真实双端】）**：
| 动作 | 观察 | 结果 |
|---|---|---|
| `leave` | B 自报 `Left team. Active agents: 1`；观察端：`wb-b=inactive`，1 active / 2 total | ✅ |
| 同 instanceId 再 join | 返回**同一 UUID** `26b5f6ab…`；`2 active / 2 total` | ✅ |
| 产品级重连（真人在面板关闭→启用服务） | daemon 日志：新 `wb:mcp:connect` → `stdio-connected`（新子进程 pid 15852，2026-10-16T03:39:31Z）；再 join → **UUID 不变**、inbox 4 条消息全保留 | ✅ |
| 最终 leave（双方） | B、A 相继 leave；终态 `inactive/inactive` | ✅ |

**协作状态可见性**：
- **原生可见**：参与者名录（名称＋短 ID＋角色＋capabilities）、`active/inactive`、`active/total` 计数、任务列表、消息类型与来源（含 `[handoff]` 类型）；
- **B 自报阻断**：B 广播 `<runId>:blocked:fixture-only` → A 端 inbox 精确读到（`* [info] from wb-b: …:blocked:fixture-only`）；A 的表述限定为「B 自报的测试阻断」，**未**改写为「WorkBuddy 正在等待审批」（产品是否等审批保持未知）；
- **最近活动时间子项：BLOCKED —— `timestamp not exposed`**。实测：`team_manage status` 与 `memorix_poll` 的原生原始输出**不含任何** last-heartbeat/last-seen/最近活动时间字段（A 端原文确认；`status` 只含 `[active]/[inactive]`、名字、短 ID、角色、计数）。`last_heartbeat` 仅存在于**observer CLI**（【diagnostic-only】）可见的 JSON 字段中 —— 存储有此字段不等于原生状态面暴露，按计划记 BLOCKED，不加分。

证据：`evidence/b6a-after-leave.json`、`evidence/b6b-after-rejoin.json`、`evidence/b6c-after-reconnect.json`、`evidence/final-roster.json`、`evidence/step8-a-final-status-leave.json`、`evidence/observer-heartbeat-final.json`、`evidence/step8-a3-status-observe.json`。

### 4.8 长操作所有权安全（步骤 9）—— ⛔ FAIL

**设计**：Q 内建 `safety-owner`(engineer)/`safety-observer`(reviewer)/`safety-trigger`(reviewer)。owner 领取一个任务并锁定 `artifacts/safety-probe.txt`（只建锁记录），完成最后一次 `memorix_poll` 记 t0 后**停止心跳但保持 stdio 连接打开**，并维持一个未完成的本地延时操作；等待 >5 分钟后由全新客户端 `memorix_session_start(joinTeam:true)` 触发懒清理。

**实测时间线**（关键值）：

| 时刻 | 事件 | 数据 |
|---|---|---|
| t0 | owner 最后一次 poll | 心跳 1792069983365 → 1792069989504（**+6139ms，poll 推进心跳**，紧贴前后采样） |
| t0+313.098s | 满足 `300000 < elapsed < 600000` | 等待期开始前锚定任务、锁、连接三态 |
| 触发 | `session_start(joinTeam:true)` | 返回 `[RESCUE] 2 stale agent(s)…` |
| 触发后 | owner 状态 | **inactive**（被回收） |
| 触发后 | 任务状态 | **pending，assignee=NULL**（被释放／可被他人重复领取） |
| 触发后 | 文件锁 | **消失**（`No files locked`） |
| 触发时 | owner 连接 | **仍打开**（`exitCode=null`） |
| 触发时 | owner 本地操作 | **仍未完成**（`localOpStillPending=true`） |

**触发源核对（固定提交源码）**：`detectAndMarkStale`（TTL=5×60×1000ms）**仅**被 `memorix_session_start(joinTeam=true)` 调用；后台维护 worker 与 CLI 读取均不触发（全仓检索确认），故回收无混淆触发源。

**解读**：Memorix 的 stale 机制只以「是否 heartbeat」判定存活，不感知持有人在**其他通道**（模型/长任务）上仍在工作。任何持续 >5 分钟且不轮询的持有人在**任何**新会话 join 时即被回收 → 唯一的任务持有保护失效，重复执行风险真实存在。**按计划判定：FAIL / 自动协作采用阻断候选。**

**范围声明**：本试验验证的是「超过 5 分钟未 heartbeat 后，新 `session_start(joinTeam)` 的回收行为」，不是后台存活检测；raw 延时操作不等价于 WorkBuddy 的实际模型工作。若回收发生（已发生），即证明单靠该状态不足以保护可能继续进行的原生长操作。

证据：`evidence/step9-safety.json`（含前后 CLI 快照、连接证据、判定字段）、`evidence/step9-transcript.json`（全量 JSON-RPC 帧）。

---

## 5. 跨项目隔离反例（【backend-only】）

- 构造：Q 的 raw 客户端与 P 共享**同一 data dir**（D），但项目不同（`local/project-b` vs `local/project-a`）。
- 结果（两轮验收，第二轮在两事实均已写入后复测）：
  - 搜索 P 的 `fact-a`/`fact-b` 标记 → **无结果**（返回的仍是「本会话暂无可用记忆」的空态文本）；
  - `team status` 与 `poll` 不含 `omp-a`/`wb-b`；
  - 正控制：同一搜索在 P 内可检出两条事实 → 证明「查不到」不是搜索功能失效。
- **判定：PASS** —— 默认项目范围下无跨项目泄漏。

证据：`evidence/step5-cross-project.json`、`evidence/b2-fact-b-search.json`。

---

## 6. 五项分级最终结论

| # | 目标 | 期望 | 实测（摘要） | 判定 | 层级 |
|---|---|---|---|---|---|
| 1 | 同项目发现 | 互相发现且不增殖 | 2/2 活跃、角色与 capabilities 互见、重复 join 稳定 | ✅ PASS | 真实双端 |
| 2 | 有限信息同步 | 双向、内容与来源准确 | fact-a ↔ fact-b 双向 search+detail 精确读取；hello 标记双向 | ✅ PASS | 真实双端 |
| 3 | 真实产物引用 | 字节级一致、引用可解析 | 两文件原生读写、哈希核验、交接链路双向闭环 | ✅ PASS | 真实双端 |
| 4 | 职责分工 | 角色/依赖/唯一领取闭环 | 编号门禁 FAIL（前缀不可 claim） | ⛔ BLOCKED | 真实双端 + backend-only |
| 5 | 协作状态 | 名单/角色/状态/自报阻断/最近活动 | 除「最近活动时间」外全部可见；时间戳原生不暴露 | ⚠️ 部分 + 子项 BLOCKED | 真实双端 + diagnostic-only |
| ＋ | 长操作所有权安全 | 未结束的长操作不被回收 | 313.098s 后连接仍开的持有人被回收（任务+锁释放） | ⛔ FAIL | backend-only |

**采用判定（按计划条款）**：任一原生必需项 BLOCKED/FAIL、或长任务所有权安全 FAIL，都不能宣布可直接采用 → **本候选（memorix@1.9.10 的团队协作面）不宜作为 OMP×WorkBuddy 协作的直接依赖**。结论是候选验证的如实交付，不是对供应商的修复建议。

---

## 7. 环境特异发现：WorkBuddy 桌面版 5.8.2 的 MCP 装载机制

> 该发现由独立 slow 模型 investigator（只读反汇编/日志/数据库取证，未改任何产品状态）得出，父进程复核关键日志。

**结论：桌面版 5.8.2 不会读取 `<工作区>/.workbuddy/mcp.json` 进入任务会话的 MCP 配置。** 两道边界：

1. **桌面聚合器无「本地工作区」MCP 提供者**。桌面为会话构建 MCP 配置时只收集已注册来源：用户级（面板编辑的 `~/.workbuddy/mcp.json`）、第一方、连接器（connector）、Buddy/应用、插件（plugin）。不存在读取工作区 `mcp.json` 的 provider。
2. **子进程以 `--strict-mcp-config` 启动**，该模式显式阻断文件系统级作用域。真实任务日志原文（P 的任务，pid=14120）：
   ```
   scope=plugin  blocked by strict MCP config
   scope=user    blocked by strict MCP config
   scope=project blocked by strict MCP config
   scope=local   blocked by strict MCP config
   ```
3. **实派分派证据**：该会话实际注入子进程的 `mcpConfig.mcpServers` 恰为 6 个内置服务（`connector-proxy / agent-mail / genie-baas / space-library / weixinpay / sheetagent`），**无 `memorix-validate`**；`projectMcpCount:0`。而工作目录确为 P（sandbox `OpenSession: workingDir=P` 成功），排除「选错目录」。
4. **信任弹窗不是原因**：工作区信任的触发条件是 `<目录>/.codebuddy` 存在（P 无此目录，故不弹、也不受限）；信任只影响 Bash/设置来源限制，**不移除** strict 模式、不新增 project MCP 来源。
5. **可用的接入路径（已实操验证成功）**：产品面板 **插件 → 连接器 → 自定义连接器 → MCP 服务管理 → 添加 MCP**，其编辑器读写路径为 `C:\Users\FKCZ3\.workbuddy\mcp.json`（用户级、全局生效）；保存后对新条目点击**「信任」**（文案：*首次连接此 MCP 服务需要您的信任确认。*），审批落盘于 `mcp-approvals.json`（按配置哈希记账），随后 `stdio-connected`。限制：**该入口是全局用户级，参数硬编码指向 P，非项目级隔离注册**。
6. 技术勘误（影响报告措辞）：本轮子进程参数为 `--mcp-config=<内联 JSON, len=9412> --strict-mcp-config`（并非落盘文件）；仅在 Windows 命令行超 30,000 字符时才压缩为临时文件。
7. 官方文档（workbuddy.cn 的中文指南）宣称项目级路径 `<项目目录>/.workbuddy/mcp.json` —— **与本机已安装桌面版 5.8.2 的实现不符**；以实际实现与运行日志为准。

**对「同项目自动发现」目标的含义**：本轮的「发现」在 Memorix 层完全成立，但**接入层不对等** —— OMP 原生支持项目级 MCP 配置，WorkBuddy 桌面需要用户级注册。这属于两个产品各自的 MCP 装载机制差异，是本验证对项目方向的一手实测输入（详见第 8 节）。

证据：`evidence/wb-investigation.md`（394 行，含 asar 字节偏移与日志行号引用）、`evidence/step5-cross-project.json` 无关但同根；产品日志在 `C:\Users\FKCZ3\.workbuddy\logs\`（外部引用）。

---

## 8. 对 OMP-WorkBuddy 项目方向的启示

基于以上实测（而非文档）：

1. **可复用的协作底座**：Memorix 的「同项目发现 + 项目可见事实 + 交接引用 + 身份生命周期」四项在真实双端下工作正常且隔离正确 —— 可作为「互通产物、同步有限信息」的候选底座。
2. **不可依赖「任务领取」链路**：1.9.10 的 MCP 返回面不提供可用任务标识；若未来采用该协作层，「按职责分工」必须另寻机制（或等待上游修复编号暴露）——不要把 create→claim 写进任何自动化。
3. **长操作需要保活设计**：任何 >5 分钟不轮询的持有都会被回收。若采用该层的任务/锁语义，必须自带周期性 `memorix_poll` 保活，或接受「任务可被抢占、需幂等」的事实。
4. **接入层要按产品分别处理**：OMP 项目级 `mcp.json` 即插即用；WorkBuddy 桌面 5.8.2 需要用户级注册（非项目级）——「自动发现」的部署文档必须写明这一差异，或等待 WorkBuddy 版本演进。
5. **状态可见性边界**：原生面不暴露活动时间戳；如需「最近活动」能力，只能经由 CLI/旁路，不要把它列为原生状态同步能力。

---

## 9. 证据索引（R = 验证根）

**协议与门禁**
- `R\evidence\step3-contract-smoke.json` — 双 stdio 客户端完整握手/工具目录/噪声/退出码
- `R\evidence\step3-id-canary-corrected.json` — 编号门禁修正分析（含误命中修正说明）
- `R\evidence\step7-a4-real-client-idcanary.json` — 真实 OMP 客户端的同型复现
- `R\evidence\step3-transcript.json` — 全量 JSON-RPC 帧

**双端会话**
- `R\evidence\step4-omp-probe.json`、`R\evidence\step4-omp-mcp-test.json` — OMP 连接与真实工具调用
- `R\evidence\spool\OUT-*.json` — 每轮真实 OMP 调用的原始工具记录（A0/A1a/A1c/A4/A5/A2/A3/final）
- `R\evidence\step5-a0-omp-join.json`、`step5-a1a-discovery.json`、`step5-a1c-dupejoin.json`、`step5-a5-factb-readback.json`
- `R\evidence\b1-roster-after-join.json`、`b2-fact-b-search.json`、`b6a-after-leave.json`、`b6b-after-rejoin.json`、`b6c-after-reconnect.json`、`final-roster.json`
- `R\evidence\step8-a3-status-observe.json`、`step8-a-final-status-leave.json`

**产物**
- `R\project-a\artifacts\wb-note.md`（sha256 `efd6cfa2…`）、`R\project-a\artifacts\omp-review.md`（sha256 `94f09303…`）
- `R\evidence\wb-note-hash.txt`

**安全与隔离**
- `R\evidence\step9-safety.json`、`R\evidence\step9-transcript.json`
- `R\evidence\step5-cross-project.json`、`R\evidence\manifest.json`、`R\evidence\home-before-snapshot.json`、`R\evidence\host-home-check-step2.json`
- `R\evidence\observer-heartbeat-final.json`（observer-only 时间戳字段）

**调查与人工手册**
- `R\evidence\wb-investigation.md` — WorkBuddy 桌面版 MCP 装载机制调查（独立 investigator）
- `R\evidence\workbuddy-runbook.md` — B 端人工操作手册（B1–B6）
- `R\evidence\screenshots\wb-b1-join-evidence.png`、`wb-final-task-state.png` — 真实产品界面记录

---

## 10. 限制与未决项

- 「职责分工」为 BLOCKED 而非「已证伪」：门禁堵住了该链路，未能在真实双端上运行角色/依赖/竞争的完整对照，因此对「若编号可用时这些语义是否正确」不持结论。
- 长操作安全试验在 raw 层（Q）执行：它证明的是**协作层语义**（心跳判定回收），不等价于 WorkBuddy 实际模型长任务的字节级行为；但对「采用该协作层」的风险判定足够（同一 TTL 同样作用于真实双端登记）。
- WorkBuddy 桌面版调查针对 5.8.2 与随附 CLI；结论不覆盖其它版本/发行方式。
- 本轮不修供应商、不向当前工程移植探针；验证根 R 全部保留（夹具、锁残留、pending 测试任务均为取证对象，未清理）。
- 宿主环境未被改动：真实 home 未生成 `.memorix`；WorkBuddy 的用户级 `mcp.json` 为本次验证人工添加的一处**产品配置**（在 R 之外，属接入前提），若需回退可由用户删除该条目。
