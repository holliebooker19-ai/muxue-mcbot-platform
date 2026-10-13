# 状态归属：谁管什么

2026-10-13 为拆驱动器（[交付计划](delivery_plan.md)「开发新功能前必须先处理」第 3 条）写的。先定三层各管哪些状态，再核对现有代码里重复保存、跨层读写的地方。**这次只记录，不改跨层行为**；可以收拢的列在最后，作为后续建议。

驱动器 2026-10-13 从一个 2080 行的 `scripts/companion.mjs` 拆成 `scripts/driver/` 下的模块（见最后一节）。下面写 `driver/xxx.mjs:行号` 的都在 `scripts/driver/` 里；行号是拆完时的位置，代码改了以函数名为准。

## 三层分工

| 层 | 位置 | 管什么 |
| --- | --- | --- |
| 服务端（Java） | `mods/mcbot-server-control` | 游戏里的事实和正在执行的动作：租约（`instanceId`、`sessionId`、`leaseId`、`stopToken`）、正在跑的操作、保护（守卫）、活着的陪伴姿态（`Posture.java`，属于租约，普通 stop 不清）、聊天游标（`watch`、`chatCursor`）、上次死亡（`ServerController.lastDeath`）。 |
| 运行端（TS） | `client-runtime` | 跟随／等待／保护姿态的请求和持久化（`companion-mode.ts`、`posture.ts`）；任务进度和身体任务锁（`scheduler.ts`、各 `*-tasks.ts`）；游戏里“等一下／停”的原地停（`player-stop.ts`）；地点、熔炉（`places.ts`、`machines.ts`）；记忆数据（`memory.ts`）；事件日志（`events.ts`）。 |
| 驱动器（JS） | `scripts/companion.mjs`、`scripts/driver/` | Agent 会话的开关、续接、压缩、换会话，以及把事件攒成一批送进去。 |

驱动器除了上面这一行，还管着这些，都和“Agent 会话”直接相关，留在驱动器：

- 托管心跳和单实例锁（运行端靠心跳判断“有托管在控制”）。
- 出错归类和额度暂停（暂停期间不送新一轮）。
- 整理记忆的**安排**：什么时候整理、另起整理会话；不读写记忆内容，只看 `state.json` 的整理时间和日志条数判断要不要整理、整理成没成。
- 交接单：换会话时读驱动器和运行端已经写下的记录，拼成一段文字送给新会话。
- ServerBody 控制通道（`scripts/server-body-control.mjs`）：撤销控制（WebUI 急停、运行端停不下来时的兜底）、叫停后等新任务、托管退出时让角色下线。

## runtime/ 里的文件：谁写谁读

`<名字>` 是游戏名。驱动器的文件名都在 `runtimeFiles`（`driver/args.mjs:62`）。

| 文件 | 写 | 读 | 删 |
| --- | --- | --- | --- |
| `companion-<名字>.json` 心跳 | 驱动器 `createHeartbeat`（`driver/lock.mjs:58`），字段 `pid`、`updatedAt`、`busy`、`compactions`（`scripts/companion.mjs:134`） | 运行端 `hostedHeartbeatFresh`（`client-runtime/src/lifecycle.ts:44`）判断托管还在；`hostedCompactions`（`lifecycle.ts:40`）看压缩次数；WebUI（`scripts/webui.mjs:51`）显示在线、思考中；驱动器 `lockHolder` | 驱动器退出时 `removeIfOwn` |
| `companion-<名字>.lock` | 驱动器 `acquireLock` | 驱动器 | 驱动器 `releaseLock` |
| `companion-<名字>.stop` / `.halt` | WebUI、`stop-companion.ps1` | 驱动器每 400 毫秒看一次（`checkMarkers`，`driver/lifecycle.mjs:108`）；`.stop` 也被 `start-server-play.mjs:180` 看 | 驱动器 |
| `session-<名字>.json` 会话 | 驱动器 `save`（`driver/session.mjs:79`） | 驱动器 `readSessionState`；**运行端** `takeHeldPosture` 读其中的 `lastStopAt`（`client-runtime/src/posture.ts:44`，由 `main.ts:147` 传入路径）；WebUI | 没人删 |
| `posture-<名字>.json` 姿态 | 运行端 `writePosture`（`posture.ts:8`，`main.ts:148` 挂到 `companion.onPosture`） | 运行端启动时 `takeHeldPosture`（`main.ts:147`，读完即删）；**驱动器** `buildHandoff`（`driver/handoff.mjs:45`） | 运行端（读完、明确结束时）；**驱动器** `stopServerAgent`（`driver/stop.mjs:139`）、`shutdown`（`driver/lifecycle.mjs:46`，不是等重连时） |
| `events-<名字>.jsonl` 事件 | 运行端 `EventJournal`（`events.ts:70`），每个进程启动时原地清空重写 | 驱动器 `createEventReader().poll`（`driver/events.mjs:73`） | — |
| `cursor-<名字>.txt` 已送达序号 | **驱动器** `markDelivered`（`driver/events.mjs:142`），由每一轮送出时（`driver/inbox.mjs:117`）、叫停撤销（`driver/stop.mjs:142`）、独立身份叫停（`driver/stop.mjs:187`）调用；运行端启动时清空（`events.ts:71`） | 运行端 `deliveredSeq`（`events.ts:298`），`wait-for-events` 不重复返回 | — |
| `consumed-<名字>.txt` 模型自己读过的序号 | 运行端 `markConsumed`（`events.ts:305`） | 驱动器 `consumedSeq`（`driver/events.mjs:133`） | — |
| `task-delivered-<名字>.json` 随工具结果送过的任务结果 | 运行端 `writeTaskReceipts`（`events.ts:96`） | 驱动器 `flush`（`driver/turns.mjs:232`）+ `taskAlreadyDelivered`（`driver/events.mjs:42`） | — |
| `operations-<名字>.jsonl` 操作结果 | 运行端（`events.ts:124`） | 驱动器 `createServerHandoff`（`driver/handoff.mjs:58`） | — |
| `activity-<名字>.jsonl` 活动记录 | 驱动器 `activity`（`driver/log.mjs:58`） | WebUI；驱动器 `buildHandoff`（自己的聊天、工具调用；连同轮转出的 `.1` 一起读） | 启动时超过 5MB 轮转 |
| `server-control-<名字>.json` 控制租约 | 运行端 `onLease`（`main.ts:114`） | 驱动器 `server-body-control.mjs:71` `capture`；`captureBodyArtifacts`（`driver/stop.mjs:66`） | 运行端 `removeControlFile`（`main.ts:73`）；**驱动器** `cleanupBodyArtifacts`（`driver/stop.mjs:81`，只在运行端进程已死、内容没变时） |
| `client-body-<名字>.lock` 运行端锁 | 运行端 `acquireRuntimeLock`（`lifecycle.ts:16`） | 驱动器 `captureBodyArtifacts` | 运行端；**驱动器** `cleanupBodyArtifacts`（同上条件） |
| `bot-<名字>.lock` | 旧 Mineflayer MCP 服务端 | 驱动器 `waitBotLockFree`（`driver/agent-process.mjs:183`） | 旧 MCP 服务端 |
| `mcp-hosted-<名字>.json`、`mcp-memory-<名字>.json` | 驱动器 | Agent CLI | — |
| `<记忆目录>/<角色>/worlds/<世界>/state.json` 整理进度 | 运行端整理会话写入时：ServerBody 的 `memory-write` 走 `MemoryStore.edit`（`memory.ts:357`），旧路径的整段覆盖走 `write`（`memory.ts:288`），都是带 `through` 那次 | 驱动器 `memoryStatus`（`driver/memory.mjs:32`） | — |

## 重复保存或跨层读写的状态

每条写现状、问题和应该归哪层。

### 1. 姿态文件 `posture-<名字>.json`

- 现状：运行端写（`posture.ts:8`）、运行端启动时读并删（`posture.ts:32`，`main.ts:147`）。驱动器在两处删它：叫停撤销（`stopServerAgent`，`driver/stop.mjs:158`）和真正退出（`shutdown`，`driver/lifecycle.mjs:46`）；换会话时读它拼交接单（`buildHandoff`，`driver/handoff.mjs:46-52`）。活着的姿态还在服务端（`Posture.java`，属于租约）。
- 重复：驱动器 `buildHandoff` 自己又校验了一遍记录（动作名、玩家名格式、`at > lastStopAt`，`driver/handoff.mjs:48`），和运行端 `takeHeldPosture`（`posture.ts:39-45`）是两份规则，而且**不一样**：运行端超过 `HELD_POSTURE_MAX_AGE_MS`（1 小时，`posture.ts:18`）的记录不接，驱动器的交接单不看时间，会写“能接上的话运行端会自己接上”。
- 叫停时驱动器删文件，其实运行端已经按 `lastStopAt` 不接叫停前的记录（`posture.ts:45`），是双保险。
- 应归：**运行端**。驱动器只读，不删、不判断能不能接。

### 2. 叫停时间 `lastStopAt` 有两套

- 现状：驱动器的 `lastStopAt` 由会话持有（`createSession`，`driver/session.mjs:75`），写进 `session-<名字>.json`（`save`，`driver/session.mjs:79`），运行端读它判断姿态记录能不能接（`posture.ts:44`）。驱动器拿它写【停止记录】提示（`stopRecord`，`driver/prompts.mjs:161`，`driver/inbox.mjs:125`）和交接单的“已取消”（`buildHandoff`）。
- 原来的问题：驱动器只在**撤销控制**的叫停（`stopServerAgent`，`driver/stop.mjs:155`；WebUI 急停、运行端 10 秒没确认）和独立试玩身份叫停（`driver/stop.mjs:204`）时更新它；游戏里原地取消后换会话，交接单不会把被取消的任务标成“已取消”。
- **10-13 已做**：运行端写 `player_stop` 时带上结构化字段 `stop`（`pause`／`cancel`）和 `player`（叫停的玩家）（`player-stop.ts:78`，`EventJournal.add` 的第三个参数，`events.ts:86`），驱动器不解析中文。驱动器收到 `player_stop` 时（`driver/events.mjs:178` → `playerStopConfirmed`，`driver/stop.mjs:248`）先清兜底计时器（有才清），再看 `stop`：`cancel` 才用**事件里的时间**（运行端停好身体的时候；叫停词之后运行端不再受理动作和任务，`mcp.ts:134` `holding()`，所以叫停前开始的任务都早于它）`markStop` 并存会话文件，同时把 `lastStopBy` 记成这位玩家；不比已记的晚就不记（同一句不重复记，也不把更晚的撤销叫停改回去）；`pause` 不记（说继续还要接着做）。计时器开没开不影响记不记。随之【停止记录】改成同一次叫停在同一个 Agent 进程里只附一次（`driver/inbox.mjs:125`，Agent 启动时 `agentStarted`、上下文压缩后 `compacted` 重置，额度／登录报错重送那一轮时也再附），原地取消后对话还在接着，不再每轮都附。
- 应归：叫停的事实归**运行端**（它真正停了身体）；驱动器只读来写提示。会话文件里的 `lastStopAt` 是驱动器写给运行端看的跨层接口，现在先保留。

### 3. 叫停词识别有两份

- 驱动器 `isAddressedStop`（`driver/stop.mjs:17`），给事件文件和 ServerBody 控制通道（`server-body-control.mjs:169` 的 `isStop`）用；运行端 `stopKind`（`player-stop.ts:28`）。两边读同一份 `client-runtime/player-stop.json`（`driver/stop.mjs:11`、`player-stop.ts:18`），但点名、去前缀、尾标点的写法各写一遍。驱动器的还会剥“名字: ”这种日志前缀，运行端拿到的已经是正文。
- 应归：词表已经共用。识别逻辑两层都需要（运行端原地停；驱动器在运行端卡住时兜底、在撤销后的等待期从控制通道收叫停）。不收拢，但应该有一张共用的用例表，两边都跑。

### 4. 叫停流程分在两层

- 游戏里叫停：运行端 `PlayerStop.hear`（`player-stop.ts:54`）原地停，发 `player_stop` 事件；同时不再受理动作和任务（`mcp.ts:134` `holding()`）。驱动器 `armPlayerStop`（`driver/stop.mjs:130`）只开一个 `STOP_CONFIRM_MS`（10 秒，值在 `client-runtime/host-timing.json` 的 `stopConfirmMs`，`driver/stop.mjs:14` 读入）的计时器，收到 `player_stop` 就清掉（`driver/events.mjs:178` → `driver/stop.mjs:248`）；到时没收到才走 `stopServerAgent` 撤销。
- 同一句叫停可能从两条路到驱动器：事件文件（`driver/events.mjs:174`）和控制通道 `watch`（`server-body-control.mjs:169` → `onStop` → `armPlayerStop`，`driver/stop.mjs:293`），先后不定。原来只靠计时器去重：事件文件先到时，同一次读取里运行端的 `player_stop` 已经把计时器清了，控制通道后到的同一句又开一个，10 秒后照样撤销。**10-13 已改**：按配对去重（`sameStopFromOtherPath`，`driver/stop.mjs:117`）——一条路来的叫停，另一条路在 `STOP_CONFIRM_MS` 内来过同一位玩家（事件的 `username`，运行端写聊天事件时带上，`events.ts:173`）还没配上的叫停，就算同一句，一对一配掉、不再开计时器。两边时间不是同一个钟（独立服务器时控制通道带服务器时间），只看驱动器收到的时间。私聊只走事件文件，不配；没带玩家名的旧事件不配。剩下的边界：一条路漏了一句（比如控制通道断了），玩家 10 秒内又说一遍时，漏掉那句的另一份会把这一遍配掉，这一遍不开兜底计时器（运行端照样原地停，只少了兜底）。
- 撤销控制时（`stopServerAgent`）收件箱连同进行中那一轮的输入一起清掉（`inbox.clear`），之后额度／登录暂停结束也不会把叫停前的话再送。不经收件箱拼的整轮——启动轮（带交接单的那次也是）和撤销后的新任务轮——额度／登录报错、没动过工具时，暂停结束后整段原样再送一次（`sendTurn` 的 `resend`，`driver/turns.mjs` 的 `flush` 先送它）。
- WebUI「叫停」是急停：驱动器直接 `stopServerAgent`（`halt`，`driver/stop.mjs:269`），撤销控制、结束这一轮 Agent，进入“等新任务”（`waiting`、排着的新任务）。
- `STOP_CONFIRM_MS`（`driver/stop.mjs:14`）和 Codex 连接的 `cancelTimeoutMs`（默认值，`scripts/agents/codex-app-server.mjs:60`）是同一个 10 秒。**已做**：两处都从 `client-runtime/host-timing.json` 的 `stopConfirmMs` 来（`scripts/host-timing.mjs` 读文件）；`cancelTimeoutMs` 仍可传参数，测试可以传小值。
- 应归：原地停归**运行端**；兜底撤销、急停、撤销后等新任务归**驱动器**（这些要结束 Agent 进程，只有驱动器能做）。现在的分法对，两个 10 秒已共用一处。

### 5. 两个 `busy` 不是一回事

- 驱动器原来的 `busy`：Agent 正在跑一轮推理。拆分后叫 `inTurn`（`driver/turns.mjs:21`），写进心跳时字段名仍是 `busy`（`scripts/companion.mjs:134`），WebUI 显示成「思考中」（`webui.mjs:60`）。
- 运行端 `Scheduler.busy()`（`scheduler.ts:64`）：身体在干活（任务、动作、陪伴差事、保护战斗），给进食、礼物装备判断用；`assertIdle`（`scheduler.ts:57`）报 `BUSY` 错误码。
- 两者无关：Agent 推理时身体可能闲着，身体干长任务时 Agent 早结束了这一轮。名字一样容易混。
- 应归：各管各的，不需要同步。驱动器内部已改叫 `inTurn`；心跳字段 `busy` 是 WebUI 在读的接口，这次不改，以后改名要 WebUI 一起改。

### 6. 心跳“新鲜”的 60 秒写了两次

- 驱动器 `HEARTBEAT_FRESH_MS`（`driver/lock.mjs:20`、`21`）用来判断锁的持有者还活着；运行端 `hostedHeartbeatFresh`（`lifecycle.ts:54`）判断托管还在；WebUI `listBots`（`scripts/webui.mjs:53`）判断在线；旧 Mineflayer 路径的 `heartbeatFresh`（`mcp-server/src/presence.ts:187`）判断托管心跳新鲜。原来四处各写一个 60 秒。
- 应归：心跳是驱动器写的，时长应该由**驱动器**定、放进一份两边都读的 JSON（像 `player-stop.json` 那样）。
- **已做**：时长是 `client-runtime/host-timing.json` 的 `heartbeatFreshMs`（和上面的 `stopConfirmMs` 同一个文件，打包清单 `RUNTIME_FILES` 里带上）；驱动器、WebUI 经 `scripts/host-timing.mjs` 读，运行端 `lifecycle.ts:35` 和 `presence.ts:181` 直接读。各处比较的边界没动：运行端、`presence.ts` 差正好这么久还算新鲜，驱动器的锁和 WebUI 差正好这么久就不算。

### 7. 心跳里的压缩次数

- 驱动器数压缩次数（`compactions`，`driver/session.mjs:77`、`noteCompaction` `driver/session.mjs:144`）写进心跳；运行端读到变了就把玩法说明再给一次（`lifecycle.ts:40`、`guides.ts:59`、`main.ts:132`）。
- 这是有意的跨层信号，归**驱动器**写、运行端读，写清楚即可。

### 8. 记忆的路径和“没整理条数”算了两遍

- 世界标识转义：驱动器 `worldKey`（`driver/memory.mjs:71`）和运行端 `worldKey`（`memory.ts:128`）。
- 没整理的日志条数：驱动器 `memoryStatus`（`driver/memory.mjs:32`）按 `state.json` 的游标数日志，和运行端 `MemoryStore.unconsolidated`（`memory.ts:421`）同一算法。
- 记忆开没开：驱动器看 `persona.md` 在不在（`driver/config.mjs:44-47`），运行端 `openMemory`（`main.ts:199`）再看一遍。
- 原因：驱动器不能 import `scripts/` 以外的模块（绿色版打包只带 `scripts/`、运行端的 dist，和运行端的几个 JSON：`tool-registry.json`、`player-stop.json`、`memory-limits.json`、`host-timing.json`，驱动器也读它们）。
- 应归：记忆数据归**运行端**。驱动器只需要“上次整理时间、还有几条没整理”，以后可以由运行端的 `--memory-only` 进程或一个状态文件给出，驱动器不再自己数。

### 9. 交接单读运行端的记录

- `buildHandoff`（`driver/handoff.mjs:29`）读 `operations-<名字>.jsonl`（运行端）、`posture-<名字>.json`（运行端）、`activity-<名字>.jsonl`（驱动器；连同启动时轮转出的 `.1`），还读运行端的工具表 `client-runtime/tool-registry.json`（`driver/handoff.mjs:10`）判断哪个工具算任务、在服务端叫什么名字（`runsAs`）。
- 应归：事实归**运行端**，拼成给模型的文字归**驱动器**。可以接受；以后可以让运行端给一份“最近任务和姿态”的摘要，驱动器不再解析它的记录格式。

### 10. 事件送达用三个文件来回握手

- 驱动器写 `cursor`（送到哪了），运行端写 `consumed`（模型自己用 `wait-for-events` 读到哪了）和 `task-delivered`（哪些任务结果已经随工具结果给过）。驱动器的 `deliveredSeq`（`driver/events.mjs:59`）和运行端的 `deliveredSeq()`（`events.ts:298`）是同一个数的两端。
- 应归：这是两层之间的协议，不算重复。拆分后驱动器这一端都在 `createEventReader`（`driver/events.mjs`）里。

### 11. 驱动器替运行端清理控制文件

- `server-control-<名字>.json`、`client-body-<名字>.lock` 是运行端的，驱动器在叫停和退出时按“运行端进程已死、内容一字节没变”删（`captureBodyArtifacts`／`cleanupBodyArtifacts`，`driver/stop.mjs:66-95`）。
- 应归：**运行端**。驱动器删是运行端被强杀后的善后，条件很严，保留。

### 12. 聊天有两个来源

- 运行端的事件文件里有聊天；驱动器的控制通道（`server-body-control.mjs:146` `poll`）还单独向服务端 `watch` 拉聊天，用来在运行端卡住或已撤销时收叫停和新任务。服务端的 `chatCursor`（租约里带）给两边对齐起点。
- 应归：聊天的事实归**服务端**；运行端是正常通道，驱动器的控制通道只在撤销后或兜底时用。现在的分法对。

### 13. 死亡

- 服务端记 `lastDeath`（`ServerController.java:115`）；驱动器启动时 `respawnIfDead`、`lastDeath`（`server-body-control.mjs:41`、`55`）复活并写【角色重生】提示（`deathNote`，`driver/prompts.mjs:16`）；捡掉落、接回姿态由运行端 `death-recovery.ts` 做。
- 分得清楚：驱动器只告诉 Agent。

## 后续建议（这次不做）

1. 驱动器不再删姿态文件、不再自己判断姿态记录能不能接：叫停靠 `lastStopAt` 已经挡住；真正退出时改由驱动器通知运行端（或在会话文件里写“托管已结束”），由运行端删（第 1 条）。
2. ~~原地叫停也让驱动器记 `lastStopAt`~~ **10-13 已做**：`player_stop` 事件带 `stop`／`player` 字段，驱动器收到 `cancel` 时按事件时间记 `lastStopAt`，暂停不记；交接单因此把原地取消前的任务标成“已取消”（做法见第 2 条）。
3. 叫停词识别加一张两边共用的用例表（第 3 条）。
4. 两个 10 秒（`STOP_CONFIRM_MS`、`cancelTimeoutMs`）和心跳的 60 秒放进共用的 JSON（第 4、6 条）。**已做**：`client-runtime/host-timing.json`。
5. 心跳的 `busy` 字段改名 `thinking`，WebUI 同步（第 5 条）。
6. “没整理条数”由运行端给，驱动器不再复制 `worldKey` 和计数算法（第 8 条）。

## 驱动器内部模块（scripts/driver/）

`scripts/companion.mjs` 是入口：命令行用法写在它开头，`main()` 把下面这些接起来，并转出测试和夹具脚本要用的名字。有状态的模块都是工厂函数，状态在闭包里，对外只给方法和只读属性；模块之间要用对方时传函数（调用时才取），不共用一个可变对象。驱动器只能 import `scripts/` 里的模块（绿色版打包按 import 收集 `scripts/` 下的文件，`scripts/package.mjs` 的 `scriptClosure`）。

| 模块 | 负责 | 持有的状态 |
| --- | --- | --- |
| `args.mjs` | 命令行参数、`runtime/` 目录和文件名 | 无 |
| `config.mjs` | 启动时一次算好的设置（记忆位置和开没开、身体范围、启动提示、会话的平台和账号目录） | 无（返回只读设置） |
| `files.mjs` | 读写 JSON、原子写文件、进程在不在 | 无 |
| `mcp-config.mjs` | 托管 MCP 配置、整理会话的 MCP 配置、记忆位置 | 无 |
| `lock.mjs` | 单实例锁、托管心跳 | 心跳只在写的时候问状态 |
| `log.mjs` | 文本日志、活动记录、游戏里的托管提示 | 提示的限频记录 |
| `errors.mjs` | 出错归类、额度恢复时刻、额度暂停 | 暂停到哪个时刻 |
| `session.mjs` | 会话状态文件和续接判断 | 对话 ID、上次请求、上下文大小和窗口、上次叫停、压缩次数 |
| `memory.mjs` | 整理触发、该不该整理、没整理的日志条数、按世界放的路径 | 无 |
| `handoff.mjs` | 交接单 | 无 |
| `prompts.mjs` | 发给模型的所有文字（启动轮、系统指令、整理、新会话、每轮的开头和结尾） | 无 |
| `consolidation.mjs` | 整理记忆的安排，ServerBody 的单独整理会话 | 排队和正在跑的整理轮、要不要换会话、整理会话和它的重试 |
| `events.mjs` | 读事件文件、一条事件怎么处理 | 读到的位置、MCP 进程的 session、已送达序号 |
| `inbox.mjs` | 攒批、拼每一轮要送的话 | 没送出去的事件／输入／提示、攒批计时、下一轮开头的说明、这一轮的输入 |
| `agent-process.mjs` | 启动和结束 Agent 进程、读写它的输入输出 | 当前进程、正在退出的旧进程、回复的半行文字、系统指令 |
| `turns.mjs` | 每一轮的发送和结束、压缩、换会话、崩溃重启、空闲检查 | 这一轮的状态（`inTurn` 等）、重启次数、换会话中、压缩排队和失败 |
| `stop.mjs` | 叫停、ServerBody 控制通道、撤销后等新任务 | 确认计时、正在撤销、等新任务、排着的新任务、上次叫停的玩家、控制通道 |
| `lifecycle.mjs` | 启动（锁、托管配置）和退出、停止／叫停标记 | 是不是正在退出 |
| `server-check.mjs` | 旧 Mineflayer 路径的服务器在线检查 | 连上过没有、上次的状态 |
