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
| 4 | **统一任务生命周期**：运行端单一调度器；建筑、种地、长途走被打断后续做 | 合并 6 个任务主人的公共部分；服务端可空字段改成一个任务槽。10-11 定 4a～4d 全做，详细设计见第 8 节 | 8～9.5 天（10-11 估） |

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

## 8. 第四步：统一任务生命周期（详细设计，2026-10-11，8.7 已答）

10-11 用户定的范围：4a、4b、4c、4d 全做，全部由我来做，不派 worker。顺序是 **4b → 4d 服务端 → 4a → 4d 运行端 → 4c**。4a 用 A 方案（服务端暂停）。和前几步一样只针对单人陪伴（见开头的适用范围）。

### 8.1 现在的样子（读代码确认，2026-10-11）

**服务端**（`ServerController.java`）
- 正在跑的东西分散在 9 个任务字段（`pickup`、`pillar`、`station`、`job`、`build`、`hunt`、`farm`、`breed`、`travel`）和几组走路状态（`navigation` 加上 `sleepBed`／`sitSeat`／`followedPlayer`／`retreatTarget`／`approachPlayer`）里。
- `beforePhysics` 用一串 `if` 逐个判断（约第 654～723 行）。每个分支的出错处理都不一样：
  - 失败结果里有的带 `position`，有的不带；
  - `pillar`、`travel`、`pickup` 不接 `RuntimeException`；
  - `job` 先 `stop()` 再 `finish`。
- `pausable()` 用一长串三元表达式挑出当前任务，给保护打怪暂停用。
- `stopBody` 逐个清空这些字段。
- 吃东西（`eat-item`）、自卫（`defend-entity`）由 `SurvivalActions` 自己跑，不占 `active`。
- `ControlSession` 只允许一个非聊天操作在跑（第 312 行）。

**运行端**
- 忙不忙的判断有 4 种写法：
  - `idleBody`（三连 `assertIdle`）；
  - `ordinaryBusy`（三连再加 `isBusy`／`pendingOperations`／`companion.busy`），`main.ts` 和 `mcp.ts` 各写了一份；
  - 礼物换装用的 `busy`（`main.ts` 第 136 行）；
  - 原子动作只查 `tasks.assertIdle()`（`mcp.ts` 第 477 行）。
- `readTools` 是另一份手写名单（第 53 行）。Codex 白名单 `CODEX_SERVER_TOOLS` 又是一份手写名单，靠 `tool-allowlist.test.mjs` 用正则扫 `mcp.ts` 兜底。
- 任务主人有 `ContainerTasks`、`GatherTasks`、`SurvivalTasks`、`PillarTasks` 四个，各自有一套 epoch／active／stopping／cancel／stopped，还要借锁（`borrowed`：采集借给陪挖陪捡，生存借给采集）。
- 打断：自动自卫（只在保护关着时）和紧急进食都先 `stopCurrent()` 取消原任务，事件里说“不会重放”（`survival-reflexes.ts` 第 176～181、215～220 行）。`defend-self` 走同一条路。
- `CompanionMode`（822 行）里的陪挖、陪捡占了约 200 行（`mineBlock`、`returnFromMining`、`pickupItem`、`block`、`childActive`）。

### 8.2 4b：忙判断一处，加工具属性表（约 1 天；10-11 完成，见本节末尾）

新增 `client-runtime/src/tool-registry.ts`，每个 MCP 工具一条记录。

| 属性 | 取值 | 现在对应的地方 |
|---|---|---|
| `kind` | `read`（只看）、`chat`、`action`（原子动作）、`task`（多步任务或服务端长任务） | `readTools`、`readOnlyCall` |
| `needsIdle` | 开始前要不要身体空着 | 三连 `assertIdle`、`idleBody` |
| `moves` | 会不会挪动身体 | 只作说明，姿态让不让开仍由服务端的 KEEPS／HOLDS 决定（第 3 步） |
| `resumable` | 被进食／自卫打断后能不能续做（4a 用） | 新增 |

`resumable` 为真的有：`build`、`tend-crops`、`breed-animals`、`hunt`、`travel-to`、`go-to-place`、`gather-resources`、`collect-items`。容器四件套、`craft-item`、`smelt-item`、`produce-item`、`modify-item`、`pillar-up`／`pillar-down` 不续做。

改动：
1. 新增 `work.ts`，里面放唯一的 `assertIdle()`／`busy()`：容器、采集、生存、垫高都没在跑，并且 `body.isBusy()` 为假。替换 `idleBody`、两份 `ordinaryBusy`、礼物换装的 `busy`、`PillarTasks` 的 `idle` 和 `mcp.ts` 里散落的三连。`register` 按表里的 `needsIdle` 统一检查，处理函数里不再自己写。
2. `readTools` 改成从表里取 `kind === 'read'`。
3. Codex 白名单从表生成：`codex-app-server.mjs` 读构建好的 `client-runtime/dist/tool-registry.js`（驱动器本来就要先构建运行端）；`tool-allowlist.test.mjs` 改成核对“表 = `mcp.ts` 实际注册的工具”。动手时先确认打包脚本按 import 收集文件时不会把这个路径当成 scripts 下的文件。

和现在不一样的地方（都是我认为该改的，审时请看一眼）：
- 原子动作在采集、生存任务跑着时，改成在运行端就报 BUSY。现在也是 BUSY，只是由 `ServerBody.act` 的任务锁报，提示文字不同。
- `companion-mode` 不再查容器任务忙不忙。姿态和任务已经分开（第 2 步），“搬箱子时说一声跟着我”应当能设上，姿态会自己先让开。

测试：`tool-registry` 表和 `mcp.ts` 注册的工具一致，`needsIdle` 的工具在忙时报 BUSY，白名单的条数和内容不变（68 个）。

**2026-10-11 完成（离线）**。离线检查：运行端 480 项（新增 `tool-registry.test.mjs` 3 项）、`mcp-server` 726 项（另有 1 项跳过）全部通过。和上面设计的出入：
- 表是 `client-runtime/tool-registry.json`，不是 `.ts`。运行端由 `src/tool-registry.ts` 按自己的位置读它并校验；Codex 用固定路径按文件读（`codex-app-server.mjs`），不 import，所以不违反打包脚本“scripts 不引用目录以外的模块”的检查；打包时多复制这一个文件。白名单因此不依赖运行端是否已经构建。
- `kind` 多了一种 `control`（`stop-action`、`set-reflexes`、`defend-self`）：不重新启用本能，也从不因为忙被拒。“重新启用被停用的本能”只有 `action`／`task` 会触发，取代原来的 `readTools`。
- `companion-mode` 记为 `action`，`needsIdle` 为假：照旧会重新启用本能，但不再查容器任务（8.7 已同意）。
- 只看不做的调用（带 `survey:true` 或 `dryRun:true`）一律不重新启用本能，也不查忙。原来只有 `tend-crops`、`breed-animals` 的 survey 是这样，现在 `hunt` 的 survey 和 `build` 的 `dryRun` 也一样。
- `list-blueprints`、`save-blueprint` 只读写蓝图文件，记为 `read`。原来它们会重新启用本能，而且本能正在吃东西或打架时会被拒。
- `assertIdle` 除了三个任务主人，还查 `body.isBusy()`（有动作在跑、有人持有任务锁、正在停止）。原来这种情况也是 BUSY，只是由 `ServerBody.act` 报出来。
- 实现过程中发现：10-11 清理 worker worktree 时，`client-runtime` 和 `mcp-server` 的 `node_modules` 被一起清空了。已按 lock 文件重新 `npm ci`；其他目录和绿色版没有受影响。

### 8.3 4d 服务端：一个任务槽（约 1.5～2 天，行为不变；10-11 完成，见本节末尾）

新增接口 `BodyTask extends GuardDuty.Pausable`：

```java
interface BodyTask extends GuardDuty.Pausable {
    void tick();                   // 照常可抛 Protocol.Error／RuntimeException
    JsonObject report();           // 失败时结果里的进度（progress()／detail()）
    void stop();
    boolean withPosition();        // 失败结果加不加 position（按现有分支逐个照抄）
    String faultLabel();           // null 表示不接 RuntimeException（pillar、travel、pickup 现在就是这样）
    default boolean stopBeforeFinish(){return false;} // job 现在先 stop 再 finish
}
```

- 现有 9 个任务类实现它。走路类操作（`move-to-position`、`follow-player`、`approach-*`、`retreat-from-entity`、`sleep-in-bed`、`sit`）收进一个新类 `WalkTask`，把 `navigation`、`actionDeadline`、`actionGrace` 和那几个零散字段搬进去；`tickApproach`／`tickRetreat`／`tickSleep`／`tickSit` 照原样搬过去。
- `ServerController` 只留一个字段 `private BodyTask task;`。`beforePhysics` 那串 `if` 换成一段共用的 tick／出错收尾；`pausable()`、`resumeAfterFight` 直接用 `task`。`stopBody` 改成一次 `task.stop()`。
- 拾取回执（`receivePickup*`）用 `task instanceof PickupItem` 拿到拾取任务。
- 手势（`emotes.gesturing()`）仍然归 `BodyEmotes` 管，不进任务槽：第 3 步的 HOLDS 靠它。
- 各分支现有的不一致（加不加 `position`、接不接 `RuntimeException`）这次**照抄不改**，在代码注释里记下，以后统一。

测试：`ControlSessionTest`、`FollowCompanionTest`、`PostureTest`、`GuardDutyTest` 全过；新增 `BodyTaskTest`，覆盖共用收尾的三种失败形状。
- 不跑隔离服 smoke（8.7 第 1 问，用户 10-11 定）。④ 全部做完打包后由用户试玩。

**2026-10-11 完成（离线）**。Java `gradlew check assemble` 全过，新增 `BodyTaskTest` 16 项；没有跑隔离服，也没有进游戏。和上面设计的出入：
- 失败形状不是四个方法，而是一个 `BodyTask.Failure` 记录（report、position、fault、stopFirst），由各任务类的 `failure()` 返回：
  - `PickupItem` 返回 null，表示它自己收尾，抛出的异常照旧往上抛；
  - `NativePillar` 和 `TravelTask` 的 fault 为 null，`RuntimeException` 照旧往上抛。
- 收尾逻辑写成纯函数 `BodyTask.end`，`BodyTaskTest` 直接测它。`faultResult` 和 `UNCERTAIN_FAULT` 从 `ServerController` 搬了过去。
- `WalkTask` 是 `ServerController` 的内部类，因为它要用控制器的 `finish`、`findPlayer`、`resources`／`targets` 和姿态。它自己 catch 并收尾，从不往外抛。
- `NativePillar` 也实现了接口：不可被打断，`stop()` 什么都不做（原来清字段时也什么都不调）。
- 几处细微差别，都不影响正常路径：
  - `sleep-in-bed`、`sit` 的 `timeoutMs` 现在在占用任务槽之前校验。原来校验失败时，操作会在 `active` 里多留一拍，再被 `stop()` 清掉。
  - 停止时，拾取任务的 `stop()` 挪到了 `posture.interrupt()` 之前，两者互不依赖。
  - 有操作在跑、却既没有任务也没有手势时（实际走不到这里），改为直接以 failed 收尾。原来会落进走路代码，因空指针以 failed 收尾。

### 8.4 4a：进食／自卫打断后续做（服务端暂停，约 2 天；10-11 完成，见本节末尾）

**规则**：自动自卫、紧急进食、`defend-self` 打断一件可续做的任务时：
- 任务**暂停**，不取消；
- 打断处理完，任务**接着做**，期限顺延；
- 模型那次工具调用照常等它的结果。

同一件任务最多续做 2 次，第 3 次打断照旧取消（现在的做法）。不可续做的任务、陪挖陪捡的子任务，也照旧取消。

**服务端**
- 新增协议方法 `interrupt`，能力名 `task-interrupts`。
  - `{action:"begin", reason:"eat"|"defend"}`：开一个“打断窗口”。
  - `{action:"end"}`：关掉窗口，被暂停的任务接着做。
- 什么时候能开窗口：判断和保护打怪暂停任务时**完全一样**，直接复用 `dutyMayInterrupt` 里的条件，不另列一张名单：
  - 身体空着；
  - 或者正在跑的任务此刻 `interruptible()`（在地面、手上没挖到一半）；
  - 或者是在地面上走路。
  
  另外，保护正在打架时不能开。
- 开不了时返回 `NOT_PAUSABLE`，并带原因。
- 窗口开着时：
  - 被暂停的任务不 tick，身体停下；
  - 会话里，被暂停的操作不算“正在跑”，允许打断用的几步一个接一个跑：`select-slot`、`swap-inventory`、`eat-item`、`defend-entity`、`retreat-from-entity`，也就是 `SurvivalTasks` 吃东西和自卫时实际发出的那几步；
  - 姿态照旧让开（任务还算在跑）；
  - 保护不在窗口里开打，和它等吃完饭是同一个道理。
- 关窗口时调用任务的 `resumeAfterGuard(暂停时长)`：停下走路、重新规划、期限顺延。顺延和保护打架共用同一份 `Grace` 额度，合起来最多顺延一倍，不另起数字。
- `stop`、租约结束都会连同窗口一起取消。窗口开着、却超过 `ControlSession.TTL_MS` 没有任何打断步骤在跑时（运行端出了问题），服务端自己关掉窗口、让任务接着做。这里复用租约“控制者失联”用的那个时长。
- 有了 4d 服务端的任务槽，这块只是在槽上加一个 `paused` 标记。

**运行端**
- `ServerBody.interrupt(reason, work)`：先发 `begin`，再用一个打断令牌跑 `work`，最后发 `end`。
  - `act()` 遇到打断令牌，绕过被暂停的那个操作和任务锁。
  - 遇到**持有任务锁的那件任务**（采集是在运行端一步一步发操作的），就**等窗口关了再发**，不报错。这样采集会停在下一步之前，不需要改采集本身的代码。
- 采集的期限顺延：`FightGrace` 除了打架时长，再加上打断暂停的时长，额度仍然是它自己的预算。
- `SurvivalReflexes`：原先“先 `stopCurrent()` 再吃／打”的地方改成先查正在跑的是什么：
  - 是可续做的任务（查 4b 的表；运行端任务看采集，服务端任务看 `pendingOperations` 的名字），并且这件任务还没续做满 2 次：走 `interrupt`。事件写“暂停了 build，打完接着做（第 1 次，最多 2 次）”，接着做时再发一条。
  - 收到 `NOT_PAUSABLE`（比如正在脚手架上、正在游泳、正在挖）：这一拍先不打断，下一拍再试，和保护的等法一样。只有血量降到 `policy.lowHealth`（自卫已有的低血线）还在等时，才照旧取消任务去处理。
  - 不可续做、已经续做满 2 次、陪挖陪捡的子任务在跑：照旧 `stopCurrent()`。事件里说明是第几次、为什么取消。
  - 打断的结果是 `unknown`：先 `stopCurrent()` 取消任务，再像现在一样停用本能。手上状态不确定时，不让任务接着跑。
- 续做次数在运行端记，按任务标识计：服务端任务用 `operationId`，采集用它自己的任务 id。服务端只管暂停和接着做。
- 改工具说明：`defend-self`、`set-reflexes`、`build`、`tend-crops`、`travel-to` 等，以及系统指令里“打断不重放”的说法。

**测试**
- Java：
  - 新增窗口的纯逻辑测试：能开／不能开的条件，开着时会话放行哪些步骤，关闭时顺延，超时自己关；
  - 补 `ControlSessionTest`。
- 运行端：
  - 自卫和进食打断可续做的任务，接着做；
  - 第 3 次取消；
  - 不可续做的任务照旧取消；
  - `NOT_PAUSABLE` 时等，降到低血线才取消；
  - 采集在下一步之前停住、期限顺延；
  - `unknown` 时取消；
  - 叫停时窗口一起取消。

**2026-10-11 完成（离线）**。Java `gradlew check assemble` 全过（新增 `TaskInterruptTest` 12 项，`ControlSessionTest` 加窗口用例）；运行端 491 项（新增 `task-interrupts.test.mjs` 11 项）、`mcp-server` 726 项（另有 1 项跳过）通过。没有跑隔离服，也没有进游戏。协议写在[打断窗口](server_body_protocol.md#打断窗口8m-第四步-4a2026-10-11)。和上面设计的出入：
- 服务端新增 `TaskInterrupt`（窗口的纯逻辑：能不能开、步骤名单、超时）。窗口开着时，被暂停的操作和任务从任务槽搬进窗口，任务槽空出来给打断步骤用（`retreat-from-entity` 要占槽）；关窗口时再搬回来。所以“在槽上加一个 `paused` 标记”变成了“槽搬进窗口”。
- `ControlSession` 的 BUSY 规则改成：不算被暂停的那个操作；窗口开着时只放行 `TaskInterrupt.STEPS`。`interrupt` 方法也要 `controlGeneration`，叫停前发出的 `begin` 不会暂停叫停后的任务。
- 只有 `ServerController.stop()`（会话取消时调用）连窗口一起清；操作自己结束、`abort` 改用 `stopBody`，不动窗口。
- 运行端 `Body.interrupt` 返回 `{value, resumed}`；`resumed` 是服务端有没有把被暂停的操作接上，用来决定发不发“接着做了”。窗口时长直接计入 `fightMs()`（窗口开着时实时增长），`FightGrace` 不用改。
- 运行端多了一种“等”：采集自己的生存步骤（换工具、两块之间吃东西）占着生存锁时，不开窗口，下一拍再试；低血线规则同 `NOT_PAUSABLE`。
- 明确的 `defend-self` 遇到 `NOT_PAUSABLE` 不等，照旧取消再打：这是模型或玩家现在就要的。
- 正在自动进食（可能就在窗口里）时来了怪，自卫照旧 `stop` 抢先，被暂停的任务也一起取消。这种情况少见，没有为它做“窗口里先吃后打”。
- 工具说明只改了 `defend-self`、`set-reflexes`（按能力加一句，列出的任务名从 `tool-registry.json` 取）；建筑、种地等任务的说明里本来就没写“会被取消”，没动。游戏指令（`scripts/companion.mjs`）那一行改成先暂停、最多两次。
- 顺手修了一个旧错误：`defend-self` 不带 `entityId`、而且之前从没发过自卫事件时，读 `this.defenseEvent!.at` 会抛 `TypeError`，自卫被当成失败并停用本能。
- 做 4d 运行端时发现并修正（10-11）：运行端原来要等 `begin` 的回复才在本地登记窗口。这之间采集发出的下一步，服务端已经开了窗口，会被当成窗口外的操作报 BUSY，采集因此失败。现在发 `begin` 之前就先登记，采集的下一步从那一刻起就等着；`begin` 被拒或叫停时撤掉登记、放行。窗口时长从服务端开窗的回复算起，`fightMs()` 仍然只增不减。

### 8.5 4d 运行端：一个调度器（约 2～3 天）

新增 `scheduler.ts`，统一管四个任务主人共有的那部分：
- 当前任务槽：id、工具名、epoch、`cancelled`／`stopPending`、身体任务锁令牌；
- `assertIdle`，替换 4b 的 `work.ts`；
- `run(tool, work)`：取锁、跑、放锁；
- `cancel()`／`stopped()`，`action-stop.ts` 只调它一个；
- 借锁 `borrow()`：采集借给陪挖陪捡，生存借给采集；
- 4a 的 `interrupt`；
- `current()`：告诉 4a 现在跑的是什么。

`ContainerTasks`、`GatherTasks`、`SurvivalTasks`、`PillarTasks` 只留各自的业务（容器引用、资源引用、进度、收据），生命周期交给调度器。下面这些语义原样保留：
- `SurvivalTasks` 的 `blocked`（结果未知后停住）；
- 采集里“停止未确认时不放锁”（`stopPending`）；
- 迟到的回执不能动新任务（epoch 栅栏）。

测试：现有 47 个测试文件全过（只改构造方式，不改断言）；新增 `scheduler.test.mjs`，覆盖借锁、迟到回执、停止未确认时保留锁、打断。

### 8.6 4c：陪挖、陪捡搬出 CompanionMode（约 1.5 天）

- 新增 `companion-errands.ts`（`CompanionErrands`）：根据姿态观察（`waiting`／`active`、离玩家多远）决定什么时候去挖、去捡，通过调度器的借锁跑子任务。`mineBlock`、`returnFromMining`、`pickupItem`、预算和收据游标都搬过去。
- `CompanionMode` 只留姿态和保护的翻译：`request`、`update` → `observePosture`、事件、`stop`。`childActive` 和它对 `GatherTasks` 的直接引用都去掉。
- 对外行为不变：
  - 子任务跑着时模型的工具报 BUSY；
  - `unknown` 和 `blocked` 不重试；
  - `get-companion-mode` 里的 `mining`／`pickup` 字段照旧。
- 测试：`companion-*` 系列全过，新增 `companion-errands.test.mjs`。

### 8.7 要你定的（10-11 已答）

用户 10-11 的回答：
1. **不跑** smoke，只做离线检查；④ 全部做完打包后试玩。
2. 用**等**的做法，血量降到低血线才取消。
3. 两处变化**都可以**。

1. **问题 4**：4d 服务端做完后，要不要跑一遍现有的隔离服 smoke 做回归？
   - 建议跑：任务槽改的是所有服务端任务共用的 tick／收尾，离线测试覆盖不到真实游戏里的走路、挖、放方块。
   - 要跑的有 `server-guard-duty-smoke`（任务暂停）、建筑、种地、长途走、垫高、陪挖这几个，大约半天，要按[隔离服实测](dev.md#进度与证据)的方法先挪开核心以外的模组。
   - 不跑的话，就等 ④ 全部做完打包后你试玩。
2. **打断时任务正好不能暂停**（`NOT_PAUSABLE`，比如脚手架上、正在挖）：
   - 我的建议是像保护一样等它到能暂停的时候，血量降到低血线才照旧取消。
   - 另一种做法是这种时候直接照旧取消。等的好处是任务不会白丢；坏处是挨打的那几秒先不还手。
3. 8.2 里的两处行为变化（原子动作提前报 BUSY；`companion-mode` 不再查容器任务）可以吗？

### 8.8 估计和风险

- 估计：
  - 4b：1 天；
  - 4d 服务端：1.5～2 天（跑 smoke 再加半天）；
  - 4a：2 天；
  - 4d 运行端：2～3 天；
  - 4c：1.5 天；
  - 合计约 8～9.5 天。
- 风险：
  - 4d 服务端是纯重构，但范围是所有服务端任务；
  - 4a 让会话第一次允许“一个暂停的操作 + 一串打断步骤”并存，`ControlSession` 的 BUSY 规则和运行端的 `exclusive`／任务锁都要一起改，回执、代次、停止栅栏是最容易出错的地方；
  - 4d 运行端要动 4 个任务主人，借锁关系最绕，所以排在 4a 之后：先让行为定下来，再整理结构。
- 每一块单独提交、单独跑三套离线测试。全部做完重新打包，交给你试玩。
