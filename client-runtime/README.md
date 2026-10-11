# Body 运行端（ServerBody 与 ClientBody V1）

> **10-12 说明**：本页按批次记录，下文的工具名和工具数（13／21／33／39 等）都是当时的。现在 ServerBody 的工具清单以 [`tool-registry.json`](tool-registry.json) 去掉 `clientOnly` 的条目为准（全部能力下 45 个），新旧名字对应见下面「工具与当前边界」开头。，包含主背包准备、工具基础评估、自动进食、有限防卫及revision策略；高差导航通过`navigation-3d`声明。生存终态单独记录，不因静默进食或取消而丢历史，也不逐击唤醒模型。当前验收与限制见[生存第二批](../docs/archive/server_navigation_defense_validation.md)；下文13／21／33等数量属于相应历史阶段。

这是独立的 TypeScript／MCP 包，使用同一 Body 契约连接两种后端。ServerBody 连接安装 `mcbot-server-control` 的独立服务器，显式接管服务端生存角色，无额外 Bot Minecraft 客户端；A／B／C、持续陪伴及有限采集首批已有对应真实验证。ClientBody 是保留的可选 V1 原型，连接安装 `mcbot-control` 的真实客户端，客户端须先由用户进入世界，游戏服务器无需安装该客户端控制 Mod。

本包运行依赖仅声明 MCP SDK 与 zod，不安装或加载 Mineflayer，不读取 RCON。它不启动 Minecraft 或管理登录；ServerBody 的创建／附着、原生交互与显式重生由服务端控制模块执行。Agent／模型凭据留在宿主，连接文件是本机控制凭据，不能分享或提交仓库。

## 构建与运行

在此目录使用 PowerShell 7：

```pwsh
npm ci
npm test
```

通常由 MCP 宿主使用 stdio 启动运行端。[scripts/start-server-play.mjs](../scripts/start-server-play.mjs)（只要 Node；根目录的 `start-server-play.ps1` 转调它）提供 ServerBody 的 Claude／Codex 托管入口；符合 MCP 的 Agent 也可直接启动下面的进程，不依赖具体 Agent 类型。

### ServerBody

服务端控制 Mod 的连接文件使用独立协议 2：`{protocol:2,backend:"server",endpoint,token,worldId,username}`。端点仅接受 loopback HTTP `/v2`；世界与角色必须同时匹配服务端允许值和 CLI。`--body` 默认为 `client`，协议 1 不会自动转为服务端协议。

```pwsh
node dist/main.js --body server --connection-file "G:/path/to/server/config/mcbot-server-control/connection.json" --username ServerBot --world-id example-world --runtime-dir "<repo>/runtime"
```

服务端控制口可达时角色可能尚不存在，首次显式 claim 才创建或附着角色；接管后先读现状。快照标记 `server-observed`，包含服务实例、角色会话与控制代次。按服务端实际 `hello.capabilities` 发布工具：A 的四个动作与九个公共观察／控制工具共 13 个；启用 B 的七个生存动作及 `get-container` 后共 21 个。记忆工具和自动重生不发布给 MCP。

B 的服务端快照还包含 `selectedSlot`、每个库存／菜单／carried 栈的完整 `components` JSON，以及 `container.revision`。所有组件 value 统一是经注册表 CODEC／NbtOps 生成的 typed-NBT，包含默认组件和嵌套物品；damage 如 `{type:"int",value:1}`，long 为字符串，浮点为原生值文本。把整个对象原样复制，不简化或重建数值；存在 transient／无持久 codec 的组件时明确 UNSUPPORTED，不静默丢字段。

`dig-block`／`open-container`／`place-block` 必须携完整 `expectedProperties`；放置还须携槽位当前 `expectedCount`／`expectedComponents`。窗口点击和关闭必须携 `expectedRevision`；点击须携槽位与 carried 的完整组件、ID 和数量。每次改变菜单后重新观察，不能仅凭 ID 或数量重用旧窗口快照。ClientBody v1 的参数保持兼容，不额外要求这些服务端字段。

`select-slot` 核对 `{slot,expectedItem,expectedCount,expectedComponents}` 后选择快捷栏；新任务另携实际栈的 `expectedMaxStackSize`，旧调用可省略。`drop-item` 在这些字段之外携明确 `count`（单次1–64），只能从当前选槽丢出且不得超过当前数量；原子64上限继续保留。挖掘使用当前选中主手，并由服务端检查执行期间工具变化、原版保护和取消。服务端拒绝使用 `failed` 与 `result.code` 分类；超时结果仍保持 `unknown`，不自动重放。

死亡使旧租约终止。独立显式命令 `node dist/main.js --body server --respawn-only --connection-file <文件> --username <角色> --world-id <世界>` 只调用 hello 与原生 respawn，不接管、不启动 MCP、不创建控制文件。其请求核对当前死亡 sessionId（首次尚未加载的死存档可为 null），活角色拒绝此命令。重生完成后须显式启动新的 MCP，旧任务不恢复。

ServerBody 普通 `stop-action` 立即发出 HTTP 请求，推进控制代次并保留租约和在线角色；不等待迟到 act 回执。旧请求与旧回执不能恢复动作，停止后的第一条明确新动作使用新代次。心跳只核对代次，不自动同步外部变化；租约失效、宿主 revoke、会话变化或失联后终止控制，工具重试不重新 claim。退出仅 release 自身租约，角色仍在线。

接管成功后原子写入 `runtime/server-control-<username>.json`，供宿主使用受限 `watch`／`revoke`。字段与 [服务端协议](../docs/server_body_protocol.md) 一致，包含 `stopToken`，但不包含连接 bearer token；工具和日志不输出这些凭据。退出／失控只删除仍匹配自身 lease、controller 和 instance 的文件。宿主可通过 `--controller-id <随机标识>` 将本次托管与控制文件绑定；不传时由运行端随机生成。

### ClientBody

```pwsh
node dist/main.js --body client --connection-file "C:/path/to/instance/config/mcbot-control/connection.json" --username ClientBot --world-id example-world --runtime-dir "<repo>/runtime"
```

先在独立客户端中以 ClientBot 进入所选世界。`--username` 必须匹配实际玩家；`--world-id` 是所选资料标识，不从地址猜测。客户端端点仅 loopback HTTP `/v1`，不跟随重定向。省略 `--body` 仍保持 client 默认，不会把协议 1 静默改成 ServerBody。[start-client-play.ps1](../start-client-play.ps1) 保留 Codex 托管入口。

托管兼容参数包括 `--hosted --nickname --bot-players --memory-dir --memory-agent`。`--blueprint-dir <目录>` 指定 build 读写蓝图的目录（默认 `<runtime-dir>/blueprints`）。记忆参数仅为接线兼容而接受，本包未实现记忆工具。`--hosted` 必须有新鲜、存活的 `runtime/companion-<username>.json` 心跳；过期会释放控制权并关闭运行端。

## 控制与结果语义

- `src/body.ts` 是可注入的强类型 Body 契约，没有 Minecraft Java、Mineflayer 或 Agent 类型。
- 控制端独占租约，每 2 秒续租；两种 Mod 都在 10 秒未续租后自行停止控制，本机进程锁与游戏端租约共同阻止并行接管。
- `running` 表示持续执行；运行端查询其状态并发出一次终态 `task` 事件。也可使用 `get-operation` 主动查询。
- `stop-action` 绕过身体动作互斥，立即发送停止。ServerBody 使用服务端控制代次屏障拒绝旧请求；ClientBody v1 若有未完成请求，等其回执后再停止一次。
- 变更请求超时／断线返回 `unknown`，从不重发动作。租约丢失、维度／世界代次变化后保留 MCP 通道并返回终态错误，必须手动重启托管才能重新接管；Agent 重试工具不能跨世界自动续做旧任务。
- 明确收到 `LEASE_BUSY` 时，首次 claim 最多等待约 12 秒，让上个进程残余租约过期；claim 超时结果不明则不重试。
- 只暴露 Mod `hello.capabilities` 声明实现的动作，不提供假记忆、自动进食或建造脚本工具。
- 挖放／槽位点击使用预期方块、物品、数量和菜单代次保护；ServerBody 另严格核对完整状态／组件和窗口 revision。任何无法确认的原生效果或客户端预测都保持 `unknown`；先观察实际状态，再接受新的明确动作。
- ServerBody 快照为 `source: server-observed`，来自服务端权威状态；ClientBody 为 `client-observed`，可能包含预测。快照本身不代替具体 Operation 成功回执。

## 工具与当前边界

**2026-10-11 起 ServerBody 的工具合并了**（[工具整理方案](../docs/tool_consolidation_plan.md)），服务端动作名和协议不变，下面各段落里的旧工具名是当时的写法，对应关系是：
- `go-to`：`move-to-position`、`travel-to`、`go-to-place`、`approach-player`。给 `x/z`（`y` 可选）、`place` 或 `player` 其中一个；32 格内、给了 `y` 的走普通导航，远了、没给 `y`、带 `meet` 或目标区块没加载的走 `travel-to`。
- `places`（`remember`／`list`／`forget`）、`blueprints`（`list`／`save`）、`pillar`（`up` 或 `down`）、`get-up`（躺着就 `wake-up`，否则 `stand-up`）。
- `container-menu`（`open`／`read`／`click`／`close`）：每一步按原来那个工具的参数严格核对，菜单 guard 照旧必填；`read` 只看，身体忙时也不拒绝。
- `get-status` 加 `include`：`inventory` 给完整背包，`survival` 给危险、威胁和进食／防卫策略；`get-position`、`list-inventory`、`get-companion-mode`、`get-survival-state` 不再单独发布。
- `equip-item` 加 `hand:"main"`：把背包里的东西拿到主手（原来的 `prepare-item`，快捷栏里的只选中，原来的 `select-slot`）；`emote` 不带 `name` 只转身看玩家或坐标（原来的 `look-at`）。
- `follow-player`（旧的限时跟随）不再给 ServerBody，跟随用 `companion-mode`。
- `tool-registry.json` 里标 `clientOnly` 的是只给旧 ClientBody 的工具，ClientBody 的工具和形状不变。10-12 又删了 4 个：`read-chat`（只留给 ClientBody，ServerBody 的聊天作为事件推给模型）、`assess-tool`（采集、挖方块时程序自己挑工具）、`approach-container`（容器任务自己会走过去）、`fetch-and-give`（先 `container-withdraw` 再 `give-item`；运行端内部这条组合流程还在，和取物、交物共用代码）。ServerBody 共 45 个。

ServerBody 现在的观察／控制工具（`tool-registry.json` 里 kind 为 read、chat、control 的）：`get-status`、`find-entity`、`get-block`、`get-operation`、`look-around`、`discover-resources`、`discover-containers`、`workstation-options`、`places`、`blueprints`、`wait-for-events`、`send-chat`、`stop-action`、`set-reflexes`、`defend-self`；`get-position`、`list-inventory`、`read-chat`、`get-container` 只给 ClientBody。

历史（10-03 之前）：两种后端已有的动作：`send-chat`、`look-at`、`move-to-position`、`follow-player`、`dig-block`、`place-block`、`open-container`、`click-slot`、`close-container`；ServerBody B 另有 `select-slot`、`drop-item`，当时全部启用共 21 个。其中 `look-at`、`move-to-position`、`follow-player`、`open-container`、`click-slot`、`close-container` 现在只给 ClientBody（ServerBody 用 `emote`、`go-to`、`companion-mode`、`container-menu`），`select-slot` 并进了 `equip-item hand:"main"`。ClientBody v1 全部启用仍为 19 个。

2026-10-03 最新ServerBody完整能力集为33个MCP工具：原交互28个、持续陪伴2个入口、有限采集／拾取3个入口；旧能力集仍按声明发布。容器流程是 `discover-containers({centerPlayer?,radius?,maxResults?})` → `container-withdraw` → `give-item`；也可 `container-list` 先看内容（当时的 `fetch-and-give` 10-12 已删，运行端内部同一流程还在）。`say` 是 Agent 自己写的自然回应，先发言再操作。程序持有完整 typed-NBT、菜单 guards 和服务端实例token，模型不用逐槽复制；任务自动走近、取物、返回指定玩家交物。

走近限有界已加载平地，可绕有限障碍，不挖路／搭桥／传送；最大搜索32格不等于保证32格内任意路线成功，预算用尽明确拒绝。接收玩家绑定UUID，行走中位移超过0.5格停止；最终丢出前校验1.5格距离与视线。同坐标同状态换箱、双箱另一半替换和目标卸载会拒绝旧引用。容器任务仍需单个足量源栈和空快捷栏，不跨源栈；组件变体歧义拒绝。任务数量可为 `count` 或 `stacks` 二选一，最多256个，取物数量还须容纳于选定实际物品的一栈；99个交物会按64＋35分批，每批重读接收者和完整物品 guards，不能通过截断数量满足接口。交物的 `pickup` 仍是指定玩家拾取未确认，与后面的Bot原生拾取证据分开。旧服务端无新能力时保留明确标注的近距／state-only保护。

持续陪伴增量：声明 `server-posture` 的新服务端发布 `companion-mode({action:"follow"|"wait"|"pause"|"resume"|"stop"|"guard",player?,distance?,wander?,pickup?,mining?,guard?,say?})` （状态随每次 `get-status` 的 `companionMode` 返回；没有 `server-posture` 时 follow／wait 报 UNSUPPORTED，提示更新核心模组，没有旧路径）。跟随／等待是**服务端持有的姿态**（`posture` 方法，带 `postureRevision`，和 `guardRevision` 一样按序号生效，迟到的旧回执 CANCELLED 丢弃），运行端只翻译：`follow` 必须明确玩家，距离默认2.5格、范围1.5..6，`wait` 原地等待，二者都不持有任务锁，也不是操作；聊天、读取和别的工具照常用。用身体的工具（走路、采集、合成、建造、吃、表情、睡觉……）开始时服务端姿态自己让开（`companionMode` 里 `suspendedFor` 写着在做什么，`state` 不变），操作结束几秒后自动接上，运行端不发任何请求，不用 `pause`／`resume`；`pause` 只是手动关掉姿态（记住意图，直到 `resume` 重新设置）。`stop` 关姿态和保护且不打断其他任务（不发身体 stop）；`stop-action`、玩家叫停、`companion-mode stop`、托管结束带 `clearGuard`＋`clearPosture`，普通停止（反射自卫、策略变更）不清姿态也不清保护。`guard` 是单独的常驻保护，保护的就是被跟随的玩家。新的 `follow`／`wait` 直接换掉旧姿态（服务端按序号只认最新）。

`get-status.companionMode` 返回 `state`、可选 `intent/player/distance/guardEnabled/suspendedFor/away/stage/code/reason/seated`；`following`／`waiting` 来自服务端观察里的 `posture`（站在玩家身边的跟随显示为 `waiting`），`suspendedFor` 是姿态让开的操作名，`away` 是玩家不在附近（回到附近自动接上，只发一次事件）。服务端自己结束了姿态（比如同名但不是原来那位玩家）时发一次 `POSTURE_ENDED`，不会自己重设。坐下由服务端设成 `seated`：跟随／等待结束、保护保留，站起来后要重新 follow；打完怪走回座位坐下失败时姿态变成等待，带 sit 错误码发一次事件。手动 `pause`、受阻（`blocked`，陪拾取／陪挖出错）时服务端不持有姿态，只有显式 `resume` 才重新设置，重新核验原会话、维度和同一玩家UUID。租约失效、叫停或进程重启均废弃旧意图。

RuntimeMonitor后台更新持续状态；显式模式变化记录 `companion_state`，受阻／失控只记录一次需宿主解释的 `companion` 事件。姿态让开、回来、站在玩家身边与走动之间的切换不发唤醒事件，也不产生逐tick任务回合。新增的事件只有：回座位失败、服务端结束了姿态、死后恢复结果。旧ServerBody、ClientBody和旧Mineflayer路径保持原有工具，有限 `follow-player` 继续保留。

跟随拾取：只有同时声明`companion-pickup`的服务端，follow才提供`pickup:{items:[物品ID],radius?}`；1–8个明确ID，半径默认3、范围1.5–4，跟随distance不得更大。未带pickup保持普通跟随。靠近玩家（服务端 `arrived`）时，程序选择白名单掉落，借任务锁把单个UUID当普通操作处理（服务端姿态自己让开又接上，运行端不停也不重设跟随）；不能每个物品都唤醒模型。玩家走出保护半径可收尾，不自动重试该旧UUID；其他失败先收住原生动作，把姿态关掉并发布一次blocked。pause保留配置、resume显式重核；wait和stop清除配置。陪挖同理（`mining`，需要 `companion-mining`）：每一步都是普通操作，任务锁只在子任务存活期间持有。

状态增加`activity:following|picking-up|switching`及`pickup:{items,radius,countStatus,pickedUpCount?,lastConfirmedPickedUpCount?,lastItem?,code?,lastCode?,totals}`。totals按实际完整组件／有效上限分变体，模型只见简要分组。外层按唯一原生游标累计活动期间收到的白名单物品，包含普通碰撞拾取；子任务只确认自己的UUID，不能再加一次数量。items仅限制主动追逐，不阻止原版顺带拾取其他物品；未知／收据缺口只报告最后确认量。拾取收据只认同一身体会话和维度（停止不再带来新的"代次"）；独立观察revision屏蔽跨切换的旧观察；迟到子任务不能释放新锁或重设姿态。

死后恢复（`death-recovery.ts`，托管下）：重生后运行端先读上次留下的姿态记录（`runtime/posture-<名>.json`，超过一小时、或早于玩家最近一次叫停的不用），再看 `hello.lastDeath.drops`：掉落还在（`remaining` 不是 0）、没过 `despawnAt`、同一维度、在 `travel-to` 的距离上限内、剩余时间够最短的行走、身边没有敌对且可防卫的怪（survival-state 的 `threats`）时，先用任务锁走到死亡地点、按 `deathDrop` 标记逐个捡起（路上有叫停就取消，且不再设姿态；怪出现就停），然后把死前的跟随／等待／保护设回去；坐姿只报告不恢复。全程结果以一条 `companion` 事件（【死后恢复】）告诉模型。

有限采集／拾取通过三个能力门控入口提供：

- `discover-resources({blockIds,radius?,maxResults?})`：明确1–8个受支持方块ID、半径1–16（默认4，中心往下 2 格到往上 4 格，近的先核验）、最多64个候选（默认32），冻结已加载、可见的候选，返回30秒内提交的 `resourceRef`。首批只支持石头、深板岩、花岗岩、闪长岩、安山岩和8种主世界原木；10-07（8a）起按方块标签认：原木 `#minecraft:logs`（不含去皮和六面树皮）、矿石 `#c:ores`、石料 `#c:stones` 加原版五种，模组的同类方块也算，`blockIds` 可以填标签。程序不判断天然树或人工建筑，Agent须选择已获授权的区域。
- `look-around({radius?})`：只读，概括已加载的 8–32 格（默认 32，上下各 8 格）内的玩家、生物（敌对在前）、掉落物，以及至少一面露在外面的矿石、原木、容器、床、工作方块、门、作物、水面／岩浆面、刷怪笼、传送门；每类给数量和最近一个的距离、方位、高差、是否看得见，另有生物群系、时间段、天气、露天和亮度。埋着的方块不报，不发目标令牌。
- `gather-resources({resourceRef,item,count?,stacks?,say?,maxSteps?,timeoutMs?})`：先收取授权区域匹配掉落，再在冻结候选内选工具、走近、原生挖掘和拾取。不会为凑够目标向外补扫；脚下或玩家支撑块、方块实体、危险、缺合适工具或已满背包会拒绝新挖掘。
- `collect-items({item,count?,stacks?,radius?,say?,maxSteps?,timeoutMs?})`：只捡当前观察到且处于固定半径内的掉落实体，冻结UUID集合；不挖方块，不启动持续“只捡”模式。

资源方块与目标掉落物须分别指定：采圆石可以发现 `blockIds:["minecraft:stone"]`，再提交 `item:"minecraft:cobblestone"`；不能因想要圆石就把不在catalog内的圆石方块当作支持的资源。

两个有限任务须明确 `count` 或 `stacks` 二选一；玩家没有给数量时由Agent根据用途、资源、工具和空间选择有限目标，并在开工回应中说明，执行层不默认64或1组。**1组是选定实际物品栈的 `maxStackSize`**，由游戏端实际 `ItemStack.getMaxStackSize()` 提供，考虑组件和Mod效果；不是当前不足额栈的数量、空槽余量或机器槽容量。非空 inventory／container／carried／ground栈与摘要保留此字段，旧身体缺字段时保持未知，不能从ID猜64。容器以实际来源栈换算；新采集以授权地面来源或首份实际拾取收据绑定变体／上限，旧背包同ID物品只参与容量检查，不决定新获得物的变体。暂无实际栈时可以在已授权候选内先取得一批原生掉落再解析组数，未知时不宣称已经换算；解析后目标固定，变体或上限改变停止。

数量与执行预算分别有限：`count/stacks`输入范围1–256，解析出的总目标最多256个，超出明确拒绝，不静默截断。`maxSteps`默认按数量算（每个约8步，64–256，整棵树最多1024）、范围1–256；总 `timeoutMs` 范围1000–120000，不填时采集按数量算（每个约4秒，2–10分钟，整棵树一样），`collect-items` 60000。拾取先捡近的；走不到的掉落（掉进坑里、被方块围住）跳过，接着捡别的，结果里记 `unreachableDrops`；被草这类不是树叶的东西挡住的照样走过去捡。砍树的任务砍完后把范围内地上的苹果和树苗也捡一遍（不等树叶腐烂，不算进目标，列在 `items`）。两个任务异步返回 `running` 和operationId，由程序连续执行重复步骤，聊天与读取可并行；共享写锁阻止原子动作或另一任务绕过。`get-operation`读取进度／终态，尚未交付的终态发一次 `task`；主动查询已交付的结果不再唤醒。`stop-action`独立停止身体并撤销后续步骤，旧任务不自动复活。

获得量来自原生拾取Post事件及其完整收据：`pickupCursor/pickupOldestCursor/pickupReceipts`含实体UUID、实际片段、完整组件、上限、数量和会话／代次／维度。游标缺口、旧会话、非授权来源、不同变体或未知回执会停止，不能凭实体消失、挖块数或背包净变化冒称成功。结果区分 `minedBlocks`、新收取的 `pickedUpCount`、`targetCount`、原生一次多捡的 `overage`、意外物品及部分证据；unknown／cancelled用 `lastConfirmedPickedUpCount`，不重复未知动作。掉落先等待权威 `onGround` 和持续稳定，最多2.5秒并服从任务总时限。仅同一目标UUID本次新增的严格收据已证明数量目标完成时，已知拾取移动失败可作为辅助诊断保留而判数量目标成功；未到量的 `BLOCKED` 仍停止，不越过危险继续采集。

资源引用是状态与已加载区块保护，不能宣称检测同一区块内同状态替换；真实一般容器的实例保护继续独立保留。首批不挖脚下平地、不挖路或搭桥，不处理复杂矿道、战斗、持续陪挖、完整砍树或建筑预设；不能把组件改为99的验证当作任意内容Mod资源采集已经支持。

ServerBody `get-status`／`get-operation` 默认摘要，原子调试需 `details:true`；完整背包用 `get-status` 带 `include:["inventory"]`（ClientBody 的 `get-container`、`list-inventory` 形状不变）。容器摘要明确区分 container／player／cursor／unknown。完整终态保留在本地 operation trace；已交付终态不再重复唤醒，内部任务步骤不产生逐步 Agent 回合。ClientBody 原工具默认形状保留。

槽位可携 `active`／`mayPickup`：通用任务忽略隐藏槽的内容，不从不可取槽拿物品；空槽的mayPickup=false不代表不能放入，存入仍服从原生mayPlace。特定内容Mod由服务端Adapter提供准确来源和槽语义，任务层不添加Mod名称分支；已实现的窄Iron Furnaces范围及实际证据见[D记录](../docs/archive/server_content_D_validation.md)。

移动是短距普通行走，不是完整寻路；不会传送或擅自挖路。`place-block` 使用快捷栏 0–8，坐标指所点击的支撑格。容器先观察 id／slots／carried，再逐次带前置核验；服务端还须携 revision 和完整组件。ServerBody 普通菜单白名单为 ChestMenu、HopperMenu、DispenserMenu、ShulkerBoxMenu、AbstractFurnaceMenu，对应箱子／木桶、漏斗、发射器／投掷器、潜影盒、熔炉系列；工作台、交易或特殊 Mod 界面尚未通用支持。命名空间 ID 原样保留，例如 `example:custom_block`。

托管事件与现有 companion 使用相同 `{session,seq,timestamp,type,text}` JSONL，以及 delivered／consumed 游标。首次观察中的历史聊天不作为新任务；自身和配置中其他 Bot 的消息不唤醒 Agent；无法可靠识别玩家名的聊天保留为 `system_chat`，不猜测身份。

## 已验证与待验证

2026-10-03最新[跟随拾取批次](../docs/archive/server_escort_validation.md)：构建与 **143／143** Node测试通过（含17项新边界）；真实程序 **23／23**，Claude-b／Codex各 **5阶段**通过，包含连续两批拾取、聊天继续、独立叫停与首个新采集。Codex三个资源工具实际短回归已补。本批不增加MCP工具，仍为33个；没有持续挖矿或建筑交付。

2026-10-03数量与有限采集首批：当时本包 **126／126** Node离线检查通过，保留已有世界／租约／组件／取消守卫。真实程序矩阵 **27／27** 与Claude-b／Sonnet5.5／low四阶段通过，详见[数量与有限采集验收](../docs/archive/server_gather_validation.md)。实际模型自主选择6个圆石并确认挖6／收6；只捡组件有效上限99的一组圆石；任务中独立叫停约310毫秒；叫停后的首个明确任务成功收取一组16雪球。程序矩阵另覆盖有效上限16／64／99、99个容器取物交还的64＋35原子丢物、部分结果、变体、满包和停止。该历史批次没有Codex有限采集／拾取模型证据，后续跟随拾取批次已补；持续陪挖与建筑仍未验收；不将不同测试阶段计数相加。

此前持续陪伴批次为100／100离线基线；[实际验证](../docs/archive/server_companion_validation.md)包含19项程序矩阵、Claude-b／Codex各6个真实聊天阶段，以及Claude受阻说明和明确恢复。该历史首批仅跟随和等待；之后跟随拾取、持续陪挖（`mining`）和建筑（`build`，8i）都已交付，验收范围见[交付计划](../docs/delivery_plan.md)。

此前交互验证见[走近与替换核验](../docs/archive/server_approach_validation.md)、[真实Claude任务体验](../docs/archive/server_agent_interaction_trial_2026-10-03.md)和[D内容Mod记录](../docs/archive/server_content_D_validation.md)；10月2日第一批近距证据保留在[交互修复记录](../docs/archive/server_interaction_validation.md)。同Sonnet5.5／low的短会话已证实先回应、绕墙返回和停止后新任务，多轮性能统计与复杂场景仍待扩展，不能把工具直连耗时当模型回复时间。以下41项是B阶段历史基线。

2026-10-02：`npm test`（含 TypeScript 构建）41 项通过；原 ClientBody 15 项保留，ServerBody A／失效边界 18 项及 B 8 项。覆盖真实 mock HTTP、互斥、停止与迟到回执、失联未知结果不重放、租约过期、世界代次、续租故障、claim 重试边界、事件游标、单实例、托管心跳，以及独立 Node 进程的 MCP stdio 调用。服务端新增验证包含代次屏障、心跳拒绝静默同步、宿主撤销后的 MCP 终止态、控制文件凭据隔离和仅自身租约清理；首轮事件以 claim 游标为界，保留接管后、MCP 首次观察前到达的新聊天。B 验证覆盖完整组件字段、菜单版本必填、21 工具按能力启用、生存拒绝保持租约，以及独立重生 CLI 不隐式 claim。明确 HTTP BUSY 拒绝可继续当前租约；主线程 TIMEOUT 为 unknown；停止请求未确认时终止旧控制，防止本地取消记录掩盖远端仍运行的动作。

stdio 测试使用模块加载器拒绝导入 `mineflayer`、`minecraft-protocol`、`minecraft-data` 和 `prismarine`；独立 `npm ls --omit=dev --all` 依赖树没有这些运行依赖。测试比较实际字段，没有哈希校验流程。

上述 41 项是离线与模拟传输证据；ServerBody 已另在真实隔离服完成 A 生命周期控制链与 B 生存交互／原生重生验证，见 [A 验收](../docs/archive/server_control_A_validation.md) 和 [B 验收](../docs/archive/server_control_B_validation.md)。实际 stdio MCP、保护拒绝、组件／容器守卫、丢物与独立重生分别有游戏证据，不能与离线计数相加。

ClientBody 游戏结果与保留余项见 [V1 验证记录](../docs/archive/client_v1_validation.md)。内容 Mod D、单机暂停、异机与多版本仍独立验收；本运行端的能力清单不表示这些后续阶段已经完成。
