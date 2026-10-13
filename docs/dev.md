# 开发与验证

修改前读取根目录 `AGENT.md`。本仓库是独立整理的源码快照，原个人备份仓库、Git历史、玩家记忆、存档和运行凭据未迁入。

## 当前路径

- `client-runtime/`：共享Body契约、ServerBody／ClientBody实现、MCP工具、任务与陪伴状态。
- `mods/mcbot-server-control/`：当前主线，MC1.21.1／NeoForge21.1.217服务端身体与原生交互。
- `scripts/companion.mjs`、`scripts/driver/`、`scripts/agents/`：Claude／Codex会话驱动和事件调度。`companion.mjs` 是入口，实现按职责分在 `scripts/driver/`（各模块管什么见[状态归属](state_ownership.md)最后一节）；驱动器只能 import `scripts/` 里的模块，绿色版按 import 收集。
- 服务端、运行端、驱动器三层各管哪些状态，`runtime/` 里的文件谁写谁读，见[状态归属](state_ownership.md)。
- 长期记忆：运行端 `client-runtime/src/memory.ts`、`memory-tools.ts`（字数上限在 `client-runtime/memory-limits.json`），驱动器 `scripts/driver/memory.mjs`、`consolidation.mjs`，WebUI `scripts/webui-memory.mjs`；见[记忆方案](memory_plan.md)。
- `mcp-server/`：保留的Mineflayer实现及宿主回归；真实验证用的协议测试玩家也依赖其依赖包。它不是新ServerBody的产品依赖。
- `mods/mcbot-control/`、`mods/mcbot-server-spike/`：保留的ClientBody与早期服务端实验，不作为默认主线继续扩大。

## 离线验证

Node.js版本要求以两个包的`package.json`为准；当前验收使用Node24，Java模块使用JDK21。首次安装需要访问包源。

```pwsh
Set-Location client-runtime
npm ci
npm test
Set-Location ../mcp-server
npm ci
npm test
Set-Location ../mods/mcbot-server-control
./gradlew.bat build
Set-Location ../mcbot-yes-steve-model   # 附属模组编译时要用核心的 jar，先构建核心
./gradlew.bat build
```

`mcp-server`的不少测试直接加载`dist/`：`npm test`会先构建，单独用`node --test tests/xxx.test.mjs`跑某个文件前要先`npm run build`，否则报找不到模块，那是没构建，不是测试原本就失败。

新加 MCP 游戏工具时，要在`client-runtime/tool-registry.json`里写一条：`kind`、`needsIdle`、`moves`、`resumable`（工具在服务端用别的操作名跑时写`runsAs`，比如`go-to`远路是`travel-to`），说明见文件开头；`clientOnly`的是只给旧 ClientBody 的工具（10-11 合并工具后留下的旧名字，见[工具整理方案](tool_consolidation_plan.md)）。`mcp.ts`只注册表里有的工具，开始前的“忙不忙”统一按表检查，处理函数里不要再写`assertIdle`；Codex 白名单就是这张表。`mcp-server`的`tool-allowlist.test.mjs`核对表和实际注册的工具是否一致。

支持范围的清单是根目录的`compat.json`（网站、README、WebUI模组页都读它）；改了模组里锁的版本或jar版本号，要同步改清单，`node scripts/check-compat.mjs`核对，`mcp-server`的`npm test`也会跑。

Linux 上跑 Gradle 要用 UTF-8 locale（`LC_ALL=C.UTF-8 bash ./gradlew build`），否则 `HostingRulesTest` 里带中文的存档路径会报 `InvalidPathException`（10-10 云端复验时遇到，Windows 不受影响）。

Java检查由`controlTest`接入`check`，标准Gradle `test`任务关闭；`check`还包括`loaderNeutralCheck`：只有`build.gradle`里登记的加载器文件能用`net.neoforged`，其余代码只用原版类，为以后的Fabric版留边界（见[工作站设计](workstation_design.md)）；应查看实际检查输出，不能仅凭`test SKIPPED`断言没有检查。Linux可用`bash ./gradlew build`，但本次整理版仅在Windows复验；Windows原生窗口截图、进程控制等用例不能直接外推为云端通过。

## 接入游戏

先由服主准备获授权的MC1.21.1／NeoForge21.1.217隔离服务器，备份后安装自行构建的控制Mod；配置见模块README。控制Mod生成的`connection.json`只留本地。

日常用法是在 [本地 WebUI](#本地-webui) 的「配置」页保存配置、点「保存并启动托管」（2026-10-08 起用户自己从 WebUI 启动托管）；下面的脚本是同一件事的命令行版本。逻辑在只要 Node 的 `scripts/start-server-play.mjs`（参数是 `--connection-file`、`--agent`、`--prepare-only` 这种写法，WebUI 和绿色版都直接用它），`start-server-play.ps1` 只是把同名参数转过去：

```pwsh
node scripts/start-server-play.mjs --connection-file '<server>/config/mcbot-server-control/connection.json' --agent claude --prepare-only
./start-server-play.ps1 -ConnectionFile '<server>/config/mcbot-server-control/connection.json' -Agent codex -Effort low -PrepareOnly
./start-server-play.ps1 -ConnectionFile '<server>/config/mcbot-server-control/connection.json' -Agent codex -Effort low
./start-server-play.ps1 -ConnectionFile '<server>/config/mcbot-server-control/connection.json' -Agent claude -PrepareOnly
./start-server-play.ps1 -ConnectionFile '<server>/config/mcbot-server-control/connection.json' -Agent claude
```

当前仅支持loopback。目前只支持生存模式：单人游戏开局域网时，游戏模式请选「生存」；Bot 第一次接管（世界里还没有它的玩家存档）时服务端把它设成生存；已有存档又不是生存模式时拒绝接管（`FORBIDDEN`），不会自动切换。Agent账号由使用者在本机配置；真实模型测试前确认使用的账号，不自动切换或复制凭据。Codex可用同一入口的`-Agent codex`。不要安装spike和正式控制Mod到同一实例。

2026-10-03用户指定Claude-b；该日之后每轮真实Claude测试先问账号，不擅自回退。`-ConfigDir "$env:USERPROFILE/.claude-b"`仅选本机已有登录环境。

启动入口可选`-NodePath '<本机Node可执行文件>'`，同时用于宿主与MCP，不改变全局PATH。本机Node24.15出现过0xC0000409原生退出；本批完整实服／模型／运行端回归使用已存在的独立Node24.19通过。原因尚未定论，不能把新运行时短测通过当作历史退出根因已解决，见[第一批验收](archive/server_survival_alpha_validation.md)。

`scripts/server-*-smoke.mjs`和`*-agent-trial.mjs`是专用隔离服夹具脚本，依赖本地备份记录、端口和存档；干净clone不具备这些条件，不要直接对日常存档运行。RCON只用于夹具和独立核对，ServerBody产品路径不需要它。`MC_SERVER_DIR`可指定RCON所读的本地服务器目录。

## dsh（DeepSeek Harness）

dsh 锁定在 `0.2.0-rc.2`，装在仓库的 `runtime/dsh`（被 git 忽略，依赖约 500MB），不全局安装：

```pwsh
cd runtime/dsh
npm install --save-exact @deepseek-ai/dsh@0.2.0-rc.2
```

托管时驱动器用 `dsh --profile acp` 加生成的补丁启动它（只留游戏工具；ACP 发不了 `/compact`，补丁把 dsh 自己的自动压缩设成在 `--rotate-tokens` 触发，宿主不给 dsh 换会话），`DSH_HOME` 默认是 `runtime/dsh/home`，不写用户的 `~/.dsh`。DeepSeek 凭据由使用者用环境变量 `DEEPSEEK_API_KEY` 或 dsh 自己的凭据配置提供，仓库和脚本都不保存。启动：`./start-server-play.ps1 -Agent dsh -ConnectionFile <connection.json>`。别处的 dsh 可用 `MCBOT_DSH_BIN` 指到它的 `lib/bin.js`。

也可以直接用 DeepSeek Harness 桌面版自带的 dsh（默认装在 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，别的位置用 `MCBOT_DSH_DESKTOP` 指到安装目录）：驱动器用它的 Electron 加 `ELECTRON_RUN_AS_NODE=1` 跑 `app.asar` 里的命令行，和它自带的 `dsh.cmd` 一样。找 dsh 的顺序：`MCBOT_DSH_BIN` > `MCBOT_DSH_DESKTOP` > `runtime/dsh` 的锁定安装 > 默认位置的桌面版。想用桌面版里已经配好的 Key，就把 `DSH_HOME` 设成 `~/.dsh`；这会在 `~/.dsh/profiles` 里多一个 `acp` profile，会话也记在 `~/.dsh/sessions`，桌面版自己的 profile 不受影响。桌面版会自动升级，版本和 `0.2.0-rc.2` 不同时要重测补丁。

## 本地 WebUI

```pwsh
node scripts/webui.mjs --open      # 默认端口 8770，--port 换端口，--runtime 指定别的 runtime 目录
```

- 界面上的文字按[界面文案规范](ui_text.md)写：书面语，状态用固定词（「已安装」「未安装」，不写「已装好」「没装」）；改了界面文字运行 `node scripts/check-ui-text.mjs`，`mcp-server` 的 `npm test` 也会查。
- 页面风格参考 NapCat WebUI（渐变背景加模糊光斑、透明侧栏、胶囊顶栏和按钮、半透明毛玻璃卡片），颜色、图标、字样都是自己的，没有用它的代码和素材；有亮色、暗色和跟随系统三种主题，窄屏时侧栏变成抽屉。页面在 `scripts/webui-page.html`（单个内联 HTML，不依赖外部资源，改完要重启 WebUI）；下拉框是自己写的组件（原生 select 只当数据存着），按钮、开关、折叠区和列表都有动画，列表按 key 原地更新，不会每次刷新都重画。
- 模型列表从本机 CLI 读（`scripts/agent-models.mjs`），都不发对话消息、不消耗额度：Claude Code 用 stream-json 只发 `initialize` 控制请求（关掉 hooks、不挂 MCP 和工具），返回里有每个模型支持的思考强度；Codex 用 `codex debug models`；dsh 开一个空的 ACP 会话读 `configOptions`（第一次约 20 秒，会在 DSH_HOME 留一条空会话记录）。按 Agent 和账号目录缓存在 `runtime/webui-models.json`，1 小时内不重读，页面上可以「重新读取」。思考强度跟着选中的模型变；读不到列表时 Claude 只给 opus／sonnet／fable／haiku 这几个别名。
- 只监听 `127.0.0.1`。每次启动生成一次性令牌，终端里打印的地址带着它，打开后存进 Cookie；不带令牌、Host 不是本机地址的请求都拒绝，别的网页没法调它。
- 只读驱动器写在 `runtime/` 里的文件：心跳 `companion-<名字>.json`（在线、是否在推理）、会话 `session-<名字>.json`（上下文大小、上次请求）、活动记录 `activity-<名字>.jsonl`（游戏事件和聊天、AI 回复、工具调用、每轮开始和结束、驱动器提示；驱动器启动时超过 5MB 就轮转，运行中不轮转）。三家 Agent 都走同一个驱动器，记录格式一样。
- 页面上的「陪伴模式」「最近工具」「最近出错」是从记录里推算的。
- 「叫停」放 `companion-<名字>.halt` 标记，是急停：驱动器撤销控制、结束这一轮 Agent（对话保留，托管不退出），等玩家用名字或昵称给新任务（目前只支持 ServerBody）。游戏里说“等一下”（暂停）或“停”（取消）由运行端原地停下，Agent 和对话不断，见 `client-runtime/player-stop.json` 和[陪伴体验评审](companion_experience_review.md)第 1 条；「停止托管」放 `companion-<名字>.stop`，和 `stop-companion.ps1` 一样让驱动器退出。WebUI 不碰游戏，关掉它不影响托管。
- 「配置」页（`scripts/webui-profiles.mjs`、`scripts/webui-games.mjs`）：按档案保存启动参数，存在 `runtime/webui-profiles.json`，不进仓库。10-10 按小白的操作顺序分成标签页（第一次给朋友试玩前用户要求的，一次只看一块，信息别太密）；页面上的顺序是连接配置、角色、灵魂设置、记忆、行为、插件、高级，下面按功能写：
  1. **连接配置**：先选模式「单人 / 局域网」或「服务器」（有 `server.properties` 的目录算服务器），再从本机的游戏目录里点一个（Prism、ElyPrism、MultiMC、PolyMC 的实例，`%APPDATA%\.minecraft` 和它 `versions` 下的版本隔离目录；服务器和找不到的手动粘贴目录添加，记在 `runtime/webui-games.json`），每个显示核心模组装没装、和包里的 jar 是否逐字节相同（不同多半是旧版）、开没开过世界、世界现在开着没有（用连接文件问一次 hello）。10-10 起还读游戏版本（实例的 `mmc-pack.json`、服务器 `libraries` 里的 NeoForge、版本隔离目录的版本 json），不是 `compat.json` 的 Minecraft 版本加 NeoForge 下限以上的标「不支持的版本」、排在最后，插件页不让装；读不出版本的不拦。地址固定是本机（控制口只开在 127.0.0.1，服务器模式要在开服的那台电脑上运行；远程地址以后单独做），端口可改（写 `server.json` 的 `port`，默认 8766）。10-10 起档案只存游戏目录、模式、名字和端口，**连接文件不出现在网页上**：它在 `<游戏目录>/config/mcbot-server-control/connection.json`，模组每次开世界都换令牌重写；旧档案的 `connectionFile` 读的时候换成游戏目录。
  2. **角色**：游戏名（存在档案里，保存和启动托管时写进游戏目录的 `server.json`，只改 `username` 和 `port`，没有文件就按模组默认值建一个；模组开世界时读，世界开着要退出重进）、昵称（留空时用游戏名，不再有预设昵称）、外观卡片（YSM 模型的显示名读 `ysm.json`；世界没开时直接列 `config/yes_steve_model/custom` 里的模型，要装了 YSM 适配）。头像是像素史蒂夫（默认外观），不再用名字首字母。可导入 YSM 模型：一个 `.ysm` 文件或一个带 `ysm.json`／`main.json` 的模型文件夹，网页读成 base64 发给本机服务，写进所选游戏的 `config/yes_steve_model/custom`（要装了 YSM 插件，不覆盖同名，合计最多 64 MB，只写游戏列表里的目录）。普通皮肤（png）不做：Bot 是服务端模拟的玩家，原版客户端只显示 Mojang 皮肤服务器上签过名的皮肤（10-10 用户定先只支持 YSM）。
  3. **灵魂设置**：Agent、凭据、模型、思考强度、账号目录（新建 dsh 配置时有 `~/.dsh` 就默认用它）、人设。人设编辑的就是托管时带上的 `persona.md`，位置是 `<记忆目录>/<游戏名小写>/persona.md`（10-10 起各 Agent 一样，`start-server-play.mjs` 把 `--memory-agent <游戏名小写>` 传给驱动器；记忆目录留空时 Claude 用仓库的 `memory`，dsh、Codex 用 `runtime/<agent>-memory`）；改游戏名时把已有的人设带到新名字下。不再有写死的 `xiaoke` 目录和「填入示例」模板；说话风格放在人设里，不写死在系统指令里。长期记忆见[记忆方案](memory_plan.md)。
  4. **行为**：保护玩家（开关、用弓、举盾、范围、撤退血量，见[协议](server_body_protocol.md#保护玩家8h2026-10-08)）。
  5. **插件**（10-10，`scripts/webui-plugins.mjs`）：按 `compat.json` 把核心模组和每个适配当成插件，装进或卸出「连接配置」选中的游戏目录。状态按实际文件判断：读 `mods` 里每个 jar 的 `META-INF/neoforge.mods.toml`（只看 `[[mods]]` 段，`${file.jarVersion}` 用 MANIFEST 的版本）得到 mod id 和版本，我们自己的 jar 和包里的逐字节比，通用物品槽插件看 `item-handlers.json` 有没有这一条。一个插件 = 我们的附属 jar ＋ 被适配模组本体（确切版本）＋ 要写的配置，一起装；核心没装或是旧版时一起装上。点按钮先出计划（下载什么、放进什么、移走什么、改哪个配置，下载写文件名、大小、来源和许可证），确认后在后台执行，网页轮询进度：先下载（第三方模组只从清单里的 Modrinth 地址，大小对上才用，存进 `runtime/mod-downloads` 下次直接用），再把要换掉的旧文件和改之前的配置挪进 `<游戏目录>/mcbot-backups/<时间>/`（不删），再放新文件；中途出错就改回原样。卸载只移走我们的适配 jar 或配置条目，模组本体留着（世界里可能有它的方块）；核心本身不在这里卸。游戏或服务器开着时不改（世界开着即能问通 hello；加载中和主菜单时看有没有 `java`/`javaw` 进程的 `--gameDir` 指向该目录，服务器看命令行里的目录，见 `scripts/game-processes.mjs`；查不了进程也拒绝，下载前后各查一次）；服务器模式提醒带「客户端也要装」的模组玩家自己也要装。接口只接受游戏列表里的目录。每个已安装的插件有「给 AI 使用」开关（10-10 晚）：默认开启，按游戏目录存在 `runtime/webui-plugins.json`（不写进游戏目录，清单里删掉的插件自动失效），下次启动托管时生效；启动时启动器读当前开关，作为 `--disabled-plugins` 传给 `start-server-play.mjs`，再写进 `mcp.json` 的运行端参数，运行端注册工具前统一过滤 hello、硬调返回 UNSUPPORTED（见[协议](server_body_protocol.md)的「插件开关和插件说明」和 [Mod 适配](mod_adapters.md#给-ai-用开关)）。附属模组可用 `McbotApi.registerHint` 带给 AI 的用法说明，运行端只收开着的官方插件：托管时工具描述里只列插件名，说明随这个工具第一次调用附上（10-12）；不托管时附在对应工具的描述末尾。
  6. **记忆**（10-12，`scripts/webui-memory.mjs`）：看当前档案角色的回忆、约定和想做的事、最近几天、玩家档案、各世界现状和每天的日志（10-13 起约定、最近几天和日志按世界分开列）；只能删某段的一行或某一天的日志，删之前把原文件复制到 `runtime/memory-backup/`，删行时拿和运行端同一把写锁、核对行内容没变；不提供编辑，人设仍在「灵魂设置」里改。
  「高级」标签里有凭据、记忆目录、蓝图目录、Node 路径和会话选项；每项对应 `scripts/start-server-play.mjs` 的同名参数。托管退出后按日志区分「游戏已关闭，托管结束」「已停止」「托管异常退出」「启动失败」，不再一律显示启动失败。「保存并启动托管」用跑 WebUI 的同一个 Node 执行 `scripts/start-server-play.mjs --headless --wait --username <名字>`（10-10 起不再需要 PowerShell），脚本输出写 `runtime/webui-launch-<角色>.log`，没起来时页面显示退出码和输出。
  - **先开托管还是先开世界都行**（10-10 实测反馈：先开托管再开局域网进不来、改名没生效、死了不复活）：`--wait` 时启动脚本每 2 秒重新读连接文件，用 `respawn` 探一次能不能接管——服务端在接管前检查单人有没有开局域网、是不是暂停，死了的角色顺便原生复活，活着的回 `INVALID_ARGUMENT`。没开世界、没开局域网、暂停、世界里的名字和配置不一样时页面显示「等待中：…」，「停止托管」也能停（启动脚本看 `companion-<名字>.stop`）。能接管了才启动驱动器；驱动器带 `--reconnect`，身体断开（游戏关了、退出世界、角色死了，运行端发 `disconnect` 事件）就撤销（不让角色下线）并以退出码 75 退出，启动脚本回去等，能连上时重新启动驱动器（会话照常接着，复活过的告诉 Agent 自己死过）。一连上就断的按次数退避，最多 60 秒一次；别的退出码（停止、崩溃）直接结束。测试用环境变量 `MCBOT_WEBUI_LAUNCH_CMD`（JSON 数组）替换启动命令。
- 配置页只存路径和参数，不存凭据：Agent 用账号目录里已有的登录；档案里出现 `apiKey` 这类不认识的字段会被拒绝。连接文件只在本机读出角色、世界和地址，控制令牌不回传给网页。能从网页启动托管，就等于拿到令牌的人能用你的账号开托管，所以令牌地址不要发给别人。

## 打包绿色版

```pwsh
node scripts/package.mjs              # 输出到 output/package：mcbot-<版本>-win-x64 目录和同名 zip
node scripts/package.mjs --no-zip     # 只出目录；--skip-build 不重新编译运行端；--node 指定要打进去的 node.exe
```

- 包里有：便携 Node（`node/`，带 Node 的 LICENSE）、运行端（`client-runtime/` 的 dist 和运行依赖）、WebUI 和托管脚本（`scripts/`，从 `webui.mjs`、`start-server-play.mjs`、`companion.mjs` 按 import 自动找）、我们的 jar（`mods/`，按 `compat.json`）、`compat.json`、`LICENSE`、`NOTICE`、`CLAUDE.md`、`使用说明.txt` 和双击用的 `启动 mcbot.cmd`（用自带的 Node 开 WebUI）。不带旧的 `mcp-server`、源码和测试。
- Node 用官方 zip 版：解压到 `runtime/node-dist/node-v<版本>-win-x64`（被 git 忽略），脚本默认用版本最新的那个；安装版 Node 没有 LICENSE，会拒绝。10-10 用的是 24.21.0。
- 不联网：jar 要先用 gradle 构建好；运行依赖复制 `client-runtime/node_modules` 再 `npm prune --omit=dev`；打包前先跑 `compat.json` 核对。
- 10-10 演练（不开模型）：目录约 105 MB；复制到干净目录、PATH 里去掉系统的 Node 后，自带 Node 能开 WebUI（页面、配置列表、连接文件检查都正常），`start-server-play.mjs --prepare-only` 生成配置，用生成的 `mcp.json` 启动运行端连隔离服，`initialize`、65 个工具、`get-status` 都正常。还没测：从 WebUI 真正启动托管（要开模型）、关掉 WebUI 后托管是否继续、双击 cmd 自动开浏览器。
- 10-10 真实演练：zip 解压到带中文和空格的目录，像双击一样启动 `启动 mcbot.cmd`，自带 Node 开 WebUI；dsh（桌面版，账号目录 `~/.dsh`，DeepSeek-V41-Flash）在用户的启动器实例单人开局域网接管，9 分钟里打招呼、跟随、砍树、捡弓护卫、低血撤退都正常，关游戏后托管自己结束。演练中修了：日文系统的 tar 按 CP932 写 zip 文件名，`启动 mcbot.cmd`、`使用说明.txt` 变问号（改成 `--options hdrcharset=UTF-8`，并固定用 System32 的 tar）。还没测：关掉 WebUI 后托管是否继续。

## 单人模式实测

模组自带开发客户端，游戏目录在 `mods/mcbot-server-control/run/client`（被 git 忽略），不动启动器实例。先在 `run/client/saves/<存档>` 放一份测试世界，`run/client/options.txt` 里写 `pauseOnLostFocus:false`，然后：

```pwsh
./gradlew.bat runClient -PquickPlay=<存档> "-PcommandFixture=<run/client的绝对路径>/mcbot-fixture"
node scripts/singleplayer-smoke.mjs --game-dir '<run/client的绝对路径>' --player Dev --world <存档> [--cheats]
```

`-PcommandFixture` 打开只用于验收的命令文件夹具（内置服务器没有 RCON），独立服务器上不生效。运行时桌面会弹出游戏窗口。

## 进度与证据

当前进度和每一步的验证记录看[交付计划](delivery_plan.md)，第一次看这个仓库先读[评审入口](review_guide.md)。已完成的批次验收、旧计划和 10-03 的旧评审入口在 `archive/`。

报告证据时把三类分开：离线测试、隔离服实测（脚本驱动真实服务器，不用模型）、真实模型试玩。隔离服实测脚本是 `scripts/server-*-smoke.mjs`，要用本机的隔离服、存档备份和端口；原始日志、存档和 `output/` 不随仓库分发。已知偶发：Node 24.15 原生退出 0xC0000409（重跑通过，原因没查到，可用 `-NodePath` 换 24.19）、mcp-server 的 vision 浏览器清理测试、导航与防卫里的高处拾取那项。

隔离服实测要原版协议测试玩家时（陪挖、保护、导航与防卫等），先把核心以外的模组临时挪出 `mods`，测完放回；装着客户端模组时原版协议客户端进不了服。