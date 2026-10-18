# omp-wb-bridge v2.1.0 阶段 3 实施报告

**日期**：2026-10-18
**工作区**：`E:\Desktop\OMP-WorkBuddy`（自 `E:\Desktop\omp-wb-remote` 迁回）
**分支**：`main`，与 `github.com/gongquan45/omp-workbuddy-bridge` 同步至 `0a95ca9`
**范围**：v2.1.0 计划阶段 1–3（契约、冻结暂存、迁移与范围协调）

---

## 一、交付结果

```
typecheck   0 错误
bun test    266 pass / 1 skip / 0 fail（267 项 / 11 文件 / 860 断言）
独立克隆     ✅ 全新克隆 + bun install → 0 错误 / 266 pass / 1 skip / 0 fail（`0a95ca9`）
```

以上三项均在**迁回 `E:\Desktop\OMP-WorkBuddy` 之后**重新执行并确认，不是迁移前的历史数据。

### 本轮 9 个提交

| 提交 | 类型 | 内容 |
|---|---|---|
| `0a95ca9` | test | 覆盖 `pathsOverlap` 的 win32 大小写归一 |
| `6e96360` | fix | `works.revision` 定为记录版本，与审计计数器分离 |
| `f397c4b` | feat | 授权门覆盖全部派发入口（任务入口 + MCP 写工具） |
| `be3b092` | feat | setup/init 启用闭环、显式会话选择、MCP access 暴露 |
| `5f749bd` | feat | `scope.ts` 纯域层、统一路径解析器、评审重算 |
| `39a0c50` | fix | 批准摘要绑定执行清单、`stageTask` 变异用例 |
| `0492a22` | fix | waiting 记录契约 + `delegatedWorkId`（UUIDv5） |
| `06953e8` | test | 修测试命题漂移、清死代码 |
| `2e7c32b` | feat | 阶段 1–3 契约、manifest 接口、迁移落地 |

变更规模（`8d404e8..0a95ca9`，9 个提交）：**16 个文件，+3,102 / −381 行**。

---

## 二、六项主要成果

### 1. `src/scope.ts` — 纯域层（新增 94 行）

范围冲突判定原先散落在队列内部，且**漏了 Windows 路径大小写归一**。提取为三个纯函数：

- `normalizeScopePath` — 归一化分隔符；拒绝绝对路径、盘符、`..` 与项目根；不合规时**抛 `WbTaskError`（`WB_INPUT_INVALID`）**，不做猜测
- `pathsOverlap` — 相等与前缀判定；win32 下大小写不敏感
- `scopesConflict` — 对**不可归一化的已存路径 fail-closed**（经内部 `normalizeOrNull` 包装判为冲突，而非放行）

队列原有局部 `overlaps` 已删除并改为调用该模块。这不是重构，是修 bug：旧实现（参考树 `queue.ts:1052`）只做 `a === b` 与 `/` 前缀比较，**没有大小写归一**，所以 `Out/a.ts` 与 `out/a.ts` 被判为不冲突——在 Windows 上这两个是同一个文件，两个任务可同时写它。

> 注：绝对路径与盘符路径不会走到比较环节，`normalizeScopePath` 会先拒绝；此项风险仅限于相对路径的大小写差异。

### 2. `resolveRoundPaths` — 路径拼装单一来源（N01）

此前三处代码各自拼 `.wb-bridge/tasks/<taskId>/<round>/…`，任一处改动都会静默错位。现统一为一个函数，带 UUID 格式校验与 round 数值校验，三个消费者全部委托。

### 3. 评审重算磁盘哈希（N02）

`publishWork` 被要求评审时**重新计算磁盘文件哈希**，不信任调用方传入值。同时删除了原实现中"与已发布哈希比对"的分支——该分支会导致二次评审永久死锁。accepted 后把新哈希写回记录。

### 4. 迁移合并改为显式字段并集

merge 逻辑以 `delegatedWorkId` 为键，字段级合并 receipt 侧与 collaboration 侧。三种形态各有测试：仅 receipt、仅 collaboration、两者并存。

### 5. 启用闭环

- `enableProject()` 幂等，要求数据库已初始化，允许空池启用
- `/wb setup` 与 `/wb init` 在**实际读取 access 确认已启用**后才报成功
- 会话选择改为显式选择器，删除静默取 `candidates[0]` 的行为
- 配置失败会报告但不阻断启用
- `Bun.which` 替代 `process.execPath`（后者指向 OMP 自身，不是 Bun）

### 6. `works.revision` 语义定案（本轮最后一项）

**问题**：三处写入把全局审计计数器 `nextRevision(db)` 写进 `works.revision` 列，而 `record_json.revision` 存的是记录自身版本，`expectedRevision` CAS 比对的是后者。**同一行对两个读者给出不同答案**。当时无人读该列，故潜伏未发。

**修复**：

| 位置 | 改法 |
|---|---|
| `queue.enqueue` | 新 waiting 记录版本恒为 `1`，不受项目此前记录数影响 |
| `queue.claim` | `waiting → active` 是记录变更，列与 `record_json.revision` 同步 +1 |
| `migration` | 合并行写合并后 `record.revision` |
| `meta.revision` | **保留原义**：项目级审计序号，与记录版本彻底分开 |

---

## 三、验证方法：可证伪性

本轮三条关键用例都做了**反向验证**——临时破坏被测逻辑，确认用例真的失败，再恢复：

| 用例 | 破坏方式 | 结果 |
|---|---|---|
| 未启用项目拒绝派发 | 把门改成 `if (false && …)` | 8 pass / **1 fail** ✅ |
| `works.revision` 双向同步 | 删除 `claim` 的 `record_json` 同步 | 22 pass / **1 fail** ✅ |
| win32 路径大小写冲突 | 移除 `pathsOverlap` 的小写归一 | 27 pass / **1 fail** ✅ |

这一点直接回应了审查意见的批评：原有用例只断言"不出现某错误码"，**在门完全不存在时也会通过**，属于单边断言。现在这些都是双向的。

第三条补充说明：`pathsOverlap` 的 `win32 ? toLowerCase()` 原先**没有任何测试覆盖**——`test/collaboration.test.ts` 里标题含 "case" 的用例实际只断言了反斜杠归一（`out/a.ts` vs `out\a.ts`），标题与断言不符。本轮已把该标题改正为 "normalizes separators"，并新增真正的用例，断言 `pathsOverlap("Out/A.ts", "out/a.ts")` 在 win32 下为 `true`、POSIX 下为 `false`。

---

## 四、过程中修正的三个问题

### 1. 授权门只写了一半（真实缺口）

`requireBinding` 解构出了 `access`，但唯一任务入口 `runTask` 只取 `{ binding, projectRoot }`，把它丢弃。后果：**有 `binding.json` 但无数据库的项目（正是 v2 用户升级后的状态）可以完整派发**，走 v2 老路径，绕开队列的 `WB_MIGRATION_REQUIRED`。

修复：`runTask` 与 MCP 的 `work_claim`/`work_publish` 均拒绝未启用项目；`project_context` 保持可读以便诊断。

### 2. 53 项审批测试因门而失败

这些用例用假 binding 无数据库。处理方式是在 harness 注入 `readProjectAccess` seam 返回已启用，并注明该组用例覆盖的是 v2 派发路径。**没有为了迁就测试而削弱门**。

### 3. `mcp.test.ts` 端到端失败

子进程服务启动时读不到启用状态。fixture 改为像 `/wb setup` 一样先 `migrateProjectToQueue` 再 `enableProject`。顺带修掉第一版漏写 `await` 造成的竞态。

---

## 五、工作区恢复

`E:\Desktop\OMP-WorkBuddy` 原为 2026-10-18 事故中被清空的工作区，本次从 `omp-wb-remote` 迁回：

| 内容 | 状态 |
|---|---|
| 37 个受跟踪文件 | ✅ 已复制 |
| `.git`（含完整提交历史） | ✅ 已迁移，`git log` 可追溯至事故前 |
| `node_modules`（129 包） | ✅ `bun install` 重建 |
| `AGENTS.md` | ✅ 按原文重建（13,689 字节，被 gitignore，不影响 `git status`） |
| `memorix-dual-client-validation-report.md` | ✅ 自恢复参考树补回（被 gitignore） |
| `memorix-report-backup.md`、`omp-wb-bridge-requirements-backup.md` | ✅ 保留，**未被 gitignore**，故 `git status` 显示为未跟踪（`??`） |
| `_recovered/`（含 `archive/` 与事故归档） | ✅ 保留，同样未被 gitignore，`git status` 显示 `??` |

### 未能恢复的文档（`.gitignore` 使其对 `git status` 不可见）

`.gitignore` 明确忽略 5 个根目录文档，其中 **3 份已确证丢失**，在三棵树里均不存在：

| 文档 | 状态 | 影响 |
|---|---|---|
| `/omp-workbuddy-bridge-plan.md` | ❌ **丢失** | `AGENTS.md` 的 "Important Files" 表点名要对照的 8 阶段历史设计文档 |
| `/CHANGELOG.md` | ❌ **丢失** | 版本变更记录 |
| `/WorkBuddy工作原理与意图场景全景报告.md` | ❌ **丢失** | 研究文档 |
| `/AGENTS.md` | ✅ 已按原文重建 | 约束性工程约定 |
| `/memorix-dual-client-validation-report.md` | ✅ 已补回 | — |

上述两份备份 md 是**目前唯一幸存的需求/计划文档**，可部分填补 `omp-workbuddy-bridge-plan.md` 的缺口；它们未被 gitignore 覆盖，属于可被误提交的事故残留。

**这点必须单独陈述**：`git status` 干净**不等于**文档齐全。这 5 份文档从未进入版本库，任何基于 `git clone` 的恢复都不会带上它们，而 `git status` 也不会报告它们缺失。

**恢复后实测**：`266 pass / 1 skip / 0 fail`（共 267 项），与迁移前一致（新增一条大小写用例）。

### 关于 `_recovered/` 的处理

迁移后首轮全量测试出现 **16 fail / 1 error**，原因是 Bun 把 `_recovered/test__*.test.ts` 当作测试收集。这些是事故时的旧副本，依赖已不存在的旧结构（单独运行 `_recovered/test__queue.test.ts` 即 15 fail）。

处理：四个测试副本移入 `_recovered/archive/` 并改名 `.txt`，`src__*.ts` 保持原名（`tsconfig` 只含 `src/` 与 `test/`，不参与类型检查）。**这不是为了让测试变绿而删除失败用例**——正式源码树 `test/` 始终是 0 失败，失败项全部来自残留副本。

---

## 六、当前架构的真实状态

### 已接线（非死代码）

```
/wb setup  → migrateProjectToQueue → enableProject → 断言 access → 报成功
/wb init   → 同上（不含 MCP 配置）
wb_task    → requireBinding（binding + access）→ 未启用则拒绝 → v2 派发
mcp.ts     → 启动读 access；写工具拒绝未启用项目；context 可读
```

### 仍存在的架构分裂（阶段 4 目标）

- `queue.ts` 的 `enqueue`/`claim` 功能完整、测试充分，但**没有生产调用方**
- 派发仍由 `index.ts` 的 `prepareTask` + `acquireLock` 文件锁完成
- 即：**数据库已是权威的授权与状态记录，但执行仍走旧文件路径**

阶段 4 就是把两者合一。

---

## 七、遗留事项

| 项 | 状态 | 影响 |
|---|---|---|
| `migration.ts:297` 的 `reviews: []` | 注释措辞不精确 | 行为正确（collab 侧经 `...record` 覆盖），无功能影响 |
| N03 `getProjectContext` 恢复投影 | 未做 | 阶段 6 前完成即可 |
| 阶段 4–8 | 未开始 | 见计划 |

### 阶段进度

| 阶段 | 状态 |
|---|---|
| 1 契约 + 日志 | ✅ |
| 2 冻结暂存 + 队列 | ✅ |
| 3 迁移 + 范围协调 | ✅ |
| 4 执行路径切换 | ⬜ **关键** |
| 5 自动入池 | ⬜ |
| 6 前台等待 + 验收 | ⬜ |
| 7 编程协助 + 接续 | ⬜ |
| 8 工作台 + 统一接入 | ⬜ |

---

## 八、需要决策或授权的事项

1. **阶段 4 是否现在开始**：这是计划中最大的结构性改动，涉及 `index.ts` 派发路径整体切换到队列。
2. **是否先做真实端到端冒烟**：需要你开启 WorkBuddy 桌面会话并在同一项目目录完成绑定，验证队列派发在真机上的行为。

## 九、规范工作树与目录归属

### 规范开发工作树 = `E:\Desktop\OMP-WorkBuddy`

桌面上曾同时存在两份**完全等价的可写副本**，各自持有独立 `.git`，同源同版本（`6e96360`）：

| 目录 | 角色 | `.git` | 处置 |
|---|---|---|---|
| `E:\Desktop\OMP-WorkBuddy` | ✅ **规范工作树**，阶段 4 起在此开发 | 独立 | **保留** |
| `E:\Desktop\omp-wb-remote` | 迁移来源副本 | 独立 | 已清理（内容全部并入前者） |
| `E:\Desktop\omp-workbuddy-recovery` | 事故恢复参考树 | 独立（3 个仅本地提交） | 已归档后清理（见下） |

**风险说明**：若在 `omp-wb-remote` 开工而此后在 `OMP-WorkBuddy` 查看，两边会立刻分叉，且因是两个独立 `.git`，`git status` 各自都显示干净、不会互相提示。因此明确：**阶段 4 的 `index.ts` / `tasks.ts` / `queue.ts` 跨文件改动一律在 `OMP-WorkBuddy` 进行**。

### `omp-workbuddy-recovery` 已归档后清理

参考树含**不可再生**内容，删除前先整体打包为 `_recovered/incident-2026-10-18-recovery.tar.gz`：

| 内容 | 为何不可再生 |
|---|---|
| `versions/` | 52 个逐文件历史版本（`.v0/.v1/.v2`）；那 6 个未推送提交已随工作树清空消失，git 历史中**不存在**这些中间态 |
| `tree/.git` | 3 个**仅本地**提交 `76da45b → 7e9f149 → da69531`（远端无） |
| `.scratch/` | 27 个用于提取 ACP 协议细节的一次性脚本 |
| `tree/docs/` | 需求/计划文档备份 |

**归档校验**：解包后逐文件比对 SHA-256，**192 个文件全部相同**（`tree/node_modules` 840M 已排除，可由 `bun install` 再生）。打包而非散放文件，是因为 `tree/test/`、`.scratch/` 内共 18 个 `*.test.ts` 会被 `bun test` 递归扫到并重现 16 个失败。

**已同步修正的事故报告引用**：`:37`、`:169`、`:196`、`:207`、`:259–261` 共 8 处指向已删除路径，其中 §6.1 的可复核命令块已改写为不依赖桌面路径的 `git clone` + `git checkout 9f01805` 形式。

### 工作区状态说明

`OMP-WorkBuddy` 的 `git status` 当前并非完全干净，有未跟踪项：

```
?? _recovered/
?? docs/TASK-REPORT-2026-10-18-stage3.md
?? memorix-report-backup.md
?? omp-wb-bridge-requirements-backup.md
```

其中 `_recovered/` 与两个 `*-backup.md` 是事故残留，按用户要求保留在主树（"暂不清理"）。

`.gitignore` 已加入三行（`/_recovered/`、`/memorix-report-backup.md`、`/omp-wb-bridge-requirements-backup.md`）阻止它们被 `git add -A` 卷入历史——其中 tarball 是 490KB 二进制且内含 `.git` 对象库，入历史即永久留痕。加规则后 `git status` 不再显示这三项。

**`_recovered/incident-2026-10-18-recovery.tar.gz` 是事故唯一不可再生的证据**（内含 3 个仅本地提交与 52 个中间版本）。现有两份物理副本，SHA-256 相同（`a4ed14e5…`）：主副本在上述路径，异副本在 `E:\Desktop\omp-wb-incident-2026-10-18.tar.gz`。异副本必要，因为主副本所在目录正是本次事故被清空过的路径。

## 十、环境清理

已删除：
- 临时克隆 `wb-v5`、`wb-v6`、`final-check`（`%TEMP%` 下，验证用）
- `E:\Desktop\omp-wb-remote`（内容全部并入 `OMP-WorkBuddy`，工作树干净、无未跟踪项、无 `.wb-bridge` 实时状态）
- `E:\Desktop\omp-workbuddy-recovery`（打包归档后删除，192 文件 SHA-256 校验无损，见 §九）

保留：
- `_recovered/incident-2026-10-18-recovery.tar.gz`（事故归档，含 `versions/` 52 个中间版本与 3 个仅本地提交）
- `E:\Desktop\omp-wb-incident-2026-10-18.tar.gz`（上述归档的异副本，SHA-256 相同）
- `E:\Desktop\wb-live-test`（事故报告 §3.3 引用的相邻工作区，含 WorkBuddy 真实产物与收据）
- `_recovered/archive/`、两个 `*-backup.md`（用户要求暂不清理；已加入 `.gitignore`）
- `%TEMP%` 下约 190 个 `wb-*` 历史测试残留目录（非本轮产生，未动）
