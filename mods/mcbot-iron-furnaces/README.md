# mcbot-iron-furnaces

MCBOT 的附属模组：让 Bot 能用 [Iron Furnaces](https://modrinth.com/mod/iron-furnaces) 的铁熔炉（`ironfurnaces:iron_furnace`）。早期这份适配写在核心模组里（`IronFurnaceAdapter`），现在拆成独立附属模组：核心只管原版，其他模组的适配都靠附属模组，接口见 [Mod 适配接口](../../docs/mod_adapters.md)。

- **只支持** Iron Furnaces `4.3.2`（NeoForge 1.21.1）。版本对不上时，适配器报告"没安装"，Bot 不会去用。
- 用类名和反射访问 Iron Furnaces，编译时不依赖它。模组里不带 Iron Furnaces 的任何代码和素材，本附属模组用 Apache-2.0。
- 服务器上同时装：`mcbot-server-control`、`ironfurnaces`、本模组。单人世界也一样，装在客户端的 mods 里。没有本模组时，核心不认识铁炉，Bot 会拒绝操作它。

## 能做什么

适配器 id 是 `ironfurnaces:iron_furnace`，是一个 `ContainerAdapter`：

| 功能 | AI 用什么 | 说明 |
| --- | --- | --- |
| 找到铁炉 | `discover-containers` | 附近的铁炉作为容器候选出现 |
| 放入原料和燃料、取出成品 | `container-menu` 打开后逐格操作，或 `container-list`、`container-withdraw` | 和原版熔炉相同的用法，菜单是铁炉自己的 55 槽菜单 |

## 安全规则

- **只认普通铁炉**：方块必须是 `ironfurnaces:iron_furnace`，方块、方块实体、菜单的类名都要和 4.3.2 一致。金、钻石等其他等级的熔炉不支持。
- **只认未点燃的普通炉子模式**：运行中（点燃）、改过类型的炉子，以及工厂、发电机、升级配置界面，都会被拒绝。
- **只点归属清楚的槽**：菜单 55 个槽里，前 19 个必须是铁炉实体自己的槽（槽位类名逐个核对），后 36 个必须是 Bot 自己物品栏的包装槽，且原索引一致；任何一项对不上，整个菜单按"不支持"处理。隐藏的工厂／升级槽不会成为任务来源。
- 原生交互仍由 Iron Furnaces 自己完成（右键打开菜单），MCBOT 不替它打开界面。

## 构建和测试

```pwsh
cd mods/mcbot-server-control; ./gradlew.bat build        # 先构建核心，它的 jar 提供 MCBOT API
cd ../mcbot-iron-furnaces; ./gradlew.bat build            # 含离线测试 IronFurnaceAdapterTest
```

隔离服实测：`scripts/server-adapter-smoke.mjs` 和 `scripts/server-body-content-smoke.mjs` 的铁炉部分，测试服 `mods` 里要同时有 `ironfurnaces` 4.3.2 和本模组的 jar。
