# MCBOT Server Control

2026-10-03增量：当前Java build有732项检查，运行端227项；已接统一原生高差导航、威胁观察、有限防卫／安全退让和原生攻击重入停止门槛。完整实服55项及Claude-b五阶段通过，已完成30分钟受控运行及独立短复验（生命值检查缺口见记录），见[生存第二批](../../docs/archive/server_navigation_defense_validation.md)。下文387项及平地能力是此前阶段说明，以最新协议和验收为当前范围。

MC 1.21.1 / NeoForge 21.1.217 及以上（21.1 线，实测用 21.1.217） 的 ServerBody 控制模块。只注册一位配置指定的非 OP 生存玩家，首次显式 claim 创建／附着；不会启动另一套 MC 客户端。旧 `mcbot-server-spike` 实验命令不进入此模块，两模块不可同时安装。

Java 21 编译：`$env:JAVA_HOME='D:/Java/jdk-21'; ./gradlew.bat build`。产物 `build/libs/mcbot-server-control-0.1.0.jar`。纯Java离线检查随build执行，当前可选陪伴拾取guard为**387项**（此前330＋新增57），日志见`output/server-escort-java.log`（本地证据未随仓库分发：`../../output/server-escort-java.log`）。历史第二批交互163项／持续陪伴227项／有限采集330项是当时结果，不重复相加。当前[跟随拾取验收](../../docs/archive/server_escort_validation.md)已通过23项真实程序矩阵及Claude-b／Codex各5阶段；Node143项通过。此前[有限采集验收](../../docs/archive/server_gather_validation.md)保留独立证据。

服务端启动读取 `config/mcbot-server-control/server.json`：

```json
{
  "worldId": "serverbody-validation",
  "username": "Claude",
  "uuid": "9c6882e0-e80c-4c3e-8f20-8e3f42c738a1",
  "port": 8766,
  "spawn": { "x": 512.5, "y": 201, "z": 512.5 }
}
```

端口被别的世界占用（例如客户端装了本模组、单人世界已经开着）时服务器照常启动，只在日志里报一行 `MCBOT local server control is off: port in use`，这时没有本地控制，换个 `port` 重启即可。

默认 spawn 为 null，使用原版出生点。配置 spawn 仅无该 UUID 的玩家存档时生效，附着已存活角色不会传送。身份、世界与端口只由服务端配置指定，claim 不能任意更换角色或出生点。不要把配置身份设为 OP；存活可控判定、claim 和 respawn 都拒绝 OP，运行中加 OP 也会使旧控制失效。唯一例外是单人世界「对局域网开放＋允许作弊」给所有玩家的 OP（内置服务器没有出生点保护）。单人世界没开局域网时拒绝接管（`SINGLEPLAYER_NOT_LAN`），`worldId: "auto"` 按存档文件夹命名，见[单人模式](../../docs/singleplayer_design.md)。

Mod 适配（R5）：附属模组通过公开包 `com.mcbot.servercontrol.api` 登记容器适配和右键交互，服主可以在 `config/mcbot-server-control/interactions/*.json` 里声明简单交互；服务器启动时加载，结果写进 `hello.adapters` 和 `hello.interactions`，日志里有一行 `MCBOT adapters: ...`。见 [Mod 适配接口](../../docs/mod_adapters.md)，示例附属模组见 [mcbot-kaleidoscope-cookery](../mcbot-kaleidoscope-cookery/README.md) 和 [mcbot-sophisticated-backpacks](../mcbot-sophisticated-backpacks/README.md)。别的 Mod 把掉落物直接收进玩家身上的存储时，附属模组可以登记 `PickupSink`，按数量核对后记账。Bot 没有客户端，核心会直接丢掉发给 Bot 的网络包，不做 NeoForge 的频道检查，这样登录时会给客户端发包的 Mod 也不会让 Bot 进不了服。

每次服务启动随机生成实例与本机 Bearer token，写同目录 `connection.json`（含 backend、endpoint、worldId、username）。此文件为本机凭据，不能公开或打印 token。HTTP 只接受本机 POST JSON /v2，拒绝 Origin、其它路径、非 JSON 与超过 64 KiB 请求；所有游戏读写在主线程执行，排队超时请求不得在后续 tick 执行。

完整协议见 [ServerBody v2](../../docs/server_body_protocol.md)。最早一批16个原子动作：send-chat、look-at、move-to-position、follow-player、follow-companion（2026-10-11 起删掉，改为下面的姿态）、dig-block、place-block、open-container、click-slot、close-container、select-slot、drop-item、approach-container、approach-player、approach-resource、pickup-item，另有只读nearby-blocks／nearby-resources。Node历史交互批次28工具、持续陪伴批次30工具，有限采集批次再新增discover-resources／gather-resources／collect-items，完整能力集共**33个MCP工具**；approach-resource／pickup-item由任务内部调用，不直接发布给模型。按实际capabilities裁剪，不发布自动重生或长期记忆工具。ClientBody协议v1和原动作参数保持兼容。

2026-10-07（第 8e 步）加了 `sleep-in-bed` 和 `wake-up`：找附近的空床走过去，用原生 `startSleepInBed` 躺下（不右键方块，下界不会炸床；重生点会设到这张床），睡着时只接受说话和起床；观察带 `sleeping` 和 `time`。细节见协议。

2026-10-07（第 8d、8f 步）加了 `craft-item`（背包 2x2 或走到工作台，原生点击放料取成品，缺料列出缺什么）、`smelt-item`（走到熔炉／烟熏炉／高炉放料放燃料，可以等烧完取出）和 `travel-to`（最远 2000 格分段走）；所有走路都会开关木门（出门后把自己开的门关上）。细节见协议。

2026-10-07（第 8g 步）加了 `tend-crops`（收熟的作物、捡掉落、原地补种，可播种空耕地、限量用骨粉，`survey` 只数）和 `breed-animals`（成对喂繁殖食物，等幼崽出生）；Bot 自己不会踩坏耕地。细节见协议。

2026-10-08（交付计划 3h）加了 `use-bucket`（倒水、舀水或岩浆，先转身到游戏视线正好落在目标面上才用）和 `tend-crops` 的 `till`（水边锄地）；`place-block` 可以放在草、蕨这类植物的位置；`open-container` 快捷栏满时先挪一格进背包腾出手；`craft-item` 没工作台时自己做一个。

新增`companion-pickup`是pickup-item玩家边界保护的能力标记，仅供Node门控，不是第17个原子动作，也不新增MCP工具；act对此标记明确UNSUPPORTED。未带guard的旧有限拾取保持兼容，Node可选持续拾取的接线／真实闭环以本批验收为准。

观察来自真实服务端世界；有限move-to-position／follow-player遇障碍即停，approach与持续模式仅做下述有界平地绕障。液体、空中、缺失支撑或未加载地形会停止，不挖路或传送。聊天按NeoForge ServerChatEvent可取消规则处理并发送实际游戏消息。单格挖放走普通生存玩家入口、视线／距离／世界边界与原版／NeoForge保护；挖掘使用当前主手与原版时间，停止清理延迟挖掘。放置坐标是支撑格，只向给定face相邻空格放置，拒绝门／床／双格植物等多格方块及菜单方块支撑。

approach动作有同高度平地有界绕障，选择满足原版reach／LOS的交互站位，逐tick核验扫掠碰撞、整脚底支撑和危险；搜索预算有限，不保证32格内必达，不挖路、搭桥或加载未知路径。资源／容器／玩家走近与掉落物拾取的规划站位中心及水平x/z±0.2四角均须满足各自原有触及／视线条件，为小于0.15格路点容差留裕量；实际原生range／LOS／拾取碰撞范围不放宽。TargetTokens以实际BlockEntity身份和完整状态绑定容器，双箱同时核验两半，替换／卸载／控制变化拒绝旧token。任务层只给模型短期containerRef；详见[走近验证](../../docs/archive/server_approach_validation.md)。

持续跟随、原地等待、坐着是租约上的**姿态**（2026-10-11，8m 第二步，能力 `server-posture`，协议方法 `posture`），不是操作：跟随绑定玩家名和 UUID，距离默认 2.5（1.5–6），站久了会闲逛几步。有操作在跑时姿态自动让开，身体空下来满 3 秒（`Posture.RESUME_AFTER_MS`）自己接上；聊天、选格、穿装备、`look-at` 不让开，内置手势（`emote` 不带 `source`）播放时只站住、播完马上接着跟（8m 第三步）；玩家下线、换维度、离开 32 格时原地等他回来，走不到时隔 3 秒再试，不会自己结束。普通 stop 不清姿态，`stop` 带 `clearPosture` 才清；租约结束、身体死亡也清。坐下成功后姿态变成 seated，被保护叫起来打完会走回座位。以前的 `follow-companion` 操作、`step-aside-stop`、`beside-follow` 已删。细节见协议「陪伴姿态」一节。只有离线测试，没进过游戏。

服务端库存、菜单槽位、carried、地面物品与原生拾取收据均报告完整components；非空栈另有maxStackSize，直接读实际ItemStack.getMaxStackSize()，空栈省略，不根据ID猜64或把当前数量当上限，实际值可大于64。菜单revision包含该上限变化。selectedSlot表示当前快捷栏；组件对象必须完整复制核验，不能只看ID／数量。所有组件统一经注册表感知的DataComponentMap CODEC／NbtOps输出typed-NBT，每个组件value均携原生类型；包括默认组件、CustomData和容器内嵌套物品，damage例如`{type:"int",value:1}`。long用字符串，原生浮点值用文本，数组和list／compound保留类型，具体字段见协议；原版已规范化的负零不伪称还原。存在transient／无持久codec或不能完整序列化的组件时明确UNSUPPORTED，不静默省略。未使用哈希／指纹代替字段比较。

dig／place／open 必须携完整 expectedProperties；place 另携当前物品数量和 expectedComponents。菜单 id 包含 session／菜单代次／原生窗口 ID，revision 跟踪 slots／carried／原生状态；click 与 close 必须带 expectedRevision，click 还须匹配槽位和 carried 的完整 ID／数量／components。每次点击后先重读，旧窗口和旧版本拒绝。

原生菜单支持 ChestMenu、HopperMenu、DispenserMenu、ShulkerBoxMenu、AbstractFurnaceMenu；方块入口对应箱子／陷阱箱、木桶、漏斗、发射器／投掷器、潜影盒和熔炉／高炉／烟熏炉。open 要求一个空快捷栏槽，避免物品使用回退。工作台、交易与特殊 Mod GUI 尚不宣称通用支持。

Iron Furnaces 的适配（`ironfurnaces:iron_furnace`）已拆成独立附属模组 [mcbot-iron-furnaces](../mcbot-iron-furnaces/README.md)，核心只管原版；它是第一个明确版本的内容Mod适配：仅Iron Furnaces4.3.2的普通未点燃iron_furnace及确切55槽菜单契约，不通配所有命名空间或机器等级。真实库存身份/InvWrapper索引、active和mayPickup字段使相同Node任务接口可以复用；不运行工厂／发电／升级GUI。安装Mod的普通玩家客户端仍需对应内容Mod，ServerBody不额外启动客户端。实际范围与证据见[D记录](../../docs/archive/server_content_D_validation.md)。

select-slot核对`{slot,expectedItem,expectedCount,expectedComponents,expectedMaxStackSize?}`后选0–8快捷栏。drop-item另携明确count（1–64），只能从当前选槽丢且不得超过栈数量；可选expectedMaxStackSize在每次原生写入前比较实际上限。走原版DROP_ITEM，分别报告requestedCount、removedCount、droppedCount，不把事件取消或未生成实体的库存减少冒充交付。Node的count／stacks任务最多解析256个，单栈容器来源与空快捷栏要求仍在；已有足量实际栈的give-item按最多64个分批drop，不静默截断，也不跨栈凑数。

有限资源按方块标签认（原木 `#minecraft:logs`、矿石 `#c:ores`、石料 `#c:stones`，模组的也算），候选带种类和按掉落表算出的掉落，见协议。nearby-resources要求1–8个方块ID或标签，半径默认4／最多16，候选默认32／最多64，固定center距Bot最多8格，扫描y±2；只看已加载且Bot可见的目标，最多845位置／150000地形读。发现、approach和资源dig共同禁止脚面以下方块、方块实体、自己或附近玩家身体／脚底支撑、相邻液体／危险与上方重力方块。目录不能识别人工建筑，Agent仍须根据明确授权选择范围。

资源候选含完整方块状态、私有targetToken、实际适用工具槽／推荐快捷栏。ResourceTargets固定120秒、最多256个，绑定session／generation／维度／坐标／BlockState／加载Chunk实例；普通块无BlockEntity，同chunk同状态替换不声称可检测。approach-resource仅走到16格内资源的原版reach／LOS站位；dig-block可携资源token逐步核验、使用正确掉落工具，仍走原生挖掘与保护。模型通过30秒本地resourceRef冻结整个候选集，不重扫、不垫高、不挖地板下坑。

groundItems报告八格内最多32个`{entityId,position,stack,visibility,visible,onGround}`，完整栈含maxStackSize；groundItemsTruncated明示截断，未返回不等于不存在。onGround直接读真实ItemEntity物理落地标志。pickup-item绑定UUID／真实实体和完整expectedItem／expectedCount／expectedComponents，可附expectedMaxStackSize；目标须保持八格内、相对初始位置位移最多0.75格，默认15秒／可配500–30000ms，2.5秒无进展停。普通Player碰撞负责拾取，不直接塞库存／虚拟touch／传送。

pickup-item现可附`companionGuard:{player,expectedEntityId,maxDistance}`，字段均必需、半径1.5–4格，无服务端默认。一次拾取绑定真实玩家实例，开始／每tick及驾驶前核验同一UUID、维度、生命和连接；身体与掉落必须在玩家当前半径内，路线候选／剩余路点／下一步也不能越界。初始身体较远即拒绝。仍为同一玩家但距离超界为COMPANION_OUT_OF_RANGE，离线／死亡／身份实例替换／跨维度为STALE_COMPANION；Node仅可对前者收尾、复核后回跟随，不重试该失败物品。其它受阻不自动重试。guard收住后续驾驶，无法回滚已经发生的正常碰撞拾取：若Post先确认获得、随后anchor变化而失败，仍保留真实pickedUpCount／stack，不伪造0；指定items也只限制主动追逐，不改变原版自然拾取规则。未增加dig guards或扩大资源目录。

NeoForge ItemEntityPickupEvent.Post按真实body与实体归因，original.count−current.count为实际pickedUpCount；pickupReceipts最多256条，包含seq／entityId／position／实际片段stack／pickedUpCount／sessionId／controlGeneration／dimension。pickupCursor为最新seq，pickupOldestCursor为最低完整前置游标；缺口或未知事件不可当成功。部分拾取只报实际数，其他玩家抢捡／合并／未知消失失败，无Post就没有收到的证据。

Node的有限采集入口为discover-resources、gather-resources、collect-items；后两者返回受理running并在共享任务锁下后台执行，聊天不中断，stop撤销旧步骤。目标为新获得数量，按seq累计原生收据，不把挖块数／背包净变化／实体消失当收获，不重复加pickup动作结果。count与stacks二选一；用户省略数量由Agent选合理有限count并说明。1组按授权地面实际栈或首份原生拾取片段的有效上限，初始未知须如实说明；固定变体／上限后变化即停，不能猜64或按旧背包变体重绑定。目标最多256、默认64动作／60秒，候选与范围冻结，不足时不向外追加；原生整栈拾取超目标时如实报告overage。落地稳定最多等2.5秒，新onGround为true至少持续200ms／4次采样，旧字段缺失时400ms／8次采样。此前程序与实际Agent结果见[有限采集批次验收](../../docs/archive/server_gather_validation.md)，不把33个工具数量当作全部参数或任意Mod验收，当前可选陪伴拾取有独立验收记录。

stop、release、revoke、失心跳仅停控制，角色保持在线并继续普通生存；服务器关停才移除并保存角色。死亡、维度变化、被移除会立即废弃旧租约与会话，不自动恢复旧动作。存活角色在 kick／维度变化后可以显式重新 claim。

claim 载入死亡角色返回 DEAD_BODY 并保留死亡状态，不能靠重新接管复活。B4 的 respawn 是独立显式原生请求，匹配当前 instance／world／username／死亡 session，调用原版 PERFORM_RESPAWN 与 PlayerList 重生路径；原版选择床／重生锚／世界出生点，处理库存规则与重生事件，不原地加血。活角色拒绝请求，成功产生新 session，且不 claim／续租／恢复旧任务。

在仓库根目录显式运行：

```pwsh
node client-runtime/dist/main.js --body server --respawn-only --connection-file <服务端connection.json> --username Claude --world-id <worldId>
```

该命令只 hello→respawn，不启动 MCP、不写控制文件、不接受 --hosted；首次尚未载入的死亡存档可使用 null session。之后须显式启动新的 MCP 接管，旧 MCP 保持终止。最近退休租约的宿主 watch 可只读聊天，直到新 claim 或身体会话变化；旧宿主 revoke 永远不能影响新租约。

首次生成与后续传送会独立于实体 tick 确认传送并迁移原版玩家区块票；即使新位置尚未加载，也能让角色自行加载其所在区域。物理与生存仍只由世界实体 tick 驱动，不需要真人旁观或 `forceload`。

动作 `ok:true` 只表示回执；以 Operation.status 区分 running／succeeded／failed／cancelled／unknown，失败分类在 result.code。原生异常或部分效果无法确认时保留 unknown；重查世界／库存／菜单，禁止自动重放。租约停止／死亡／重生之后旧 operation 不恢复。

真实Claude／Codex的C已完成，新任务的Claude实际聊天见[10月3日记录](../../docs/archive/server_agent_interaction_trial_2026-10-03.md)。单机暂停、异机传输和更广Mod／版本仍需分别验收；白名单普通交互不代表理解所有Mod。本模块没有OP实验命令或RCON产品依赖，测试RCON仅准备隔离夹具和独立观察。
