# mcbot-sophisticated-backpacks

MCBOT 的示例附属模组，让 Bot 能用 [Sophisticated Backpacks](https://modrinth.com/mod/sophisticated-backpacks)（精致背包）的背包。它也是 [Mod 适配接口](../../docs/mod_adapters.md) 的第二个参考例子，展示三件事：物品处理器（item handler）型容器怎么适配、对空使用物品怎么写、别的 Mod 把掉落物直接收进背包时怎么记账。

- **只支持** Sophisticated Backpacks `3.25.77`，配 Sophisticated Core `1.4.86`。版本对不上时，下面的功能都报告"没安装"，Bot 不会去用。之所以不用最新版，是因为更新的版本要求 NeoForge 21.1.229 以上，而我们实测用的是 21.1.217（MCBOT 本身 10-10 起支持 21.1.217 及以上的 NeoForge，但新版 SB 没有实测过）。
- 用反射访问背包，编译时不依赖 SB。本模组不带 SB 的任何代码和素材（SB 是 All Rights Reserved），自身用 Apache-2.0。
- 服务器上要同时装 `mcbot-server-control`、`sophisticatedbackpacks`、`sophisticatedcore` 和本模组。SB 需要客户端也装，玩家要装 SB 才能进服。

## 能做什么

| 功能 | AI 用什么 | 说明 |
| --- | --- | --- |
| 打开手里的背包 | `use-item`，交互 `sophisticatedbackpacks:backpack/open` | 背包要在快捷栏里。打开后菜单不会自动关，AI 用 `container-menu` 的 read 看、click 存取，用完 close |
| 放在地上的背包当容器 | `discover-containers`、`container-list`、`container-withdraw`；也可以用 `container-menu` 打开后逐格操作 | 和箱子用法一样。适配器 id 是 `sophisticatedbackpacks:backpack` |
| 拾取升级的记账 | 不需要额外调用 | Bot 身上的背包有拾取升级时，掉落物会被直接收进背包。回执里会写明数量进了 `storedIn: sophisticatedbackpacks:backpack/pickup`，不算进 Bot 的物品栏 |

适配器认六种背包：皮革、铜、铁、金、钻石、下界合金。实服只测了皮革背包和铁背包。

## 安全规则

- **只认拾取升级**：背包里装了别的升级（堆叠、销毁、压缩、进食、磁铁……），手持打开和放置后打开都会在右键前被拒绝（`UNSUPPORTED`），并点名是哪个升级。这些升级会改变槽位上限，或者自己挪动、销毁物品，MCBOT 没法核对结果。
- **只点归属清楚的槽**：背包的存储槽算容器槽，玩家物品栏算玩家槽。装着当前打开背包的那一格是锁定的，Bot 不会去点。升级槽不在原版槽位列表里，Bot 碰不到。
- **手上背包的变化**：第一次打开新背包时，SB 会给背包写上存储 ID，并刷新槽数和渲染缓存。只允许这几项变化，而且已有的存储 ID 绝不能变；其他任何变化都会让回执变成 `unknown`。
- **拾取按计数核实**：拾取前后各读一次 Bot 身上所有背包的物品数。只有"这种物品正好多了吃掉的那么多、其他都没变"时，才把这次拾取记到背包名下。销毁、压缩这类升级会让数量对不上，那样就不算捡到（`PICKUP_UNKNOWN`），物品栏收据里也会留一个缺口。

## 暂不支持

- Bot 自己放下或收起背包：SB 要求潜行右键，Bot 不会潜行使用物品。
- 背包里的背包、从别的玩家身上打开背包。
- 背包的设置页、过滤器、升级页。

## 构建和测试

```pwsh
cd mods/mcbot-server-control; ./gradlew.bat build          # 先构建核心，它的 jar 提供 MCBOT API
cd ../mcbot-sophisticated-backpacks; ./gradlew.bat build   # 含离线测试 BackpackRulesTest
```

隔离服实测：

1. 停服后备份存档。
2. 运行 `scripts/server-backpack-fixture.mjs`，往存档的 SB 存储里写入几只预设背包：带拾取升级的、预放了物品的、带未验证升级的。升级只能在背包界面里装，命令改不了，所以要预先写进存档。
3. 开服后运行 `scripts/server-backpack-smoke.mjs`。
4. 测完用备份还原存档。
