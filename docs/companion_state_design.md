# 陪伴状态设计：姿态、任务、打断

2026-10-10 起草。起因是用户觉得托管时的状态管理设计得不好（8l 刚把跟随改成持续状态，但守卫、跟随、建筑、临时小任务之间的关系还是乱的）。本文先整理现状和问题，再定分层目标和分步路线；**第一步是守卫和跟随解耦**，详细设计见第 5 节。同一天的外部陪伴体验评审见 [companion_experience_review.md](companion_experience_review.md)，其中第 5 条与本文第一步是同一个问题。

状态：第 6 节的三个问题用户 10-10 已定。第一步分两块做：
- **第一块（10-10，离线完成）**：服务端常驻保护（`GuardDuty`、协议方法 `guard`、观察里的 `guard`），空闲、原地等待、跟随时都能保护，等待中打完走回原位；运行端改用它（跟随让开、等待都不关保护，`companion-mode stop`／`stop-action` 关）。协议见 [server_body_protocol.md](server_body_protocol.md#常驻保护8m-第一步第一块2026-10-10)。离线：Java `GuardDutyTest` 17 项、`ControlSessionTest` 和 `FollowCompanionTest` 补的检查，运行端 `companion-guard-duty.test.mjs` 5 项；没有隔离服实测、没有真实模型试玩。
- **第二块（10-10，离线＋隔离服完成）**：5.2 表里的任务打断和期限顺延，能力`guard-duty-tasks`，协议见 [server_body_protocol.md](server_body_protocol.md#保护打断任务8m-第一步第二块2026-10-10)。和 5.2 表的出入：`emote`手势不打断（几秒就完，打断反而要多处理一个被取消的操作）；`approach-player`不打断（玩家一动它就失败）；走向床可打断。没有改“打架开始前在路上挨打就 `BLOCKED`”的规则，打完后才把受伤基线重置。隔离服`server-guard-duty-smoke`8 项通过（等待、地面建筑、垫脚柱上不打、玩家太远），没有真实模型试玩；合成界面开着时只有离线检查。

**适用范围（2026-10-11 用户定）**：本文只针对**单人陪伴**，也就是服务器上一个真人玩家和一个 Bot。多人（多个真人，或多个 Bot）暂不适配，放到以后，已知的问题记在 7.9。在此之前，设计照单人的情况写：Bot 陪的就是那个玩家，跟谁就保护谁，听到的命令都当成这个玩家下的。

## 1. 现状：状态分在三层

| 层 | 状态在哪 | 怎么组织 |
| --- | --- | --- |
| 服务端会话 | `ControlSession.java` | 同一时间只有一个 running 操作（`send-chat` 除外）；每次 `stop` 都让 `controlGeneration` 加一，并调 `game.stop()` |
| 服务端执行 | `ServerController.java` | 十几个可空字段（`companion`、`pickup`、`pillar`、`station`、`job`、`build`、`farm`、`breed`、`travel`、`navigation`、`sleepBed`、`retreatTarget`……）实际上是“只有一个非空”；`beforePhysics` 用一串 `if` 决定这一刻驱动谁，顺序就是隐含的优先级；`stop()` 一次清空全部 |
| 运行端 | `client-runtime/src/` | 6 个各自独立的“任务主人”：`ContainerTasks`、`GatherTasks`、`SurvivalTasks`、`PillarTasks`、`CompanionMode`、`SurvivalReflexes`，各有一套 epoch／active／stopping／`cancel()`／`stopped()`；合成、烧炼、建筑、长途走、种地等工具没有主人，直接 `body.act`，运行端只能从 `pendingOperations()` 看出它们在跑 |

`CompanionMode` 单独有约 15 个互相牵连的状态变量：`state`（6 种）、`intent`、`activity`、`suspendedFor`、`awaitingPlayer`、`leases`、`childActive`、`changing`、`stopping`、`stopUnconfirmed`、`epoch`、`observationRevision`、`resumeTimer`、`pickup`、`mining`。

## 2. 问题

1. **守卫挂在跟随底下（最影响体验）**。保护玩家只是 `follow-companion` 操作的 `guard` 参数，`GuardCombat` 只在 `FollowCompanion.tick()` 里跑。所以：
   - 原地等待时不能保护（`companion-mode.ts` 的 guard 分支直接拒绝 wait）。
   - 任何占用身体的工具（建筑、采集、合成、长途走，甚至 `emote`）一开始，跟随就让开，服务端的 follow 操作被停掉，**保护跟着没了**，只剩运行端 3 格近身自卫，而且只护 Bot 自己。“帮我砍树，同时保护我”在行为上有空档。
2. **跟随“让开”是拆掉再重建**。持续意图在服务端只是一个普通操作。每次让开：pause → `body.stop()`（代次加一）→ 跑工具 → 身体空闲满 3 秒 → 重新观察 → 再提交一次 `follow-companion`。因此到处是“新代次还算不算我的”检查（`adoptable`、`exactlyNext`、`internalStop`），还需要补丁：`resumeDelayMs = 3000` 防止两次工具调用之间跟随把身体带走；`emote` 在租约里 sleep 等动画放完，防止跟随提前接上。
3. **CompanionMode 既是模式又是调度器**。陪挖、陪捡作为跟随的子任务塞在里面（`mineBlock`、`pickupItem`、`returnFromMining`、`block`），和 `GatherTasks` 靠借锁（`borrowed`）配合，约占 600 行里的一半。
4. **任务没有统一模型，“忙不忙”的判断散在多处且不一致**。`tasks.assertIdle(); gather.assertIdle(); survival?.assertIdle()` 在 `idleBody`、`busyProbe`、`ordinaryBusy`、`pauseCompanion`、`PillarTasks` 各写一遍；普通原子动作只查 `tasks.assertIdle()`；`busyProbe` 不查垫高（靠身体写锁兜底）。新加一个工具要同时改 `bodyTools` 集合、`idleBody`、Codex 白名单、服务端 begin／tick／stop，漏一处不报错。
5. **打断后的处理不一致**。跟随、等待被自卫或进食打断后会自动接上；建筑、种地、长途走被打断就取消（“不重放旧任务”），模型得自己发现再调一次。可这几个任务本来就是按世界现状重新规划的，能安全续做（建筑已支持“同样参数再调一次接着盖”）。
6. **小动作也走整套让开**。`look-at`、`emote`、`select-slot`、`equip-item` 不移动身体，也会触发让开、换代次、等 3 秒、重新跟随。

## 3. 目标：三层

参照原版生物的 `GoalSelector`（按优先级排的行为，加 MOVE／LOOK 这类互斥标志）：

1. **姿态层（常驻，在服务端）**：跟随、等待、守在某处；**保护谁**是独立的一项，和跟随正交。有任务时姿态在服务端挂起，任务结束后服务端自己恢复，不需要运行端重新提交、也不换代次。
2. **任务层（同时一个）**：统一生命周期 running／suspended／succeeded／failed／cancelled／unknown，每个任务声明能不能续做、此刻能不能被打断。
3. **打断层（按优先级抢占）**：保护玩家 > 近身自卫 > 紧急进食 > 普通进食，统一走“挂起当前任务 → 处理 → 恢复”。

运行端相应改成一个调度器，替代 6 个主人各自的 epoch 和空闲检查；每个工具在注册时声明属性（占不占移动、能否续做、能被谁打断），去掉 `bodyTools` 这类集合和重复的 `assertIdle`。

叫停也分开（与评审第 1 条一致）：暂停当前动作、取消当前任务、紧急停止（清掉所有姿态和保护）是三件事。

## 4. 分步路线

每一步都能单独上线、单独验收：

| 步 | 内容 | 主要改动 | 估计 |
| --- | --- | --- | --- |
| 1 | **守卫解耦**：保护玩家变成服务端独立的常驻职责，在等待、做任务时都有效（第 5 节） | 服务端新职责层和协议方法；任务的可打断点和期限顺延；运行端 `GuardDuty` | 2.5～3.5 天 |
| 2 | **姿态在服务端挂起／恢复**：跟随、等待、坐着成为服务端姿态，让开不再拆掉重建（第 7 节） | `FollowCompanion` 从操作改成姿态；`CompanionMode` 去掉让开、代次接纳逻辑 | 4～5 天（10-11 估） |
| 3 | **小动作不打断姿态**：按 MOVE／LOOK 标志区分，`look-at`、`emote`、选格、穿装备不让开。10-11 先做了 select-slot、equip-item；emote、look-at 仍让开，待第 2 步后再做。**2026-10-11 完成（离线，未进游戏）**：没有用 MOVE／LOOK 标志，而是两张名单放在 `Posture.java`：`look-at` 进 KEEPS（姿态照常驱动）；内置手势 `emote` 进 HOLDS（播放时站住但不挂起、不补 3 秒，正常结束即继续跟随）；附加动画不变（挂起，播完 3 秒）。坐着时不变。见[协议](server_body_protocol.md)「陪伴姿态」一节里的「不让姿态挂起的操作」。 | 名单（`Posture`、`ServerController.finish`） | 0.5 天 |
| 4 | **统一任务生命周期**：运行端单一调度器；建筑、种地、长途走被打断后续做 | 合并 6 个任务主人的公共部分；服务端可空字段改成一个任务槽 | 待评估 |

陪挖、陪捡（问题 3）在第 2、4 步里一起拆：子任务交给统一调度器，`CompanionMode` 只留姿态。

## 5. 第一步：守卫解耦（详细设计）

### 5.1 目标

- 保护玩家是独立的常驻职责（下称“保护”），绑定一个玩家（名字＋UUID）和选项（范围、撤退血量、弓、盾）。
- 跟随、等待、做任务、空闲时，保护都在；跟随让开不影响保护。
- 打怪时暂时接管身体，打完把身体交还给原来在做的事（姿态或任务），任务的期限把打架的时间顺延。
- 战斗逻辑（`GuardCombat` 的选目标、近战、弓、盾、撤退、躲苦力怕、防误伤）不改，只改它挂在哪、谁来 tick。

不在这一步做：跟随本身改成姿态（第 2 步）；被进食、自卫打断的任务续做（第 4 步）。

### 5.2 服务端

**新的职责层**。`ServerController` 加一个字段 `GuardDuty duty`，不属于任何操作：

- 内容：被保护玩家的名字和 UUID、`GuardCombat.Options`、一个 `GuardCombat` 实例、打架累计时长、最后一次的覆盖状态。
- 生命周期按租约算，不按操作算：`stop`（代次加一）**不清**保护；`revoke`、`release`、新的 `claim`、`bodyChanged`（死亡、换维度、移除）清掉。紧急停止可以在 `stop` 上带 `clearGuard:true` 一起清（见 6.1）。
- 现在 `GuardCombat.create` 里的导航用 `new NativeNavigation(body, session, operation)`，按操作判断能不能驱动。保护不属于操作，需要一个按租约判断的版本（例如 `session.mayDriveDuty()`：租约有效、身体在线、代次不限）。

**tick 顺序**。`beforePhysics` 在 `survival.tick()` 之后、任务链之前：

```
if (duty != null && duty.wantsBody(...) && interruptible(当前任务)) {
    若当前任务还没被挂起：task.suspend()（停输入、丢掉导航路线），记下开始时间
    duty.tick() 驱动身体，本刻不 tick 任务
} else {
    若刚打完：task.resume()（重新寻路），期限顺延打架时长
    照旧 tick 当前任务（没有任务时就是空闲凝视）
}
```

`wantsBody` 就是现在 `GuardCombat.tick()` 返回 true 的那些情况（接近、近战、拉弓、举盾、撤退、躲闪）。

**交战范围**。保护只在 Bot 离被保护玩家 16 格以内时才接管身体（6.2）。超出时保护处于“不覆盖”状态，不去打，运行端的 3 格近身自卫照常起作用。

**哪些时刻可以打断**（`interruptible`）。默认不可打断，逐个任务放开：

| 当前在做 | 可打断 | 说明 |
| --- | --- | --- |
| 空闲、等待 | 是 | 等待目前只在运行端，服务端看到的就是空闲 |
| `follow-companion`、`follow-player`、`move-to-position`、`approach-*`、`travel-to` | 是 | 打完后导航重算路线（跟随现在就是这么做的：`resetNavigation`） |
| `build` | 站在地上、不在垫脚柱和屋顶上时 | `BuildTask` 自己报告此刻是否在柱上（`scaffold`、`Mode.UP/RISING/DESCENDING/COLLECT`） |
| `tend-crops`、`breed-animals` | 走路时是；在原生使用物品（喂食、骨粉）时否 | |
| `craft-item`、`smelt-item`、`produce-item`、`modify-item` | 走向工作站时是；界面打开后否 | 中途关菜单可能丢东西，宁可等它做完 |
| 开着的容器（`open-container` 后）、`click-slot` | 否 | 同上 |
| `pillar-up`、`sleep-in-bed`（已躺下）、进食等原生使用、`dig-block` 正在挖 | 否 | 都很短，或者打断有危险；原子挖掘完成后再接管 |
| `emote` 手势 | 是 | 直接取消手势 |
| `pickup-item` | 是 | 打完重新走向物品 |

**期限顺延**。`ServerController` 的 `actionDeadline` 加上打架时长；自带期限的任务（`BuildTask`、`TravelTask`、`FarmTask`、`BreedTask`、工作站任务）加 `extendDeadline(ms)`。运行端自己计时的任务（`GatherTasks` 默认 60 秒、`ContainerTasks` 90 秒）读观察里的保护累计时长，按增量顺延，不然一场长架会让采集超时失败。

**跟随里的旧保护**。过渡期保留 `follow-companion` 的 `guard` 参数（旧运行端还用）。身体声明新能力 `guard-duty` 后，新运行端不再给 follow 传 `guard`，改用职责层；`FollowCompanion` 在职责层保护同一个玩家时不再自己 tick 保护。实测通过后删掉旧路径。

**协议**（写进 [server_body_protocol.md](server_body_protocol.md)）：

- 能力 `guard-duty`。
- 新方法 `guard`：需要租约（和 `heartbeat` 一样校验 instance／session／lease），**不是操作**：不占操作 ID 预算，不会和正在跑的操作冲突报 `BUSY`。参数 `{player, expectedEntityId, options}` 打开或修改，`{off:true}` 关掉；返回当前保护状态。玩家不在 32 格内或 UUID 不符时拒绝打开。
- `observe` 在保护开着时多一个 `guard`：`{player, entityId, options, covering, reason?, state, target?, targetId?, hits, damage, shots, kills, retreats, busyMs}`。`covering` 为 false 时 `reason` 说明为什么（玩家太远、玩家下线、换了维度、当前任务不可打断）；`busyMs` 是打架累计时长。
- 玩家下线、换维度、超出范围时保护进入不覆盖状态，**不自动关**；玩家回来后继续保护（同一 UUID）（6.1）。
- 空闲（运行端在等待）时打完，服务端把身体走回开始打之前站的位置（6.3）；有任务时交还给任务，由任务自己重新寻路。
- 防误伤（Bot 的伤害落到玩家、宠物、村民、有名字的生物上时取消）不变。

### 5.3 运行端

- 新文件 `client-runtime/src/guard-duty.ts`：保存运行端想要的保护（玩家、选项），调新增的 `Body.setGuard()`（ServerBody 走 `guard` 方法），从观察读 `guard` 状态。租约丢失、重新接管后不自动恢复（和“不重放”的原则一致），由驱动器提示模型。
- `CompanionMode`：`Intent` 去掉 `guard`；`guardFor`、`noteGuard`、`lastGuard`、`fight` 移到 `GuardDuty`。
  - `follow` 的 `guard` 参数保留，含义变成“开始跟随时顺便打开保护”（默认开，沿用 WebUI 的默认值）。
  - `companion-mode guard` 不再要求正在跟随：没在跟随时要带 `player`（等待、做任务时也能开），在跟随时默认保护跟随的玩家。
  - `companion-mode stop` 结束跟随或等待时同时关掉保护（6.1）。
- `guard` 事件（开打、打完、撤退、躲苦力怕）改由 `RuntimeMonitor` 每次观察时根据 `guard` 状态生成，规则不变（开打 20 秒内只报一次，距离变化和每一下挥击不唤醒模型）。
- `SurvivalReflexes`：
  - `guarding()` 改成“保护开着且 `covering`”；覆盖时 3 格近身自卫不插手，不覆盖时照常自卫。
  - `ordinaryBusy` 把“保护正在打”算作忙：普通进食等打完；紧急进食照旧抢占（服务端在原生使用物品时不接管身体，所以吃完保护再接上）。
- 工具说明和提示词：`companion-mode` 的说明、`scripts/agents/game-instructions.mjs` 的保护规则改成“保护是独立开关，跟随、等待、做事时都有效”；不新增工具名，Codex 白名单不用改。
- WebUI：状态栏把保护单独显示（保护谁、是否覆盖、在不在打），不再挂在陪伴模式下面。

### 5.4 测试

离线：

- Java：`GuardDuty` 用假视图测（空闲时接管；任务中可打断时挂起任务、打完恢复、期限顺延；不可打断时等待；超出交战范围不接管；玩家离开、回来；`stop` 后保护还在、`revoke`／`claim`／`bodyChanged` 后清掉）；`ControlSessionTest` 补 `guard` 方法的租约校验和操作预算不变；`FollowCompanionTest` 补“职责层保护同一玩家时 follow 不再自己打”。
- 运行端：没跟随时 `companion-mode guard` 带 player 能开；跟随让开去做 `build` 时保护状态不变；`stop-action` 和 `companion-mode stop` 都关掉保护，任务的普通取消不关（6.1）；近身自卫在覆盖时不插手、不覆盖时照常；采集任务按 `busyMs` 顺延期限。

隔离服实测（新脚本 `scripts/server-guard-duty-smoke.mjs`，用协议测试玩家当被保护的人）：

1. 等待中，测试玩家身边刷僵尸 → Bot 过去打，打完回到原地附近。
2. 建筑进行中（地面层）刷僵尸 → Bot 停下去打，打完接着盖，最后放对的格数和不打断时一致，没有 `TIMEOUT`。
3. 建筑在垫脚柱上时刷僵尸 → 不下柱，先做完这根柱，下来后再打。
4. 合成界面开着时刷僵尸 → 做完合成、关界面后再打。
5. 测试玩家走到 20 格外 → `covering:false`，Bot 只自卫。
6. `stop` 后保护还在；`revoke` 后保护清掉。

之后请用户在真实模型试玩里验收“帮我砍树，同时保护我”。

### 5.5 风险

- 打断建筑、种地时，身体被带离原位，任务恢复后的重新寻路是否稳定，要看实测；先只放开地面层，柱上和屋顶不打断。
- 打架时长顺延可能让一个任务拖得很久；期限顺延设上限（例如原期限的 2 倍），超过照常 `TIMEOUT`，模型可再调一次续做。
- 过渡期新旧两条保护路径并存，测试要覆盖“旧运行端＋新服务端”。

## 6. 用户的决定（2026-10-10）

1. **保护什么时候结束**：明确关掉（`companion-mode guard false`、玩家说不用保护）、**不跟了（`companion-mode stop`）**、紧急停止、撤销控制时结束；任务中途的普通取消不关保护；玩家下线、走远只是暂时不覆盖，回来接着保护。
   - 注意：现在玩家在聊天里说“停／等一下”走的是驱动器的硬停止，会撤销控制，保护也就跟着清掉。要等评审第 1 条（暂停、取消、紧急停止分开）做了，“普通叫停不关保护”才会真正成立。
   - 只在等待（`wait`）中开的保护，`companion-mode stop` 结束等待时也一起关。
2. **离玩家多远还去打**：Bot 离被保护玩家 16 格以内才放下手上的事去打；超出只靠 3 格近身自卫。
3. **打完回哪**：等待中打完回到开始打之前站的地方（在保护范围内）；跟随中打完接着跟；做任务时打完回到任务。

## 7. 第二步：姿态在服务端挂起／恢复（详细设计，2026-10-11 待用户审）

### 7.1 现在怎么走一遍“跟随中让 Bot 去做件事”

以“跟随中砍一棵树”为例，现在要经过这几步：

1. 运行端 `CompanionMode.yieldTo('gather')` 拿一张租约。
2. 内部 `request({action:'pause'})` → `body.stop({stepAside:true})`。服务端 `ControlSession.cancel()` 把控制代次加一，`ServerController.stop()` 清掉所有字段（包括 `companion`）；`stepAside` 只是让 `carryFloor` 不动，旧的 `resourceRef` 还能用。
3. 砍树跑完，租约 `release()` → `autoResume()`。要等：身体空闲满 `resumeDelayMs`（3 秒），而且玩家在附近。
4. `request({action:'resume'})` 用 `adoptable()` 检查“同会话、代次只往前走”，再 `body.act('follow-companion')` 开一个**新的**跟随操作。
5. 之后 `update()` 每轮读这个新操作的回执，靠 `accept()` 把状态抄回运行端。

问题都出在第 2、4 步：跟随是一个普通操作，所以每次让开都要“停掉再重建”。代价包括：
- **代次判断**：`adoptable`、`exactlyNext`、`internalStop` 要判断新代次还算不算自己的；
- **补丁**：`stepAside`／`carryFloor` 保住引用，3 秒延迟防止两次工具调用之间把身体带走；
- **陪挖、陪捡**：每捡一次东西都要内部停止两次，再重新开始跟随；
- **坐下**：`seatedDown` 要先停掉跟随，曾经出过 BUSY 竞态；
- **死后重连**：只能另存一份 `posture-<名>.json`，提示 Agent。

### 7.2 目标

**跟随、等待、坐着变成服务端的“姿态”**。它不是操作，跟保护一样：
- **怎么开、关**：用一个协议方法开关，绑定在租约和这次登录上；
- **有操作时怎么让**：任何操作开始时，姿态自动挂起；操作结束、身体空闲后，服务端自己接上；
- **不打断它的事**：运行端不用重新提交，代次也不变；一般的 `stop` 只停操作，不碰姿态；
- **怎么结束**：只有明确结束（叫停、`companion-mode stop`、换成另一个姿态、关掉控制）才结束。

做完以后，运行端的 `CompanionMode` 只做三件事：
- 把模型的请求转成姿态设置；
- 把服务端的姿态状态翻译成事件；
- 管陪挖、陪捡这两个子任务（第 4 步再拆）。

### 7.3 服务端

**协议方法 `posture`**（新能力 `server-posture`）。写法照 `guard`：要租约，不算操作，不占操作预算，用 `postureRevision` 排序。

- 参数（三选一）：
  - `{action:'follow',player,expectedEntityId,distance?,wander?}`
  - `{action:'wait'}`
  - `{off:true}`
- 回执：`{action,state,player?,suspendedFor?,reason?}`。
- `state` 的取值：
  - `following`：在跟；
  - `waiting`：停在玩家旁边，或者在等待；
  - `suspended`：让给一个操作；
  - `away`：玩家不在 32 格内或在别的维度，回来自动接上；
  - `blocked`：走不过去，隔几秒再试，原来就有这个逻辑；
  - `seated`：坐着。
- 坐下：`sit` 操作成功后，姿态改成 `seated`，跟随或等待到此结束，保护不变；`stand-up` 之后姿态为空。坐下以后不再需要运行端的 `seatedDown`。

**`ServerController` 里的结构**：
- 新增字段 `Posture posture`。
- `FollowCompanion` 从“操作”改成姿态的执行者：
  - 不再持有 `ControlSession.Operation`；
  - 失败不再 `finish` 一个操作，而是改姿态状态；
  - 能否驱动身体，改用和保护一样的租约检查：`dutyPermission()` 那种“同租约、同登录”。
- 每 tick 的顺序：保护（`tickDuty`）→ 正在跑的操作 → 姿态。也就是说：
  - 操作在跑时，姿态是 `suspended`，`suspendedFor` 填操作名；
  - 没有操作时，姿态驱动身体；等待时照旧原地看人、闲逛。
- 接上的时机：
  - 操作结束后，身体空闲满 `RESUME_AFTER_MS` 才接上。这个值沿用现在运行端的 3000：模型连着调工具时，两次调用之间常隔两三秒；
  - 中间来了新操作就重新计时；
  - 第 3 步再按“这个动作移不移动身体”区分：转头、做表情、换手里的东西这类不移动身体的动作，不重新计时。
- `stop()` 分两种：
  - **普通 `stop`**（取消任务、反射抢占、一般叫停）：只清操作，不碰 `posture`；
  - **`stop` 带 `clearPosture:true`**：同时清姿态。玩家叫停、`companion-mode stop`、运行端结束托管都走这个，和现在的 `clearGuard` 一起发。
  - `stepAside` 参数和 `carryFloor` 都删掉：跟随不再因为让开而停，引用自然还在。
- 身体换了（死亡、换维度、断开）：`bodyChanged` 会撤销租约，姿态跟保护一样一起清掉。注意死亡也算：`connected()` 要求活着，死了就撤销租约，复活后运行端要重新认领控制。所以死后、重连后要不要自动恢复姿态，由运行端决定（见 7.7 问题 3）。
- `besideFollow` 名单和 `ControlSession` 里那条 `beside&&o.name.equals("follow-companion")` 的特殊情况一起删掉，因为跟随不再占用操作位。

**观察**：`observe` 多一个 `posture` 字段，内容同上面的回执。运行端只看这个，不再轮询跟随操作。

### 7.4 运行端

`companion-mode.ts`（约 800 行）这些可以删：

| 删掉 | 原来管什么 |
|---|---|
| `yieldTo`、`leases`、`holdPause`、`autoResume`、`resumeTimer`、`resumeDelayMs`、`idleSince`、`awaitingPlayer` | 让开和自动接上：服务端自己会做 |
| `adoptable`、`internalStop`、`intent.context` 里的控制代次、`accept()` 对 `follow-companion` 回执的核对 | 判断新代次还算不算自己的 |
| `start()`（开 `follow-companion` 操作）、`seatedDown` | 改为调 `body.setPosture` |
| `stopWork` 里“跟随在跑就不停”的特殊情况 | 普通 stop 不再碰姿态 |

保留和要改的：
- **`request()`**：`follow`、`wait`、`stop`、`guard` 改成调 `posture`／`guard` 协议方法。`pause`、`resume` 保留给模型手动用：`pause` 就是 `posture off`，同时运行端记住上一个姿态，`resume` 再设回去。
- **陪挖、陪捡（`mineBlock`、`pickupItem`）**：
  - 子任务本身照旧，作为普通操作跑，跑的时候姿态自动挂起；
  - 删掉每次前后的 `internalStop` 和 `start()`；
  - 收据游标按会话检查。现在 `generations` 集合是为了跨代次认收据，不再换代次以后可以简化成“同会话”；
  - 把子任务拆给统一调度器留到第 4 步。
- **`update()`**：读 `state.posture`，状态变了就发事件，内容和现在的提示一样，比如“让开去做 X，做完自动接着跟”“玩家不在附近，回来自动接上”。
- **`mcp.ts`、`survival-reflexes.ts`、`main.ts`**：去掉 `yieldTo`／`release` 的调用（4＋2＋1 处）。工具照常 `body.act`，服务端负责挂起和接上。
- **`posture.ts` 和 `posture-<名>.json`**：保留，只用在托管驱动器重启这种“租约没了”的情况（见 7.7 问题 3）。

### 7.5 兼容

打包时运行端和核心 jar 总是一起发的，WebUI 也会核对 jar 和包里的逐字节相同，所以**不保留旧的“跟随是操作”那条路**。运行端在服务端没有 `server-posture` 能力时，直接报 UNSUPPORTED，提示更新核心模组。`follow-companion` 操作本身要不要留给旧的试验脚本，看 7.7 问题 1。

### 7.6 测试和验收

- **Java 新增 `PostureTest`**：
  - 开、换、关；revision 排序；
  - 操作开始时挂起，结束 `RESUME_AFTER_MS` 后接上，中途来了新操作就重新计时；
  - 普通 stop 不清姿态，`clearPosture` 才清；
  - 玩家走远进入 `away`，回来自动接上；换了身份就结束；
  - 坐下变成 `seated`，`stand-up` 后为空；
  - 保护打完回到姿态。
- **`ControlSessionTest`、`FollowCompanionTest`**：改成姿态写法。
- **运行端**：`companion-*.test.mjs` 共 9 个文件、`seat`、`stop-fence`、`emote`、`sleep`、`beside-follow`，按新协议重写。“让开再接上”的测试改成断言“只发了工具调用，没发过 pause／resume”。
- **隔离服实测**（我来跑，用现有的 smoke 改）：
  - 跟随中砍树，砍完自己接着跟，中间没有停 3 秒再重新开始跟随；
  - 跟随加保护，同时让它砍树；
  - 等待中做事，做完回到等待；
  - 陪捡；
  - 坐下、被怪叫起来、站起；
  - 叫停清掉姿态。
- **真实模型验收**：顺带把第 1 步欠的“帮我砍树，同时保护我”一起做。

### 7.7 要你定的（审设计时回答）

1. **旧的 `follow-companion` 操作删不删**：
   - 建议删掉：它只服务旧路径，留着就得维护两套；
   - `scripts/` 里有十几个试验和实测脚本用它，一起改成 `posture`。
2. **接上要等多久**：建议照旧 3 秒，只是挪到服务端，起名为常量 `RESUME_AFTER_MS`，注释写明理由。也可以改短，第 3 步区分“移动／不移动身体的动作”之后，3 秒的必要性会小很多。
3. **死后复活、托管驱动器重启或重连后，要不要自动恢复姿态**：
   - 现在的做法：只提示 Agent“之前在跟你”，由模型决定；
   - 建议：玩家没叫停过就自动恢复。运行端读 `posture-<名>.json`，重新认领后直接设回去，再告诉 Agent 一声；
   - 这一项也牵涉排在后面的“驱动器重启空档”。
4. **谁来做**：
   - 跨服务端和运行端、带状态机，Haiku 不适合；
   - 建议我自己做服务端，再派一个 Sonnet high 改运行端和测试；
   - 或者全部由我自己做，慢一些，但改动集中在一个人手里，少一次合并。

**用户的回答（2026-10-11）**：
1. 删掉 `follow-companion` 操作，`scripts/` 里的试验和实测脚本一起改成 `posture`。
2. 接上前等 3 秒，挪到服务端，常量 `RESUME_AFTER_MS`。
3. 自动恢复姿态，但要看情况：死亡有掉落（没开 keepInventory）时，要先考虑把装备捡回来，再恢复跟随。这一点还没设计，compact 后补：死因和死亡地点从 `last-death` 拿，掉落物会不会消失、离得多远、路上危不危险、要不要先问玩家。
4. 主 agent 做服务端，派一个 Sonnet high 做运行端和测试。
5. compact 后先再审一遍这份设计有没有缺陷，再动手。

**审设计后补定的（2026-10-11）**：
1. 保护在打架时，姿态状态是 `guarding`；打完回到原来的状态。
2. 坐着时被怪叫起来，不清掉 `seated`：打完走回座位坐下。座位被拆了或被占了，就改成原地等待，并告诉模型。只有 `stand-up` 才清掉 `seated`。
3. 等待就是停在当前的位置，**不记位置**：被叫去做事，做完就在做完的地方接着等。打完架走回原位是 10-10 定的保护规则，不受影响。
4. 死后捡装备照 7.10 的 R5：
   - 掉落还在、走得到、那边没在打怪，就先捡回来，再恢复姿态；
   - 否则直接恢复姿态，并告诉模型东西掉在哪、还剩几分钟；
   - 不先问玩家。
5. 7.7 第 1 题说“`scripts/` 里有十几个脚本”，核对后只有 2 个：`server-body-companion-smoke`、`server-navigation-defense-smoke`。

### 7.8 估计和风险

- 估计：服务端 1.5 天，运行端 1.5～2 天，测试和隔离服 1 天，共 4～5 天。
- 风险：
  - 运行端测试改动量大，约 15 个测试文件；
  - 陪挖、陪捡的收据和代次检查改动后，计数可能出错，要靠 `companion-mining`／`companion-pickup` 两个 smoke 兜底；
  - 姿态和操作同时存在后，`beforePhysics` 的优先顺序是新的隐含规则，要在 `PostureTest` 里逐条写出来。

### 7.9 以后再做：多人适配（2026-10-11 审设计时记下）

现状：ServerBody 这条路没有“主人”的概念。除了 Bot 自己，所有玩家的聊天都会交给模型（`events.ts` 的聊天事件），由模型决定听不听；跟随要写明玩家名，并用实体 id 确认是同一个人；保护只保护一个玩家。第 2 步不为多人做额外处理，下面这些等做多人时再定：

1. **跟着一个人，保护另一个人**：现在运行端在只开保护时能单独指定要保护的玩家。如果姿态是跟着 A，保护的却是 B，跟随往 A 走，打完架往 B 回，两边会拉扯。第 2 步按单人处理：有跟随时，保护的就是跟随的那个人。
2. **别人让 Bot 做事，做完它会回去找原来的人**：跟着 A 时，B 让它砍树，砍完 3 秒后它会自动接着跟 A，B 可能以为它会留下。做多人时，“接着跟”的事件要写出名字。
3. **别人叫停，也会清掉正在跟的人的姿态**：服务端分不出是谁叫停的。做多人时，要让模型知道发话的不是正在陪的人，或者另加权限。
4. **死后捡装备会捡到别人的东西**：原版的死亡掉落不记是谁掉的。做多人时，服务端给 Bot 死亡时掉出来的物品打标签，只捡带标签的；被别人先捡走的，算正常结束。
5. **陪捡会捡到别人扔的东西**：只按物品种类筛选，是老问题，和第 4 步一起处理。
6. **多个 Bot**：每个 Bot 的姿态和保护各自独立。两个 Bot 跟同一个玩家时，会不会挤在一起、抢同一个怪，都还没看过。

### 7.10 任务拆分和顺序（2026-10-11）

**第 0 步：先定接口（我做，约半天）**

在 `server_body_protocol.md` 里先写好这些，作为服务端和运行端共同照着做的约定，然后提交这份设计：
- `posture` 方法：参数、回执、`state` 的 7 个取值、`suspendedFor`；
- 能力名 `server-posture`；
- 观察里新增的 `posture` 字段；
- `stop` 的 `clearPosture` 参数；
- 死亡掉落：`lastDeath.drops`，以及掉落物在观察里的标记。

**第 1 步：两边同时做**

服务端（我做）：

| 编号 | 内容 | 测试 |
|---|---|---|
| S1 | 新增 `Posture`，照 `GuardDuty` 的写法：用 `View` 接口隔开游戏，状态机是纯逻辑，包括状态、`RESUME_AFTER_MS`、`postureRevision`；`FollowCompanion` 改成姿态的执行者，不再持有操作 | 新增 `PostureTest` |
| S2 | 接进协议：`posture` 方法、观察、`stop` 的 `clearPosture`；删掉 `follow-companion` 操作、`stepAside`／`carryFloor`、`besideFollow`，以及 `ControlSession` 里的特殊情况；有跟随时，保护的就是跟随的那个人 | 改 `ControlSessionTest`、`FollowCompanionTest` |
| S3 | 坐下：`sit` 成功后姿态变成 `seated`；被保护叫起来，打完回到座位坐下；座位没了或被占了，就改成等待 | 改 `SeatTest` |
| S4 | 死亡掉落：Bot 死时掉出的物品打上标签 `mcbot_body_death_drop`；`lastDeath` 加上掉落数量和消失时刻（掉落后 6000 tick，即原版 `ItemEntity` 的 `LIFETIME`）；开了 keepInventory 时掉落数量为 0 | 新增几项检查 |

运行端（派 Sonnet high）：

| 编号 | 内容 |
|---|---|
| R1 | `body.ts`、`server-body.ts`：加 `setPosture`、观察 `posture`、`stop` 带 `clearPosture`、检查服务端能力；删掉 `follow-companion` 那条路 |
| R2 | `companion-mode.ts`：按 7.4 删掉让开和接上那一套，`update()` 改成把姿态状态变化翻译成事件，包括 `guarding` 和“回到座位” |
| R3 | `mcp.ts`、`survival-reflexes.ts`、`main.ts`：去掉 `yieldTo`、`release`、`withCompanionStepAside` |
| R4 | 陪挖、陪捡：去掉 `internalStop` 和重新开始跟随；收据游标只按会话检查 |
| R5 | 死后恢复：重新认领控制后看 `lastDeath`。有掉落、还没过消失时刻、离得不太远、身边没有怪，就逐个 `pickup-item` 去捡带标签的物品，捡完再按 `posture-<名>.json` 恢复姿态；否则直接恢复，并发事件告诉模型 |
| R6 | 测试：重写 14 个测试文件（`companion-*`、`seat`、`sleep`、`emote`、`stop-fence`、`beside-follow`），新增死后恢复的测试 |

运行端的 R5 要先确定几个数：
- “离得不太远”：复用陪挖、陪捡已有的范围，或者长途走的上限，不另起新数字；
- “身边没有怪”：复用保护的 `wouldFight` 判断。

**第 2 步：合并（我做）**
- 逐行审 worker 的代码；
- 改 2 个 smoke 脚本；
- 跑 `gradlew check` 和 `npm test`；
- 更新协议文档、交付计划和 README。

**第 3 步：重新打包，用户直接试玩（用户 10-11 定）**

不做隔离服实测，7.6 里的“隔离服实测”一项取消。用户试玩时顺便看这几项：
- 7.6 列的那些情况；
- 坐着被怪叫起来，打完坐回去；
- 死后捡回装备，再接着跟；
- 掉落已经消失时，只恢复姿态，并告诉模型。

要等用户关掉 WebUI 再打包。

**估计**：
- 第 0 步：半天；
- 第 1 步：服务端约 2 天，运行端同时做；
- 第 2 步：约 1 天；
- 共约 3.5～4 天。
