# 状态归属：谁管什么

2026-10-13 为拆驱动器（[交付计划](delivery_plan.md)「开发新功能前必须先处理」第 3 条）写的。先定三层各管哪些状态，再核对现有代码里重复保存、跨层读写的地方。**这次只记录，不改跨层行为**；可以收拢的列在最后，作为后续建议。

行号是写这份文档时（158c8b8 之后）的位置，代码改了以函数名为准。

## 三层分工

| 层 | 位置 | 管什么 |
| --- | --- | --- |
| 服务端（Java） | `mods/mcbot-server-control` | 游戏里的事实和正在执行的动作：租约（`instanceId`、`sessionId`、`leaseId`、`stopToken`）、正在跑的操作、保护（守卫）、活着的陪伴姿态（`Posture.java`，属于租约，普通 stop 不清）、聊天游标（`watch`、`chatCursor`）、上次死亡（`ServerController.lastDeath`）。 |
| 运行端（TS） | `client-runtime` | 跟随／等待／保护姿态的请求和持久化（`companion-mode.ts`、`posture.ts`）；任务进度和身体任务锁（`scheduler.ts`、各 `*-tasks.ts`）；游戏里“等一下／停”的原地停（`player-stop.ts`）；地点、熔炉（`places.ts`、`machines.ts`）；记忆数据（`memory.ts`）；事件日志（`events.ts`）。 |
| 驱动器（JS） | `scripts/companion.mjs` | Agent 会话的开关、续接、压缩、换会话，以及把事件攒成一批送进去。 |

驱动器目前除了上面这一行，还管着这些，都和“Agent 会话”直接相关，留在驱动器：

- 托管心跳和单实例锁（运行端靠心跳判断“有托管在控制”）。
- 出错归类和额度暂停（暂停期间不送新一轮）。
- 整理记忆的**安排**：什么时候整理、另起整理会话；不读写记忆内容，只看 `state.json` 的整理时间和日志条数判断要不要整理、整理成没成。
- 交接单：换会话时读驱动器和运行端已经写下的记录，拼成一段文字送给新会话。
- ServerBody 控制通道（`scripts/server-body-control.mjs`）：撤销控制（WebUI 急停、运行端停不下来时的兜底）、叫停后等新任务、托管退出时让角色下线。

## runtime/ 里的文件：谁写谁读

`<名字>` 是游戏名。驱动器的文件名都在 `runtimeFiles`（`scripts/companion.mjs:139`）。

| 文件 | 写 | 读 | 删 |
| --- | --- | --- | --- |
| `companion-<名字>.json` 心跳 | 驱动器 `beat`（`companion.mjs:1965`），字段 `pid`、`updatedAt`、`busy`、`compactions` | 运行端 `hostedHeartbeatFresh`（`client-runtime/src/lifecycle.ts:43`）判断托管还在；`hostedCompactions`（`lifecycle.ts:38`）看压缩次数；WebUI（`scripts/webui.mjs:51`）显示在线、思考中；驱动器 `lockHolder` | 驱动器退出时 `removeIfOwn` |
| `companion-<名字>.lock` | 驱动器 `acquireLock` | 驱动器 | 驱动器 `releaseLock` |
| `companion-<名字>.stop` / `.halt` | WebUI、`stop-companion.ps1` | 驱动器每 400 毫秒看一次（`companion.mjs:2057`）；`.stop` 也被 `start-server-play.mjs:180` 看 | 驱动器 |
| `session-<名字>.json` 会话 | 驱动器 `saveSession`（`companion.mjs:1215`） | 驱动器 `readSessionState`；**运行端** `takeHeldPosture` 读其中的 `lastStopAt`（`client-runtime/src/posture.ts:42`，由 `main.ts:146` 传入路径）；WebUI | 没人删 |
| `posture-<名字>.json` 姿态 | 运行端 `writePosture`（`posture.ts:8`，`main.ts:147` 挂到 `companion.onPosture`） | 运行端启动时 `takeHeldPosture`（`main.ts:146`，读完即删）；**驱动器** `buildHandoff`（`companion.mjs:596`） | 运行端（读完、明确结束时）；**驱动器** `stopServerAgent`（`companion.mjs:1515`）、`shutdown`（`companion.mjs:1918`，不是等重连时） |
| `events-<名字>.jsonl` 事件 | 运行端 `EventJournal`（`events.ts:63`），每个进程启动时原地清空重写 | 驱动器 `readNewEvents`（`companion.mjs:1612`） | — |
| `cursor-<名字>.txt` 已送达序号 | **驱动器** `flush`（`companion.mjs:1815`）、`stopServerAgent`（`companion.mjs:1520`）、独立身份叫停（`companion.mjs:1692`）；运行端启动时清空（`events.ts:69`） | 运行端 `deliveredSeq`（`events.ts:296`），`wait-for-events` 不重复返回 | — |
| `consumed-<名字>.txt` 模型自己读过的序号 | 运行端 `markConsumed`（`events.ts:303`） | 驱动器 `consumedSeq`（`companion.mjs:1759`） | — |
| `task-delivered-<名字>.json` 随工具结果送过的任务结果 | 运行端 `writeTaskReceipts`（`events.ts:94`） | 驱动器 `flush`（`companion.mjs:1773`）+ `taskAlreadyDelivered`（`companion.mjs:315`） | — |
| `operations-<名字>.jsonl` 操作结果 | 运行端（`events.ts:122`） | 驱动器 `buildHandoff`（`companion.mjs:588`） | — |
| `activity-<名字>.jsonl` 活动记录 | 驱动器 `activity`（`companion.mjs:965`） | WebUI；驱动器 `buildHandoff`（自己的聊天、工具调用） | 启动时超过 5MB 轮转 |
| `server-control-<名字>.json` 控制租约 | 运行端 `onLease`（`main.ts:114`） | 驱动器 `server-body-control.mjs:71` `capture`；`captureBodyArtifacts`（`companion.mjs:322`） | 运行端 `removeControlFile`（`main.ts:73`）；**驱动器** `cleanupBodyArtifacts`（`companion.mjs:337`，只在运行端进程已死、内容没变时） |
| `client-body-<名字>.lock` 运行端锁 | 运行端 `acquireRuntimeLock`（`lifecycle.ts:16`） | 驱动器 `captureBodyArtifacts` | 运行端；**驱动器** `cleanupBodyArtifacts`（同上条件） |
| `bot-<名字>.lock` | 旧 Mineflayer MCP 服务端 | 驱动器 `waitBotLockFree`（`companion.mjs:1359`） | 旧 MCP 服务端 |
| `mcp-hosted-<名字>.json`、`mcp-memory-<名字>.json` | 驱动器 | Agent CLI | — |
| `<记忆目录>/<角色>/worlds/<世界>/state.json` 整理进度 | 运行端 `MemoryStore.write`（`memory.ts:288`，带 `through` 那次） | 驱动器 `memoryStatus`（`companion.mjs:491`） | — |

## 重复保存或跨层读写的状态

每条写现状、问题和应该归哪层。

### 1. 姿态文件 `posture-<名字>.json`

- 现状：运行端写（`posture.ts:8`）、运行端启动时读并删（`posture.ts:31`，`main.ts:146`）。驱动器在两处删它：叫停撤销（`stopServerAgent`，`companion.mjs:1515`）和真正退出（`shutdown`，`companion.mjs:1918`）；换会话时读它拼交接单（`buildHandoff`，`companion.mjs:595-601`）。活着的姿态还在服务端（`Posture.java`，属于租约）。
- 重复：驱动器 `buildHandoff` 自己又校验了一遍记录（动作名、玩家名格式、`at > lastStopAt`，`companion.mjs:597`），和运行端 `takeHeldPosture`（`posture.ts:38-43`）是两份规则，而且**不一样**：运行端超过 `HELD_POSTURE_MAX_AGE_MS`（1 小时，`posture.ts:18`）的记录不接，驱动器的交接单不看时间，会写“能接上的话运行端会自己接上”。
- 叫停时驱动器删文件，其实运行端已经按 `lastStopAt` 不接叫停前的记录（`posture.ts:43`），是双保险。
- 应归：**运行端**。驱动器只读，不删、不判断能不能接。

### 2. 叫停时间 `lastStopAt` 有两套

- 现状：驱动器内存里的 `lastStopAt`（`companion.mjs:902`）写进 `session-<名字>.json`（`saveSession`，`companion.mjs:1220`），运行端读它判断姿态记录能不能接（`posture.ts:42`）。驱动器拿它写【停止记录】提示（`companion.mjs:1808`）和交接单的“已取消”（`buildHandoff`）。
- 问题：驱动器只在**撤销控制**的叫停（`stopServerAgent`，`companion.mjs:1512`；WebUI 急停、运行端 10 秒没确认）和独立试玩身份叫停（`companion.mjs:1688`）时更新它。游戏里“停”由运行端原地停（`player-stop.ts:66`），驱动器收到 `player_stop` 只清计时器（`companion.mjs:1678`），**不更新** `lastStopAt`。所以原地取消之后换会话，交接单不会把被取消的任务标成“已取消”。
- 应归：叫停的事实归**运行端**（它真正停了身体）；驱动器只读来写提示。会话文件里的 `lastStopAt` 是驱动器写给运行端看的跨层接口，现在先保留。

### 3. 叫停词识别有两份

- 驱动器 `isAddressedStop`（`companion.mjs:175`），给事件文件和 ServerBody 控制通道（`server-body-control.mjs:169` 的 `isStop`）用；运行端 `stopKind`（`player-stop.ts:28`）。两边读同一份 `client-runtime/player-stop.json`（`companion.mjs:60`、`player-stop.ts:18`），但点名、去前缀、尾标点的写法各写一遍。驱动器的还会剥“名字: ”这种日志前缀，运行端拿到的已经是正文。
- 应归：词表已经共用。识别逻辑两层都需要（运行端原地停；驱动器在运行端卡住时兜底、在撤销后的等待期从控制通道收叫停）。不收拢，但应该有一张共用的用例表，两边都跑。

### 4. 叫停流程分在两层

- 游戏里叫停：运行端 `PlayerStop.hear`（`player-stop.ts:54`）原地停，发 `player_stop` 事件；同时不再受理动作和任务（`mcp.ts:134` `holding()`）。驱动器 `armPlayerStop`（`companion.mjs:1483`）只开一个 `STOP_CONFIRM_MS`（10 秒，`companion.mjs:67`）的计时器，收到 `player_stop` 就清掉（`companion.mjs:1678`）；到时没收到才走 `stopServerAgent` 撤销。
- 同一句叫停可能从两条路到驱动器：事件文件（`onEvent`，`companion.mjs:1674`）和控制通道 `watch`（`server-body-control.mjs:169` → `onStop` → `armPlayerStop`，`companion.mjs:2003`），靠 `playerStopTimer` 去重。
- WebUI「叫停」是急停：驱动器直接 `stopServerAgent`（`companion.mjs:2066`），撤销控制、结束这一轮 Agent，进入“等新任务”（`waitingNewServerTask`、`queuedServerTasks`）。
- `STOP_CONFIRM_MS`（`companion.mjs:67`）和 Codex 连接的 `cancelTimeoutMs`（`scripts/agents/codex-app-server.mjs:59`）是同一个 10 秒，写了两次。
- 应归：原地停归**运行端**；兜底撤销、急停、撤销后等新任务归**驱动器**（这些要结束 Agent 进程，只有驱动器能做）。现在的分法对，只是两个 10 秒应该共用一处。

### 5. 两个 `busy` 不是一回事

- 驱动器 `busy`（`companion.mjs:876`）：Agent 正在跑一轮推理。写进心跳的 `busy` 字段（`companion.mjs:1967`），WebUI 显示成「思考中」（`webui.mjs:60`）。
- 运行端 `Scheduler.busy()`（`scheduler.ts:64`）：身体在干活（任务、动作、陪伴差事、保护战斗），给进食、礼物装备判断用；`assertIdle`（`scheduler.ts:57`）报 `BUSY` 错误码。
- 两者无关：Agent 推理时身体可能闲着，身体干长任务时 Agent 早结束了这一轮。名字一样容易混。
- 应归：各管各的，不需要同步。驱动器这边拆分后内部改叫 `inTurn`（“这一轮还没结束”）；心跳字段 `busy` 是 WebUI 在读的接口，先不改，以后改名要 WebUI 一起改。

### 6. 心跳“新鲜”的 60 秒写了两次

- 驱动器 `HEARTBEAT_FRESH_MS`（`companion.mjs:73`）用来判断锁的持有者还活着；运行端 `hostedHeartbeatFresh`（`lifecycle.ts:52`）写死 `60_000` 判断托管还在。
- 应归：心跳是驱动器写的，时长应该由**驱动器**定、放进一份两边都读的 JSON（像 `player-stop.json` 那样）。

### 7. 心跳里的压缩次数

- 驱动器数压缩次数（`compactions`，`companion.mjs:918`、`noteCompaction` `companion.mjs:1207`）写进心跳；运行端读到变了就把玩法说明再给一次（`lifecycle.ts:38`、`guides.ts:59`、`main.ts:131`）。
- 这是有意的跨层信号，归**驱动器**写、运行端读，写清楚即可。

### 8. 记忆的路径和“没整理条数”算了两遍

- 世界标识转义：驱动器 `worldKey`（`companion.mjs:610`）和运行端 `worldKey`（`memory.ts:128`）。
- 没整理的日志条数：驱动器 `memoryStatus`（`companion.mjs:491`）按 `state.json` 的游标数日志，和运行端 `MemoryStore.unconsolidated`（`memory.ts:421`）同一算法。
- 记忆开没开：驱动器看 `persona.md` 在不在（`companion.mjs:854-857`），运行端 `openMemory`（`main.ts:198`）再看一遍。
- 原因：驱动器不能 import `scripts/` 以外的模块（绿色版打包只带 `scripts/` 和运行端的 dist）。
- 应归：记忆数据归**运行端**。驱动器只需要“上次整理时间、还有几条没整理”，以后可以由运行端的 `--memory-only` 进程或一个状态文件给出，驱动器不再自己数。

### 9. 交接单读运行端的记录

- `buildHandoff`（`companion.mjs:581`）读 `operations-<名字>.jsonl`（运行端）、`posture-<名字>.json`（运行端）、`activity-<名字>.jsonl`（驱动器），还读运行端的工具表 `client-runtime/tool-registry.json`（`companion.mjs:64`）判断哪个工具算任务、在服务端叫什么名字（`runsAs`）。
- 应归：事实归**运行端**，拼成给模型的文字归**驱动器**。可以接受；以后可以让运行端给一份“最近任务和姿态”的摘要，驱动器不再解析它的记录格式。

### 10. 事件送达用三个文件来回握手

- 驱动器写 `cursor`（送到哪了），运行端写 `consumed`（模型自己用 `wait-for-events` 读到哪了）和 `task-delivered`（哪些任务结果已经随工具结果给过）。驱动器的 `deliveredSeq`（`companion.mjs:885`）和运行端的 `deliveredSeq()`（`events.ts:296`）是同一个数的两端。
- 应归：这是两层之间的协议，不算重复。拆分后驱动器这一端都在事件读取模块里。

### 11. 驱动器替运行端清理控制文件

- `server-control-<名字>.json`、`client-body-<名字>.lock` 是运行端的，驱动器在叫停和退出时按“运行端进程已死、内容一字节没变”删（`captureBodyArtifacts`／`cleanupBodyArtifacts`，`companion.mjs:322-351`）。
- 应归：**运行端**。驱动器删是运行端被强杀后的善后，条件很严，保留。

### 12. 聊天有两个来源

- 运行端的事件文件里有聊天；驱动器的控制通道（`server-body-control.mjs:146` `poll`）还单独向服务端 `watch` 拉聊天，用来在运行端卡住或已撤销时收叫停和新任务。服务端的 `chatCursor`（租约里带）给两边对齐起点。
- 应归：聊天的事实归**服务端**；运行端是正常通道，驱动器的控制通道只在撤销后或兜底时用。现在的分法对。

### 13. 死亡

- 服务端记 `lastDeath`（`ServerController.java:115`）；驱动器启动时 `respawnIfDead`、`lastDeath`（`server-body-control.mjs:41`、`55`）复活并写【角色重生】提示（`deathNote`，`companion.mjs:161`）；捡掉落、接回姿态由运行端 `death-recovery.ts` 做。
- 分得清楚：驱动器只告诉 Agent。

## 后续建议（这次不做）

1. 驱动器不再删姿态文件、不再自己判断姿态记录能不能接：叫停靠 `lastStopAt` 已经挡住；真正退出时改由驱动器通知运行端（或在会话文件里写“托管已结束”），由运行端删（第 1 条）。
2. 原地叫停也让驱动器记 `lastStopAt`：收到 `cancel` 类的 `player_stop` 时更新（或由运行端写叫停记录、驱动器只读），交接单才能把原地取消的任务标成“已取消”（第 2 条）。
3. 叫停词识别加一张两边共用的用例表（第 3 条）。
4. 两个 10 秒（`STOP_CONFIRM_MS`、`cancelTimeoutMs`）和心跳的 60 秒放进共用的 JSON（第 4、6 条）。
5. 心跳的 `busy` 字段改名 `thinking`，WebUI 同步（第 5 条）。
6. “没整理条数”由运行端给，驱动器不再复制 `worldKey` 和计数算法（第 8 条）。
