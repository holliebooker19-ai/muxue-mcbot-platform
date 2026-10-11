# 工具整理方案（2026-10-11）

## 进度

- 10-11 小雪同意先做合并。已做（离线）：合并清单第 1～4、6～9、12、13 条，名字按本方案（go-to、places、blueprints、get-status include、equip-item hand main、get-up、pillar、container-menu、emote 看人）；ServerBody **68 → 49 个**。旧名字在 `tool-registry.json` 里标 `clientOnly`，只给旧 ClientBody。运行端 520 项、`mcp-server` 728 项通过（另 1 项跳过；vision 截图那项本机连不上 viewer，没改那部分）；核心 `gradlew build` 通过（坐着、睡着时的提示改成 get-up）。
- 10-12 小雪看过用法后定：第 5、10、11、14 条（read-chat、approach-container、fetch-and-give、assess-tool）都删，ServerBody **45 个**；启动提示里的“取物交还优先 fetch-and-give”改成先 container-withdraw 再 give-item。`AGENT.md` 的工具数小雪同意改成 45。
- 没做：说明瘦身（下一步）；隔离服 smoke／agent-trial 脚本里按旧名字调工具的地方（约 37 个文件，另开任务）；真实模型实测。

下面是当时的方案原文。

## 为什么要整理

- 现在 ServerBody 给模型 68 个工具（`client-runtime/tool-registry.json`）。所有能力都打开时，工具名、说明和参数加起来约 **7 万字符**（约 2 万 token），每一轮都要带给模型。有缓存时不太贵，但模型要在里面挑工具，Haiku 这类小模型更容易挑错。
- 10-06～10-11 的活动记录里一共调用了 984 次工具（`runtime/` 和绿色版 `runtime/` 里的 `activity-*.jsonl`）：
  - 用得最多：send-chat 282、get-block 89、discover-resources 75、get-operation 52、gather-resources 51。
  - **16 个一次也没用过**：assess-tool、forget-place、list-blueprints、save-blueprint、approach-container、open-container、click-slot、close-container、use-item、interact-block、use-bucket、machine-items、wake-up、fetch-and-give、produce-item、breed-animals。
  - 没用过不等于没用：繁殖、酿造、机器这些是试玩里还没测到。所以本方案按**是不是同一件事有好几个入口**来合并，不按次数删。
- 同一件事有好几个入口的例子：
  - 走路有 4 个：move-to-position、travel-to、go-to-place、approach-player。
  - 看自己的状态有 5 个：get-status、get-position、list-inventory、get-companion-mode、get-survival-state。
  - 把东西拿到手上有 3 个：select-slot、prepare-item、equip-item（副手）。

## 原则

1. **不删能力，只合并入口。** 服务端的动作名和协议都不变，核心 jar 不用改；合并只在运行端 `mcp.ts` 和 `tool-registry.json` 里做（一个工具按参数转给原来的服务端动作）。
2. 合并后的工具用一个参数区分做什么（`action`，或者给了哪组参数），说明里每种写一句。
3. 只在装了对应插件或核心声明了能力时出现的工具（sit、use-item、interact-block、machine-items 等）照旧按能力出现。
4. 说明里能交给错误信息讲的细节，移到错误信息里（模型真碰到时才看到），说明只留"什么时候用、给什么参数"。

## 合并清单

| # | 现在 | 合并成 | 少几个 |
|---|---|---|---|
| 1 | move-to-position、travel-to、go-to-place、approach-player | **go-to**：给 `x,y?,z` 走到坐标（32 格内普通走，远了自动分段走，现在已经这样转），给 `place` 去记住的地点，给 `player` 走到这位玩家身边；都可带 `meet` | 3 |
| 2 | remember-place、list-places、forget-place | **places**：`action` 是 remember／list／forget | 2 |
| 3 | list-blueprints、save-blueprint | **blueprints**：`action` 是 list／save | 1 |
| 4 | get-position、list-inventory、get-companion-mode、get-survival-state | 并进 **get-status**：默认给精简状态（位置、血、饿、手上、陪伴状态），`include` 选 inventory／survival（威胁和生存策略）等 | 4 |
| 5 | read-chat | 去掉：托管时聊天会作为事件推给模型，`wait-for-events` 也能读 | 1 |
| 6 | select-slot、prepare-item | 并进 **equip-item**：`hand:"main"` 把背包里的东西拿到主手（现在 prepare-item 做的事），盔甲、盾牌、副手照旧 | 2 |
| 7 | wake-up、stand-up | **get-up**：躺着就下床，坐着就站起来 | 1 |
| 8 | pillar-up、pillar-down | **pillar**：`up: 格数` 或 `down: true` | 1 |
| 9 | open-container、click-slot、close-container、get-container | **container-menu**：`action` 是 open／read／click／close（打开背包这类菜单时还要用） | 3 |
| 10 | approach-container | 去掉：container-list／container-withdraw 自己会走过去 | 1 |
| 11 | fetch-and-give | 去掉：用 container-withdraw 再 give-item 两步做（一次没用过） | 1 |
| 12 | follow-player | 去掉：旧的限时跟随，已经被 companion-mode follow 取代 | 1 |
| 13 | look-at | 并进 **emote**：不带动作只带 `player` 或坐标时就是转过去看 | 1 |
| 14 | assess-tool | 去掉：采集、挖方块时程序自己挑工具；一次没用过 | 1 |

合计少 23 个：**68 → 45 个**。

不动的：send-chat、wait-for-events、get-operation、stop-action、set-reflexes、defend-self、companion-mode、get-block、find-entity、look-around、discover-resources、discover-containers、dig-block、place-block、drop-item、eat-food、equip-item、sleep-in-bed、sit、emote、give-item、container-list、container-withdraw、collect-items、gather-resources、craft-item、smelt-item、produce-item、modify-item、workstation-options、tend-crops、breed-animals、hunt、build、use-item、interact-block、use-bucket、machine-items。

### 以后可以再做（要改核心）

- craft-item、smelt-item、produce-item 合成 **make-item**：给物品和数量，服务端自己挑合成台、熔炉、切石机或酿造台（workstation-options 已经知道每样东西怎么做）。再少 2 个。要改核心，等第一批试玩过再说。

## 说明瘦身

最长的几个：companion-mode 约 6000 字符、build 4400、modify-item 2700、tend-crops 2500、discover-resources 2100、save-blueprint 2100。

- companion-mode：陪挖（mining）那一大段规则移到参数说明和错误信息里；保护的细节（拉回范围、等多久）不写给模型，模型只需要知道"跟随时会自动保护，玩家不要你打就 guard:false"。
- build、modify-item、tend-crops：只留常用参数的写法，例外情况交给错误信息。
- 目标：合并加瘦身后总量从约 7 万字符降到 **4 万以内**。

## 要一起改的地方

- `client-runtime/tool-registry.json`（Codex 白名单就是它）、`mcp.ts`、运行端和 `mcp-server` 的工具测试（`tool-allowlist.test.mjs` 等）。
- 游戏说明 `scripts/agents/game-instructions.mjs` 里提到的工具名。
- 隔离服的 `*-agent-trial.mjs` 和少数直接调 MCP 工具名的 smoke 脚本（大部分 smoke 直接调服务端动作，不受影响）。
- 文档：`client-runtime/README.md`、`docs/server_body_protocol.md` 里写工具名的地方、`docs/dev.md`。
- `AGENT.md` 里写着"共 68 个"。按约定改 `AGENT.md` 要你点头。
- 已有的托管会话：续上的会话历史里有旧工具名，模型会看到新列表里没有它们。不影响使用，最多第一次调错一回；也可以合并后第一次启动换个新会话。
- 你自己的人设（`persona.md`）里如果写了工具名，要你自己改，我不碰。

## 步骤

1. 先做合并 1～14（只改运行端），离线测试全过，再用 Haiku 实测一轮常见对话：砍树、跟随、去坐标找人、给东西、开箱子、睡觉。
2. 再做说明瘦身，同样实测一轮，对比改之前同样的对话挑工具对不对。
3. make-item 等第一批试玩反馈后再定。

## 需要你定的

1. 合并清单 14 条，哪些不要。
2. 新名字（go-to、places、get-up、container-menu……）可以吗，还是保留旧名字里的一个（比如走路仍叫 travel-to）。
3. 去掉 read-chat、follow-player、assess-tool、fetch-and-give、approach-container 这 5 个，可以吗。
4. 要不要再加一个"高级工具"开关（WebUI 里默认关）：dig-block、place-block、container-menu 这些底层工具默认不给模型，开了才给。我倾向**先不加**，合并完数量已经降下来了，开关会让"为什么 Bot 不会开箱子"更难查。
