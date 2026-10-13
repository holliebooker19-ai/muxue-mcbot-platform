# 设计：手持物品使用（交付计划第 1 步）

2026-10-06 定稿并实现（用户确认按推荐做：内置堆肥桶测试交互、只加一个 `interact-block` 工具、森罗厨房用反射适配）。实测见 [验收记录](archive/use_item_validation.md)；实现时的调整：失败回执不带 inventory，`use-item` 只在有物品类交互时才声明。目标是给 ServerBody 加两个通用能力，为森罗物语：厨房和 Sophisticated Backpacks 的适配打底：

- **对方块使用**（`use-item-on-block`）：手持某个物品（或空手）右键某个方块，比如往炒锅里放油、加料、拿锅铲翻炒、出锅。
- **对空使用**（`use-item`）：手持物品右键空气，比如打开手里的背包。

不在这一步：右键实体（村民、动物）、按住持续使用（拉弓、举盾）、多格放置（门、床）、具体 Mod 的适配器和做菜任务（第 8 步）。

## 1. 为什么能做、难在哪

`place-block` 和 `open-container` 已经在走原版的右键数据包（`handleUseItemOn`），Mod 自己的 `useItemOn` / `useWithoutItem` 会照常触发，原版和 NeoForge 的保护事件也照常生效。所以执行路径基本现成，新东西是两件：

1. **允许做什么**：右键的效果完全由方块和手里的物品决定，同一个动作可能放料、也可能取料。比如森罗炒锅：**空手右键会把已经放进去的料取出来**，手拿锅铲是翻炒，手拿原料是加料，锅里没油时拿油是放油。所以不能像开箱子那样"找个空槽去点"，必须事先知道这次右键会发生什么。
2. **怎么确认结果**：放方块看目标格变没变就行；右键交互的效果可能在方块状态、方块实体内部、手里的物品、背包、掉落物或打开的菜单里，要逐项核对。

## 2. 规则：默认拒绝，按「交互」登记

每次调用必须带一个 **交互 ID**，例如 `kaleidoscope_cookery:pot/add_ingredient`。服务端只放行适配器登记过的交互；没登记的方块或物品在发出任何原生数据包之前就返回 `UNSUPPORTED`。

一个交互的登记内容：

| 字段 | 含义 |
| --- | --- |
| id | 交互 ID，模型和任务层用它表达意图 |
| 适用方块 | 方块 ID，加上方块状态的前置条件（例如炒锅 `has_oil=false` 才能放油） |
| 手持要求 | 指定物品、物品标签，或「必须空手」；空手只在交互明确声明时允许 |
| 前置检查 | 读方块实体的只读状态（例如炒锅状态必须是「放料」），不满足就在写入前拒绝 |
| 摘要 | 交互前后各取一次的只读摘要，例如炒锅的状态、原料数、有没有油 |
| 预期变化 | 成功时应该看到什么：方块状态哪些属性变、摘要哪些字段变、手持物品可以减少几个或掉几点耐久、可以多出哪些物品、会不会打开菜单 |

首批内置一个**原版交互**，用来在不装 Mod 的情况下做实服测试：

- `minecraft:composter/add`：拿可堆肥物品右键堆肥桶。物品必定消耗 1 个，`level` 不变或加 1（有概率，不一定加）。正好用来测「物品消耗了、方块状态可能没变」这种情况。

森罗炒锅和 SB 背包的交互在第 8 步按同样的格式登记。

## 3. 协议

`hello.capabilities` 增加 `use-item-on-block`、`use-item`，并新增 `interactions` 字段，列出当前已安装并通过版本核对的交互 ID。MCP 只发布实际可用的交互。

### use-item-on-block

`act.args`：

```
{ x, y, z, face, interaction,
  slot | emptyHand: true,
  expectedBlock, expectedProperties,
  expectedItem, expectedCount, expectedComponents,   // emptyHand 时省略
  targetToken?, timeoutMs? }
```

执行顺序：

1. 核对身份、租约、代次（沿用现有 `act`）。
2. 核对目标：已加载、普通距离和视线内、方块和属性跟 `expected*` 一致；有 `targetToken` 时再核对方块实体身份（沿用容器的做法）。
3. 查交互登记：方块、手持物品、前置检查都满足，否则 `UNSUPPORTED` / `STALE_BLOCK` / `STALE_ITEM`，不发数据包。
4. 取交互前快照：方块状态、交互摘要、完整背包（36 格，带组件）、当前菜单、目标周围 2 格内的掉落物。
5. 选槽（或换到空槽）、看向命中点、`guard`，发 `ServerboundUseItemOnPacket`（主手）。选槽和看向沿用 `place-block`。
6. 取交互后快照，按第 4 节判定结果。

### use-item

```
{ interaction, slot, expectedItem, expectedCount, expectedComponents, timeoutMs? }
```

发 `ServerboundUseItemPacket`（主手），流程同上，只是没有目标方块。首批只允许「打开物品自带菜单」这一类交互；吃东西继续用协议动作 `eat-item`（MCP 工具 `eat-food`），不并进来。打开的菜单不在已核验的菜单名单里时，立刻原生关闭，并返回 `unknown`（菜单确实打开过）。

## 4. 结果判定

沿用现有的三种状态，**unknown 一律不自动重试**：

| 状态 | 条件 |
| --- | --- |
| succeeded | 前后快照的差异全部落在「预期变化」里，而且至少出现了一项预期的变化 |
| failed | 能证明什么都没变：方块状态、摘要、整个背包、菜单、附近掉落物都和交互前一样。返回 `FORBIDDEN`（被保护拒绝）或 `NO_EFFECT` |
| unknown | 其他情况：有预期外的变化，或者原生调用中途出错。结果里带上前后快照，交给任务层和模型重新观察 |

例子：

- 往炒锅加料：原料少 1、炒锅原料数加 1 → succeeded。
- 往炒锅加料时，锅已经被别人放满：什么都没变 → failed（`NO_EFFECT`）。
- 往炒锅加料，结果背包里多出一个产物（锅其实已经做好了）→ unknown。
- 往堆肥桶放一个种子：种子少 1、`level` 没变 → succeeded（预期允许 level 不变）。

方块实体内部的摘要只能由适配器提供，通用层不去猜。适配器读不到就返回空摘要；如果这时预期变化又依赖摘要，交互在第 3 步就拒绝，不会执行了再说不知道。

## 5. 安全

- 默认拒绝：没有适配器、Mod 版本不对、交互没登记，一律 `UNSUPPORTED`，不发数据包。
- 空手只在交互声明「必须空手」时允许，绝不当成「没有物品就空手试试」的回退。
- 每次只发一个数据包，不连点。去重沿用 `operationId`，unknown 不重放。
- 保护、距离、视线、生存模式规则跟 `place-block` 一样，原版和 NeoForge 的取消事件照常生效。
- 叫停：发包前检查代次；发包之后结果已经产生，叫停不回滚，只影响后续。
- 用户登记过的区域和建筑：ServerBody 现在**没有**这类保护（那是旧 Mineflayer 版的功能）。首批靠「交互默认拒绝」兜底，区域保护的迁移另外排期。

## 6. 适配器接口（首批，放在核心模组里）

先放在 `mcbot-server-control` 内部，第 7 步（R5）再拆成可以独立打包的附属模组和 JSON 配置。10-06 已完成：交互接口移到公开包 `com.mcbot.servercontrol.api.ItemInteraction`，见 [Mod 适配接口](mod_adapters.md)。

```java
interface InteractionAdapter {
    String modId();
    boolean installed();                      // 核对 Mod 版本、MC 版本、加载器版本
    List<Interaction> interactions();
}
record Interaction(
    String id,
    Predicate<BlockState> block,              // use-item 时为 null
    HeldRequirement held,                     // 物品/标签/必须空手
    Precondition precondition,                // 读方块实体，只读
    Summary summary,                          // 交互前后各调用一次
    ExpectedChange expected) {}
```

- 原版堆肥桶作为第一个实现，不依赖任何 Mod。
- 森罗厨房：它有公开的 `api/blockentity` 接口（`IPot.getStatus()` 等，状态是放料、烹饪中、完成、烧糊四种）。首批沿用 Iron Furnaces 的做法：用反射调用、锁定版本、出错就拒绝，不加编译期依赖。
- 版本锁定：适配器只在核对过的那个 Mod 版本上生效；用户升级了 Mod 就拒绝，不硬上。

## 7. Node 和 MCP

- 只加 **1 个 MCP 工具** `interact-block`，参数是交互 ID、目标方块、用哪个物品。工具描述里列出当前可用的交互。`use-item` 不直接给模型用，由第 8 步的背包任务在内部调用（实际做成了模型工具，见下面第 5 条）。
- 工具从 39 个变成 40 个（当时；10-12 合并后共 45 个），描述尽量短；具体交互的说明放在交互登记里，不写进工具描述。
- 任务层在发起前先读一次观察，按交互的手持要求挑选物品槽，不让模型自己算槽位。
- 「盯着翻炒时机」这类连续玩法属于第 8 步的做菜任务，由程序循环执行，不逐次唤醒模型。

## 8. 测试

**离线（Java）**

- 判定函数：succeeded / failed / unknown 的各种前后快照组合，包括「物品消耗了但状态没变」「多出预期外的物品」「打开了菜单」。
- 登记规则：没登记、版本不对、空手但没声明、前置检查不满足，都在发包前拒绝。
- 用一个假的适配器测完整流程和叫停时机。

**离线（Node）**

- 按 capabilities 和 interactions 裁剪工具；参数映射；unknown 不重试；叫停期间的回执。

**实服（隔离测试服，开始前确认 CPU 和内存）**

1. 堆肥桶：放 10 次可堆肥物品，每次都是 succeeded，`level` 变化和物品消耗对得上。
2. 拿物品右键箱子（没登记）：返回 `UNSUPPORTED`，箱子没打开，物品没变。
3. 用现有测试夹具 `ValidationProtection`（放钻石块当标记，取消右键事件）保护堆肥桶，再右键：返回 failed（`FORBIDDEN`），什么都没变。
4. 执行中叫停：发包前叫停 → 不执行；发包后叫停 → 结果照常回报。
5. `use-item` 的实服测试等第 8 步装上 SB 背包再做；首批只做离线测试。（10-06 已用 SB 背包实服验收，见 [SB 附属模组](../mods/mcbot-sophisticated-backpacks/README.md)。实际做法和这里不同：`use-item` 也做成了 MCP 工具，只在装了对空使用的交互时发布，因为背包打开后由 AI 自己存取，10-12 起用 `container-menu`，当时是 `get-container`、`click-slot`。）

## 9. 要确认的事

1. 首批用原版堆肥桶做内置测试交互，可以吗？
2. MCP 只加一个 `interact-block` 工具，交互用 ID 区分。这样上下文开销最小，但模型要从列表里选交互 ID。另一种做法是每个 Mod 给一个高层工具（比如 `cook-dish`），模型用起来更直观，但工具数会随 Mod 增加。建议首批先用通用工具，做菜任务在第 8 步再加高层工具。
3. 森罗厨房先用反射调用（不加编译期依赖），还是直接依赖它公开的 API jar？反射和 Iron Furnaces 一致、不用分发它的 jar；直接依赖写起来更清楚，但构建时要下载它。建议首批用反射。
