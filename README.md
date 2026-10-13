# muxue-mcbot-platform

让不同的 Agent（Claude Code、Codex、DeepSeek Harness，以后加原生 API）用同一套工具，在 Minecraft 服务器里控制一个游戏伙伴。

结构是 **本机 Agent → MCP 与任务层 → 服务端 ServerBody**。玩家只开自己的 MC 客户端，Bot 不需要第二个客户端；服务器要装控制模组。

仓库里没有个人记忆、人设原文、本机登录和连接配置、存档、运行日志、第三方皮肤或整合包素材。

## 从这里开始

- [评审入口](docs/review_guide.md)：第一次看这个仓库先读这页（目标、架构取舍、进度、已知问题）
- [交付计划](docs/delivery_plan.md)：目标、现在有什么、还没解决的、下一步
- [试玩步骤](docs/survival_trial.md)
- [开发与构建](docs/dev.md)
- [ServerBody 协议](docs/server_body_protocol.md)
- [Agent 接入计划](docs/agent_integration_plan.md)
- [部署与架构取舍](docs/architecture_reassessment.md)
- [归档](docs/archive/)：已完成的批次验收、旧计划、架构评审材料

## 现在能做什么

范围：MC 1.21.1 / NeoForge 21.1.217 及以上（21.1 线，实测用 21.1.217）、独立服务器或开了局域网的单人世界（[单人模式](docs/singleplayer_design.md)）、单 Bot、本机 Agent。2026-10-05 首版受限试玩已验收（[验收记录](docs/archive/server_alpha_release_validation.md)）。

- 跟随、等待、坐下、跟随时捡指定物品、跟着玩家陪挖附近的矿；玩家走远了自己去找，看不到的玩家只告诉 AI 大致方向和距离；可以边做边聊天，游戏里说“等一下”暂停、说“停”取消
- 单格挖放、标准容器、走近取物再交还
- 有限采集：原木、矿石、石料，按方块标签认，模组的树、矿、石头也算；整棵树会垫高砍完
- 背包整理、工具选择、自动进食、原版寻路（能跳一格空隙、开关木门、在水里游上岸）、近距自卫、跟着玩家睡觉、穿护甲和副手盾牌
- 保护玩家：跟随时主动打靠近玩家的怪，近战、弓、盾，血少往玩家那边撤，不打玩家和宠物；按吩咐打猎，村庄的铁傀儡和地面近战怪可以垫高到它够不着的高度往下打
- 认出玩家的建筑：村庄、床／门／箱子旁、记下的家附近的方块不当资源，模型要挖时先提醒它“可能是建筑”，玩家明确要求才挖（提醒，不是硬拒绝）
- 长期记忆：记忆目录里有角色人设时，托管自动记日志、能记一句和查以前的事，躺床或玩家都下线时另开会话整理；约定和日志按世界分，回忆和玩家档案跨世界（[方案](docs/memory_plan.md)）
- 表情：挥手、点头、摇头、蹲起、跳、转圈和模组动画；日落、下雨、打雷时提醒 AI 随口说一句
- 托管启动时角色死了会先原生重生；WebUI 托管途中死了原地复活后自动接上，去捡死亡掉落、接上之前的跟随和保护
- 合成和烧炼；切石机、酿造台；烧东西、酿药默认放好就走，好了（或没燃料停了）通知 AI 回来取，酿药每段好了回来加下一段的料；附魔台、铁砧、砂轮、锻造台、织布机、制图台（先预览、问过玩家再做）
- 记住地点、回家，最远 2000 格分段走（地表粗路线、游泳过河）
- 建筑：按蓝图逐格放，够不着就垫高，能上楼板和屋顶，两层木屋一次盖对约 94%
- 种地：收熟的作物、捡掉落、原地补种，可以播种和用骨粉（模组作物按 `#minecraft:crops` 认）；用水桶倒水舀水、用锄头在水边开新地；喂动物繁殖
- 手持物品右键方块（`interact-block`）和对空使用（`use-item`），按登记的交互放行，内置的只有原版堆肥桶
- 内容 Mod：Iron Furnaces 普通铁炉（独立附属模组 [mcbot-iron-furnaces](mods/mcbot-iron-furnaces/README.md)）；示例附属模组：[森罗厨房](mods/mcbot-kaleidoscope-cookery/README.md)（炒锅做菜）、[Sophisticated Backpacks](mods/mcbot-sophisticated-backpacks/README.md)（打开背包、放置的背包当容器、拾取升级记账）、[Yes Steve Model](mods/mcbot-yes-steve-model/README.md)（在 WebUI 里选模型、播模型动画）。服主还能按 Mod 打开通用物品槽适配，让 Bot 不开界面放料、取成品（森罗厨房的油壶、石磨、竹筛、茶壶实测过）。别的 Mod 可以写附属模组或 JSON 声明来适配（[Mod 适配接口](docs/mod_adapters.md)）。支持的 Mod、确切版本和官方下载地址统一写在 [compat.json](compat.json)

Agent：Claude Code、Codex、DeepSeek Harness（dsh，可直接用桌面版自带的；2026-10-06 隔离服真实模型实测通过）。

还没有：发布版安装包（绿色版能打包，还没发布）、网站、自主行动、农夫乐事适配、原生 API、多版本。详见[交付计划](docs/delivery_plan.md)。

日常从本机 WebUI 启动：运行 `node scripts/webui.mjs --open`，在「配置」页保存 Agent、账号、模型、思考强度、记忆目录、保护玩家、外观等设置，一键启动托管；「监控」页看 Bot 状态、游戏聊天、AI 回复和工具调用，也能叫停（急停）或停止托管；「插件」页按 `compat.json` 安装核心模组、装卸适配（核心不在这里卸载）、开关「给 AI 使用」；「记忆」页看和删角色的记忆（[说明](docs/dev.md#本地-webui)）。命令行入口是 `scripts/start-server-play.mjs`（只要 Node；`start-server-play.ps1` 转调它），WebUI 也是调用它。ServerBody 全部能力下有 45 个游戏工具，有人设时再加记忆工具（以 `client-runtime/tool-registry.json` 为准，按服务器声明的能力裁剪），不代表所有 Mod 或服务器都能用。

## 目录

- `client-runtime/`：Body、MCP 工具、任务和陪伴状态
- `mods/mcbot-server-control/`：服务端身体：假玩家、控制租约、原生交互、Mod 适配
- `mods/mcbot-iron-furnaces/`、`mods/mcbot-kaleidoscope-cookery/`、`mods/mcbot-sophisticated-backpacks/`、`mods/mcbot-yes-steve-model/`：示例附属模组
- `scripts/companion.mjs`（入口）、`scripts/driver/`、`scripts/agents/`：Agent 会话和事件驱动（三层各管什么见[状态归属](docs/state_ownership.md)）；`scripts/start-server-play.mjs`：启动托管（只要 Node）
- `compat.json`：支持的 MC、NeoForge、Agent 和 Mod 清单；`scripts/package.mjs`：打 Windows 绿色版（[说明](docs/dev.md#打包绿色版)）
- `mcp-server/`、`bot-scripts/`：旧 Mineflayer 实现，用来对照迁移，协议测试玩家也用它
- `mods/mcbot-control/`、`mods/mcbot-server-spike/`：保留的实验（ClientBody、早期服务端原型），不是默认路线
- `docs/`：计划和协议；`docs/archive/`：验收记录和历史材料

构建依赖、启动步骤和真实测试的条件见[开发文档](docs/dev.md)。Agent 账号和服务器要自己配置，仓库不提供登录凭据和测试存档。

## 来源

整仓按 [Apache License 2.0](LICENSE) 发布（2026-10-06 定），版权声明见 [NOTICE](NOTICE)。`mcp-server/` 基于 yuniko-software/minecraft-mcp-server 扩展，保留原许可证和 NOTICE。
