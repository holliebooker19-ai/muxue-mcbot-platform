# bot-scripts — 小克自己写的行为脚本

> 只属于旧 Mineflayer 实现（`mcp-server/`）。当前主线 ServerBody 没有 `list-scripts`、`run-script`、`memory-note` 这些工具，怎么玩见 [docs/play.md](../docs/play.md)。

玩的过程中发现某个多步操作会反复做（砍树→做木板、挖一条隧道、铺一片地……），就把它写成脚本放在这里。
文件保存后立即生效：`list-scripts` 查看，`run-script` 运行，不需要编译或重启。

## 格式

文件名：`小写字母-数字-连字符.mjs`（如 `gather-wood.mjs`），脚本名就是去掉 `.mjs` 的部分。

```js
export const meta = {
  description: '一句话说明它做什么',
  params: { count: '参数说明，写清默认值' },
};

export default async function (ctx, params) {
  const count = Number(params.count ?? 8);
  // ……
  return '给自己看的结果摘要';
}
```

## ctx 里有什么

| 名称 | 用途 |
|---|---|
| `ctx.tool(name, args)` | 调用任意 MCP 工具（除了 `run-script`），返回结果文本；工具报错会抛异常 |
| `ctx.say(text)` | 在游戏里说话（会看向对方，也会进入 TTS）；不能发 `/` 开头的命令 |
| `ctx.goto(goal, { timeoutMs })` | 安全地走过去（只走路：不挖方块、不垫方块），到不了会抛出错误；`goal` 用 `ctx.goals` 创建 |
| `ctx.checkpoint()` | 检查是否该停（stop-action、超时、受伤、玩家叫名字），该停就抛异常结束脚本。**循环里每一轮都要调用** |
| `ctx.sleep(ms)` | 等待（自带 checkpoint） |
| `ctx.log(...)` | 记日志，运行结束后返回最后 30 条 |
| `ctx.bot` | mineflayer bot 的**受控接口**：可以读位置、方块、背包、玩家等；动作和工具走同一套保护检查（直接 `ctx.bot.dig` 会被拒绝，改方块请用 `ctx.tool('mine-blocks' / 'build' / 'dig-block')`）；不能用 `_client`、`chat`、`quit`、寻路配置等；`bot.on(...)` 注册的监听器在脚本结束时自动移除 |
| `ctx.Vec3` / `ctx.goals` / `ctx.mcData` | 坐标类、寻路目标、方块物品数据 |
| `ctx.params` | 同第二个参数 |

## 规则

- 不能 `import` / `require`，不能访问 `process`、`eval`、`fetch`；需要的东西都从 ctx 拿。这只是防手滑的检查，不是安全沙箱，写的时候自觉只操作游戏。
- 走路用 `ctx.goto`，不要自己改寻路配置。任何移动都不会挖方块或垫方块，过不去就停下来说明，不要想办法拆路。
- 脚本停止（stop-action、超时、出错、断线、换维度）后，它残留的异步代码发出的动作都会被拒绝；循环里照样要调用 `ctx.checkpoint()`。
- 优先组合已有工具（`mine-blocks`、`build`、`craft-item`……），它们已经处理了保护方块、中断、工具选择等细节。
- 会破坏方块的脚本，遵守 AGENT.md：不破坏玩家的建筑，大范围改动先问。
- 跑得久的脚本用 `run-script` 的 `background: true`：立即返回，你可以继续聊天；结束时收到 `task` 事件。停下用 `stop-action`。
- 脚本出错时，改文件后直接再 `run-script` 即可。
- 写好、试过能用的脚本，在脚本开头写清用途（`list-scripts` 会列出来），再用 `memory-note` 记一笔。
- 修改或删除别人（玩家）写的脚本前先问。
