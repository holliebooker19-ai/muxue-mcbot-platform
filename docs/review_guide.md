# 评审入口（2026-10-10，10-12 更新数字和现状）

写给第一次看这个仓库的评审者（人或另一个模型）。请根据代码和测试判断，不要把文档里的计划当成已经实现。旧的评审入口（10-03）在 [archive/review_guide.md](archive/review_guide.md)，只作历史参考。

10-08 外部评审（GPT）的结果和处理见[交付计划](delivery_plan.md#2026-10-08-外部评审的问题)对应段落。

## 1. 项目要做什么

让不同的 AI Agent（Claude Code、Codex、DeepSeek Harness〔dsh〕，以后加原生 API）用同一套工具，在 Minecraft 里控制一个游戏伙伴，陪真人玩家玩。用户是一个人（muxue），她在 B 站发过视频，有观众想用 dsh 版本，所以目标是做成别人也能装的测试版 v0.1。

v0.1 的范围（用户定的）：

- Agent：Claude Code、Codex、dsh 三家都能用。
- 本地 WebUI：看状态和记录、叫停、保存配置并一键启动托管。WebUI 是用户日常的主要入口。
- 陪玩能力：跟随、采集、合成烧炼、工作站、种地、睡觉、记地点、保护玩家、表情、长途行走，以及建筑（8i，10-09 做完服务端执行）。
- Mod：核心开放适配接口，自己做几个示例附属模组，其余由使用者按接口适配。
- 平台：MC 1.21.1 / NeoForge 21.1.217 及以上（21.1 线，实测用 21.1.217），独立服务器，或开了局域网的单人世界；单 Bot；Agent 在玩家本机运行。多版本、Fabric 放到 v0.1 之后。

## 2. 架构

```
本机：Agent CLI（Claude Code / Codex / dsh）
        │  MCP（stdio）
        ▼
本机：client-runtime（Node）── MCP 工具、任务状态机、陪伴模式、事件日志
        │  HTTP（只限 127.0.0.1）+ 令牌、租约
        ▼
服务器：mcbot-server-control（NeoForge 模组）── 服务端假玩家 BodyPlayer，用原版代码路径做动作
        ▲
        └─ 附属模组（森罗厨房、SB 背包、YSM）通过公开 API 登记适配

本机：scripts/companion.mjs（驱动器）── 起 Agent 会话、把游戏事件变成一轮轮对话、叫停和重启
本机：scripts/webui.mjs ── 只读驱动器写的文件，加配置页，用 scripts/start-server-play.mjs 启动托管
```

几个关键取舍（评审时请判断是否合理）：

1. **Bot 是服务端的假玩家，不是第二个客户端。** 玩家只开自己的客户端；动作走原版的玩家代码（挖掘、放置、点格子、吃东西、寻路用原版 `WalkNodeEvaluator`），尽量让 Mod 看到的是“一个普通玩家在操作”。代价：服务器必须装我们的模组；部分 Mod 假设玩家有真实网络连接（装 SB 后要用 mixin 让 Bot 跳过 NeoForge 频道检查）。
2. **具体的活交给程序，模型只做决定。** 例如“砍这棵树”是一个工具调用，找树、垫高、爬树、捡掉落都由运行端和服务端完成，结果以事件通知模型。保护玩家、自动进食、近身自卫是逐 tick 的反射，不经过模型。
3. **每个改动游戏的动作都带前置核验。** 动作参数里写明期望的方块、物品、数量、组件、容器版本，服务端对不上就拒绝；结果分 succeeded／failed／cancelled／unknown，unknown 不自动重试。
4. **控制权是独占租约。** 带代次和心跳，死亡、换维度、被叫停都会让旧租约失效；叫停走独立通道（驱动器直接 revoke），不依赖模型配合。
5. **不认识的 Mod 默认拒绝。** 适配器锁定被适配 Mod 的精确版本，版本对不上就当没装；适配器抛异常按“不匹配”或 unknown 处理。
6. **为多加载器留边界。** 核心里只有 `build.gradle` 登记的几个“加载器文件”能用 `net.neoforged`，其余只用原版类，构建时检查（`loaderNeutralCheck`）。公开 API 只用原版和 JDK 类型。
7. **私人数据不进仓库。** 人设、记忆、存档、凭据、第三方模型都不在公开仓库；驱动器从用户指定的记忆目录读人设。

## 3. 现在做到哪了

进度表见 [交付计划的进度总览](delivery_plan.md#进度总览2026-10-10)。概括：

- 已完成：Agent 接入三家、WebUI 和配置页、Mod 适配接口和三个示例模组、按标签认模组资源、合成烧炼和工作站、睡觉、地点和走门、种地养动物、保护玩家、表情和外观（8j）、托管启动时自动重生、长途走（8k：地表粗路线、游泳过河）、建筑（8i：按蓝图逐格放，放前在原版放置代码里试出能得到要求状态的点击，够不着就垫高，缺点击面就放临时靶块，从垫脚柱迈上盖好的楼板和屋顶，两层木屋 94% 一次盖对）。
- 用户已试玩八轮（Claude 六轮、dsh 两轮，另有一次 dsh 补测整棵树；模型有 Sonnet、Haiku、DeepSeek-V41-Flash），每轮的反馈都修完了（交付计划 3a～3j）；之后 10-11、10-12 又在用户自己的单人实例（局域网）试玩了几次，修复记在交付计划的「10-11 试玩反馈和排期」。Codex 只在 10-05 首版验收时跑过受控阶段，没有试玩过。
- 8b 10-09 基本做完：模组机器通用物品槽适配（`machine-items`，服主按 Mod 开启）、熔炉和酿造台放好就走到时回来取（只读 `machine-status`、运行端记账和 `machine` 事件），只有隔离服实测。
- 10-10 用户把“让别人装得上”提前：兼容清单 `compat.json`（9a，网站、README、WebUI 模组页的唯一来源，`scripts/check-compat.mjs` 核对它和代码里锁的版本）已完成，NeoForge 放宽到 21.1.217 及以上；托管启动改成只要 Node（`scripts/start-server-play.mjs`），`scripts/package.mjs` 能出 Windows 绿色版目录（自带官方 Node），还没发布。
- 10-10～10-12 又做了：WebUI 插件页（6c 的②）、陪伴状态重构（8m，四步）、工具合并（68 → 45 个）和说明瘦身、启动提示词分三层、Agent 自己压缩上下文、远处找人和跟丢自己追、游戏里叫停分暂停／取消。
- 还没做：发布绿色版（9）、网站（9b）、安装向导、农夫乐事（8c）、模组炉子沿用 smelt-item（8b 收尾）、三家回归发布（10）。

证据分三层，强弱不同，请分开看：离线测试 < 隔离服实测（脚本驱动真实服务器，不用模型）< 真实模型试玩。很多能力只有隔离服实测，没经过真实模型。

当前规模（行数，Java 行很长，行数偏少）：核心模组约 13100 行、测试 3700 行；client-runtime 约 7300 行、测试 8200 行；scripts（驱动器、WebUI、64 个隔离服实测脚本等）约 19000 行（10-12）；三个示例附属模组各 150～500 行。

## 4. 已知问题和风险

- **外部评审的 11 个问题 10-09 已修**：2026-10-08 评审发现，清单、做法和证据见[交付计划](delivery_plan.md#2026-10-08-外部评审的问题)。
- **工作站有几处比说法窄**：熔炉类（`PROCESSOR`）目前按单原料执行；附魔、铁砧“先预览、问过玩家再做”只是提示词约定，程序不验证玩家是否同意。详见[工作站设计](workstation_design.md)。
- **驱动器太大**：`scripts/companion.mjs` 约 1800 行，三家 Agent 的会话、事件调度、叫停、重启、记忆整理都在里面。
- **启动提示词**：10-12 已分三层（常驻规则约 1,100 字、玩法说明用到时才给，见[启动提示词瘦身方案](prompt_slimming_plan.md)），还没用真实模型试过。
- **工具多**：10-12 从 68 个合并到 45 个（以 `client-runtime/tool-registry.json` 去掉 `clientOnly` 为准，按服务器能力和已装适配增减），见[工具整理方案](tool_consolidation_plan.md)。小模型（Haiku、Flash）会选错工具或自己逐格探查。
- **实测靠本地夹具**：`scripts/server-*-smoke.mjs` 依赖本机的隔离服、存档备份和端口，干净 clone 跑不了；没有 CI。有几个已知的偶发失败（保护实测有一次无报错退出、导航与防卫的高处拾取偶发、Node 24.15 原生崩溃 0xC0000409；绿色版改带官方 Node 24.21.0）。
- **R6 只做了一半**：背包里无法完整编码组件的物品会降级显示，容器格子和地上物品还没有。
- **托管途中死亡**：WebUI 启动的托管（`--wait`）会原地复活后自动接上，并告诉 Agent 死因；命令行不带 `--wait` 时死后要重新启动托管（启动时会自动重生）。
- **YSM 看不到结果**：YSM 的指令不回任何消息，只能确认指令发出去了；模型和动画的样子要在客户端看。
- **多版本还没开始**：核心大量依赖原版内部实现（寻路、发包、菜单、配方、组件），NeoForge 事件（受伤、横扫、聊天、踩耕地等）在 Fabric 上要用 mixin 重做。评估见[交付计划](delivery_plan.md)末尾「多版本和发布渠道」一段。

## 5. 想请评审重点回答的问题

1. 第 2 节的取舍有没有明显错误，或者会在 v0.1 之后（多版本、Fabric、原生 API、多 Bot）卡住的地方？
2. 程序和模型的分工合适吗？工具数量和粒度对小模型是不是太重？有没有该合并或该拆开的工具？
3. 安全边界（前置核验、租约、unknown 不重试、未知 Mod 拒绝、不伤玩家和宠物的兜底）有没有漏洞，特别是并发和停止时的竞态？
4. Mod 适配接口（`com.mcbot.servercontrol.api` 和 `api.workstation`：McbotApi、ContainerAdapter、ItemInteraction、PickupSink、SeatAdapter、WorkstationAdapter、EmoteSource、AppearanceSource）是否一致、够用？以后别人写适配会不会踩坑？
5. 驱动器和提示词：`companion.mjs` 和 `startupPrompt` 应该怎么拆、怎么控制长度？
6. 测试：离线、隔离服、真实模型三层的投入比例合理吗？哪些风险目前没有任何测试覆盖？
7. 按 10-12 的排期（这批改动试玩 → 长期记忆 → 自主性 → v0.1 剩下的：网站 9b、8c、8b 收尾、回归发布 10；“在干净环境从头安装一遍”的演练跟发布一起做），顺序是否现实，有没有该先做的基础工作？

请先给总判断，再按优先级列出有证据的问题（文件和调用链、触发条件、影响、最小建议），区分“v0.1 前必须修”和“可以以后再做”。没有把握的标成待验证，不要直接建议大规模重写。

## 6. 阅读顺序

1. [交付计划](delivery_plan.md)：目标、能力表、进度总览、每步的完成标准和验证记录（大表很长，可以只看总览和各行开头）。
2. 本页第 2 节，加上 [ServerBody 协议](server_body_protocol.md)：租约、代次、动作和结果、各动作的参数和失败码。
3. [Mod 适配接口](mod_adapters.md) 和 [工作站设计](workstation_design.md)；示例模组 `mods/mcbot-*/README.md`。
4. [Agent 接入计划](agent_integration_plan.md)、[部署与架构取舍](architecture_reassessment.md)（10-06 写的，个别数字已过时）。
5. 按下面的代码链看实现。

## 7. 代码链

| 主题 | 从哪看 | 想知道的 |
| --- | --- | --- |
| Agent 会话和托管 | `scripts/companion.mjs`、`scripts/agents/`、`scripts/start-server-play.mjs`、`scripts/server-body-control.mjs` | 事件怎么变成对话轮次；叫停、重启、换会话、启动时重生是不是单一可靠的路径 |
| MCP 工具和任务 | `client-runtime/src/mcp.ts`、`gather-tasks.ts`、`tasks.ts`、`companion-mode.ts`、`survival-tasks.ts`、`survival-reflexes.ts`、`events.ts` | 写锁、子任务、反射（自动进食、自卫）和陪伴模式之间怎么让路；事件会不会漏或重复 |
| 运行端到服务端 | `client-runtime/src/server-body.ts`、`body.ts`；服务端 `ControlSession.java`、`ServerController.java` | 每个动作的参数校验、租约和代次检查、结果分类 |
| 原生动作 | `SurvivalActions.java`、`NativeNavigation.java`、`GuardCombat.java`、`FarmTask.java`、`WorkstationTask.java`、`BuildTask.java` 等 | 是否真的走原版代码路径；失败时会不会留下半完成的状态 |
| 适配接口 | `api/` 包、`ModAdapters.java`、`ItemInteractions.java`、`JsonInteractions.java`、`BodyEmotes.java`；`mods/mcbot-*` | 适配器出错时的隔离；版本锁定；登记冻结 |
| WebUI | `scripts/webui.mjs`、`webui-profiles.mjs`、`webui-page.html` | 本机令牌、Origin 检查、不回传控制令牌、不存凭据 |

## 8. 怎么跑

离线测试（需要 Node 24、JDK 21，首次要联网装依赖）：

```pwsh
Set-Location client-runtime; npm ci; npm test          # 运行端，约 540 项（10-12）
Set-Location ../mcp-server; npm ci; npm test           # 驱动器、WebUI、打包和兼容清单、旧 Mineflayer 实现，约 740 项（10-12）（vision 浏览器清理那项在干净 HEAD 上也偶发失败）
Set-Location ../mods/mcbot-server-control; ./gradlew.bat build   # 核心，含 Java 检查和 loaderNeutralCheck
Set-Location ../mcbot-yes-steve-model; ./gradlew.bat build       # 附属模组要先构建核心
```

隔离服实测和真实模型试玩需要本机的服务器、存档备份和 Agent 账号，网页评审跑不了；结果记在交付计划各行和 `docs/archive/` 里。原始日志、存档、`output/` 目录不随仓库分发。
