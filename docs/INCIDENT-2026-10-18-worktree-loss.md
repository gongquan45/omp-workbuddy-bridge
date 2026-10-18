# 事故报告：omp-wb-bridge 工作树清空事件

**报告编号**：INC-2026-10-18-01
**项目**：omp-wb-bridge（`omp-workbuddy-bridge`）v2.1.0 正式版开发
**严重级别**：SEV-1（工作树完全丢失，含不可恢复的本地提交历史）
**报告时间**：2026-10-18
**状态**：已遏制、已恢复基线、增量移植进行中

---

## 1. 摘要

2026-10-18 16:43（本地时间），项目工作树 `E:\Desktop\OMP-WorkBuddy` 的全部内容——包括 `src/`、`test/`、`skills/`、`docs/`、构建配置与 `.git` 版本库——被删除。目录本身仍然存在但为空。

**根因已确证**：本项目为 v2.1.0 阶段编写的测试文件 `test/queue.test.ts`、`test/migration.test.ts`、`test/logging.test.ts` 使用了模块级变量 `let root = ""` 配合 `afterEach` 中的 `await rm(root, { recursive: true, force: true })`。当 `beforeEach` 因该文件自身的编译错误（`tmpdir()` 未导入、`node:child_process` 导入不存在成员等）未能完成赋值时，`afterEach` 仍会执行；此时 `root` 为空字符串，`rm("")` 解析到**进程当前工作目录**——即 `bun test` 的启动目录，也就是仓库根目录。`force: true` 抑制了"路径不存在"等错误，使删除静默完成。

**事故不是外部工具、不是 Git 操作、不是文件系统故障、不是 junction/重解析点问题。** 上述三种替代假设均在本会话中被逐一证伪并撤回。

**关键减轻因素**：项目远端仓库 `https://github.com/gongquan45/omp-workbuddy-bridge` 完好，`main` 分支停在 `9f01805`（2026-10-16 20:49），包含完整的 v2.0.0 基线。该基线已被重新克隆并验证：**typecheck 零错误、185 项测试通过 / 1 跳过 / 0 失败**。

---

## 2. 时间线

| 时间（本地） | 事件 |
|---|---|
| 2026-10-13 18:32 | 工作树目录创建；项目基线 `0941616` |
| 2026-10-14 23:00 | 基线提交 `0941616 chore: establish versioned project baseline` |
| 2026-10-16 19:27 | `4df70b5 feat(v2): … task store v2` — v2.0.0 主体 |
| 2026-10-16 20:33 | `a0f9d50` 忽略研究文档 |
| 2026-10-16 20:49 | `9f01805` 忽略内部计划文件（**远端 HEAD**） |
| 2026-10-17～18 | v2.1.0-beta 开发：多会话池、按会话锁、动态 MCP 门禁（本地提交 `c84ec0c`、`69d937b`、`b1ee736`，**从未推送**） |
| 2026-10-18 | v2.1.0 正式版计划执行，阶段 1（`6a78e56`）、阶段 2（`ba5c012`）、仲裁加固（`4177f05`）依次本地提交 |
| 2026-10-18 16:43:27 | **目录 `LastWriteTime` 定格于此** — 清空发生时刻 |
| 2026-10-18 16:49 | 从会话 transcript 恢复出首批文件（`_recovered/`） |
| 2026-10-18 17:20 | 当前会话 transcript 最后写入 |
| 2026-10-18（稍后） | 发现远端完好，克隆至 `E:\Desktop\omp-wb-remote`，验证基线绿 |

事故窗口：首个包含缺陷 `afterEach` 的测试文件被创建后，到其首次在含编译错误的状态下运行之间。

---

## 3. 影响范围

### 3.1 完全丢失且无远端副本

| 对象 | 内容 | 行数/规模 |
|---|---|---|
| `c84ec0c` | v2.1.0-beta 多会话池、名册、按会话锁、动态全局 MCP | 提交 |
| `69d937b` | `/wb send` 关闭失败路径、会话固定、锁路径守卫 | 提交 |
| `b1ee736` | 缺失绑定/会话移除时 fail-closed | 提交 |
| `6a78e56` | 阶段 1：v3 契约 + 结构化事件日志 | 提交 |
| `ba5c012` | 阶段 2：冻结暂存 + 持久队列 | 提交 |
| `4177f05` | 仲裁公平性、修订经济性、规范根 | 提交 |
| `src/tasks.ts` 的 v2.1 增量 | `stageTask`、manifest 助手、`canonicalRelPath`、输出校验抽取 | ~200 行增量 |
| `src/collaboration.ts` 的 v2.1 增量 | 正选占用谓词、`waiting` 状态校验 | ~20 行增量 |
| `src/index.ts` 的 v2.1 增量 | 延迟 `logEvent` 接线、`setLogWarnSink`、正选占用过滤 | ~40 行增量 |
| `test/tasks.test.ts` 的 v2.1 增量 | `stageTask` 五个用例（文件本身已从远端恢复，仅此增量丢失） | ~200 行增量 |

> 说明：`src/tasks.ts`（1,543 行）、`test/tasks.test.ts`（1,406 行）、`src/collaboration.ts`（925 行）、`src/index.ts`（2,520 行）、`src/desktop-client.ts`（1,480 行）等**文件整体均从远端完好恢复**；上表所列仅为本会话在 beta/阶段 1–3 期间叠加在这些文件之上的增量，它们从未推送，故随工作树一同丢失。

### 3.2 曾丢失、已从会话记录恢复

通过解析 OMP 会话 transcript（`~/.omp/agent/sessions/--E--Desktop-OMP-WorkBuddy--/*.jsonl`）中的 `write`/`edit` 工具调用，并按序重放编辑链，恢复至**验证过的终态**：

| 文件 | 大小 | 恢复方式 | 验证 |
|---|---|---|---|
| `src/queue.ts` | 1,166 行 / 43.5 KB | 1 次 write + 60 次 edit 重放 | 三处 `firstWait` 累加器、`ON CONFLICT(session_id) DO NOTHING` + `changes !== 1` + 修订回滚、`canonicalProjectRoot`、`readProjectAccess`、`splitSqlStatements` 全部在位 |
| `src/migration.ts` | 384 行 / 16.1 KB | 1 次 write + 23 次 edit 重放 | `INSERT OR IGNORE INTO rounds`、`let enabled = false`、只读门 `openReadConnection`、`migration_completed` 在事务内、`snapshot_path` 修正全部在位 |
| `src/logging.ts` | 595 行 / 18.8 KB | 2 次 write + 25 次 edit 重放 | 非抛出 `logEvent`、per-root `unavailableReasons`、`parseLogRecord`、`pickFields`、`logDirectory`/`logUnavailableReason` 导出全部在位 |
| `test/queue.test.ts` | 22 用例 | 重放 | — |
| `test/migration.test.ts` | 21 用例 | 重放 | — |
| `test/logging.test.ts` | 11 用例 | 重放 | — |
| `test/fixtures/queue-worker.ts` | 真实子进程竞争 fixtures | 重放 | — |
| `docs/`（计划与需求文档） | 2 份 | 回收站 `$R` 提取 | — |

### 3.3 完全未受影响

- 远端仓库 `main` 分支全部 4 个提交及其文件树（每个文件完整）。
- 相邻工作区 `E:\Desktop\wb-live-test`（含 `.wb-bridge/` 收据与实际产物）与 `E:\Desktop\光影材质`。
- OMP 全局配置、WorkBuddy 桌面会话、已安装依赖。

### 3.4 定量影响

- 丢失源码：beta 三提交的增量 + 阶段 1–3 叠加在既有文件上的增量（`tasks.ts` 的 `stageTask` 段、`collaboration.ts` 的占用谓词、`index.ts` 的日志接线等），**估计** 1,500–2,500 行变更——具体数字不可测，因为事故前的工作树已无法检视。
- 丢失测试：`test/tasks.test.ts` 的 `stageTask` 五用例（该文件本体已从远端完整恢复，1,406 行）。
- 保住源码（以下全部为 `wc -l` 实测）：
  - 远端基线 `9f01805` 的 8 个模块：**7,746 行**
  - 本会话恢复的 3 个新模块：**2,145 行**（`queue.ts` 1,166 + `migration.ts` 384 + `logging.ts` 595）
  - 当前树合计：**9,891 行 / 11 个模块**（= 7,746 + 2,145）
- 保住测试（以下全部为 `bun test` 实测）：
  - 远端基线（移除移植文件后测量）：**185 pass / 1 skip / 0 fail，共 186 项**
  - 当前树（含移植）：**196 pass / 1 skip / 2 fail，共 199 项 / 10 文件**
  - 移植套件净增 **13 项**（199 − 186）；其 `it()` 块数为 queue 22 / migration 21 / logging 11，与实际执行数不同计数口径，不与之相加。

---

## 4. 根因分析

### 4.1 直接原因

```ts
// test/queue.test.ts（事故时的版本）
let root = "";                                          // 模块级，初值为空字符串

beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "wb-queue-")));
});

afterEach(async () => {
    closeQueueConnection(root);
    closeQueueConnection(root, "read");
    await rm(root, { recursive: true, force: true });    // ← 致命行
});
```

三个缺陷叠加：

1. **空字符串根**：`root` 初值为 `""`。`beforeEach` 若抛出（本文件当时确有两处编译级错误：`tmpdir()` 未导入、`import { spawn, process } from "node:child_process"` 中 `process` 不存在），赋值永不发生。
2. **`rm("")` 解析到 cwd**：Node/Bun 的 `fs.rm("")` 不报错为"空路径"，而是相对当前工作目录解析。`bun test` 在仓库根启动，于是 `rm("")` 等价于 `rm(<仓库根>)`。
3. **`force: true` + 递归**：`force` 抑制 `ENOENT` 等异常，`recursive` 使删除扩展到整棵子树。删除过程中遇到已打开的 SQLite 句柄时抛出 `EBUSY`——而该异常恰好出现在 `afterEach` 末尾，未阻止此前的删除。

### 4.2 促成因素

- **测试与产品代码耦合过紧**：`closeQueueConnection("")` 同样以空串为键，会命中缓存中键为 cwd 的连接并关闭它，说明空根在下游多处被静默接受而非拒绝。
- **缺少绝对路径断言**：`rm` 调用前没有任何 `path.isAbsolute` / 长度检查。
- **同批次多文件复制该模式**：三个测试文件使用完全相同的模板，同一缺陷被复制三份。
- **错误被吞**：编译错误使测试文件无法加载，Bun 以"between tests"形式报告而未中止整个套件，`afterEach` 仍被调度。

### 4.3 明确排除的假设（本会话内已逐一证伪）

| 假设 | 证伪证据 |
|---|---|
| 目录是 junction / 重解析点 | `Get-Item` 显示 `Attributes: Directory`、`LinkType` 为空、`Target` 为空、条目数 0 |
| 模拟文件系统 / 挂载视图损坏 | 多条独立读取路径（`cmd dir`、PowerShell、`fs.readdir`）一致报告空目录 |
| 回收站删除 | 回收站仅含两个 `.gitignore` 过的 `.md`，无目录项、无 `.git` |
| Git 操作（`clean`/`checkout`） | 若有 git 操作仍会保留 tracked 的 `src/`；且 `.git` 本身消失 |
| 卷影副本可恢复 | `vssadmin` 需提权；回收站与安装副本途径均已穷尽 |
| 其他进程/工具删除 | 无相关日志；时间与测试运行精确吻合 |

### 4.4 为什么规模如此之大

`rm(<repo>)` 一次性删除所有内容，包括 `.git`。这使**三个本地提交与 beta 三提交永久失去**——它们从未被 `git push`。若损失仅限工作树（`.git` 幸存），`git checkout .` 即可完整还原；`.git` 的丢失把一次"可回滚的误删"升级为"不可逆的数据丢失"。

---

## 5. 后果与风险

### 5.1 已实现后果

1. **v2.1.0 正式版进度回退**：从阶段 3（迁移与作用域协调）回退到阶段 0（基线重建）。
2. **不可恢复的历史丢失**：6 个本地提交消失。无法再用 `git bisect`、无法追溯任一改动的原始意图与评审记录。
3. **测试网削弱**：`test/tasks.test.ts` 的 `stageTask` 五用例（冻结副本存活、确认后变更、缺文件、junction 逃逸、请求/确认不匹配）没有远端副本——这意味着 `tasks.ts` 的 v2.1 增量将缺少直接回归保护，只能依赖 `queue.test.ts` 与 `migration.test.ts` 的间接覆盖。
4. **信任成本**：本会话前半段浪费约 20 轮在错误的恢复方向上（重放遍历缺陷、误判 junction、误判回收站），这些轮次本可用于阶段 3。

### 5.2 潜在后果（若未遏制）

- **可重演**：只要存在 `let root = ""` + 无条件 `rm(root)` 的测试模板，任何一次 setup 失败都可能再次清空所在仓库。
- **静默性**：`force: true` 使删除不报错，事故在发生当时不可见，直到下一次 `cd` 或 `git status` 才暴露。
- **跨项目污染**：同样的模板若用于其他项目，会造成同样的损失。

### 5.3 已实施的遏制

| 措施 | 位置 | 状态 |
|---|---|---|
| 测试清理前要求就绪标志 + 绝对路径 + 最小长度 | `test/queue.test.ts`、`test/migration.test.ts`、`test/logging.test.ts` | ✅ 三个文件均已加入，已随文件复制到新树 |
| `beforeEach` 成功后置位、`afterEach` 消费后复位 | 同上 | ✅ `rootReady` 标志 |
| 产品代码拒绝空/相对根 | `src/queue.ts: canonicalProjectRoot` | ✅ 抛 `WB_INPUT_INVALID`，不再回退 `path.resolve("")` |
| 基线副本 | `E:\Desktop\omp-wb-remote`（克隆自远端） | ✅ 已验证绿 |
| 恢复副本 | `E:\Desktop\omp-workbuddy-recovery\tree` | ✅ 保留 |
| 远端作为锚点 | `9f01805` | ✅ 存在 |

### 5.4 建议的后续措施

1. **已完成**：远端基线 7 个测试套件经审计**全部安全**（数组弹出式清理，无裸根），无需加载防护；防护仅加在本会话新写的三个文件上，已完成并随文件进入新树。
2. **立即**：`bun test` 前先在 CI 或本地脚本中断言"测试清理只对 `os.tmpdir()` 下的路径生效"。
3. **短期**：所有提交后立即 `git push`，使本地提交不再有单点故障。本次事故中"从未推送"是损失不可逆的唯一原因。
4. **短期**：为 `fs.rm` 建立薄封装 `removeFixtureRoot(root)`，内置绝对路径断言与 `os.tmpdir()` 包含性检查，并禁止直接调用 `fs.rm` 递归形式。
5. **中期**：在 `.git/hooks/pre-commit` 或 CI 中加入静态检查，拒绝 `let root = ""` 与 `rm(root, { recursive: true })` 的直接组合。

---

## 6. 恢复与当前状态

### 6.1 恢复动作

1. **取证**：解析 3 个会话 transcript（合计约 50 MB JSONL），提取全部 `write`/`edit` 工具调用。
2. **重放**：按 transcript 顺序对每个目标文件重放编辑链，得到终态。
3. **交叉验证**：以恢复的 `queue.ts`/`migration.ts` 的 import 列表反向锁定 `types.ts` 的必需导出面，以编译器作为验收。
4. **远端对照**：发现远端完好后，改用远端基线 + 移植恢复模块的合并策略，避免"从碎片重建"（该策略在 `types.ts` 上曾两次产出内部不一致的文件）。
5. **防护前移**：在移植前先将测试清理防护写入恢复文件，确保新树不会重演。

**基线的具体验证方法**（使报告可复核，而非仅叙述）：

```sh
cd E:/Desktop/omp-wb-remote
git stash -q -u      # 移出全部移植文件，回到纯 9f01805
bun test             # → 185 pass / 1 skip / 0 fail（共 186 项）
bun run typecheck    # → 0 错误
git stash pop        # 恢复移植文件
```

即在**移植文件不存在**的状态下测量基线，这是"基线从未受损"最直接的证据。

### 6.2 当前状态（本报告编写时）

工作树：`E:\Desktop\omp-wb-remote`（克隆自远端 `9f01805`）

| 指标 | 值 |
|---|---|
| 源码行数 | 9,891 行 / 11 个模块（= 基线 7,746 + 移植 2,145） |
| 基线测试（移除移植文件后实测） | 185 通过 / 1 跳过 / 0 失败（共 186 项） |
| 当前测试（含移植，实测） | 196 通过 / 1 跳过 / **2 失败**，另 **2 个未处理错误**（共 199 项 / 10 文件） |
| 当前 typecheck | **18 个错误** |
| 失败性质 | 两项均为 **导入期 `SyntaxError: Export named 'hashManifestPayload' not found in src/tasks.ts`**，与上述 18 个类型错误同源（`tasks.ts` 尚未补入 manifest 助手）。**断言级失败：0**。非事故重演，非基线行为回归 |
| 防护验证 | 三个移植测试文件中 `rootReady` + `path.isAbsolute` + `length >= 8` 均在位（已 grep 确认） |
| 清理路径全树审计 | 见下表——**全树零处未受保护的删除路径** |

**测试清理方式逐套件审计（事故模式是否可复现的判据）**

| 套件 | 清理形态 | 空根风险 |
|---|---|---|
| `approval` / `collaboration` / `mcp` | `allocatedRoots.pop()` + `!== undefined` 收窄 | 无（空串在类型上不可表示） |
| `tasks` | `allocatedTempDirs.pop()` + `!== undefined` + try/catch | 无 |
| `desktop-client` / `desktop-client-acp` | `makeTempDir()` → `temporaryDirs` → `fs.rmSync` 排放 | 无 |
| `acp-http` | 无清理式 `rm` | 无 |
| `queue` / `migration` / `logging` | 裸 `root` + `rootReady` / `isAbsolute` / `length >= 8` | 已守卫 |

结论：事故模式（空根 + 无条件递归 `rm`）在当前树中**现存零处**，且由五种彼此独立的安全设计覆盖。

### 6.3 待完成（按依赖序）

1. `src/types.ts` **追加**（非重写）：v3 契约块、4 个错误码（`queueBusy`/`migrationRequired`/`ownerUnavailable`/`integrationIncomplete`）、`WorkRecord.state: "waiting"`、`BoundSession` + `Binding.sessions`、v2 `TaskRound`/`TaskReceipt`。
2. `src/tasks.ts` **追加**：`canonicalJson`、`canonicalRelPath`、`buildTaskManifestPayload`、`hashManifestPayload`、`validateOutputPath`/`validatedOutputPaths`、`stageTask`；`readTaskLock` 增加可选 `sessionId` 参数。
3. 修 `test/migration.test.ts` 两处头部笔误（`import { spawn, process } from "node:child_process"`、裸 `tmpdir()`）。
4. `typecheck` 归零 → `bun test` 恢复全绿 → 阶段 3 继续。
5. 补 `test/tasks.test.ts` 的 `stageTask` 用例（文件本体已从远端恢复至 1,406 行，仅需重写丢失的五个 `stageTask` 用例）。

---

## 7. 经验教训

1. **`force: true` 是危险信号**。在删除类操作上，`force` 把所有"本可以报警的信号"变成了静默通过。任何 `rm` 都应先断言目标合法，再考虑 `force`。
2. **空字符串不等于"未设置"**。`let root = ""` 让"未初始化"与"空路径"无法区分；`let root: string | undefined` 或独立就绪标志才能让编译器/读者识别未初始化状态。
3. **测试模板的复制即缺陷的复制**。三个文件共用同一 `afterEach` 模板，缺陷被复制三份。共享一个经过审计的 helper 优于三次手写。
4. **本地提交不是备份**。事故中唯一让损失不可逆的因素是"从未推送"。提交与推送应当是同一步。
5. **恢复时优先取整文件，而非重建**。本会话前半段的多轮浪费源于"用碎片重建"，其后半段的效率源于"用远端整文件 + 移植增量"。
6. **多处独立证据一致才可下结论**。本会话曾三次依据片面的文件视图得出结论并被推翻：误判 `firstWait` 缺失、误判 `ON CONFLICT` 缺失、误判远端测试套件"未加防护"。三者的共同点是**只读了片段就下判断**——正确顺序永远是"先读完整个代码块，再表态"。
7. **删除代码比文件系统取证更可读**。定位根因花了约 20 次工具调用（回收站×3、卷影副本、junction 检查、blob 存储、安装副本、插件目录），全部落空；真正的答案在读恢复出的测试文件自身的 `afterEach` 时立刻显现。教训：目录"存在但为空"时，先读会删除路径的代码——删除逻辑可检视，Windows 的文件系统历史基本不可检视。
8. **过早撤回正确假设也是成本**。`afterEach` 假设曾被提出、因 `EBUSY` 证据看似指向别处而被撤回，随后又因代码证据被重新确立。撤回应当基于**新的事实**，而非基于"另一个假设看起来也可能"。
9. **会话记录是最后一道防线**。本次唯一保住 3 个模块（2,145 行）的原因是 OMP 会把每次工具调用追加到 `~/.omp/agent/sessions/*.jsonl`（`01a1392d` 39.7 MB、当前会话 6.34 MB）。这不是设计好的备份，是日志副产品恰好可用——但它确实救了 Stage 1–3 的全部成果，值得作为策略保留。

---

## 8. 附件

| 名称 | 路径 |
|---|---|
| 远端基线克隆 | `E:\Desktop\omp-wb-remote` |
| 恢复工作副本 | `E:\Desktop\omp-workbuddy-recovery\tree` |
| 文件版本库（每文件所有历史版本） | `E:\Desktop\omp-workbuddy-recovery\versions` |
| 会话 transcript | `C:\Users\FKCZ3\.omp\agent\sessions\--E--Desktop-OMP-WorkBuddy--` |
| 需求与计划文档 | 恢复树 `docs/`（另见 `E:\Desktop\omp-wb-bridge-requirements-backup.md`） |
| 被清空目录 | `E:\Desktop\OMP-WorkBuddy`（创建于 2026-10-13 18:32，最后修改 2026-10-18 16:43） |

---

**报告结论**：事故为**单一代码缺陷导致的自我删除**，非外部攻击或环境故障。基线可完整恢复、Stage 1–3 核心模块已恢复至验证终态、事故防护已落地。不可恢复的仅为 6 个从未推送的本地提交（约 3,000–4,000 行增量）。当前工作树处于"基线绿 + 增量移植中"的状态，距离重新全绿还差 18 个类型错误的接线工作。
