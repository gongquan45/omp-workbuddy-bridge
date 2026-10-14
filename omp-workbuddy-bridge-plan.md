# OMP 主导的 WorkBuddy 原生任务委派

## Context
用户主要使用 OMP 编程与处理通用任务、使用腾讯 WorkBuddy 调研/办公/设计，需要在同一项目免去人工复制背景与成果。用户已选择“主要在 OMP 中自动委派 WB”：OMP 是父任务入口，WB 是专业子任务执行者。实现要调用 WB 桌面端已启动并完成宿主配置的真实 Agent 会话，而不是把现有 WorkBuddy2API 模型连接或一个普通 CodeBuddy CLI 当成完整 WorkBuddy。

## Approach
### 1. 建立原生 OMP 扩展，不另起 MCP 服务
在 `<repository-root>/` 新建 Bun/TypeScript 工程（该目录现仅含本计划文件 `omp-workbuddy-bridge-plan.md`，工程文件与之共存，不要清空目录或另选落点），包名 `omp-workbuddy-bridge`，`private: true`、`type: module`，`omp.extensions: ["./src/index.ts"]`。文件分工固定为 `src/index.ts`（OMP 工具/命令与交互批准）、`src/desktop-client.ts`（发现和连接 WB ACP）、`src/acp-http.ts`（WB Streamable-HTTP 传输）、`src/tasks.ts`（任务资料、状态、产物、互斥）。没有本地等价实现；社区 `workbuddy-mcp` 只包装普通 CLI，默认跳过权限且没有原生会话复用，不作为此次运行后端。

复用 `<reference-extension-root>/src/index.ts` 已读取的默认 `activate(pi: ExtensionAPI)`、`session_start`、`ctx.hasUI` 模式及其 `package.json#omp.extensions` 包入口约定，但不修改该相邻工程。工具参数使用宿主提供的 `pi.zod`；OMP 引入仅用 `import type`。运行依赖固定 `@agentclientprotocol/sdk: 1.8.0`、`zod: 4.6.7`；开发依赖固定 `@oh-my-pi/pi-coding-agent: 18.10.3`、`@types/bun: 1.4.2`、`typescript: 5.9.3`。`scripts.test = "bun test"`、`scripts.typecheck = "tsc --noEmit"`；TS 配置使用 strict、ESNext、moduleResolution bundler、noEmit 和 Bun types。

选 OMP 原生扩展是因为本次只有 OMP 一个调用方，且必须在 OMP 的真实 UI 中批准 WB 权限/计费请求。已核实 OMP 的 `ctx.ui.approve`、`confirm`、`select`、`input` 可用；不能假定 MCP elicitation 已支持（官方 issue #12471 仍 open）。不加入 Memorix、数据库同步、反向调用、独立 HTTP 控制面或额外模型连接。

### 2. 用真实桌面 worker 的 ACP v1 会话协议派发任务
在该模块定义 `Binding = {version: 1; projectRoot: string; sessionId: string; workbuddyVersion: string}` 与 `DesktopCallbacks = {onUpdate(params: acp.SessionNotification): Promise<void>; onRequest(method: string, params: unknown): Promise<unknown>}`；SDK 的已验证请求进入 onRequest，由第 4 节原生 UI 按具体方法解析/批准，未知请求 fail closed。`desktop-client.ts` 内部模块接口固定为：
- `connect(binding: Binding, callbacks: DesktopCallbacks, signal: AbortSignal): Promise<DesktopSession>`
- `DesktopSession.prompt(text: string): Promise<{stopReason: string; errorMessage?: string}>`
- `DesktopSession.cancel(): Promise<void>`
- `DesktopSession.close(): Promise<void>`

复用 ACP SDK 的非弃用 `client({name: "omp-workbuddy-bridge"})`、`onRequest`、`onNotification`、`connectWith`、`methods`、`PROTOCOL_VERSION`，不使用已弃用的 `ClientSideConnection`，也不启用实验 ACP v2。

WB 桌面 worker 的传输是 `http://127.0.0.1:<port>/api/v1/acp`。在 `acp-http.ts` 实现 SDK 的 `Stream`（`readable: ReadableStream<AnyMessage>`、`writable: WritableStream<AnyMessage>`），使用以下已核实的 WB 契约：
- POST `/api/v1/acp/connect` 返回 `connectionId`/`sessionToken`；后续带 `X-CodeBuddy-Request: 1`、`acp-connection-id`，服务返回 token 时同时带 `acp-session-token`，全部仅驻内存。
- POST `/api/v1/acp` 发 JSON-RPC 消息；Accept 同时接受 `application/json` 和 `text/event-stream`；支持 JSON 响应及 `event: message`/`data: <JSON-RPC>` SSE，合并同一事件的多行 data，忽略注释/其他事件，使用流式 TextDecoder 处理跨块 UTF-8、LF/CRLF 与拆分空行。每个完整 JSON-RPC 对象入 SDK readable。
- Writable 的 write 只等到 HTTP 头已收到并启动响应 pump，不能等整个 prompt 的 SSE 结束，否则 SDK 发回权限应答会死锁。POST pump、可选 GET `/api/v1/acp` 的异步通知流均归该连接的 AbortController；请求失败使 stream error，而不是返回一个伪完成结果。
- 关闭仅 DELETE `/api/v1/acp` 释放本扩展 connection，取消/关闭不得 terminate worker、daemon 或别的 WB 会话。

不直接使用 SDK `createHttpStream`：已读 `src/http-stream.ts` 的 initialize 路径要求 JSON 响应，而本机 WB 契约允许 SSE initialize；HTTP transport 本身也属于 SDK experimental export。没有已确认兼容本机 WB 的现成公开 transport，因此只在这个模块实现差异，JSON-RPC 路由、ACP 请求/验证仍用 SDK。

initialize 精确传 `{protocolVersion: acp.PROTOCOL_VERSION, clientInfo:{name:"omp-workbuddy-bridge",version:"1.0.0"}, clientCapabilities:{}}`，不声明未实现的远程文件系统或 terminal；标准权限请求通过已注册的 handler 处理，额外 elicitation 请求仅按实际协商能力/明确方法处理。必须校验 agent protocolVersion 与 load/resume capability；优先 `session/resume`，不支持时用标准 `session/load {sessionId, cwd: projectRoot, mcpServers: []}`。load 历史只用于恢复连接，不并入 OMP 上下文或产物。目标 UUID 不匹配、服务器仅支持新建会话或协议不兼容时返回 `WB_PROTOCOL_UNSUPPORTED`，不退回其他用户会话或通用 CLI。

prompt 使用 `session/prompt {sessionId, prompt:[{type:"text",text}]}`。只把 `agent_message_chunk` 汇总到回复，把 `tool_call`/`tool_call_update` 用作进度；不把 `agent_thought_chunk` 保存或传给 OMP。`session/cancel` 发无 id notification，params 仅绑定 UUID。网络断开记 `interrupted`，保留已收到回复和文件，不自动重发任务（防止重复写文件、重复付费）。

### 3. 绑定一个专用桌面 WB 会话，禁止接管任意已有会话
**unverified — confirm first：**本轮未启动真实业务会话，尚未验证外部 ACP 能在保留宿主插件/权限的情况下 load/resume 专用桌面会话。先用第二节客户端在初次绑定时完成此验证；拒绝附着时停止并报告契约缺口，不能把一般 CLI 或其他会话当成替代。

注册唯一命令 `/wb`，支持 `bind` 与 `status` 两个子命令。绑定按 OMP 当前 `ctx.cwd` 的 realpath 区分项目，写 `<projectRoot>/.wb-bridge/binding.json`，精确字段：`{ "version": 1, "projectRoot": "<absolute real path>", "sessionId": "<WB UUID>", "workbuddyVersion": "5.8.2" }`。不保存端口、登录凭证或原始对话。

初次 `/wb bind` 在原生 UI 明示：用户需在 WB 桌面端选择同一项目目录，创建“OMP 委派专用”会话，先发送“仅确认当前工作目录，不修改文件，等待后续任务”，使桌面端完成 worker、技能、插件和宿主凭证注入。不要通过普通 CLI 冷启、`session/new`、修改 WB 安装包、复制宿主环境变量或读取 sidecar ticket 代替这一步。专用会话由 WB 启动后，后续任务在 OMP 发起；WB 仅需保持运行，并在 worker 被回收后重新打开该专用会话。

发现实现放在 `desktop-client.ts`：
1. 从 `~/.workbuddy/logs/<date>/*.log` 的 `WorkerRegistryLifecycle` 日志提取 `Worker registered with endpoint: http://127.0.0.1:<port>`。在同一 worker 启动记录中关联 `--session-id`/`--session-id=` 与 cwd；只提取这些字段，不复制整行 argv/env（可能含秘密）。读取日志从新到旧；候选以 endpoint 去重。
2. 只允许 URL 的 hostname 为 `127.0.0.1`、协议为 `http:`、无账号信息且端口合法；不做全端口扫描、不跟随跨源重定向。每个候选先 GET `/api/v1/health`、`/api/v1/info`、`/api/v1/status`，请求均带 `X-CodeBuddy-Request: 1`，逐个请求 3 秒超时。兼容本机旧响应对象与公开文档的 `{data: ...}` 成功封套；`{error: ...}` 必须报错。通过 info 的 cwd realpath、日志 UUID、status 中可用的 session 标识交叉确认，字段缺失/互相矛盾的候选不纳入绑定。
3. 显示已验证的同项目会话候选（UUID、工作目录、端口），让用户显式选择专用会话。无候选时给出上述唤醒操作，不默选最新 worker；多候选时同样必须选择，不绑定用户原有私人会话。
4. 用 ACP initialize 与加载同一 session 验证绑定，再保存。原绑定存在时显示精确旧/新 UUID，由用户确认替换；取消保持原文件不变。

每次发新任务重新发现并探活匹配已绑定 UUID 的 worker；status.busy 为 true 时返回 `WB_BUSY`，不打断桌面用户已发起的任务。端口轮换只更新内存 endpoint，绝不更换 sessionId。无匹配返回 `WB_SESSION_NOT_RUNNING`，提示重新打开专用会话；401/403 返回 `WB_AUTH_REQUIRED`，交由用户完成 WB 原生登录/授权，不关闭服务认证、不抓取密码或 ticket。当前本机曾探测的 worker 均已被回收，所以首次执行必须做此绑定，计划阶段未完成业务连接。


### 4. 把 WB 安全检查留在 OMP 的真实交互 UI
在 `index.ts` 连接回调中处理标准 `session/request_permission`：展示任务、工具、精确目标与请求详情；有 `ctx.ui.approve` 时使用它，否则使用带“拒绝/仅此次批准”的 `ctx.ui.select`。只允许显式人类批准后，返回服务器提供的 allow-once optionId；不选择 allow_session、allow_always 或其他持久授权。拒绝/ESC/Abort/headless/没有一次性允许选项均返回 cancelled 或服务器 reject optionId，不能推荐超时默认批准。使用真实工具调用上下文中的 signal；不设置批准超时默认值。

WB 的 `interruption_request` 与标准 request_permission 可能表示同一个检查；以 sessionId + toolCallId/request ID 去重。确需私有通知应答时，按已读取的 `_codebuddy.ai/resolveInterruption {sessionId,toolCallId,decision,answers}` 契约回应，只在交互 UI 获得对应选择后发送；不能由模型自行调用一个“批准”工具。

处理 `elicitation/create` 时，把 form 的标题、字段说明、枚举选项显示在真实 UI，逐字段用 `input`/`select` 收集答案，最后显式确认才返回 accept；取消返回 cancel。只接受能明确渲染的字符串、数值、布尔与枚举字段；复杂/未知 form 或 URL 授权让用户在 WB 原生窗口处理，返回 `WB_APPROVAL_UNSUPPORTED` 并停止任务，不猜答案或伪造授权完成。计费生成、权限授予、发布/发送等仍必须在发生前明确批准；不会因为这个方案获批而永久放行。

不设置 `--dangerously-skip-permissions`、不改 WB 现有权限模式、不注入 `CODEBUDDY_IS_SANDBOX` 或关闭身份验证。WB 桌面自身的宿主策略与本扩展的交互审批是不同层；cwd、prompt 的写入范围都不是 OS 安全沙箱，文案不得误称已硬隔离。

### 5. 用三个 OMP 工具完成上下文交接、长任务和结果回收
在 `index.ts` 注册且只注册：
- `wb_task({prompt: string, inputFiles?: string[], expectedOutputs?: string[], taskId?: string})`
- `wb_status({taskId: string, waitMs?: number})`（默认 1000，范围 0–30000）
- `wb_cancel({taskId: string})`

当前 OMP cwd 必须对应已绑定项目；不暴露任意 cwd 参数。新任务 UUID 由 `crypto.randomUUID()` 生成，状态目录固定 `<projectRoot>/.wb-bridge/tasks/<taskId>/`，含 `brief.md`、`inputs/`、`outputs/`、`receipt.json`。inputFiles 为项目内真实普通文件的相对路径：realpath 后拒绝逃出项目、目录、缺失文件；保留其相对层次拷贝到 inputs，不拷贝整个项目、聊天历史或用户凭据。expectedOutputs 是 outputs 内相对文件名，拒绝绝对路径和 `..`；不与用户源码重名覆盖。没有 inputs/outputs 时允许纯咨询并返回实际 WB 回复。

brief 写任务目标、输入快照路径、预期成果、验收条件，要求 WB 输出只落本任务 outputs，并要求最终回复列真实产物；禁止反向调用 OMP、改源码、自动发布/发送或批准自身权限。此处是任务分工，不声称安全沙箱。prompt 只携带 brief 路径和本次明确指令，让 WB 使用原生技能/插件，不附加整段 OMP 对话。

receipt 的唯一 schema：`{version:1, taskId, sessionId, projectRoot, status, prompt, inputFiles, expectedOutputs, summary, artifacts, error}`；status 为 `running | awaiting_approval | completed | failed | cancelled | interrupted`，artifacts 为已存在普通文件的绝对路径数组，error 为 null 或 `{code,message}`。binding/receipt 原子写入，禁止放 token、环境变量或私有思考。新任务投递成功即返回 taskId/running，不占用一个长工具调用等完整调研；后台结果落 receipt，`wb_status` 返回状态、精炼真实回复、真实产物路径，OMP 自己用 read/文档工具消费产物。

完成以 ACP prompt 最终 result 为依据：只有 stopReason=end_turn 且无 errorMessage、所有 expectedOutputs 实际存在才记 completed；少产物返回 `WB_OUTPUT_MISSING`/failed，保留已生成文件，不以一句“完成了”、exit 0 或任意非空日志判成功。native canvas/远端设计成果可保留在 WB 的真实最终回复中，但不把它假装成已导出的本地文件；要求本地 PNG/PDF 时必须真实导出并验收。

`taskId` 用于同一个既有任务的明确补充要求：复用绑定 WB 会话与该任务文件夹，更新 brief，不能 silently 重跑原指令。只有终态任务允许补充；running/awaiting_approval 时返回 `WB_BUSY`。同项目同时只允许一个任务：`active.lock` 用原子 exclusive create，记录 adapter owner PID 与 taskId，终态释放；活 owner 则拒绝第二任务，死 owner 的旧任务标 interrupted 后才释放，不重放。新 OMP 会话可读取旧终态 receipt，不能自动恢复断线的正在运行操作。

`wb_cancel` 仅取消本扩展拥有的任务，再记 cancelled；重复取消返回既有终态，不删除文件。OMP `session_shutdown` 时取消本扩展未完成任务、关闭本连接并清除状态栏，不杀 WB worker；状态栏通过 `ctx.ui.setStatus("workbuddy", ...)` 展示 running/awaiting_approval/完成，不追加每个 token 到 OMP 聊天。工具描述明确按需用于调研/办公/设计，返回路径后 OMP 继续自己的任务；这是实际调用入口，不是只有工具名的占位实现。

### 6. 真实能力验收后启用日常加载
先显式 `-e` 加载，不更改当前运行的 OMP。通过下一节真实任务与审批验证后，在 `~/.omp/agent/config.yml` 的已有 `extensions` 数组追加 `<repository-root>/src/index.ts`，保留原项；若尚无数组则新增该键。若有禁用该路径的配置，应精确移除本扩展对应项，不删除其他禁用规则。重启一个 OMP 会话确认工具与 `/wb` 都存在。

不修改当前 `models.yml` 的 `workbuddy-openai`/`workbuddy-claude`（127.0.0.1:8790）、现有 `mcp.json` 的 markitdown 服务，亦不改变 WB 登录/安全/插件配置。跨项目使用在各项目运行 `/wb bind`，不共享一个专用会话到所有项目。

## Critical files & anchors
- `<workbuddy-install>/resources/app.asar.unpacked/cli/bin/codebuddy`：lite-wb/prewarm/serve 分流；普通 node --help 已实际报 `Cannot find module '../dist/codebuddy'`，不要拿这个命令冷启后端。
- WB 安装归档 `<workbuddy-install>/resources/app.asar` 中 `cli/dist/codebuddy-lite-wb.mjs`（部分资源可在 `.asar.unpacked`）：ACP 控制器、AcpConnectionGuard、WorkerRegistryLifecycle、interruption/approval、status；实现前按当前安装版本复读这些契约，不提取/改安装包。专用 read 工具有整包提取 199.5MB editor_sdk.exe 失败，可用只读 ASAR header/offset 文件切片读取必要文本。
- `~/.workbuddy/logs/<date>/*.log`：同一 worker 的 launch sessionId/cwd 与 endpoint 关联；不能只取最新端口。不要把含完整 argv/env 的行存入日志或发送给模型。
- OMP `packages/coding-agent/src/extensibility/extensions/types.ts`：`registerTool` execute 的上下文、`ctx.hasUI` 与 `ui.approve`；使用实际安装的 18.10.3 类型，main 文档已读但不是本机类型的替代。
- ACP SDK `src/examples/http-client.ts` / `src/http-stream.ts`：复用 fluent client/handlers，避免示例的“默认选第一个批准选项”与 transport 的 JSON-only initialize 假设。

## Verification
### 运行前提和命令
执行阶段安装仅本工程依赖。工作目录 `<repository-root>`：`bun install`，再运行 `bun test test/acp-http.test.ts test/tasks.test.ts test/approval.test.ts` 与 `bun run typecheck`。独立测试采用本地可控 ACP Agent/HTTP fixture，不调用真实模型、WB 账号或收费功能。

新增永久测试只覆盖 consumer-visible 边界：
- JSON 与 SSE initialize 均能完成真实会话协议；SSE 跨块中文、多行 data/CRLF，且收到 permission request 后可在原 prompt 未结束时发回拒绝，不卡死。
- 未显式批准、headless、ESC 或取消时绝不发送 allow_once；拒绝一次不应变为 allow_session；重复 permission/interruption 只问一次。
- 两次并发任务不得同时写同一 outputs；相对路径逃逸/输入 symlink 指向项目外被拒；end_turn 少产物必须 failed；断流后记录 interrupted，不重复提交原 prompt。
不写单纯注册/转发/mock 回声或源文本断言测试。

### 原生端到端证明（不能用上述测试代替）
建立 `<repository-root>/smoke-workspace/`，放 `input/sales.csv`：`month,product,revenue` 三行分别 `2026-01,A,100`、`2026-01,B,200`、`2026-02,A,150`。从该工作区启动：
`omp --cwd <repository-root>/smoke-workspace -e <repository-root>/src/index.ts`。

在 WB 用同工作区创建专用会话并完成 `/wb bind`；绑定 UI 必须显示准确 cwd/UUID，找不到时完成唤醒后再绑定，不对用户其他会话发消息。随后在这个 OMP 交互会话中依次验证：
1. **调研**：交给 WB 对比 SQLite/DuckDB 用于嵌入式本地数据分析的差异，要求使用原生研究流程、引用两者官方资料、保存 `comparison.md`；通过 wb_status 得到真实文件，OMP 读取后能基于其具体结论给出选型理由，无复制聊天文字。观察真实 WB 工作流/工具事件及报告来源，不能只看返回文本。
2. **办公**：输入 sales.csv，交给 WB 原生办公能力生成两页 `sales.pptx`（首页按月份汇总，第二页按产品汇总）。用 WB 正常预览并核对月份合计 300/150、产品合计 A=250/B=200；OMP 能读到真实产物路径。不得用 generic Python 生成一个近似文件冒充用户依赖的 WB 原生能力。
3. **设计**：通过用户已授权的 WB 原生设计工作流制作虚构书店活动海报并导出 `poster.png`，确认真实设计画布/产物可打开，OMP 能查看导出的文件。日志曾出现 Ardot 401，不能据此宣称当前可用/不可用：遇到授权错误由用户在 WB 正常授权后再验。涉及计费时必须当场交互确认；未批准就拒绝，不能自动扣费或用 HTML/占位图替代。
4. **安全与取消**：真实 WB 发出一次待批准操作时，在 OMP 选择拒绝，观察对应工具没有执行；重新发一个任务，在运行中 wb_cancel，只目标任务终止，WB 进程和专用会话仍在，其他 WB 会话不受影响。
5. **交接延续**：结束并重新启动 OMP，读取上一条终态 receipt，直接消费已有报告/PPT/图片；一次后续补充任务使用原 taskId，WB 能在同一专用会话据已有资料完善成果。随后回收/关闭该 worker，下一次调用应 `WB_SESSION_NOT_RUNNING` 而不是转投别的会话。

记录实际执行的结果和未满足的前提。只有调研、办公、设计、权限和文件交接均有真实证明时才宣称完整专业委派已完成；服务连通、模型回复和 TypeScript 检查都不等于这些能力通过。

## Assumptions & contingencies
- 用户选择 OMP 主入口，因此采用原生扩展而不是通用 MCP 服务。共享仅为任务 brief、显式输入与成果，不同步两套私人聊天或内部记忆；如未来需要多个调用产品，再单独变更接口范围。
- 使用 WB 桌面 5.8.2 + OMP 18.10.3 为已观察基线；公开 CodeBuddy HTTP 文档标记 Beta、ACP v1 是公开协议，但“外部客户端附着桌面已配置会话”的生命周期没有桌面稳定性承诺。版本不匹配时先只读检查 health/info/initialize 与批准形状；兼容则正常运行，否则 `WB_PROTOCOL_UNSUPPORTED`，不猜新契约或修改安装包。
- 独立 CLI 不作为自动 fallback。绑定会话尚未启动、已被回收、缺插件或账号授权时，返回明确前提错误并保留可交接资料；原生授权完成后重新调用。若桌面 worker 明确拒绝外部加载专用会话，实施停止在准确契约缺口，不安装普通 CLI 并声称替代完成；需用户另行选择接受较窄的 CLI 能力或桌面 UI 自动化路线。
- 一项目一个专用 WB 会话、一次一个专业任务，是默认写入责任分工。用户以后要并行多个 WB 专家时须另行选择多个专用会话，不能直接去掉互斥。

## 已读来源
- https://www.workbuddy.ai/docs/cli/http-api （公开 REST/ACP、Beta、认证和 `X-CodeBuddy-Request`）
- https://www.workbuddy.ai/docs/cli/reference 与 /cli/daemon
- https://github.com/LinHaiJ/workbuddy-mcp （README 与 server.js）
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/extensions.md
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/extension-loading.md
- https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/extensibility/extensions/types.ts
- https://github.com/agentclientprotocol/typescript-sdk （package.json、src/acp.ts、src/examples/http-client.ts、src/http-stream.ts）