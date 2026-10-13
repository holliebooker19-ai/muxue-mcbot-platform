# 单人模式（内置服务器，开局域网）

2026-10-06 按用户确认实现：**单人世界要先「对局域网开放」，Bot 才能接管**；局域网开不开作弊都行。对应 [交付计划](delivery_plan.md) 第 2 步。

## 1. 为什么要求开局域网

单人模式的 Bot 由内置服务器（IntegratedServer）承载，玩家只装一个客户端，原存档直接能用，也不用另开 Java 进程。按 MC 1.21.1 / NeoForge 21.1.217 源码核对：

| 事实 | 出处 | 影响 |
| --- | --- | --- |
| 打开暂停界面（ESC，或窗口失焦且开着默认的「失焦暂停」）且没开局域网时，内置服务器暂停，不跑世界 tick | `Minecraft` 第 1235 行、`IntegratedServer.tickServer` | Bot 的动作冻结，但超时用的是真实时间，回来后跟随和任务会失败 |
| 开了局域网就不再暂停 | 同上 | 行为和独立服务器一样 |
| 暂停时服务器线程的任务队列照常处理 | `MinecraftServer.waitUntilNextTick` | HTTP 调用照常应答 |
| 局域网勾「允许作弊」后，所有玩家都算 OP | `PlayerList.isOp` | 原规则会拒绝 Bot |
| 内置服务器没有出生点保护 | `MinecraftServer.isUnderSpawnProtection` 默认返回 false | 放宽 OP 不会让 Bot 多出这项特权 |
| 单人没有 `/op` 命令 | `Commands` 只在独立服务器注册 | 单人里没法「明确加 OP」 |
| 配置在实例的 `config/mcbot-server-control/`，所有存档共用 | `FMLPaths.CONFIGDIR` | 要按存档区分 `worldId` |

要求开局域网，就绕开了最难的暂停问题。不开局域网也能用的「暂停处理」（暂停时中止、回来自动恢复，或者冻结计时）用户 10-13 定不做。

## 2. 规则（`HostingRules`）

- **接管、重生、动作**之前检查宿主：单人世界没开局域网 → `SINGLEPLAYER_NOT_LAN`；服务器处于暂停 → `GAME_PAUSED`（开了局域网不会出现，留作兜底）。读操作不受影响。
- **OP**：照旧拒绝 OP 身份，唯一例外是「局域网＋允许作弊」给所有人的 OP。明确列在 OP 名单里的照样拒绝；独立服务器不适用这个例外。
- **worldId**：`server.json` 的 `worldId` 写 `"auto"` 时，按存档文件夹名生成：单人是 `sp-<文件夹名>`，独立服务器是 `<文件夹名>`；只保留字母、数字、`-`、`_`（其他字符换成 `_`），最长 48 个字符。单人世界第一次生成配置时默认就是 `"auto"`；已有配置不变。（10-13：独立服务器第一次生成配置时给 `srv-` 加 8 位随机字符，不用 `"auto"`，因为独立服务器的存档文件夹几乎都叫 `world`；以前写死 `serverbody-validation`。）
- 运行端把 `SINGLEPLAYER_NOT_LAN` 翻成中文提示：「单人世界要先在游戏里按 Esc 选『对局域网开放』（作弊开不开都行），再启动 Bot」。`GAME_PAUSED` 算可恢复的错误，不会让运行端失去控制。

退出到标题后，控制桥关闭，运行端失去控制（和独立服务器停服一样）；重新进世界、开局域网后，再运行一次启动脚本。每次打开世界都会重新生成 `connection.json` 的令牌。

## 3. 玩家怎么用

1. 把 `mcbot-server-control` 放进客户端实例的 `mods`（要用的适配模组和被适配的 Mod 也放这里）。PCL2、HMCL 开了版本隔离时，实例目录是 `.minecraft/versions/<实例名>`。
2. 进单人世界，按 Esc 选「对局域网开放」（作弊随意），点「创建局域网世界」。
3. 在 WebUI 的「连接配置」选「单人 / 局域网」，点这个实例，再启动托管；先启动托管再开世界也行，托管会等到开了局域网再连上。命令行是 `node scripts/start-server-play.mjs --connection-file '<实例>/config/mcbot-server-control/connection.json' --wait`（不带 `--wait` 要先开好局域网）。

同一局域网来联机的朋友：内容 Mod（森罗厨房、背包、YSM 等）他们的客户端也要装；我们的核心和适配模组要不要装还没实测，打包演练时确认后补在这里。

## 4. 验收（2026-10-06）

**离线**：Java `HostingRulesTest` 18 项（局域网要求、暂停兜底、OP 例外的各种组合、worldId 命名）；运行端 288 项全部通过。

**实机**：用模组自带的开发客户端（`gradlew runClient`，游戏目录在 `mods/mcbot-server-control/run/client`，被 git 忽略，不动用户的启动器实例），把隔离测试服的世界复制一份进去，用 Quick Play 直接进单人世界。内置服务器没有 RCON，夹具命令通过只在 `-Dmcbot.commandFixture=<目录>` 时生效的命令文件执行（`CommandFileFixture`，独立服务器上不启用）。脚本：`node scripts/singleplayer-smoke.mjs --game-dir <run/client> --player Dev --world mcbot-sp [--cheats]`，不用模型。

| 检查 | 不开作弊 | 开作弊 |
| --- | --- | --- |
| 单人存档自动得到 `sp-mcbot-sp` | 通过 | 通过 |
| 没开局域网：拒绝接管并给出中文提示，Bot 不进世界 | 通过 | 通过 |
| `publish` 开局域网后接管成功 | 通过 | 通过（此时 Bot 按原版规则算 OP） |
| 跟随单人世界的房主、进入稳定状态、叫停 | 通过 | 通过 |

**独立服务器回归**：改动后在隔离服（新 jar 267,709 字节，开着验收夹具）重跑陪挖矩阵 24 项和手持物品 18 项，全部通过；开始前备份到 `backups/serverbody-companion-mining-20261006-072159`，结束后配置按备份字节恢复。

第一轮还试了「明确加 OP 后控制失效」，发现单人没有 `/op` 命令，这项不适用，已从脚本删掉；这条规则由离线测试和独立服务器覆盖。

## 5. 没有测的

- 真人在自己的启动器实例里装模组、开局域网：10-11 起用户在自己的实例里（局域网）连续试玩过，见[交付计划](delivery_plan.md)「10-11 试玩反馈和排期」；退出再进没有单独记录。
- 单人世界里的采集、陪挖、开箱等其他能力：动作代码和独立服务器同一套，没有逐项在单人里重跑（用户试玩里用过跟随、保护、砍树、坐下、换装备）。
- 不开局域网时的暂停处理：不做（10-13 定），Bot 直接拒绝接管。
