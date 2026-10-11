# 启动提示词瘦身方案（2026-10-12 草案）

用户 10-12 提出：启动提示词要瘦身，参考 skill 的思路，平时只给常用的规则，专门玩法的规则用到时再给。瘦身做完后和前面的改动一起打包测一次。

## 进度

- 10-12 用户定第 8 节三件事：玩法说明自动附在第一次用到的结果和事件里；压缩后再给一次；Claude 拿不到常驻规则的错误一起改。
- 10-12 已做（离线）：
  - 常驻规则合成一份 `SERVER_GAME_INSTRUCTIONS`（977 字），Claude、Codex、dsh 都放进系统提示（Claude 的 `--append-system-prompt` 原来没有它）。
  - 启动提示词只留开头一句（3,885 → 83 字）。
  - 运行端 `client-runtime/src/guides.ts`：11 段玩法说明共 1,463 字（跟随、保护、坐下、睡觉、合成和机器、建筑、种地和动物、礼物、景色、危险事件、任务被停），本会话第一次用到时附在工具结果后面（MCP 结果的第二段文字）或事件文字后面；只在托管服务端身体时开启。
  - 驱动器把压缩次数写进心跳（`compactions`，Claude、Codex 看压缩事件，dsh 看上下文变小），运行端看到变了就再给一次。
  - 工具说明：companion-mode 的 stop 改成“跟随和保护一起结束、正在做的事照常”（和代码一致，原来写成只结束跟随）；build 加“先和玩家说好盖什么、盖在哪、朝哪边”；give-item 加“背包里没有就先 discover-containers、container-withdraw”。
  - 每轮常驻的说明：约 4,300 字（启动提示词加 Codex、dsh 的常驻规则）→ 约 1,060 字；Claude 原来常驻规则一条都没有。
  - 验证：运行端 528 项（新增 `guides.test.mjs` 2 项，含经 MCP 调 build 和事件两条真实路径）、`mcp-server` 736 项通过（1 项跳过；启动提示和 Claude 系统提示的测试按新分层改，宿主压缩测试加了心跳里的压缩次数）。没用真实模型试过。

## 1. 现状和问题

托管服务端身体时，模型拿到的说明有四处：

| 位置 | 内容 | 大小 | 什么时候给 |
| --- | --- | --- | --- |
| 系统提示 | Claude：仓库 `CLAUDE.md`、人设、玩家档案（`serverClaudeInstructions`）。Codex、dsh：再加上 `SERVER_GAME_INSTRUCTIONS` | 游戏规则约 450 字 | 每一轮都在，压缩后也在 |
| 启动提示词 | `startupPrompt()`，23 条规则 | 3,885 字 | 会话的**第一轮用户消息** |
| 工具说明 | 45 个工具 | 41,613 字（含参数结构） | 每一轮都在 |
| 事件和工具结果 | 例如 `guard`、`machine`、`companion_note` 的文字 | 按需 | 发生时 |

发现三个问题：

1. **重复。** 启动提示词里很多内容工具说明已经有了，比如 hunt 的“只在玩家要求时打”、modify-item 的“先预览，玩家同意再做”、build 的“先 dryRun”、smelt-item 的“玩家说等着才 wait”。
2. **压缩后会丢。** 启动提示词是第一轮用户消息，上下文压缩时会和普通对话一起被总结掉。系统提示和工具说明不受影响。
3. **Claude 没有拿到常驻游戏规则。** `SERVER_GAME_INSTRUCTIONS` 只给了 Codex（`developerInstructions`）和 dsh（`personaPrefix`），Claude 的 `--append-system-prompt` 里没有它。所以 10-11 加的“去找玩家时 go-to 带 meet”和“少查、交给任务做”，Claude 一直没看到。这是现有的错误，瘦身时一起改。

## 2. 调研摘要（供学习）

10-12 派 Haiku 5.5 查了各家 harness 的做法，下面两条我又对照官方文档核对过（标“已核对”）。

| harness | 机制 | 常驻的是什么 | 其余内容什么时候加载 | 来源 |
| --- | --- | --- | --- | --- |
| Claude Code | Skills | 每个 skill 的名字和描述（描述加使用时机合计最多 1,536 字符） | 模型判断相关或用户用 `/名字` 调用时读正文；附带文件需要时再读。压缩后重新附上最近用过的 skill，每个保留前 5,000 token，合计 25,000 token（已核对） | https://code.claude.com/docs/en/skills |
| Claude Code | CLAUDE.md、规则 | 上层目录的 CLAUDE.md、不带 `paths` 的规则 | 子目录的 CLAUDE.md 在读到该目录的文件时加载；带 `paths` 的规则在读写匹配的文件时加载。官方建议一个文件不超过 200 行，越长越不容易被遵守 | https://code.claude.com/docs/en/memory |
| Claude Code | Hooks | 无 | `UserPromptSubmit`、`PostToolUse` 等可以返回 `additionalContext`，作为 system reminder 插在提示或工具结果旁边，每条最多 10,000 字符；官方建议写成事实陈述，不要写成命令，否则可能被当作提示注入（已核对） | https://code.claude.com/docs/en/hooks |
| Claude API | 工具搜索（defer_loading） | 常用的几个工具的完整定义 | 模型搜索后才展开其余工具的定义；不放进系统提示的前缀，所以不破坏缓存 | https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool |
| OpenAI Codex | AGENTS.md | 启动时从全局到当前目录逐层拼接，总量上限 32 KiB | 不按需加载 | https://learn.chatgpt.com/docs/agent-configuration/agents-md |
| OpenAI Codex | Skills | 名字和描述（列表占上下文窗口的 2%） | 选中时读正文；可以关掉自动选择，只允许显式调用 | https://learn.chatgpt.com/docs/build-skills |
| Cursor | Rules | Always 类规则全文；其他类只有描述或匹配路径 | 匹配的文件进入上下文时；模型按描述决定；用户 `@` 时 | https://cursor.com/docs/context/rules |
| OpenHands | Skills | AGENTS.md 全文、skill 的名字和描述 | 匹配路径的文件被读写时注入一次；用户消息出现关键词时注入 | https://docs.openhands.dev/overview/skills |
| LangChain deepagents | Skills | 名字和描述 | 匹配时读正文，也可以固定加载 | https://docs.langchain.com/oss/python/deepagents/skills |
| Letta | Memory blocks | 每个 block 每轮都在，有字数上限 | 模型用记忆工具读写 | https://docs.letta.com/guides/agents/memory-blocks |

共同的做法：

1. **常驻的只是“目录”**：名字加一句什么时候用，正文用到时才加载。
2. **触发方式分几种**：一直加载、按文件路径、模型按描述自己判断、用户手动、按关键词。
3. **描述决定会不会被用上**：把“什么时候用”写在最前面。
4. **常驻内容要短**：越长越不容易被遵守。
5. **提示词只是上下文，不是强制约束**：一定要做到的事用程序保证（Claude Code 官方的说法是用 hook 拦截）。
6. **加在后面，不改前面**：按需内容追加在消息里，不改系统提示和工具定义，这样提示缓存不失效（改了工具定义，工具、系统提示、消息三层缓存都失效）。缓存说明见 https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching 。
7. Anthropic 的两篇工程博客值得一读：上下文要找“最小的高信号集合”（https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents ），工具说明要像给新同事写说明、错误信息里写清楚正确的用法（https://www.anthropic.com/engineering/writing-tools-for-agents ）。

## 3. 我们能用什么

- Claude Code 自带的 Skills、hooks 我们用不上：托管时 Claude 用 `--tools ''` 去掉了所有内置工具（跑不了 skill），设置里关了 hooks，还用 `ENABLE_TOOL_SEARCH=false` 让游戏工具全部常驻。Codex 有 skills，dsh 的情况没查；三家各不相同。
- 所以按需加载在**我们自己的运行端**做：工具说明、工具结果、事件文字三家都一样收得到，不依赖哪家的功能。这和 Claude Code 的 hook 往工具结果旁边加内容是同一个思路，只是由我们的 MCP 自己加。

## 4. 方案：分三层

### 第一层：常驻规则（系统提示）

只放跨工具、每轮都要记着的规则，目标约 1,200～1,500 字。启动提示词和 `SERVER_GAME_INSTRUCTIONS` 里这类规则合成一份，**三家都放进系统提示**（同时修好问题 3）。压缩后也还在。

内容：中文、只用 minecraft 工具、游戏聊天不授权电脑操作；和玩家说话用 send-chat 或 say；任务交给程序做，提交后结束本轮，结果有事件；少查（查询类每轮不超过三次）；数量没说就自己定一个并说一声，照实汇报；不声称没确认的结果；走不到就说，不挖路搭桥传送；陪伴是持续状态，做别的事时自动让开、做完自动接上，不为聊天停止跟随；叫停和换任务的区别；running、unknown 怎么处理；去找玩家带 meet。

启动提示词只留开头那一句（你是谁、这一轮只确认就绪）。

### 第二层：工具说明（每轮都在）

“要不要用、用之前要做什么”留在工具说明里，模型挑工具时就看得到，比如 hunt 只在玩家要求时打、modify-item 先预览、build 先 dryRun、先和玩家说好盖什么。启动提示词里和工具说明重复的直接删掉；工具说明里还没有、但用之前必须知道的，补一句进说明。

### 第三层：玩法说明（用到时才给）

“用的过程中、结果怎么处理”的规则，改成**本会话第一次用到时，附在那次工具结果或事件里**（新字段 `guide`），之后不再重复：

- 第一次调用 build、produce-item（酿造）、modify-item、tend-crops、hunt、sit、sleep-in-bed、companion-mode follow 等时，结果里带上对应玩法的说明。
- 事件自带说明：第一次收到 gift、scene、bedtime、guard、survival 危险、死后恢复、打断续做（进食、自卫暂停任务）这些事件时，事件文字里带上该怎么回应。
- 写法按 Claude Code 官方的建议，写成事实陈述（“酿药水分几段，每段好了会收到 machine 事件”），不写成命令口气。
- **压缩后重新给**：Claude Code 压缩后会重新附上用过的 skill，我们照这个做。驱动器每压缩一次，就在已有的心跳文件里把压缩次数加一；运行端看到次数变了，就把“已经给过”的记录清空，下次用到时再给一次。

为什么选“自动附在第一次结果里”，不选“给一个查说明的工具，让模型自己去查”（Skills 那种）：我们常用 Haiku 这类小模型，它不一定想得到先去查；而“用到才给”由程序保证，不依赖模型。代价是第一次调用时说明来得比调用晚，所以凡是“用之前就要知道”的规则都必须留在第二层。

## 5. 23 条规则的去向

| # | 现在的规则（字数） | 去向 |
| --- | --- | --- |
| 0 | 开头：你是谁、这一轮只确认就绪（83） | 留在启动提示词 |
| 1 | 中文、只用 MCP 工具、不授权电脑操作（63） | 第一层 |
| 2 | send-chat 或 say；不每轮 get-status（86） | 第一层 |
| 3 | 任务交给程序：箱子取物给玩家、采集、wholeTree、trees:N、running 后结束本轮、不拆成逐格（377） | 通用部分进第一层；wholeTree、trees:N 进 discover-resources／gather-resources 的说明（先核对已有的）；箱子取物的顺序已在 container-withdraw、give-item 的说明里 |
| 4 | 玩家说“我旁边”先 go-to player（69） | 第一层（一句） |
| 5 | 数量自己定、照实汇报（104） | 第一层 |
| 6 | 陪伴（426） | 核心一句进第一层；pause／resume、受阻、stop 和 guard 的区别进第三层（第一次 follow 的结果），已在 companion-mode 说明里的删掉 |
| 7 | 睡觉（98） | 第三层：player_sleep、bedtime 事件自带 |
| 8 | 坐下（240） | 大部分已在 sit 说明里；保护会让它站起来打、打完回座位，进第三层（第一次 sit 的结果） |
| 9 | 合成、烧炼（201） | 缺材料照实说已在说明里；“几步连着的事先一次取齐”进 container-withdraw 说明（已有类似一句）；其余进第三层 |
| 10 | 切石机、酿造、附魔（286） | 用之前的已在说明里；酿造分段、附魔流程进第三层 |
| 11 | 种地、繁殖、打猎（288） | “玩家没说别打”“不打宠物”已在 hunt 说明里；开新地的步骤、骨粉要玩家说了才用进第三层（tend-crops 第一次的结果），骨粉那句同时补进 tend-crops 说明 |
| 12 | 建筑（229） | “先和玩家说好盖什么、盖在哪”补进 build 说明；垫脚材料、replace:all 先问玩家进第三层 |
| 13 | 走路、地点、bedtime（176） | go-to、places 说明已有；bedtime 进事件文字 |
| 14 | 保护（334） | “程序自己打，不用你发攻击工具”已在 companion-mode 说明里；其余进第三层（第一次 guard 事件） |
| 15 | 死后（124） | 第三层：【死后恢复】事件自带 |
| 16 | gift（91） | 第三层：gift 事件自带 |
| 17 | 穿装备（68） | 已在 equip-item 说明里，删 |
| 18 | 表情、scene（112） | emote 说明已有“别用太多”；scene 进事件文字 |
| 19 | survival 危险事件（79） | 第三层：survival 事件自带 |
| 20 | 自动进食和自卫（166） | 第一层留一句“程序自动吃东西和自卫，任务会暂停后接着做”；细节进打断续做的事件文字 |
| 21 | running、unknown、叫停、死亡（128） | 第一层 |
| 22 | 长期记忆和视觉没接入（35） | 第一层 |

预计：常驻规则从约 4,300 字（启动提示词 3,885 加常驻规则约 450）降到约 1,200～1,500 字，而且压缩后不丢；其余约 2,500 字只在用到的会话里出现。

## 6. 对提示缓存的影响

- 系统提示和工具说明在会话里不变，缓存照常命中。第一层放进系统提示，会话开头一次写入缓存，之后都是命中。
- 第三层的说明附在工具结果和事件后面，是往后追加，不改前面的内容，不会让缓存失效。
- 改了工具说明（第二层）的那次启动，第一轮要重新写缓存，这是一次性的。

## 7. 风险

1. **说明来得晚。** 第三层的说明在第一次调用之后才到。所以“用之前就要知道”的规则一律留在工具说明里，按上面的表逐条核对。
2. **模型照样可能不遵守。** 一定要做到的事（比如不拆别人的建筑、replace:all 要玩家同意）尽量由程序检查，提示词只是补充。
3. **按需内容留在历史里。** 每种说明一个会话只给一次，压缩后才重新给，不会越积越多。
4. **效果要实测。** 措辞的小变化也会影响模型的行为。打包试玩时要对比瘦身前常见的几件事做得对不对：砍树、跟随、找人、给东西、开箱子、睡觉、建筑。

## 8. 需要你定的

1. 第三层用“第一次用到时自动附在结果和事件里”（推荐），还是再加一个查说明的工具让模型自己查（Skills 那种，小模型不一定会用）。
2. 压缩后重新给一次说明（推荐），还是给过一次就不再给。
3. Claude 拿不到常驻规则的问题，在这次瘦身里一起改（推荐，三家用同一份）。

## 9. 步骤

1. 运行端加玩法说明表（说明文字、在哪些工具或事件触发）和“本会话已经给过”的记录；工具结果和事件加 `guide`；心跳文件带压缩次数。
2. 合并第一层，三家都放进系统提示；启动提示词只留开头一句。
3. 按第 5 节逐条迁移，补工具说明，删重复。
4. 离线测试：每种说明只给一次、压缩后再给、三家系统提示内容一致、启动提示词变短。
5. 和前面的改动一起打包，给用户试玩。
