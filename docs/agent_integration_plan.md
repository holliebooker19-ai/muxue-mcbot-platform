# MCBOT 多 Agent 与原生 API 接入计划

> **2026-10-08 状态说明**：本文的进度描述停在 10-03～10-06，已过时。之后：R7 统一 Agent 适配接口 10-06 完成（第 4 步）；dsh 走 ACP 接入、10-06 隔离服真实模型通过，之后试玩两轮（第 5 步）；v0.1 只做 Claude Code、Codex、dsh 三家，Antigravity 和原生 API 不在 v0.1 范围里（原生 API 列在 v0.1 之后）。本文保留的是接入方式的调研和取舍理由；当前进度看[评审入口](review_guide.md)和[交付计划](delivery_plan.md)。10-12 补：正文里的“39 工具”“持续陪挖与建筑仍待实现”“游戏端 follow-companion”“`companion --body server` 已接 Claude／Codex”都是当时的说法——现在 ServerBody 合并后 45 个工具，持续陪挖和建筑（8i）已做，`follow-companion` 已由服务端姿态取代，dsh 也接上了 ServerBody 托管。

2026-10-03 进度核对。Codex V0 已实现并完成首轮试玩；ServerBody 上本机 Claude／Codex 的 C 验收也已完成。最终通用接入层、其他新增 Agent 和原生 API 通道尚未完成。与 [通用适配主计划](archive/platform_compat_plan.md) 一起作为架构方向，近期顺序以 [交付清单](delivery_plan.md) 为准。

**最新部署约束：Agent默认在用户本机运行；另一台Agent主机是保留的设计目标，异机安全传输与部署尚未交付。保留Claude Code账号环境，模型凭据不交给MC服务器；本机避免额外完整MC客户端，服务端正常成本可接受。C与真人体验已完成；10月3日Claude-b与Codex均实际跑通取物和持续陪伴新接口，见[本批记录](archive/server_companion_validation.md)。**

真实 Claude 测试账号遵守[开发手册](dev.md#接入游戏)：2026-10-03 用户指定 Claude-b，之后每轮测试前先询问；历史 `<selected-claude-config>` 实测不代表持续授权。玩法与数量决策遵守[交付清单](delivery_plan.md)：持续跟随／等待、Agent决定省略的有限目标数量、实际堆叠上限及有限采集首批已交付；持续陪挖与建筑仍待实现。随后[跟随拾取批次](archive/server_escort_validation.md)由Claude-b／Codex分别完成真实5阶段，Codex新增三个采集工具的短回归也已补；持续陪挖仍待实现。

## 1. 用户要求与现状

2026-10-03 评审后的 ServerBody Claude 启动策略已收窄为仅游戏 MCP 工具，禁止通用宿主读写／执行，并使旧宽权限会话失效；旧身体策略尚未迁移。详细验证范围见[边界修复记录](archive/boundary_review_fixes.md)。此修复不等于 R7 的统一 Agent 会话及公共工具执行入口已经交付。

后续[真实Claude-b混合回归](archive/server_mixed_validation.md)10阶段通过，包含收窄权限后的取物交还、忙时独立叫停及受控Agent强杀后首个新任务；未以这次Claude结果替代新的Codex/API回归或真实模型网络失联专项。

用户要求支持不同 Agent，并提供原生 API Key 接入通道。明确举例：

1. [DeepSeek 官方 deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，用户已确认具体项目。
2. Codex。
3. Antigravity。

上述三项是需要适配的 Agent 产品；API Key 直连是另一条独立渠道。接入 DeepSeek Harness 与直接调用 DeepSeek 模型 API 不是同一件事，应分别提供并验收。

当前代码事实：

- `scripts/companion.mjs` 和 `start-companion.ps1` 已接受 `gemini`／`claude`／`codex`。Claude／agy 的命令与消息转换位于 `scripts/agents/process-protocols.mjs`；Codex 的握手、线程、回合、取消与配置适配位于 `scripts/agents/codex-app-server.mjs`。驱动器消费统一事件；进程生命周期、MCP 和身体仍有耦合，尚不是最终完整 AgentAdapter。Codex 首轮真实试玩已完成，最新快捷停止和首次交还修复待复验，见 [试玩说明](archive/codex_v0.md)。
- 当前存在 MCP 工具服务，但“能配置 MCP 工具”不等于已经完成自动事件唤醒、会话恢复、中断、错误处理等托管适配。
- 旧身体层直接依赖Mineflayer；`client-runtime/`已实现ClientBody v1与ServerBody v2，共用Body／MCP边界。ServerBody完整能力集现为39工具（此前33工具＋5生存／工具／进食入口＋defend-self）；游戏端follow-companion、approach-resource及pickup-item供任务层内部调用，不要求模型逐步操作。新生存工具已有Claude实际模型证据，Codex本批仅同步允许列表并通过宿主检查，实际短回归仍待完成。长期记忆10-12已搬到运行端（见[memory_plan.md](memory_plan.md)），三家Agent共用一份；不把测试观察者的Mineflayer依赖当产品依赖。
- `companion --body server`已接Claude／Codex，独立watch／revoke不等待模型或MCP journal。C已通过；10月3日早一批Sonnet5.5／low实测见[真实体验](archive/server_agent_interaction_trial_2026-10-03.md)，最新Claude-b／Codex分别通过取物、持续跟随、聊天、等待、叫停和新查询，见[持续陪伴记录](archive/server_companion_validation.md)。这些是功能及单轮耗时样本，性能结论不外推。
- 不把现有 `gemini` 名称同时当成 Agent 产品、模型供应商、人物身份和游戏用户名。

## 2. 相互独立的选择

| 配置维度 | 例子 | 负责什么 |
| --- | --- | --- |
| Agent runtime | DeepSeek Harness、Codex、Antigravity、MCBOT Native Runtime | 推理与工具调用循环、会话运行 |
| 模型供应商／协议 | DeepSeek API、其他明确适配的 API | 请求与响应格式、模型功能、认证 |
| 身体后端 | ServerBody（当前主线）、ClientBody、MineflayerBody | 游戏观察和动作；不决定 Agent 所在机器 |
| Agent 所在机器 | 用户本机（默认）、用户选择的独立设备 | CLI／工具循环、模型认证、MCP 和记忆；不自动复制登录凭据 |
| 人物身份 | botId、personaId、memoryScope | 人设、关系、长期记忆归属 |
| 游戏环境 | 账号、实例、服务器配置、worldId | 登录、游戏版本、世界数据隔离 |

维度独立不代表每个 Agent 都允许任意模型供应商。具体组合受其实际接口与认证支持限制；由各适配器报告。更换 Agent 不要求更换身体或人设，更换身体不要求更换模型。

## 3. 接入结构

```text
外部 Agent 路线                         原生 API 路线
DeepSeek Harness / Codex / Antigravity   MCBOT Native Runtime
          │ AgentAdapter                        │ ProviderAdapter → 模型 API
          │ MCP 或经验证的原生工具桥              │ 工具调用循环
          └──────────────┬────────────────────────┘
                        ▼
              MCBOT 统一工具与事件边界
              记忆、能力目录、任务与权限仲裁
                        │
                   Body 契约
                        ├─ ServerBody（当前独服主线，无额外客户端）
                        ├─ ClientBody（可选原型）
                        └─ MineflayerBody（兼容环境）
```

MCP 是对外工具接口之一，不承担所有 Agent 的进程与会话管理。底层工具定义、校验、执行策略和结构化结果只有一套；外部 MCP 和内置 API runtime 都进入同一边界，不另建能绕过保护的执行路径。

运行时一次只由一个 Agent 拥有某个 Bot 的动作控制权。支持多个可选 Agent，不自动意味着同时让多个 Agent 驱动同一个身体。

## 4. 外部 Agent 适配

### 接入等级

- **工具接入**：用户在 Agent 中配置 MCBOT 工具，主动发起陪玩请求。
- **托管接入**：MCBOT 可以启动／连接会话、投递游戏事件、观察回合完成、请求中断、处理认证错误并恢复运行。

两级单独声明和测试。某产品支持 MCP，不能据此宣称托管陪玩已完成。若指定版本没有可用的会话控制接口，应明确限制并通过适配插件研究补齐，不用 UI 点击自动化冒充稳定协议。

### 首批目标与候选接法

| Agent | 候选接入方式 | 必须完成的验证 |
| --- | --- | --- |
| DeepSeek Harness（dsh） | 官方 SDK／JSON-RPC 控制会话，官方插件工具扩展连接 MCBOT；可用 MCP 桥接能力按选定版本核查 | Windows 启动、工具注入、事件、回合完成、取消与恢复；冻结开发者预览版本及配置 |
| Codex | MCP 提供游戏工具；托管优先评估官方 app-server 的会话、事件和中断接口 | 所选 Codex 版本及登录方式、工具权限、事件解析、恢复与中断；不混用其他 CLI 的 JSON 格式 |
| Antigravity | 官方 MCP 接入；托管评估其 SDK 或 CLI 的受支持控制接口 | 当前安装版本与接口、会话／事件／取消语义；现有 agy 代码作为迁移输入，不能当作新版保证 |
| Claude Code（保留） | 将现有托管逻辑封装为适配器 | 保持当前陪玩流程，逐步移除核心中的 Claude 专用分支 |

候选名称是设计标识，不是已经实现的类或可用配置项。上述产品的账号由各自受支持的认证流程管理，不能假定订阅登录凭据可直接用于通用模型 API。

### dsh 调研（2026-10-06）

锁定 `@deepseek-ai/dsh@0.2.0-rc.2`（npm 的 latest／next），装在 `runtime/dsh`（被 git 忽略），`DSH_HOME` 指到 `runtime/dsh/home`，不写用户的 `~/.dsh`。两条接法：

| | ACP（`dsh --profile acp`） | dsh 插件（Cordis 插件，跑在 dsh Web 宿主里） |
| --- | --- | --- |
| 协议 | 标准 ACP v1，stdio JSON-RPC；官方说明不加私有方法 | dsh 内部插件 API（开发者预览，会有不兼容改动） |
| 挂工具 | `session/new` 直接带我们的 stdio MCP 声明 | `dsh-mcp-client` 插件配置，或插件自己注册工具 |
| 游戏事件唤醒 | 驱动器调用 `session/prompt`（一次一条，AI 空闲后才返回，即回合结束） | 插件用 `sessionController.resolveAgent` 找到会话，`agent.followup()` 投递消息（`dsh-schedule` 就是这么做的） |
| 叫停 | `session/cancel` | 插件调内部接口 |
| 恢复 | `session/resume`、`session/list` | 宿主自己管理 |
| 界面 | 无界面，由我们的 WebUI 展示 | 用户在 dsh 自带网页里看对话 |
| 和现有驱动器 | 和 Codex app-server 同一类，直接成为第三个适配器 | 驱动器的批处理、叫停、换会话等逻辑要在插件里另写一份 |

实测（不带 Key）：`initialize` 返回协议 1、支持 HTTP MCP、会话 close/list/resume；`session/new` 返回会话 id 以及可选模型（deepseek-v4-flash、DeepSeek-V4-Pro 等）和思考档位（off/low/high/max）。还没验证：真实 `session/prompt`（要 DeepSeek Key）、把 dsh 自带的 bash/pwsh/文件工具关掉只留游戏工具。

**2026-10-06 实现（R7＋ACP 适配器，离线）**：

- 驱动器 `scripts/companion.mjs` 不再按 Agent 名字分支，全部改读 `scripts/agents/process-protocols.mjs` 里的描述字段：支持的身体、默认角色名和昵称、账号目录环境变量、身份（读小克记忆还是独立身份）、系统指令、托管 MCP 配置、环境变量调整、ServerBody 工具策略。新增一个 Agent 只需在那里注册一个描述和一个适配器。
- 游戏陪玩的系统指令抽成 `scripts/agents/game-instructions.mjs`，Codex 和 dsh 共用同一份。
- `scripts/agents/dsh-acp.mjs`：dsh 走 ACP，接口和 Codex 一样（start / sendTurn / handleMessage / interrupt / dispose）。启动时生成 profile 补丁，关掉命令行、文件、联网、子代理、技能、工作流等，只留 `minecraft` MCP 工具，并把人设换成陪玩指令；权限请求只批准 `mcp__minecraft__` 开头的工具。思考档位 low/medium/high/xhigh 对应 dsh 的 low/high/high/max，默认 low。`DSH_HOME` 默认在 `runtime/dsh/home`。
- dsh 只接 ServerBody，是独立试玩身份（不读小克的人设和记忆）。`start-server-play.ps1 -Agent dsh` 可用。
- 测试：新增 `dsh-adapter.test.mjs` 7 项；`server-driver.test.mjs` 的端到端流程（启动、快速回复、出错通知、叫停、带新任务重连）对 dsh 跑通，和 Claude、Codex 同一套。
- 同日补上：可以直接用 DeepSeek Harness 桌面版自带的 dsh（`MCBOT_DSH_DESKTOP`，或默认安装位置），用桌面版里配好的 Key 时把 `DSH_HOME` 设成 `~/.dsh`。隔离服真实模型实测通过，见 [dsh 实测记录](archive/dsh_validation.md)。

### AgentAdapter 最小契约

- 连接与健康：启动／附着／关闭、版本、运行能力与认证状态。
- 会话：创建、继续、输入事件／用户消息、回合 ID、忙闲状态。
- 输出：文本增量、工具活动、回合终态、错误及可用时的用量。用量未知不能计为零。
- 中断：请求取消、等待终态；即使 Agent 不能立即终止推理，核心也能撤销其游戏动作授权。
- 工具绑定：MCP 或专用工具桥，使用同一能力目录和权限配置。
- 能力声明：是否支持流式输出、图片、恢复、外部事件、回合中断等；缺项明确降级或拒绝，不静默丢弃。

会话 ID 只在同一 runtime／账号／实例作用域内有效。更换 Agent 时，撤销旧控制权，重新建立会话并读取授权的人设、长期记忆、任务摘要及当前游戏状态；不承诺迁移厂商内部上下文或恢复原生会话 ID。

MCBOT 核心与身体应具有独立生命周期。Agent 轮换和模型请求失败，不应必然让 Bot 退出游戏；失控时按策略停动作。实时停止和本能行为不等待模型响应。当前 MCP 随 CLI 重启的耦合是待迁移项。

### 按任务选择思考档位（2026-10-02 新增设计，自动模式未实现）

现有 `--effort` 是启动时固定值，不是任务自动路由。Codex 虽然在每个 `turn/start` 请求里发送 effort，当前所有回合仍复用同一个设置。本轮先将 Codex 默认设为 `low`；显式指定的 `medium`／`high` 等档位继续优先生效，Claude／agy 的原有默认值不变。

后续由宿主的任务策略选择档位，AgentAdapter 负责映射到对应产品的能力：

| 任务阶段 | 默认策略 | 说明 |
| --- | --- | --- |
| 停止、避险、本能反应 | 程序直接处理 | 不等待模型，不因复杂度分类而推迟停止 |
| 日常聊天、状态查询、明确的单步动作、执行已确认计划 | low | 已有路径跟随与动作执行由身体负责，不需要模型逐 tick 思考 |
| 多步骤目标分解、材料与顺序规划、需要分析原因的失败 | medium | 只提升规划／诊断阶段；不能把暂时寻路失败当作升档并重做动作的理由 |
| 约束很多的建造／机器规划、medium 仍无法解决的推理问题 | 按需 high | 有升级原因与预算上限；不是整场陪玩长期高档 |

最小实现顺序：先让 `sendTurn(text, { effort })` 接受逐轮选项，并由适配器报告支持的档位及能否逐轮切换；再增加独立的自动模式。用户固定指定 `--effort low` 时保持低档，不擅自自动升级。Codex 可使用逐轮字段；Claude／agy 当前启动参数的方式不能直接假定支持热切换。

路由依据结构化任务类型、当前是规划还是执行阶段、已知失败类别和明确的升级请求。分类不确定时保留 low；不因为聊天提到“别墅”等关键词就自动 high，也不为每句聊天额外调用一个分类模型。升级只发起新的规划步骤，先核对已有动作结果，不重放已提交的挖放／物品操作。

日志记录任务类别、档位、选择原因，以及事件排队、首个响应、工具执行、整轮完成的耗时。分别比较同类任务在不同档位下的体验；当前约 40 秒是端到端回合时长，不是 TPS 测量，不能直接归因于输出速度或思考强度。本设计暂不引入自动更换模型／供应商。

## 5. 原生 API Key 路线

用户选择 MCBOT Native Runtime，配置供应商、模型、接口协议、端点和凭据引用即可使用；不要求先安装任何外部编码 Agent。首个明确目标是 DeepSeek 原生 API，其他供应商通过 ProviderAdapter 扩展。

MCBOT 在该路线承担完整的最小 Agent 循环：

1. 根据人设、记忆、任务和游戏事件构造上下文。
2. 调用模型并接收文本／工具调用，校验名称、参数、权限和调用 ID。
3. 经统一工具边界执行，并将结构化结果交还模型，继续到本轮结束。
4. 处理多步调用、流式中断、错误恢复、上下文整理、预算和最大循环次数。

“换 baseURL”不能代替 ProviderAdapter。Chat Completions、Responses 和其他协议分别适配；工具调用 ID、流式片段、图片、结构化参数、推理相关协议字段、错误和用量都要按对应供应商规则处理。先支持验证过的模型能力组合，不硬编码“某品牌所有模型都能看图／调用工具”。

模型请求的可重试错误与游戏动作重放分开处理。API 超时、限流或网络断开后，先核对已执行操作；不能整轮重试造成重复挖放或投料。凭据无效和额度不足应停止无意义重试并报告。

连接资料分离 runtime、provider、model、baseURL、protocol、credentialRef、请求预算及能力选项。密钥通过本机凭据存储或环境变量引用读取，不作为工具参数、游戏聊天、记忆或导出资料的一部分；切换端点不自动把已有 Key 发给另一域名。

API 消费记录独立于外部 Agent 订阅状态；不同通道的用量与费用不能混算。此阶段不要求用户提供 Key，也不进行付费 API 调用。

## 6. 核心与依赖约束

- 核心公共接口和数据不引入 `mineflayer`／`minecraft-data` 类型。相关依赖局限于 Mineflayer 后端或其专属渲染等组件。
- ClientBody／候选 ServerBody 路线必须能在不安装、不加载、不启动 Mineflayer 的部署中完成基础闭环。若开发仓库暂时共用依赖，不能把它当成最终运行时依赖设计。
- AgentAdapter 不 import 任一具体 Body；Mod 适配器不 import 某个 Agent SDK。组合由显式配置选择。
- 原生 API 工具调用不依赖 MCP 的文本返回值来判断成败。MCP 和内部调用共享类型化结果与权限策略。
- 接口面向能力差异，避免只把现有 Claude／agy 的字段改名后强加给所有 Agent。
- 人设和长期记忆由项目统一管理，外部 Agent 的内部历史保留在其作用域；同一 Bot 不因切换供应商创建另一份不一致的世界记忆。
- 日常陪玩只开放所需游戏能力，开发文件工具与普通玩家聊天分开授权；外部 Harness 本身的权限仍须由其配置约束。

## 7. 实施与验收

本节描述Agent通道依赖，全项目排期以[交付清单](delivery_plan.md)为准。A／B／C、持续陪伴、有限采集及跟随拾取首批已通过，Claude-b／Codex最新真实短回归均有证据。下一步持续陪挖与小型建筑。V2其他Agent／原生API保留，各通道独立验收。

1. **复用并补齐公共工具／事件边界**：保留已抽取的 Claude／agy 协议和 Codex V0，按 ServerBody 最小接线补观察来源、角色生命周期、会话范围与工具能力。先用假 Agent 和真实 Body 验证事件投递、忙闲、取消与断线；不重建全套框架。
2. **本机 Claude 完成新身体闭环，再复验 Codex**：宿主直接停止不等待模型；重启不让角色重复生成或执行旧任务。仅放开 Claude 启动参数不算验收。原版独服先试玩，内容 Mod 按对应样本验收；单机／异机有各自部署检查。
3. **V2 两种新渠道各贯通一条闭环**：DeepSeek 官方 Harness 与原生 DeepSeek API 分别实现和验证；再验新版 Antigravity 托管。它们调用同一组查询、动作与停止工具，不互为必需依赖。先模拟协议，实际 API 联调需要用户配置有效凭据。
4. **跨 Agent／部署联合验收**：同一任务可更换 Agent，Agent 默认本机、可选异机；适配器不依赖 Mineflayer。切换控制权需旧任务失效，且人物、世界记忆连续；记录具体 Agent 版本与能力限制。
5. **公开扩展契约**：提供 AgentAdapter、ProviderAdapter、工具桥示例与测试夹具，允许新增其他 Agent 和原生 API 供应商。

必要场景：聊天与移动、事件唤醒、多个工具调用、停止／取消、旧会话迟到请求、重复事件、断线重连、认证失效、API 限流、模型不支持图片或工具、预算耗尽、Agent 崩溃。工具成功与回合成功分别记录。

不以“能输出一句话”代替 Agent 适配验收，也不以“能列出 MCP 工具”代替托管陪玩成功。Agent 层可以先用假 Body／现有身体验证，不必等待完整新身体完成。

## 8. 官方依据与限制

以下于 2026-10-02 查阅，只确立接入候选，不代表 MCBOT 已完成联调：

- [DeepSeek Harness 仓库](https://github.com/deepseek-ai/deepseek-harness)：官方开源 Harness，处于开发者预览；按选定版本维护适配。
- [DeepSeek Harness Python SDK](https://deepseek-harness.github.io/deepseek-harness/en/guide/python-sdk)与[插件开发](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/)：提供运行与扩展入口；具体 profile 的工具、权限和会话行为必须实测。
- [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)：原生 API 工具循环的供应商依据；与使用官方 Harness 分开。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：官方会话、事件与中断接口，是托管接入候选。
- [Antigravity MCP](https://antigravity.google/docs/mcp)：支持 MCP 工具配置；托管生命周期另验 SDK／CLI 接口。

目前已完成现有 CLI 协议抽取和 Codex V0 托管实现，并按用户授权开始真实模型及测试服试玩；自动进服、聊天和状态查询已有实际证据，完整行为验收仍在进行，见 `delivery_plan.md`。未安装新 SDK、修改全局 Agent 配置或读取密钥。按任务自动分配思考档位仍处于设计阶段。
