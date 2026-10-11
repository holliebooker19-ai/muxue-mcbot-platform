# Mod 适配接口（R5）

Bot 默认只会用原版的箱子、木桶、漏斗、发射器、潜影盒、熔炉，以及登记过的右键交互。其他 Mod 的方块要靠适配器才能用。没有适配的方块，Bot 一律拒绝操作，不会去猜。服主也可以按 Mod 打开[通用物品槽适配](#通用物品槽适配8b)，让 Bot 不开界面、按物品槽放取那个 Mod 的机器。

适配有两种办法：

| | JSON 声明 | Java 附属模组 |
| --- | --- | --- |
| 适合 | "拿着这些物品、右键这些方块，可能产生这些变化"这类简单交互 | 容器和机器的菜单、对空使用物品、需要读方块内部状态或自己校验结果的交互、把掉落物直接收走的 Mod |
| 谁来写 | 服主，不用写代码 | Mod 作者或适配者，单独打包成一个附属模组 |
| 放在哪 | `config/mcbot-server-control/interactions/*.json` | 和 mcbot-server-control 一起放进 `mods/` |

两种都在服务器启动时加载。之后服务端会把它们告诉运行端：容器适配列在 `hello.adapters`，交互列在 `hello.interactions`，其中对空使用的交互另外列在 `hello.itemInteractions`。AI 在 `container-menu`、`interact-block` 和 `use-item` 的工具说明里能看到这些名单。启动日志里会打一行 `MCBOT adapters: ...`。有问题的 JSON 文件和适配器会被跳过，并记一条 `MCBOT adapter: ...` 警告。

## 安全规则

所有适配都遵守下面几条：

- **版本锁定**：只在验证过的确切版本上启用。版本对不上就当作没装。JSON 的 `requires` 和 Java 的 `McbotApi.versionsMatch` 都要求被适配 Mod 的版本号完全一致；Minecraft 必须是 1.21.1，NeoForge 是 21.1 线上的 21.1.217 及以上（2026-10-10 起放宽，实测用的仍是 21.1.217）。
- **清单**：支持哪些 Mod、确切版本和官方下载地址统一写在仓库根目录的 `compat.json`，网站、README 和 WebUI 的模组页都读它。改了适配里锁的版本要同步改清单，`node scripts/check-compat.mjs` 会核对（也在 `mcp-server` 的测试里）。
- **原版容器不能被接管**：原版的容器方块和菜单走内置规则，适配器不能声明它们。
- **出错就拒绝**：适配器的方法抛异常，就当作"不匹配"。如果异常发生在右键之前，就拒绝这次操作；如果发生在右键之后，回执记为 `unknown`。不会因为适配器出错而当作成功。
- **按声明判结果**：右键交互前后会各拍一次快照，包括方块、Bot 的背包、打开的菜单和附近掉落物。
  - 所有变化都在声明范围内：`succeeded`。
  - 什么都没变：`failed`。
  - 其余情况：`unknown`，AI 被要求先重新观察，不要重放。
- **id 不能重复**：容器、交互和拾取适配的 id 共用一个命名空间。先登记的优先，顺序是内置（目前只有原版堆肥桶交互）→ JSON → 附属模组，重复的会被跳过并记日志；附属模组之间重复登记，会在模组加载时直接报错。
- **登记有截止时间**：服务器启动后，附属模组就不能再登记了。

## JSON 声明

每个文件写一个对象，或一个对象数组。只要有一条写错，整个文件都会被跳过。不认识的键也算写错。

```json
{
  "id": "minecraft:respawn_anchor/charge",
  "note": "给重生锚充能；满能量时右键会在主世界爆炸，所以 charges=4 时拒绝",
  "blocks": ["minecraft:respawn_anchor"],
  "held": ["minecraft:glowstone"],
  "consume": [1, 1],
  "changes": ["charges"],
  "refuseWhen": { "charges": ["4"] }
}
```

| 键 | 必填 | 含义 |
| --- | --- | --- |
| `id` | 是 | 交互名，AI 调用时用它。命名空间不是 `minecraft` 时，这个命名空间必须写进 `requires` |
| `requires` | 非原版必填 | `{ "模组id": "确切版本" }` |
| `blocks` | 是 | 能右键的方块 id 列表 |
| `held` | 二选一 | 手持物品的 id，或 `#标签`。和 `emptyHand` 只能选一个 |
| `emptyHand` | 二选一 | `true` 表示必须空手；空手时不能消耗物品 |
| `consume` | 是 | `[最少, 最多]`，每次消耗多少个手持物品（0～64） |
| `heldDamage` | 否 | 手持工具允不允许掉耐久，默认不允许 |
| `changes` | 否 | 允许变化的方块状态名，比如 `level`、`charges` |
| `gains` | 否 | 允许新出现在背包或掉在地上的物品 id |
| `refuseWhen` | 否 | `{ "状态名": ["值", ...] }`：方块处于这些状态时直接拒绝，不右键。方块没有这个状态也拒绝 |
| `note` | 否 | 写给人看的说明 |

什么效果都不声明的交互（不消耗、不变状态、不得物品、不掉耐久）永远不会成功，所以直接拒绝加载。会把方块换成另一种方块的交互（比如往炼药锅倒水，炼药锅会变成另一种方块），JSON 表达不了，要用 Java 适配。

## 通用物品槽适配（8b）

2026-10-09 加的。很多模组机器（粉碎机、模组炉、储物方块）都通过 NeoForge 的物品槽能力（`Capabilities.ItemHandler.BLOCK`，漏斗和管道也用它）放取东西。对这类没有专门适配的方块，Bot 可以用 `machine-items` 动作直接查看、放入、取出，不开界面。细节和回执见[协议](server_body_protocol.md)。

默认关闭。服主在 `config/mcbot-server-control/item-handlers.json` 里按 mod id 开启，版本要写确切的，对不上就不开（启动日志记一条 `MCBOT adapter: ...`）：

```json
{
  "note": "粉碎机和模组炉都试过，放取正常",
  "mods": { "examplemod": "1.2.3" }
}
```

| 键 | 必填 | 含义 |
| --- | --- | --- |
| `mods` | 是 | `{ "mod id": "确切版本" }`。方块 id 的命名空间就是这里的 mod id。不能写 `minecraft` |
| `note` | 否 | 写给人看的说明 |

没有这个文件就什么都不开；写错一处（不认识的键、版本不是字符串等）整个文件跳过并记日志。开了的 Mod 列在 `hello.itemHandlerMods`，启动日志的 `MCBOT adapters: ...` 也会列出来；运行端只在有开了的 Mod 时才给 AI 发布 `machine-items` 工具。

分派顺序：原版方块只走内置规则（`open-container`、工作站工具）；有专门适配的方块（附属模组登记的 `ContainerAdapter`，比如 Iron Furnaces 的铁炉；或 `WorkstationAdapter`）用专门适配，即使它的 Mod 也开了通用适配；剩下的方块，它的 Mod 开了才用通用适配，没开就拒绝。

和其他适配一样的安全规则：Bot 要看得见、够得着这个方块；动手前像右键方块一样问服务器（出生点保护、世界边界、NeoForge 的右键方块事件，保护类模组靠取消这个事件拦人），不让用就拒绝，内容也不读。放入、取出按物品槽自己的规则来（`isItemValid`、先模拟再真放／真取），回执写实际移动的数量，部分成功不算成功；物品槽抛异常时，还没真动东西就拒绝，真动时出错记为 `unknown`。

物品槽常常分方向面：比如上面是原料、侧面是燃料、下面是成品，和漏斗、管道看到的一样。`side` 不给就用不分面的那份（大多数 Mod 给的是整台机器），`list` 会列出哪些面有物品槽。

注意：

- 实测过的例子（森罗厨房 1.6.0）：油壶不分面；石磨只有上面能放、什么面都取不出；竹筛没有不分面的，只按面给，没晒好的东西取不出。取不出但机器里有这种东西时，回执的 `withheld` 写着有几个，换个面或等做好再来。
- 通用适配不知道哪一格是原料、哪一格是成品，也不知道要烧多久；“放好就走、到时回来取”和酿造台留在 8b 的后续部分。
- 问保护模组让不让用，是真的发一次右键方块事件（不真的右键）。有的模组监听这个事件自己做事（比如右键收割），对机器一般不会，但没实测过。
- 只在离线测试里验证过，还没有在装了真实模组的服务器上跑过；开哪个 Mod 之前，服主最好自己先试一下放取。

## Java 附属模组

公开接口都在 `com.mcbot.servercontrol.api` 包里：

- `McbotApi`：负责登记（`registerContainer`、`registerInteraction`，以及下面各接口的 `register*` 和[插件说明](#插件说明registerhint) `registerHint`），提供版本检查（`modVersion`、`versionsMatch`），以及拒绝时用的 `refuse(code, message)`。拒绝码只能是 `INTERACTION_NOT_READY` 或 `UNSUPPORTED`，写别的码会按 `INTERACTION_NOT_READY` 处理。
- `ContainerAdapter`：用来接管容器和机器，要实现这些方法：
  - 识别方块（`block`），核对方块实体（`entity`）
  - 在方块自己不提供菜单时给出菜单（`provider`）
  - 识别菜单（`menu`）
  - 核对完整的槽位布局后，返回真正的存储（`storage`）
  - 给间接包装的玩家槽报出对应的背包位置（`playerSlot`）
  - 物品处理器（item handler）型的存储：槽位的 `Slot.container` 只是占位，`storage` 返回一个代表这份存储的只读对象，再用 `storageSlot` 认领它的槽，用 `storageOf` 说明它属于哪个方块实体（`discover-containers` 的目标核对要用）。例子见 SB 附属模组的 `BackpackContainerAdapter`

  Bot 只操作归属清楚的槽：`storage` 里的算容器槽，玩家背包里的算玩家槽。其余的槽标成 `unknown`，Bot 不会去点。
- `ItemInteraction`：右键交互。除了 JSON 能表达的内容，还可以：
  - 用 `summary` 读方块内部状态，比如锅里有什么
  - 用 `expectedFor(右键前的 summary)` 按当时的状态给出预期效果，比如出锅时会得到哪道菜
  - 用 `consistent` 核对前后两次快照的值。参数是完整快照，包含 `summary`、`block`、`inventory`、`menu`、`drops`
  - 用 `precondition` 在右键前检查
  - 用 `menu` 核对打开的菜单

  回执会把 `summary` 带给 AI。对时间敏感、需要连续右键的步骤（比如炒锅翻炒），AI 可以给 `interact-block` 传 `repeatUntil`，运行端会连续右键，直到 `summary` 里某个字段达到目标值。

  `kind` 为 `item` 时是对空使用物品，比如打开背包，AI 用 `use-item` 调用。手上物品会被 Mod 改写的（比如背包第一次打开时写上存储 ID），在 `Expected` 的 `heldComponents` 里列出允许变化的组件名，再在 `consistent` 里核对具体的值。

  10-08 新增两项（都有默认值，旧的适配不用改）：`sneaking()` 返回 true 时，核心按住潜行发这次右键，发完松开；`Expected` 多了 `removesBlock`（九参数构造器），为 true 时允许目标方块变成空气，用于把放着的方块捡到手上。SB 背包适配的 `sophisticatedbackpacks:backpack/take` 就是这样：空手、潜行右键放着的背包，背包连同里面的东西到手上；之后用 `equip-item` 穿上（背包穿在胸甲那一格）。
- `PickupSink`：有些 Mod 会在原版拾取之前把掉落物直接收进玩家身上的存储，并取消原版拾取（比如背包的拾取升级），这时没有原版的拾取事件。MCBOT 在拾取前后各调用一次 `stored`，读出这类存储里每种物品的数量。只有"被吃掉的那种物品在某一个存储里正好多了吃掉的数量，其他都没变"时，才把这次拾取记下来，回执里用 `storedIn` 写明去处。对不上就记为 `PICKUP_UNKNOWN`，并在拾取收据里留一个缺口。用 `McbotApi.registerPickupSink` 登记。

- `WorkstationAdapter`（`api.workstation` 包，10-07 新增，[设计](workstation_design.md)）：工作站。适配者只说明是哪个方块和界面、哪个格子是什么端口（原料、燃料、成品等）、配方从哪来、用哪种执行模板（`GRID_CRAFTER` 合成网格、`PROCESSOR` 放料→等→取的机器，目前按单原料执行，多原料机器要等具体适配，布局不支持的会拒绝；另有 `OPTION_PICKER`、`IN_PLACE`、`MODIFIER`，目前只有原版切石机、酿造台、附魔台等内置适配在用，附属模组登记这三种还不会被 produce-item／modify-item 选中）；走过去、开界面、点格子、等待和核对都由核心做。登记后 `craft-item`、`smelt-item` 会自动用上。可选的 `progress(level,pos,state)`（10-09 加，8b）不开界面读机器的内容和进度（`StationProgress`：待加工的、成品、燃料、在不在工作、还要多少 tick、燃料够多少 tick），只读，什么都不能改；实现了它，Bot 放料不等时运行端到时间能读出真实进度（还在烧就再等、没燃料就提醒），没实现就只按时间估。原版熔炉、烟熏炉、高炉已实现。原版方块只由内置适配处理，附属模组不能接管。用 `McbotApi.registerWorkstation` 登记。这个包只用原版和 JDK 类型，以后的 Fabric 版也用同一套接口。

- `EmoteSource`（10-08 新增，第 8j 步）：别的 Mod 提供的身体动画，比如玩家模型 Mod 的动作。AI 用 `emote` 工具，`source` 填来源 id、`name` 填动画名。核心先检查名字只含 `[A-Za-z0-9_.:-]`、最长 64，再问 `accepts`；开始时调 `play`，到 `seconds`（默认 6 秒，1～30）、Bot 开始做别的事（说话和转头除外）或下线时调 `stop`，因为模型动画一般会一直循环。`hint()` 是给 AI 看的一句说明，会写进 `emote` 工具的说明里。用 `McbotApi.registerEmotes` 登记。没有来源时，`emote` 只有内置的原版手势：wave、nod、shake、crouch、jump、spin。
- `AppearanceSource`（10-08 新增）：Bot 的样子，比如玩家模型 Mod 的模型。`choices` 列出服务器上可选的（只读）；托管的人在 WebUI 里选一个，运行端每次接管后用 `set-appearance` 动作套用一次（`apply`）。AI 不能改，MCP 也不发布这个动作。用 `McbotApi.registerAppearance` 登记。
- `SeatAdapter`（10-11 新增）：别的 Mod 的椅子、凳子，右键后玩家骑上一个座位实体。AI 用 `sit`／`get-up`。适配者只回答：这个方块是不是座位（`seat`）、座位上是不是已经有人（`occupied`，拿不准就答 true）、这个实体是不是该 Mod 的座位实体（`seatEntity`）。核心负责走过去、保证主手是空手（手里拿着地毯这类东西时，右键会改椅子而不是坐下）、发右键，并且只认观察到的结果：Bot 真的骑着一个 `seatEntity` 认定的实体才算坐下。原版楼梯、台阶不是座位，没有适配器就是 `NO_SEAT`。范例见森罗厨房附属模组的 `SeatAccess`（按类名认方块和实体，不用反射）。

在附属模组的构造函数里登记：

```java
@Mod("mcbot_examplecook")
public final class McbotExampleCook {
    public McbotExampleCook() {
        McbotApi.registerInteraction(new PotAddOil());   // 实现 ItemInteraction，installed() 里用 McbotApi.versionsMatch("examplecook", "1.2.3")
    }
}
```

附属模组的 `neoforge.mods.toml` 要声明依赖 `mcbot_server_control`，同时也依赖被适配的模组（可以设为可选，被适配的模组没装时，`installed()` 返回 false 就行）。编译时只需要 mcbot-server-control 的 jar（`compileOnly`）。被适配的模组建议用反射访问，不在编译期依赖它：Mod 改了类名或方法，适配器只会认不出来，不会让服务器崩溃。

参考例子：

- [mcbot-iron-furnaces](../mods/mcbot-iron-furnaces/README.md)：独立的附属模组（原先内置在核心里，现已剥离）。一个完整的 `ContainerAdapter`（`IronFurnaceAdapter`），用反射访问 Iron Furnaces，锁定 4.3.2 版。
- [mcbot-kaleidoscope-cookery](../mods/mcbot-kaleidoscope-cookery/README.md)：独立的附属模组。用森罗厨房的炒锅做菜，包括放油、加料、翻炒、出锅四个交互。
- [mcbot-sophisticated-backpacks](../mods/mcbot-sophisticated-backpacks/README.md)：独立的附属模组。打开手里的背包（对空使用）、把放在地上的背包当容器（物品处理器型存储）、拾取升级的记账（`PickupSink`）。
- [mcbot-yes-steve-model](../mods/mcbot-yes-steve-model/README.md)：独立的附属模组。YSM 的模型（`AppearanceSource`）和动画（`EmoteSource`），只执行 YSM 自己的服务端指令。

### 插件说明（registerHint）

2026-10-10 加（交付计划 6c，只做加法，`API_VERSION` 仍是 1）。附属模组可以登记一段给 AI 看的用法说明，经 `hello.hints` 下发：

```java
McbotApi.registerHint("examplecook:hint", "Wok: add oil first, then ingredients, then stir with repeatUntil ...");
```

- id 规则和其他登记一样（`命名空间:路径`，和容器、交互等共用一个 id 集合，不能重复），**同一命名空间只能登记一条**；服务器启动后冻结，再登记抛 `IllegalStateException`。命名空间要用被适配模组的 mod id（运行端靠它对应插件，`check-compat` 会查）。
- 文本：控制字符和格式字符换成空格、合并连续空格、去掉首尾空白后，不能为空，最长 `McbotApi.HINT_MAX`（600）字符，超了直接抛 `IllegalArgumentException`（加载模组时就发现）。
- 服务端只在这个命名空间下有已安装的登记项（容器、交互、工作站、表情或外观来源、拾取记账）时才下发；被适配模组没装或版本不对时不发。
- 运行端把说明当不可信文本：只收命名空间属于 `compat.json` 官方插件、且「给 AI 用」开着的；附在该插件影响到的第一个工具（`use-item`、`interact-block`、`container-menu`、`emote`）的描述末尾，前缀写明来自附属模组、只解释这些工具。它不能新增工具、参数或权限。插件不带这四个工具中的任何一个时说明不会出现。
- 只写模组里已经实现、有测试证据的用法。现有 4 个附属模组的说明写在各自的 `Mcbot*` 主类（`HINT` 常量），离线测试检查长度和控制字符。config 类插件（通用物品槽）这一轮没有说明。

## 「给 AI 用」开关

2026-10-10 加。插件可以装在游戏里给玩家自己用、但不让 AI 用：WebUI「插件」页每个已安装的插件有一个「给 AI 使用」开关，默认开启，按游戏目录存在 WebUI 自己的 `runtime/webui-plugins.json`（不写进游戏目录），**下次启动托管时生效**。关掉的插件 id 经 `start-server-play.mjs --disabled-plugins` → `mcp.json` 里运行端的参数（驱动器生成托管配置时原样保留）→ 运行端。

效果（细节见[协议](server_body_protocol.md)）：运行端注册工具前统一过滤 hello，AI 看不到这个插件带来的任何工具、参数和说明（addon 类按 `requires` 的 mod id 匹配命名空间：容器适配、交互、表情来源、插件说明；config 类去掉 `itemHandlerMods` 里的 mod）；AI 硬调时运行端返回 UNSUPPORTED，不发给服务端。服务端模组和游戏不变，玩家照常使用。关掉 YSM 只影响 AI 能不能播放 YSM 动画，外观仍由托管的人在「角色」页选。

这套对应关系依赖「附属模组登记的 id 的命名空间等于 compat.json 里它 `requires` 的 mod id」：`node scripts/check-compat.mjs` 会从源码里取出每个附属模组登记的 id（`id()` 返回的字面量或常量、带 `String id` 参数的 record 构造时的字面量、`registerHint` 的第一个参数），命名空间不在 requires 里、或写法认不出来都报错。

## 测试

- 离线：`ModAdaptersTest`（登记、合并、出错时的处理、JSON 格式、`registerHint` 的校验和 hello 的 `hints`）、运行端 `client-runtime/tests/plugins.test.mjs`（开关过滤、硬调拒绝、说明的过滤和位置）、`ItemInteractionsTest`、`GenericItemSlotsTest`（通用物品槽适配：配置、分派、方向面、放入取出、出错）。
- 铁炉附属模组的离线测试 `IronFurnaceAdapterTest` 在 `mods/mcbot-iron-furnaces`，由它自己的 `gradlew build` 运行。
- 隔离服：`scripts/server-adapter-smoke.mjs`。测试服要临时装上 Iron Furnaces 4.3.2 和 `mcbot-iron-furnaces` 附属模组，并在 `interactions/` 里放一份正确的重生锚声明和一份故意写错的声明。
- 示例附属模组：`scripts/server-cooking-smoke.mjs`（森罗厨房）、`scripts/server-backpack-smoke.mjs`（SB，开服前先运行 `scripts/server-backpack-fixture.mjs`）、`scripts/server-emote-smoke.mjs`（YSM，也测内置手势和场景提示）。

## 和其他 Mod 一起用时要注意

- 有的 Mod 会在玩家登录时给客户端发自己的网络包。Bot 没有客户端，核心会直接丢掉发给 Bot 的包，不做"客户端有没有这个频道"的检查（否则 Bot 登录会失败）。
- 像 SB 这样要求客户端也装的 Mod，没装的玩家（包括用原版协议的测试玩家）进不了服。
- 方块的 `open` 属性（木桶、背包被人打开时会变）不算目标变化，核对 `discover-containers` 的目标时会忽略它。
