# mcbot-yes-steve-model

MCBOT 的示例附属模组，让 Bot 能用 [Yes Steve Model](https://modrinth.com/mod/yes-steve-model)（YSM）的模型和动画。它是 [Mod 适配接口](../../docs/mod_adapters.md) 里"外观"和"表情"两个接口的参考例子。

- **只支持** YSM `2.6.5`（NeoForge 1.21.1 版）。版本对不上时，两个功能都报告"没安装"，WebUI 不显示外观选项，AI 也看不到 YSM 动画。
- 只在服务端执行 YSM 自己给管理员的两条指令：`ysm model set <Bot> "<模型>" - true` 和 `ysm play <Bot> <动画>`。本模组不带 YSM 的任何代码、模型和素材，自身用 Apache-2.0。
- 服务器上要同时装 `mcbot-server-control`、`yes_steve_model` 和本模组。玩家的客户端装了 YSM 才看得到模型和动画。

## 能做什么

| 功能 | 谁来用 | 说明 |
| --- | --- | --- |
| 选模型（外观来源 `yes_steve_model:model`） | 托管的人，在 WebUI 配置页「角色」标签的外观里选 | 列表是服务器 `config/yes_steve_model/custom` 里的模型：单个 `.ysm` 文件（ID 带扩展名，比如 `ds_whale.ysm`）和模型文件夹（ID 是文件夹名）。每次启动托管、运行端接管身体后套用一次。AI 不能改 |
| 播动画（表情来源 `yes_steve_model:animation`） | AI，用 `emote` 工具填 `source` | 播当前模型的动画，比如表情轮盘的 `extra0`～`extra7`。按 `seconds`（默认 6 秒，1～30）后自动播 `idle` 停下；Bot 开始做别的事时也会马上停，说话和转头不打断 |

## 限制

- YSM 对这两条指令成功失败都不回话，所以只能确认指令发出去了；模型和动画的样子要在客户端上看。动画名写错时什么也不会发生。
- 不列 YSM 的内置模型和 `.zip` 模型（ID 规则没验证过），以后需要再加。
- 模型文件是谁的就按谁的授权用。很多模型不允许再分发，所以本仓库不放任何模型文件，WebUI 只列服务器上已有的。

## 构建和测试

```pwsh
cd mods/mcbot-server-control; ./gradlew.bat build    # 先构建核心，它的 jar 提供 MCBOT API
cd ../mcbot-yes-steve-model; ./gradlew.bat build     # 含离线测试 YsmCommandsTest（指令拼接、模型列表）
```

隔离服实测：服务器装上核心、YSM 2.6.5、本模组，`custom` 里放一个模型，开服后运行

```pwsh
$env:MC_SERVER_DIR = '<隔离服绝对路径>'; node scripts/server-emote-smoke.mjs --allow-fixture
```

它会核对 hello 里的手势、动画来源和模型列表，带 `--appearance` 启动运行端，再试内置手势、YSM 动画和日落、下雨的场景提示。