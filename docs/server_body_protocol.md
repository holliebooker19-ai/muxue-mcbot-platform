# ServerBody 控制协议 v2

2026-10-04 更新。本协议是当前实现与测试共用契约；当前只交付独服、本机控制、单 Bot。客户端协议 v1 保持兼容。服务端正常成本不设预算，默认无 Bot MC 客户端。Agent／模型凭据留在 Agent 主机。本日整栈转移、任务总期限与矿石目录仅做编码和离线验证，未更新运行中的服务器。

## 传输与身份

控制口仅 `http://127.0.0.1:8766/v2`（端口可配置），POST JSON `{method,params}`，Bearer token；拒绝 Origin、重定向、超限请求。响应 `{ok:true,result}` 或 `{ok:false,error:{code,message}}`。游戏读写只在服务器主线程；HTTP 超时后尚未执行的排队请求必须丢弃。

连接文件 `config/mcbot-server-control/connection.json`：`{protocol:2,backend:"server",endpoint,token,worldId,username}`，不记录模型凭据。worldId 与允许的唯一角色在服务端配置中固定，不接受客户端任意指定世界或玩家；默认角色 Claude。instanceId 每次服务启动随机变化；sessionId 每次角色创建或死亡／维度变化更新；leaseId 每次接管更新。均使用随机标识或字段比较，不计算哈希。

## 方法

| 方法 | params | result |
| --- | --- | --- |
| hello | `{}` | `{protocol:2,backend:"server",instanceId,worldId,username,connected,sessionId,platform:{minecraft,loader,loaderVersion},capabilities}`；connected 表示角色存活可控，不代表控制口是否可达 |
| claim | `{instanceId,worldId,username,controllerId}` | `{leaseId,stopToken,ttlMs,instanceId,sessionId,controlGeneration,chatCursor}`；新租约 10000ms。显式接管时创建或附着角色，已占用则 LEASE_BUSY。重复同一 controllerId 返回原租约和实际剩余期限，不延长有效期 |
| heartbeat | `{instanceId,sessionId,leaseId}` | `{ttlMs:10000,controlGeneration}`；只续当前有效租约，不复活过期租约 |
| observe | `{instanceId,sessionId,leaseId,block?}` | 现有 Observation 字段，`source:"server-observed"`，另含 instanceId/controlGeneration；未加载区块不隐式加载，空 container 必须为 null |
| nearby-blocks | `{instanceId,sessionId,leaseId,centerPlayer?,radius?,maxResults?}` | 只读发现普通容器方块，不读取内容；返回 instanceId/sessionId/worldId/controlGeneration/dimension、center、candidates、truncated 和 budget。需 `nearby-blocks` 能力；radius 1–8（默认4）、maxResults 1–16（默认8）、y±2，仅已加载区块。指定玩家须同维度、Bot 32格内且视线通过 |
| nearby-resources | `{instanceId,sessionId,leaseId,blockIds,radius?,maxResults?,center?}` | 只读有限资源发现；blockIds为1–8个方块ID或方块标签（`#c:ores`），radius 1–16（默认4）、maxResults 1–64（默认32）。center为`{x,y,z}`，默认Bot位置且距Bot不得超过8格；返回完整控制上下文、center、candidates、truncated、budget，详见有限采集边界 |
| survival-state | `{instanceId,sessionId,leaseId,details?}` | 只读当前维度／控制上下文、serverTick/observedAt、生命／饥饿／饱和、选槽及foods；默认details:true含自身inventory，false省略完整库存。safe表示食品语义已核验，不代表省略的栈守卫可以用于写入 |
| assess-tool | `{instanceId,sessionId,leaseId,x,y,z,expectedBlock?,policy?,minRemainingDurability?,dropPreference?}` | 32格内已加载目标；完整上下文含dimension，返回36槽候选、基础资格／估算／耐久／掉落偏好、推荐及原因；未知不推荐，禁止临时装备来执行只读评估 |
| machine-status | `{instanceId,sessionId,leaseId,x,y,z}` | 只读（8b，10-09）：不走过去、不打开界面读一台机器的内容和进度，给运行端的“放好就走、到时回来取”用，不占动作、不打断正在做的事。只认身体所在维度、水平 256 格内（OUT_OF_REACH）；区块没加载回 `state:"unloaded"`（没加载的机器不工作，时间也不走）；加载了回 `id`，以及 `supported`（这个方块的工作站适配实现了 `progress`，现在是原版熔炉、烟熏炉、高炉和酿造台）、`machine`、`inputs`、`results`、`fuel`、`working`、`ticksLeft`／`secondsLeft`（照这样一直工作还要多久）、`fuelTicks`（燃料还够烧多少 tick）、`stalled`（还有料但没在工作：没燃料或出口满了） |
| act | `{instanceId,sessionId,leaseId,controlGeneration,operationId,name,args}` | 现有 Operation 字段，另含 controlGeneration；同 ID 同内容返回原结果，异内容拒绝。动作按原生字段比较，不哈希；结果缓存淘汰后同 ID 也不能重新执行 |
| operation | `{instanceId,sessionId,leaseId,operationId}` | 对应当前租约的 Operation；不以查询续租 |
| stop | `{instanceId,sessionId,leaseId,clearGuard?,guardRevision?,stepAside?}` | `{stopped:true,controlGeneration}`；取消当前操作、推进代次、角色保持在线，旧代次 act 拒绝；`guard-duty-fenced`支持`clearGuard:true`连同必填`guardRevision`在同一请求中清保护（停止本身从不因序号被拒，序号已被更新的设置超过时只停不清）；省略则保留保护意图；`step-aside-stop`支持`stepAside:true`（跟随让开，之前发现的目标继续有效，见[跟随让开、自卫失败、没武器](#跟随让开自卫失败没武器试玩反馈修正)）；`server-posture`支持`clearPosture:true`连同必填`postureRevision`，同一请求里清姿态，规则同`clearGuard`（8m 第二步约定，届时删掉`stepAside`） |
| guard | `{instanceId,sessionId,leaseId,guardRevision,player?,expectedEntityId?,options?,off?}` | `guard-duty-fenced`保护配置；开启返回保护状态和`guardRevision`，关闭返回`{enabled:false,guardRevision}`；不占操作 ID 预算，见常驻保护一节 |
| posture | `{instanceId,sessionId,leaseId,postureRevision,action?,player?,expectedEntityId?,distance?,wander?,off?}` | `server-posture`陪伴姿态（跟随／等待）；不是操作，不占操作 ID 预算，见[陪伴姿态](#陪伴姿态8m-第二步约定2026-10-11)（**约定，尚未实现**） |
| release | `{instanceId,sessionId,leaseId}` | `{released:true}`；仅停止并放弃这一份控制权，角色保留；旧 lease 不能影响新 lease |
| revoke | `{instanceId,sessionId,leaseId,stopToken,leave?}` | `{stopped:true,revoked:true,left}`；宿主专用，仅撤销指定租约，角色默认保留；不能接管／移动，不续租。已释放的匹配旧租约可幂等确认，但绝不影响新租约。`leave:true`（宿主退出时用）同时让角色像玩家一样下线（原版存档），只在没有别的租约时生效，`left`说明这次是否真的下线；下次 claim 在原地重新上线 |
| watch | `{instanceId,sessionId,leaseId,stopToken}` | `{chat,chatCursor}`；宿主只读新聊天，用于 MCP 不响应时直接叫停，不续租、不创建角色。也接受同 instance/session 下最近已撤销／释放／过期的租约，前提没有不同的新有效租约；新 claim 或角色代次变化即使旧 watch 失效。chat 格式同 Observation |
| notice | `{instanceId,sessionId,leaseId,stopToken,text}`；两种授权：① 没有活租约时，sessionId／leaseId／stopToken 必须匹配最近一次退役租约（同 watch，否则 LEASE_LOST）；② 有活租约时走同一实例、会话、租约校验，stopToken 须对（否则 FORBIDDEN）。 | `{shown:true}`；托管向所有玩家发一句短提示（服务端广播灰色斜体，不是聊天、不是动作），不续租、不创建角色、不影响动作。text 为 1–120 个字符、不能全是空白，不能含控制字符（<32、127）和 `§`，否则 INVALID_ARGUMENT；距上一次成功的 notice 不足 2000 ms 返回 RATE_LIMITED。能力 `host-notice`（hello 的 capabilities 里有才发；旧服务端没有这一项时宿主不发请求，`scripts/server-body-control.mjs` 的 `notice` 返回 false）。 |
| respawn | `{instanceId,worldId,username,sessionId}` | `{respawned:true,connected:true,instanceId,sessionId,controlGeneration}`；独立显式原生重生，无 claim／lease。必须匹配 hello 当前死亡会话；首次尚未加载的死亡存档可携 `sessionId:null`。活角色拒绝此请求，成功产生新会话 |

B 基线已有11个动作：send-chat、look-at、move-to-position、follow-player、dig-block、place-block、open-container、click-slot、close-container、select-slot、drop-item。参数见 `client-runtime/src/body.ts` 与下面的服务端必填核验；stdio MCP 只发布实际 capabilities 允许的动作。B另有10个观察／控制工具，合计21个：get-status、get-position、list-inventory、find-entity、read-chat、get-block、get-container、get-operation、stop-action、wait-for-events。respawn不发布为模型可调用的MCP工具；最新增量见下段。

交互增量另声明只读 `nearby-blocks` 及两个走近动作。Node 在所需原子能力齐备时提供 `discover-containers`、`container-list`、`container-withdraw`、`give-item`、`fetch-and-give`，再加 `approach-container`／`approach-player`，该历史批次合计28个MCP工具。持续陪伴另声明内部动作 `follow-companion`，Node增加`companion-mode`／`get-companion-mode`，该历史批次为30个工具。此前有限采集再声明`nearby-resources`／`approach-resource`／`pickup-item`能力，Node增加`discover-resources`／`gather-resources`／`collect-items`，该批完整能力集为 **33 个 MCP 工具**；持续跟随与新增采集原子动作由任务层内部使用，不直接发布给模型。工具仍按实际capabilities裁剪。任务在 Agent 主机组合原子动作，不新增服务器模型或第二个 MC 客户端。容器HTTP候选为 `{position,id,properties,targetToken,distance,visible,visibility}`；MCP保留私有targetToken，仅返回本地containerRef。可见性相对 center，可能为 visible／occluded／unknown。发现不代表菜单一定受支持，空结果不代表未加载区域或更远处不存在箱子。

有限平地移动／跟随遇障碍或危险停止；不寻路挖墙、不传送完成移动。角色生成位置使用服务端配置或安全出生点；客户端不能借 claim 任意传送。单格生存动作通过原版玩家交互路径执行，检查生存模式、普通距离／视线、世界边界和原版／NeoForge 保护，不因身体是服务端角色而绕过规则。非 OP 约束覆盖角色存活可控判定、接管与重生，不能先接管再加 OP 绕过生存规则。

租约在每次请求、每次物理动作前按单调墙钟检查；服务器卡顿期间不执行动作，恢复的第一步先处理过期控制。TTL 不能靠自动重新 claim 绕过。死亡／换维度／被移除立即取消控制。存活角色可显式重新连接；claim 载入死亡角色返回 DEAD_BODY 并保留死亡状态，不能借 claim 复活。显式 respawn 使用原版重生点、库存规则与重生事件，不直接加血，不自动取得控制，不续旧任务。角色保留与自然生存继续，不等于永久停机或无敌。

act 通过身份与操作去重核验后，动作级失败可返回 `ok:true` 的 `Operation.status:"failed"`，`result.code` 给出结构化原因；ok 仅表示拿到动作回执，不代表动作成功。身份、租约、代次等协议拒绝仍是 `ok:false`。

每租约最多接受4096个不同operationId，保留最近256条操作结果；结果淘汰不允许重放旧ID。`claim`／`heartbeat`／观察类／`act`／`operation`／`stop`回执增加`operationBudget:{used,remaining,limit,exhausted}`，表示读取当时的租约总额度。重复同ID不再计数；stop改变控制代次但不重置额度。耗尽时新动作返回`OPERATION_LIMIT`，查询、停止和释放继续可用，只有释放后明确重新接管才能获得新额度，不自动轮换租约或续做旧任务。新运行端保留旧服务端缺少该可选字段的兼容，缺字段不等于额度无限。

错误码包括 FORBIDDEN、INVALID_ARGUMENT、WRONG_INSTANCE、WRONG_WORLD、WRONG_PLAYER、WORLD_CHANGED、DEAD_BODY、LEASE_BUSY、LEASE_LOST、STALE_CONTROL、BUSY、UNSUPPORTED、UNKNOWN_OPERATION、OPERATION_CONFLICT。生存动作还可能在 result.code 返回 STALE_ITEM、STALE_BLOCK、STALE_CONTAINER、UNLOADED、NO_LINE_OF_SIGHT、OUT_OF_REACH、NOT_DIGGABLE、TARGET_OCCUPIED、EMPTY_HAND_REQUIRED、DROP_PARTIAL、NATIVE_UNKNOWN 等。网络超时或原生调用已产生但无法完整确认的效果为 unknown，不自动重放动作；部分效果须核对实际库存、方块和掉落物。

2026-10-03 R2 修复：原生调用入口前置待确认标记；调用内部或其后回执构造抛出协议错误（包括 UNSUPPORTED）／运行时异常时，尚未建立可靠结果的操作保留 unknown。写前拒绝、已证实无变化的拒绝仍是 failed；drop 的已确认 droppedCount 与独立已知 removedCount 保留，即使后续单件结果未知。重复 operationId 继续返回原回执。详见[边界修复与故障注入范围](archive/boundary_review_fixes.md)，不把该离线验证称为真实 Mod 故障验收。

## B 的快照与动作核验

服务端 Observation 增加 `selectedSlot`（快捷栏 0–8）。B历史栈结构为`{slot,id,count,components}`，有限采集增量已为所有非空inventory／container.slots／carried／groundItems.stack及拾取收据栈增加`maxStackSize`，直接读取实际`ItemStack.getMaxStackSize()`；空栈为`id:"minecraft:air",count:0,components:{}`，省略该上限字段。上限与当前count、槽位容量分开，可为1／16／64／99或其它实际值，不从物品ID猜64。任务仅接受已核验的正整数上限，并保留完整components。container为null或`{id,type,revision,slots,carried:{id,count,components,maxStackSize?}}`。id包含角色会话、菜单代次与原生窗口ID；revision是非负安全整数，槽位、carried（包括实际maxStackSize）或原生窗口状态变化时递增，重开窗口产生新id。不要用旧id或旧revision进行下一次点击。

交互增量为 container.slots 增加 `source: container|player|unknown`，player 槽另有原生 `playerSlot`。来源由真实库存身份和经过验证的菜单契约判断，不能靠槽位列表末尾数量猜测。Node 的 `get-status`／`get-container`／`get-operation` 默认给模型摘要；`details:true` 可取完整快照，`list-inventory` 保留完整组件。HTTP 原始观察与每次写入的完整 guards 不减少。

槽位还可携`active`／`mayPickup`。新服务端如实返回原生值并把它们纳入完整菜单变化比较；旧版本未携字段时保留已验证标准菜单兼容。通用任务只列活跃容器槽、只从允许取出的活跃槽取物；未知来源即使不活跃也不能默认为可用。空SlotItemHandler的mayPickup=false表示没有可取内容，向空槽存入仍由原生mayPlace等规则处理，不能混同取出与存入权限。隐藏槽始终拒绝点击。

任务用短期随机 `containerRef`（30秒供提交）绑定身体／实例／世界／维度／控制代次、位置及方块状态。新服务端另签发固定120秒有效、最多保留256个的随机targetToken，绑定实际BlockEntity身份；双箱绑定两半，不读取内容，不使用哈希。同坐标同状态替换、卸载重载或会话变化拒绝旧引用。带token开箱后，菜单在自身生命周期内持续校验来源实例与状态，不因发现缓存淘汰而误失效；每次点击仍核验菜单版本和完整组件。旧服务端无此能力时明确返回state-only保护及近距限制。

任务写互斥贯穿走近、开取关、返回交物，内部步骤不会逐个唤醒Agent。走近复用第二批统一原生高差导航，限已加载地形、32格搜索半径，预算见文末第二批契约；这些是上限，不保证任意32格位置都有路。真实碰撞形状、扫掠身体、整脚底支撑、危险及实体占位逐tick复核；无路或预算用尽明确失败，不挖路／搭桥／传送／隐式生成路线区块。接收者开始时绑定UUID；行走中移动超过0.5格停止，最后丢出前再次校验身份、可见及1.5格距离。仍只从一个足量源栈取物，要求空快捷栏；同 ID 多组件变体拒绝，variant编号尚不是可授权选择句柄。结果区分 withdrawn／held／dropped 与 pickup unconfirmed，不自动重试 unknown 或补丢物品。

2026-10-04容器增量：请求数量恰好等于完整源栈且目标为已核验空快捷栏时，用两次普通PICKUP左键完成取起／放下，核对完整组件、来源映射、数量、实际堆叠上限及空carried；不使用QUICK_MOVE。部分栈保留逐件右键与原槽归还核验。容器四类任务共享从受理开始的90秒总期限，初始观察、动作请求、动作轮询、接收者检查与失败收尾均计时；原有单动作期限仍保留。超时请求身体停止，最多再等待5秒；停止未确认保留写锁，直到最新明确停止确认。写后未确认结果仍为unknown及最后确认下限，迟到回执不重放动作、不影响新所有者。

资源／容器／玩家走近及指定掉落物拾取的路线规划站位，要求中心与水平`x/z±0.2`四角均满足各自原有reach／LOS或拾取碰撞条件，为`<0.15`格的路点到达容差留裕量。实际到达与原生交互范围不放宽；狭窄区域没有合格网格站位仍可返回NO_PATH。

components 是完整对象，按当前观察直接复制和字段比较，不提取少量白名单、不计算哈希。所有组件统一经注册表感知的 DataComponentMap CODEC／NbtOps 序列化，每个资源 ID 对应的 value 都是 typed-NBT；不仅 CustomData，damage、custom_name、默认组件以及嵌套容器物品中的组件也采用同一表示。例如：

```json
{
  "minecraft:damage": { "type": "int", "value": 1 },
  "minecraft:custom_data": {
    "type": "compound",
    "value": {
      "byteFlag": { "type": "byte", "value": 1 },
      "longId": { "type": "long", "value": "9223372036854775807" },
      "floats": { "type": "list", "elementType": "float", "value": [{ "type": "float", "value": "0.1" }] }
    }
  }
}
```

NBT 类型为 end／byte／short／int／long／float／double／byte_array／string／list／compound／int_array／long_array。long 与 long_array 元素是十进制字符串；float／double 是原生 Tag 实际值的文本，可表示 NaN／Infinity，不能经 JSON number 投影。若原版已把负零规范化为正零，输出 0.0，不声称还原输入负零。byte／short／int 与 byte_array／int_array 元素使用 JSON number；string 的 value 为原字符串，end 为 null；list 另携 elementType，元素仍是 typed-tag。compound 的 value 是字段到 typed-tag 的对象。客户端把组件对象视为完整不透明数据直接复制；不得改类型、压缩数值或重建为普通 JS 数值。无法完整序列化或实际存在 transient／无持久 codec 的组件时明确 UNSUPPORTED，不静默遗漏、不降级为仅 ID／数量核验。

以下参数是在 act.args 中的服务端必填项；客户端 v1 仍保留原参数，不额外要求 B 字段。

| 动作 | args／确认边界 |
| --- | --- |
| dig-block | `{x,y,z,expectedBlock,expectedProperties,timeoutMs?,targetToken?}`；仅一格，使用当前选中主手的原版挖掘时间／耐久。资源任务携targetToken，额外核验资源目录／区域安全、引用位置与当前工具可获得掉落；旧原子调用不强加资源目录。执行期间核对方块与主手；停止／失效清理原生延迟挖掘，不延迟破坏 |
| place-block | `{x,y,z,face,slot,expectedBlock,expectedProperties,expectedItem,expectedCount,expectedComponents,timeoutMs?}`；坐标是支撑格，目标是其 face 相邻格。slot 0–8；检查支撑状态、当前完整栈、空目标和原生放置／真实消耗。当前拒绝门、床、双格植物等多格放置，拒绝以菜单方块为支撑 |
| open-container | `{x,y,z,expectedBlock,expectedProperties,timeoutMs?}`；普通距离／视线下原生交互，要求至少一个空快捷栏槽以避免物品使用回退 |
| approach-container | `{targetToken,timeoutMs?}`；仅走到当前实例绑定容器的原版可触及／可见站位，不打开菜单。MCP用本地`containerRef`转换，模型不传私有token。running须查询，取消复用控制代次 |
| approach-player | `{player,expectedEntityId?,distance?,timeoutMs?}`；distance默认1.3，范围1–1.5；同维度真实玩家，任务内部必带UUID。行走中目标位移超过0.5格返回TARGET_MOVED；到达后由任务重新核验 |
| approach-resource | `{targetToken,timeoutMs?}`；仅走向引用资源的原版block reach／LOS站位，不挖掘。开始时目标距Bot最多16格，默认15秒、timeoutMs 500–120000；复用已加载安全高差路线与资源引用／支撑保护 |
| pickup-item | `{entityId,expectedItem,expectedCount,expectedComponents,expectedMaxStackSize?,timeoutMs?,companionGuard?}`；完整UUID必需、expectedCount为正整数。绑定真实ItemEntity实例与完整栈，距Bot须保持8格内；相对开始位置移动超过0.75格停止；统一导航行走无进展3秒进入有限重规划，预算耗尽停止。默认15秒、timeoutMs 500–30000。可选companionGuard另限制实时玩家范围，未携带时保持原有限拾取语义。普通物理碰撞拾取，不调用虚拟touch、塞库存或传送；原生Post才确认获得量，详见下节 |
| follow-companion | `{player,expectedEntityId,distance?}`；UUID必需，distance默认2.5、范围1.5–6。持续运行，无总时长自然结束；距离及LOS满足时waiting，玩家离开站位后following。绑定真实玩家实例／UUID／维度，已加载安全高差地形内有界重规划；受阻、离线、受伤等失败后不自动恢复。原follow-player有限语义不变 |
| click-slot | `{containerId,expectedRevision,slot,expectedItem,expectedCount,expectedComponents,expectedCarriedItem,expectedCarriedCount,expectedCarriedComponents,button?}`；仅普通 PICKUP，button 0／1。每次点击后重读菜单，确认实际槽位／carried 变化 |
| close-container | `{containerId,expectedRevision}`；检查当前窗口与版本，走原生关闭／carried 归还或掉落路径 |
| select-slot | `{slot,expectedItem,expectedCount,expectedComponents,expectedMaxStackSize?}`；slot 0–8，匹配完整当前栈后选择，不搬移库存。可选上限在原生写入前比较实际getMaxStackSize，旧API兼容 |
| sleep-in-bed | `{player?,timeoutMs?}`（2026-10-07 第 8e 步）；以指定玩家（不给就是 Bot 自己）为中心，在已加载区块的水平 16 格、上下 4 格里找最近的空床（`BedBlock`，`occupied=false`），走到原版床的距离内后走原生 `ServerPlayer.startSleepInBed`，不右键方块（下界／末地右键床会爆炸，这条路只会拒绝）。出发前白天拒绝 NOT_NIGHT、不能睡的维度拒绝 BED_NOT_POSSIBLE_HERE，没床 NO_BED；躺下时按原版结果报 NOT_SAFE（附近有怪）、BED_OBSTRUCTED、OUT_OF_REACH 等，走路途中床没了 STALE_TARGET、被占 BED_OCCUPIED。成功 result 为 `{bed,id,sleeping:true,respawnSet:true}`：和玩家一样，躺下会把重生点设到这张床。默认 30 秒 |
| wake-up | `{}`；`stopSleepInBed`，已醒着也成功，result `{wasSleeping,sleeping}`。睡着时除 send-chat 和 wake-up 以外的动作都拒绝（SLEEPING）；天亮、受伤由原版叫醒 |
| sit | `{x?,y?,z?,timeoutMs?}`（2026-10-11）；x、y、z 要么都给（指定座位方块），要么都不给（在已加载区块的水平 8 格、上下 3 格里找最近的空座位）。座位只由已安装的 `SeatAdapter` 附属模组认定（森罗厨房的椅子和厨师凳），楼梯、台阶不算；没装适配或附近没有座位 NO_SEAT，座位被占 SEAT_OCCUPIED。走到座位旁（沿用 NativeNavigation），主手必须是空手：选中格不空就换到空的热栏格，热栏全满就把一格挪进背包（挪动记在 result.movedAside），背包也满 EMPTY_HAND_REQUIRED；手里不是空手时右键椅子会被换色而不是坐下。然后发玩家同款右键（`ServerboundUseItemOnPacket`），**只认观察**：`player.isPassenger()` 且载具是适配器认定的座位实体、离座位不超过 1.5 格才回成功（result `{seat,id,vehicle,sitting:true}`），否则 SIT_REFUSED／SEAT_OCCUPIED／WRONG_SEAT。已经坐着不给坐标时成功（`alreadySitting`），给了坐标 ALREADY_SITTING；在骑别的载具（船、马）时 BUSY。**朝向**：坐下成功后身体（yRot、yBodyRot）和头都转到座位朝向，即座位实体的 `getYRot()`（森罗厨房的椅子、凳子生成 SitEntity 时由方块 FACING 写入，之后不变）。坐着时视线（look-at、emote 朝向、待机看人、emote 的摇头和转圈）只转头（yHeadRot），身体不动；头与座位朝向的夹角限制在 `NativeSeat.SIT_HEAD_YAW`＝105 度以内（借用原版 `Boat.clampRotation` 的值，原版对普通实体乘客不限制，注释里有出处）；俯仰照常。站着时 look 系的动作仍同时转身体和头。 |
| stand-up | `{}`；原版 `stopRiding`，已站着也成功，result `{wasSitting,sitting}`；骑着的不是座位（船、马）NOT_SITTING，不下骑。坐着时只有 send-chat、look-at、emote、set-appearance、wake-up、sit、stand-up、select-slot、equip-item、swap-inventory、eat-item、drop-item、open-container、click-slot、close-container 能用，其余会动身体的动作一律拒绝（SEATED，先 stand-up；入口 `ServerController.begin` 紧挨 SLEEPING 检查，列表在 `NativeSeat.allowedWhileSeated`）。保护：坐着时保护照常保留，保护要出手时（`GuardDuty.wouldFight`：有控制权、玩家在 `ENGAGE_RANGE` 内、以玩家为中心保护半径内有保护会打的怪，和保护每 tick 的判断同一套）`tickDuty` 先让 Bot 站起来再交给保护，坐下没有自己的范围，打完不会自动坐回去 |
| craft-item | `{item,count?,timeoutMs?}`（2026-10-07 第 8d 步）；count 是想要的件数（1–256，按每次合成的产量向上取整）。只用普通有序／无序合成配方（`ShapedRecipe`／`ShapelessRecipe`，烟花、复制地图这类特殊配方不做），材料只取没有附加组件的普通栈（有名字、附魔、耐久损耗的不用）。能放进 2x2 就在自己的背包格里做；要 3x3 时走到 16 格内最近的工作台（打开后同一 tick 做完再关），附近没有而背包里有工作台就在身边放一个（回执 `placedTable`）。放料用原生 PICKUP 点击（拿起整栈、右键逐个放、放回），取成品用 QUICK_MOVE，消耗、返还空桶这类剩余物、统计和进度都走原版。材料不够时能做多少做多少；一件都做不了报 MISSING_MATERIALS，`missing` 列出每种材料的可选物品、需要和现有数量。成功 result `{item,requestedCount,crafts,made,recipe,table?,placedTable?,missing?,inventoryChange:{gained,used}}`。限制合成（limitedCrafting 规则）下没解锁的配方报 RECIPE_REFUSED |
| smelt-item | `{input?,count?,fuel?,wait?,furnace?,timeoutMs?}`（第 8d 步）；原版熔炉、烟熏炉、高炉（模组炉子留给 8b 的适配）。不给 furnace 就在 16 格内找能烧这个 input 的最近一个走过去打开；输入格里已有别的东西就换下一个（`skipped`）。先取出成品格里的东西，再放 count（1–64）个 input 和够烧完的燃料：给了 fuel 只用它，否则按 煤／木炭 → 木板 → 原木 → 木棍、木台阶 → 煤块 的顺序自动选，从不拿 input 当燃料；燃料格已有燃料就只补同一种。点亮着的炉子剩余燃烧时间读不到，最多多放一个燃料。没有任何燃料可烧报 NO_FUEL（input 已放进去）。`wait:true` 站在炉边开着界面，产出随出随取，烧完或到时间关掉（默认 600 秒、最多 900 秒）；不等就关掉，回执给 `readyInSeconds`，之后不带 input 再来一次只取成品。result 带 `furnace,type,added,queued,output,cookSeconds,readyInSeconds,fuel,fuelAdded,coveredByFuel,collected?,inventoryChange`；只取成品时带 `furnace,type,collected`。运行端（8b，10-09）：不等时按世界记下这台炉子（`runtime/machines/<世界>.json`），到预计时间用 `machine-status` 读一下，还在烧就按剩余时间再等，好了、停了（没燃料或出口满）、读不到（区块没加载、不在同一维度、太远）都发一条 `machine` 事件（驱动器会叫醒模型），每台只发一次；在那台炉子取过成品就划掉，还有没烧完的接着跟；`get-status` 的 `machines` 列出还在等的。 |
| travel-to | `{x,y?,z,tolerance?,timeoutMs?}`（第 8f 步加，8k 补自然地形）；最远 2000 格，默认 300 秒、最多 900 秒，tolerance 1–8（默认 2）。分段走，每段最多 28 格，Bot 是真玩家，走到哪区块加载到哪。**粗路线**（`SurfaceRoute`，8k）：每段开始时，把身体周围 96 格内已加载的每一列取地面高度（`MOTION_BLOCKING_NO_LEAVES` 的最高处），分成陆地、水、不能走（树干、岩浆、仙人掌、岩浆块、营火、头顶没空间、未加载），用 A* 找去目的地的路；陆地相邻两列高差不超过 1 格才算能走（往上只能跳 1 格，往下也只走 1 格，走下去的地方一定能走回来），水能游、代价 3 倍：从高出水面不超过 3 格的岸下水，只能从和水面一样高或更低的岸上来。目的地到不了或在范围外，就走到离它最近的能到的那一列。每段沿这条路走最多 28 格，细节交给原版寻路（和 move-to-position 同一个，但搜索预算加大到 6000 个节点、范围 48 格，只往下走 1 格，不做跳沟）。路线要下水时先走到岸边，再像玩家一样游：按住跳浮在水面，朝路线上的下一处（最多 16 格，或上岸的地方）游；离岸不到 3.5 格就交给寻路，它在水里会游向能爬上去的岸。**退回偏转**：粗路线这一段失败或没进展，就把那个落点记下、以后的规划避开，下一段改用原来的办法（直接朝目的地，失败后左右偏 35°、70°、100°、135° 或缩短，用的寻路能看到洞穴和崖下）；身体不在地表（洞里、崖下）或粗路线已经到头时也这样。连续 12 段没有比以往更接近目的地才失败（NO_PATH），说明里写上地面最近能到离目的地多远；受伤照样停（说明里带伤害来源，如 fall）。到达要同时满足：距离在 tolerance 内、高度差 3 格内（给了 y 时）、身体和目标之间没有实心方块（不在墙的另一边）、身体不站在门框里。result `{position,remaining,travelled,legs,failures,swims,plans,lastFailure?,recentLegs?}`，recentLegs 是最近 8 段的去向和结果。move-to-position 超过 32 格（8k）：服务端先查目标区块是否加载（UNLOADED），再查距离（OUT_OF_REACH，说明里提示用 travel-to）；运行端发现目标超过 32 格且服务器有 travel-to 时，直接改走 travel-to（结果带 `routedVia: travel-to`）。 |
| drop-item | 同 select-slot，另携 `{count}`；仅当前选中槽，count 1–64 且不超过当前数量，通过原版逐个 DROP_ITEM 执行。result 的 requestedCount／removedCount／droppedCount 分别记录请求、库存减少、实际新掉落实体；不把丢物事件取消后的库存减少称为成功交付 |

通用工作站 B、C（2026-10-07 第 8l 步，[设计](workstation_design.md)）：

| 动作 | 参数和语义 |
| --- | --- |
| workstation-options | `{item?,potion?,count?,subjects?}`；不动任何东西，瞬时完成。result：`stations`（16 格内认得的工作站：id、模板、位置、距离）；给了 item 时 `ways`（用哪个工具、哪个工作站、配方、缺什么）；给了 subjects（物品 id 或 `*`）时列出背包主栏里这种物品的每一叠，带 `ref`（随机的 `item-xxxxxxxx`，绑定那一格和那一叠的完整内容，15 分钟内有效，内容或位置变了就作废）；`levels` 经验等级 |
| produce-item | `{item,count?,potion?,wait?,station?,timeoutMs?}`。切石机：count 1–64 个产物，原料只取普通栈，按配方的按钮选结果，shift 取出（游戏会一直切到原料用完），剩下的拿回；可能多出不到一份。酿造台：item 是药水／喷溅／滞留药水，potion 指定药水，count 1–3 瓶；按服务器自己的酿造规则从背包里的瓶子和材料规划最多 4 段，缺什么列在 `missing` 并附 `stages`；燃料不够时放 1 个烈焰粉；默认不等（8b，10-09）：放瓶、放这一段的 1 个材料，确认开始酿就关掉走开，瓶子留在台上，回执 `{item,potion,station,stage,of,stages,bottles,inStand,brewing:true,readyInSeconds,nextIngredient?,fuelAdded}`（`stage`／`of` 按这次调用剩下的段数算）；同样的参数再调用一次时，附近台上已经有往这个药水走的瓶子（同一种）就在那台接着：还在酿报 STILL_BREWING（带 `readyInSeconds`），酿好了就放下一段的材料，已经是要的药水就取出来；台上的瓶子不往这个药水走就当别人的不碰。只走一段时只要够这一段的燃料，接着酿时没燃料报 NO_FUEL、瓶子留在台上。运行端照熔炉记账，每段好了发 `machine` 事件说下一段加什么，最后一段好了说取出来。`wait:true` 时照旧：站在旁边等每瓶都变成这一段的结果再放下一段（约 20 秒一段），最后取出；在已有瓶子的台上也能接着等完。`machine-status` 对酿造台读瓶子、材料、烈焰粉、还剩多少 tick。result `{item,requestedCount,made,recipe?,stages?,stagesDone?,station,fuelAdded?,inventoryChange,levels?}`；错误码 NO_RECIPE（提示该用 craft-item／smelt-item）、MISSING_MATERIALS、NO_STONECUTTER、NO_BREWING_STAND、STILL_BREWING、NO_FUEL、RECIPE_REFUSED、BREW_FAILED |
| modify-item | `{subject,action:{kind,...},preview?,maxLevels?,expect?,station?,timeoutMs?}`；subject 是 workstation-options 给的 ref。kind：`enchant`（option 1–3）、`anvil`（with 材料 id 或另一个 ref，rename ≤50 字）、`grind`（with 另一个 ref 可选）、`smith`（template、addition 物品 id）、`loom`（dye、patternItem 可选、pattern）、`cartography`（with）。preview：放进去读游戏显示的结果、花费、附魔三个选项（只有游戏给玩家看的那一条提示）或织布机图案，然后全部拿回，ref 指向拿回后的那一格。正式做：要花的等级大于 maxLevels（默认 0）报 OVER_LIMIT，等级不够 NOT_ENOUGH_LEVELS，给了 expect 而结果变了 PREVIEW_CHANGED，这些都把东西拿回、什么都不改；附魔按选项按钮提交，其余从结果格 shift 取出提交，之后旧 ref 作废。result `{kind,station,subject,result,options?,levelCost?,levelsSpent?,preview?,inventoryChange,levels?}` |

`inventoryChange` 在这几个动作里按“物品 id＋重要组件”计数，例如 `minecraft:potion[potion=minecraft:swiftness]`、`minecraft:iron_sword[enchantments=minecraft:sharpness 1]`，原地变化（酿造、附魔、修理）也看得出来。Bot 正在用的工作站界面（酿造台等）可以照常观察，只读，界面自己的格子标为 unknown；`click-slot` 不能点这类界面。

种地和养动物（2026-10-07 第 8g 步）：

| 动作 | 参数和语义 |
| --- | --- |
| tend-crops | `{survey?,player?／center?,radius?,crops?,replant?,plant?,boneMeal?,till?,timeoutMs?}`；till（0–64，2026-10-08 加）：用背包里的锄头把离中心方块最近的 N 格泥土或草方块锄成耕地，只锄上方是空气、4 格内（同高或高一格）有水的，和原版耕地保湿的范围一样；有 plant 时新耕地同一趟播种；没锄头 NO_HOE，范围里没有能锄的 NO_TILLABLE；回执 tilled／notTilled，survey 多报 tillable。范围以玩家、给定点或 Bot 自己为中心，水平 radius 1–16（默认 8）、上下 3 格，只看已加载区块，中心离 Bot 32 格内。认的作物：普通作物（`CropBlock` 或 `#minecraft:crops`，带 age 属性，模组的也算，按 age 到顶算熟）、地狱疣、可可、甜浆果（右键摘，不拆）、有结果瓜茎指着的西瓜和南瓜（摆着的不算）、甘蔗（只砍最底下一节上面那节，底下留着再长）；瓜茎、火把花、瓶子草从不碰。crops 可以写方块 id、作物物品 id（`minecraft:carrot` 找胡萝卜）或 `#标签`。survey:true 只数：每种作物 `{ripe,growing}`、空耕地数、最近一棵熟的位置，瞬时完成。否则：熟的逐个走到够得着的地方（选一个能站、看得见目标的落脚点，掉落在浆果丛或水里也一样）用原生挖掘收掉（瞬间破坏的直接收，西瓜南瓜和可可按挖掘进度，有斧子就用斧子），捡起新掉落（掉在够不着的地方会过一会儿再试，最多 3 次），replant（默认 true）时用作物自己的种子（`getCloneItemStack`，必须是种这种作物的方块物品）在原地补种；plant 给一个种子 id 时把范围里所有空耕地都种上；boneMeal 0–64 是最多能用的骨粉数，用在没熟的作物上。每个动作之间隔一刻，所有方块改动走原生数据包，保护区和其他模组照常生效。默认 180 秒、最多 600 秒。result：`harvested`（每种方块收了几棵）、`replanted`、`planted`、`boneMealUsed`、`notPlanted`（没种上的原因和数量）、`ripeUnreachable`、`dropsLeft`、`skippedWhy`（最多 8 条：跳过了什么、在哪、为什么）、`inventoryFull`、`inventoryChange`。什么都没得做时成功并带 `nothingToDo` 和 survey；有熟的却一棵都没收成报 UNREACHABLE |
| breed-animals | `{animal,survey?,player?／center?,radius?,food?,pairs?,timeoutMs?}`；animal 是实体 id。只找这种 `Animal`、长大了、不在 5 分钟冷却、没在恋爱中的（可驯服动物和马类不处理），一次只喂成对的，pairs 1–8（默认 4）。食物用动物自己的 `isFood` 判断（给了 food 就只用它），背包里要至少 2 个。走到实体交互距离内、看得见，用原生交互包右键喂；喂完等最多 8 秒数新出生的幼崽。survey:true 只数：`total/ready/babies/inLove/cooldown` 和手里能喂的食物。失败码：NO_ANIMALS、NOT_READY（能繁殖的不到两头）、NO_FOOD、UNSUPPORTED（只有可驯服动物或马）。result：`fed`、`babies`、`food`、`unpaired`、`couldNotFeed`、`inventoryChange` |
| build | `{blocks:[{x,y,z,state,rotation?}],replace?,dryRun?,timeoutMs?}`（第 8i 步，2026-10-09）：把一组方块状态像玩家一样盖到世界里。blocks 1–4096 格，都在 Bot 水平 48 格内；state 是 `/setblock` 写法（`oak_stairs[facing=east,half=bottom]`，不带命名空间按 minecraft），用原版 `BlockStateParser` 解析；rotation（0／90／180／270，顺时针）用原版 `BlockState.rotate` 转状态，位置由运行端转好。门、双格植物写下半，床写床尾，另一半由游戏自己放，只写上半／床头报 INVALID_ARGUMENT；双层半砖、流体、没有物品的方块报 UNSUPPORTED。**先比**：已经对的不动；只比 state 里写了的、由点击决定的属性，楼梯转角、栅栏和玻璃板的连接、含水等由相邻方块决定的不比。空气、可替换且没有轮廓的（草、花）直接放；replace（默认 soft）：soft 挖掉有轮廓的可替换植物和同种方块但状态不对的，all 还挖别的方块，none 什么都不挖；液体、带内容的方块（箱子、熔炉、告示牌）和不可破坏的方块从不挖。**备料**：要放的按物品（`asItem`）和背包普通栈对比，缺的话整个动作 MISSING_MATERIALS（`missing:[{item,need,have}]`），世界不动。dryRun:true 只报计划（`toPlace`、`toDig`、`already`、`materials`、`missing`、`skipped`），瞬时完成。**挖**：从上往下，用最快且掉落的工具，原生挖掘。**放**：一层层从下往上，门、火把、灯笼、地毯、植物等挂着或立在别的方块上的放在所有普通方块之后；每块先在原版放置代码里试（物品自己的 `getPlacementState`，六个邻面各 9 个点击点，朝向按从眼睛看那个点算，潜行），只用能得到要求状态的那次点击，看得见、够得着才点，点完核对状态和消耗。潜行点击所以不会打开或拨动当支撑的箱子、门。落脚点不站在还要放方块的格子里。**垫高**：站在地上够不着（比如眼睛以上的顶面）时，在附近地面选一列，用背包里多出来的普通整方块（泥土、木板等，不用建筑要用的、空手挖不出的）原地起跳垫高，最多 8 格，站在上面把够得着的先挖后放，再从上往下挖回去，捡回弹出去的垫脚方块。垫脚的位置先找和身体同一层的（在二楼就先用二楼地板），再找最低的地面；走不到的换下一个，最多 6 次。**上楼板和屋顶**：在垫脚柱顶上放完能放的、旁边有盖好的楼板或屋顶、上面还有活时，直接迈过去（高出 1.2 格以内直接迈，高 1.5～2.5 格先再垫一两格）；要去的站位在走不上去的屋顶上时，在它旁边垫一根刚好能迈上去的柱子。在上面够不着的活先回原来那根柱子下来再从下面盖；活干完走回柱顶，从上往下挖回去。走不回去的柱子改成从下面挖。普通走法到不了、要去的地方比身体低 3 格以上时，允许往下跳，高度以落地后血量还剩一半为限（最多 8 格）。走路时 4 秒不动就换站位或垫高。**临时靶块**：一层里有方块怎么点都放不出要的状态时（墙顶横梁两头没有东西），在它旁边（左右或下面、有东西撑着的空格，可以是之后才放的格子）放一块备用方块当点击面，放好后挖掉，一次一块。默认 240 秒、最多 600 秒。result：`placed`、`dug`、`already`、`remaining`、`skippedWhy`／`skipped`（最多 12 条）、`wrongState`（点了但状态不对的）、`scaffoldUsed`、`scaffoldLeft`（结束时还立着的垫脚：叫停、或到时收尾没拆完的）、`helpersUsed`、`falls`（摔下来又接着盖的次数）、`trace`（最近 60 步）、`inventoryChange`。都做完 succeeded；有做不了的 INCOMPLETE；到时 TIMEOUT，再调一次接着盖（已经对的会跳过）：到时还在柱子或屋顶上的，最多再用 60 秒下来、拆掉柱子再报。身体在半空（刚跳下、刚拆完柱子）时也能开始，落地后再走。摔伤后血量还过半就从落地处接着盖，其他受伤（或摔到不足一半）报 BLOCKED 并停下 |
Bot 不会踩坏耕地：ServerBody 取消 Bot 自己触发的 `FarmlandTrampleEvent`（任何动作里都是），别的生物和玩家照旧。

水桶（2026-10-08，交付计划 3h）：`use-bucket` `{x,y,z,action:"pour"|"scoop"}`。pour 把背包里一个水桶的水倒进 x/y/z（空气、可替换的植物，或能含水的方块如台阶），scoop 用空桶从 x/y/z 的水源或岩浆源舀起。水桶在原版里作用于玩家正看着的方块，所以先找一个视角：pour 依次试目标六个邻块朝向目标的那个面（能含水的邻块跳过，免得水进了邻块），scoop 看水面；每个面试中心和靠边四个点，用游戏自己的视线计算（玩家视线、交互距离）确认正好落在那个面上才发原生 `ServerboundUseItemPacket`，都不行就 NO_LINE_OF_SIGHT、什么都不发。不倒岩浆（只认水桶），极热维度（下界）不倒水。成功要看到目标变成水源、水桶和空桶数量各变一个；什么都没变是 FORBIDDEN（比如保护区），其他情况 unknown。

`place-block`（2026-10-08）：目标格除了空气，也可以是草、蕨、花、薄雪这类可替换的非液体方块：这时直接点那株植物（游戏按玩家放方块的规则替换它），因为它的轮廓会挡住指向支撑面的视线。

`open-container`（2026-10-08）：开箱要空手，免得手里的东西被用掉。快捷栏没有空格时，先用原生 SWAP 把一格（不是当前选中的）挪进背包主栏的空格腾出手，回执 `movedAside` 说明挪了什么；背包也满时才 EMPTY_HAND_REQUIRED。

模组机器（2026-10-09，交付计划 8b 第一块）：`machine-items` `{x,y,z,mode:"list"|"insert"|"extract",side?,item?,count?,slot?,expectedBlock?}`，按 NeoForge 的物品槽能力（`Capabilities.ItemHandler.BLOCK`）用模组机器，不开界面。默认关闭：只认服主在 `config/mcbot-server-control/item-handlers.json` 按 mod id 和确切版本开了的 Mod（方块 id 的命名空间就是 mod id，见 [Mod 适配](mod_adapters.md#通用物品槽适配8b)），`hello.itemHandlerMods` 列出开了的；原版方块和有专门适配的方块（容器适配、附属模组的工作站）一律 UNSUPPORTED，让它们走 `open-container` 和工作站工具。检查顺序：方块所在区块已加载（UNLOADED）、`expectedBlock` 给了就核对（STALE_BLOCK）、通用适配开没开（UNSUPPORTED）、世界边界、看得见（NO_LINE_OF_SIGHT）且在原版交互距离内（OUT_OF_REACH），然后像右键方块一样问服务器让不让用：出生点保护和世界边界（`mayInteract`），再发一次 NeoForge 的 `RightClickBlock` 事件，被取消或 `useBlock` 为 FALSE 就 FORBIDDEN（保护类模组靠这个拦）；这些都在读内容之前，被保护的机器不看也不动。`side` 是 `up`／`down`／`north`／`south`／`west`／`east` 之一，不给就用不分面的那份（`null` 面，一般是整台机器）；这一面没有物品槽时 UNSUPPORTED，并列出哪些面有。list 回 `sides`（每个有物品槽的面和格数，`side:null` 是不分面的）、`slots`（每格的物品、数量、`limit`，空格 `item:null`）、`size`，超过 256 格只列前 256 格并标 `truncated`。insert 要 `item`、`count`（1～2304），只拿背包主栏（0～35）里的普通栈（没有组件改动的）；每格先问 `isItemValid`，再模拟放入，按模拟接受的量真放，真放少收了就把剩下的还回背包；`slot` 指定只放那一格。extract 要 `item` 和／或 `slot`，`count` 不给就是能拿的全拿；先模拟取出，不超过背包主栏还放得下的量，再真取，放不下的放回那一格，放回也不收才丢在 Bot 脚下并判 unknown。回执：`moved`（实际移动的数量）、`slots`（每格移了多少）、`after`（这一面动完后的内容）、`refusedByIsItemValid`、`withheld`（取出时机器里有这种物品、但这一面模拟取不出的数量：可能只从别的面出，或者只放出做好的东西）、`detail`。全部做到 succeeded；做了一部分是 failed + `PARTIAL`；一个都没动是 failed + `NOT_ACCEPTED`（放入）或 `NOTHING_TO_TAKE`／`NO_ROOM`（取出）；背包里没有普通栈是 MISSING_ITEM。物品槽的方法抛异常或答得不合约定（比如模拟返回的比给的还多）：还没真动东西时整个动作 UNSUPPORTED；已经动了一些、出错的是模拟，就按已动的报 PARTIAL；真放／真取时出错是 unknown + `NATIVE_UNKNOWN`，`uncertain` 写这次说不清去向的数量（放入时这些已经从背包拿出，不会还回去，免得多出东西）。运行端只在服务端声明了 `machine-items` 且 `itemHandlerMods` 不空时发布同名工具。运行端给模型的回执摘要保留 `slots`、`sides`、`after`。离线测试：`GenericItemSlotsTest` 37 项、运行端参数转发和回执摘要。隔离服实测（10-09，`scripts/server-machine-items-smoke.mjs`，森罗厨房 1.6.0，26 项）：油壶不分面放入、取出如实，拿错东西 NOT_ACCEPTED；石磨只有上面有物品槽，模拟放入说全收、真放自己定收几个，回执和背包、机器的变化对得上，取不出时报 `withheld`；竹筛没有不分面的物品槽，被拒时列出六个面，从上面能放入，生肉从上下都取不出；没灌水的茶壶不收料；没有物品槽的砧板、原版箱子、挡住、太远、方块对不上都按上面的码拒绝；列出时发的右键事件不改方块、不掉东西。

走门（2026-10-07 第 8f 步）：所有走路（move-to-position、跟随、走近、拾取、睡觉、合成烧炼、travel-to）共用的原版寻路现在允许穿过手能打开的门（木门这类，`BlockSetType.canOpenByHand`；铁门不行，栅栏门还没做）。路线下两个节点里有关着的门、离眼睛 3.5 格内时，先停下用原生右键（`handleUseItemOn`，门自己的交互优先，手里的东西不会被用掉）把门打开再走；身体离开门框、路线不再经过它之后，把自己开的门关上，走到终点时也会关；别人开着的门不动。回执 navigation 里有 `doorsOpened`／`doorsClosed`。

drop-item携expectedMaxStackSize时，每次原生DROP_ITEM前均再核验；数量上限不因实际栈大于64而扩大。Node的give-item可以把一个真实足量栈的最多256个目标分成每批最多64个丢出；容器取物仍要求一个足量源栈和空快捷栏，不跨栈凑数，目标不能超过实际源／目标栈有效上限。

Observation 另带 `sitting`（Bot 是否骑着已安装座位适配认定的座位实体，hello 的 `seatAdapters` 列出已安装的适配）、`sleeping`（Bot 是否躺在床上）和 `time:{dayTime,canSleep}`（一天里的时刻 0–23999；canSleep 是当前维度能用床且不是白天），附近玩家的 entities 条目带 `sleeping`。客户端运行端据此发两种唤醒事件：附近玩家上床 `player_sleep`（接管时已经在睡的不算），Bot 自己起床 `woke`。

表情和外观（2026-10-08，第 8j 步）：
- `emote` `{name,source?,player?,seconds?}`。不带 source 是内置手势 wave（挥三下手）、nod（点头）、shake（摇头）、crouch（蹲起两次）、jump（跳一下）、spin（转一圈），约 1 秒，逐 tick 做，做完把朝向和姿势复原；player 先转向那位玩家（32 格内，否则 PLAYER_NOT_VISIBLE）。带 source 是附属模组登记的动画（`EmoteSource`），立即成功，result `{source,name,seconds}`；到 seconds（默认 6，1–30）、开始别的动作（send-chat、look-at、emote、set-appearance 除外）或身体被移除时，核心调来源的 `stop`。名字只能是 `[A-Za-z0-9_.:-]{1,64}`；没装的来源 UNSUPPORTED，来源不认的名字 INVALID_ARGUMENT。
- `set-appearance` `{source,choice}`：套用附属模组登记的外观（`AppearanceSource`），choice 必须在来源当前的 `choices` 里。只给托管宿主用：运行端带 `--appearance <source>=<choice>`（WebUI 配置页选）时，每次接管后调一次，失败只在 stderr 提示；MCP 不发布这个动作。
- hello 多两项：`emotes:{builtin:[...],sources:[{id,hint}]}` 和 `appearances:[{id,choices:[...]}]`（只列已安装的来源）。
- Observation 多 `weather:{natural,sky,raining,thundering}`（natural 是有昼夜的维度，sky 是头顶看得见天）。运行端据此发 `scene` 唤醒事件：露天时太阳下山（dayTime 进入 11800–13000）、开始下雨、开始打雷各一次，下雨时不报日落；接管后的第一次观察只当基准，从下界等维度回来也重新当基准。

插件开关和插件说明（2026-10-10，交付计划 6c）：
- hello 多 `hints:[{id,text}]`：附属模组用 `McbotApi.registerHint` 登记的用法说明（[Mod 适配](mod_adapters.md#插件说明registerhint)）。服务端只列命名空间下此刻有已安装登记项（容器、交互、工作站、表情或外观来源、拾取记账）的那些，被适配模组没装或版本不对时不列；text 是去掉控制字符的纯文本，最长 600 字符，每个命名空间最多一条。旧运行端不认识这个字段，照常工作。
- 运行端（`client-runtime/src/plugins.ts`）拿到 hello 后、注册工具前统一过滤一次。参数 `--disabled-plugins <插件id,...>`（compat.json 的 adapters id；`--compat-file` 默认用 client-runtime 旁边的 compat.json）：addon 类插件关掉时，去掉命名空间属于它 `requires` 里 mod id 的 `adapters`、`interactions`、`itemInteractions`、`emotes.sources` 和 `hints`；config 类插件关掉时，从 `itemHandlerMods` 去掉它 `config.mods` 的键。某项能力因此一条都不剩（`machine-items`、`use-item`、`use-item-on-block`）就当作服务端没声明，不发布对应工具。`appearances` 不过滤：外观是托管的人在 WebUI 选的，不是 AI 的能力。
- 硬调：服务端模组不变，所以运行端在 `act` 里拒绝（UNSUPPORTED，不发给服务端）：`open-container` 的 `expectedBlock`、`use-item-on-block`／`use-item` 的 `interaction`、`emote` 的 `source` 属于关掉的 addon 插件；`machine-items` 的 `expectedBlock` 属于关掉的 config 插件，或有 config 插件关掉时不带 `expectedBlock`（无法确认是谁的方块）。拾取记账（`storedIn`）照旧如实报告，它不是 AI 能调用的能力。
- `hints` 只留 compat.json 官方插件（命名空间属于某个 addon 插件的 requires）且开着的，其余丢弃；再去一次控制字符、截到 600 字符。说明附在该插件影响到的第一个工具的描述末尾（顺序 `use-item`、`interact-block`、`open-container`、`emote`），前面写明「来自附属模组、只解释这些工具、不授予其他权限」；它不能新增工具、参数或权限。插件不带这四个工具中的任何一个时不发说明。没有 compat.json 时一律不发说明；有插件关掉而读不到 compat.json 时运行端拒绝启动。

## 地面物品、原生拾取与有限采集

Observation新增`groundItems`：`[{entityId,position,stack:{id,count,components,maxStackSize},visibility,visible,onGround}]`。仅观察Bot八格内的实际ItemEntity，按距离及UUID排序，最多32个；`visibility`为visible／occluded／unknown，`visible`在unknown时为null。`onGround`直接来自实际`ItemEntity.onGround()`，不由两次相同坐标或瞬时速度推算。数量截断或无法完整投影的地面栈使`groundItemsTruncated:true`，不能把未返回的UUID解释为区域里不存在。

`pickupCursor`是最新原生收据seq；`pickupOldestCursor`是仍可完整读取的最低**前置游标**（首条保留seq−1；空历史等于最新游标）。`pickupReceipts`最多保留256条，格式`{seq,entityId,position,stack,pickedUpCount,sessionId,controlGeneration,dimension}`。stack是实际获得片段，count等于pickedUpCount并保留完整组件与实际上限。事件为NeoForge21.1.217的`ItemEntityPickupEvent.Post`：明确归因到当前真实身体，数量取`getOriginalStack().count-getCurrentStack().count`，在discard／空栈计数回填前记录。不能归因的原生事件推进游标并清空历史，制造可见缺口而非编造数量。任务游标小于pickupOldestCursor、seq断档或上下文不匹配必须停止，不自动重试。

pickup-item成功result为`{entityId,pickedUpCount,pickup:"confirmed",requestedCount,remainingCount,stack}`；部分原生拾取也只报告真实片段。失败保留真实已获得量和`code`，没有Post时为`pickup:"unconfirmed"`，不猜消失实体的剩余量。其它玩家拾取为PICKUP_TAKEN，未知消失为PICKUP_UNKNOWN；被原版合并进附近同物品掉落（实体被丢弃、1.5 格内有同物品同组件的掉落）为PICKUP_MERGED（普通失败，没捡到任何东西，客户端重新观察后去捡合并后的那个实体），变体或上限变化为STALE_ITEM；危险／掉血／无进展为BLOCKED，移动过远为TARGET_MOVED，原生延迟／拒绝等未确认在有限时限内停止。收据也覆盖dig／walk期间的自然拾取；Node按seq累计一次，不再把pickup-item返回量重复相加。

2026-10-07（第 8a 步）起资源按方块标签认，模组的也算：原木是 `#minecraft:logs`（不含去皮原木和 `_wood`／`_hyphae` 六面树皮木），矿石是 `#c:ores`，石料是 `#c:stones` 加上原版 `minecraft:stone`／`deepslate`／`granite`／`diorite`／`andesite`；带方块实体的不算。blockIds 可以是方块 ID（必须属于上面三类，否则 UNSUPPORTED），也可以是标签（`#c:ores/iron`），标签只用来缩小范围。每个候选多带 `kind`（`log|ore|stone`）和 `drops`：服务器用顶级镐（原木用斧）不带时运、分别带和不带精准采集，各按掉落表掷 12 次算出的 `{item,preference,least}`，preference 是 `any|silk_touch|no_silk_touch`，least 是这几次里每块最少的数量（偶然掉落为 0）；矿石只报普通产物，不报精准采集掉的矿石块。实际数量仍以原生拾取回执为准。陪挖的拾取授权按目标矿石的同一份掉落表核对。不能区分玩家建筑与天然地形。明确用户请求／授权区域仍由Agent判断，发现不等于破坏授权。

有限任务先筛选与目标产物匹配的冻结候选，矿石须完整工具评估／准备能力、已知掉落效果与非精准工具；服务端资源引用挖掘仍在执行前核验实际主手及原生位置相关采掘资格。首批不支持精准矿石块，不按工具名称写等级表，不保证数据包或Mod未改变掉落。目标数量按原生新拾取回执累计；铜的多产物、时运等可导致一次真实拾取超过目标，以`overage`如实记录，到量后不再开挖新候选。实际掉落不匹配、无工具、未知或部分完成均保留真实结果，不扩大区域或自动重试。

nearby-resources按固定center的水平圆形半径和y±2扫描，最多845个位置、150000次地形读取；只用已加载区块，不隐式加载未知区域。发现与后续approach／dig一致禁止`pos.y<floor(Bot.y)`、方块实体、玩家身体或任何附近玩家脚底支撑、液体／危险邻居及上方重力方块。候选只返回当前Bot视线通过者：`{position,id,properties,targetToken,distance,visible:true,requiresCorrectTool,suitableToolSlots,recommendedToolSlot?}`；工具槽仅0–8，由真实采掘工具适用性／速度提供，不凭物品名字猜。候选截断／预算耗尽通过truncated与budget明示。原木例外（10-07）：视线只被树叶挡住的原木也算候选并标`visible:false`（被树冠整棵包住的云杉），approach-resource对原木目标接受“去掉树叶后有视线”的站位；dig-block仍按真实视线判定，挡路的树叶由Node采集任务先敲掉（不当作资源）。整棵树（10-07）：nearby-resources可带`wholeTree:true`（center可离Bot最多16格），只返回离center最近的那一整棵树的原木（最多256节，不受maxResults限制），回复带`wholeTree:true`。原木候选都带`tree`编号：挨着的原木（含斜对角）连成一段，底下踩着地面（泥土、石头、红树根，不是原木、树叶或空气）的一段是树干，悬空的一段（隔着树叶的树枝、斜伸的金合欢／樱花枝）归到4格内最近的树干，连不到树干的不算树；两棵各自扎根的树树冠挨着也分开。gather-resources带`wholeTree:true`时不填count／stacks，目标就是这些树的全部原木，默认时限按节数算（每节4秒，120～600秒）、步数预算最多1024。`trees:1..8`（只配wholeTree）一次找离center最近的几棵、一次提交砍完；连不到任何树干的悬空原木（根已经砍掉的剩余部分）彼此4格内算一棵；整棵树扫描不按“低于脚底平面”排除原木（Bot站在比树根高的地方），走近和挖时仍按当时站的位置检查。同一任务里路过顺手捡到别的物品（树苗、木棍）只记进`unexpectedPickedUpCount`／`items`，不算目标、不中断任务。

ResourceTargets随机token固定120秒、最多256个，绑定session／generation／实际维度、坐标、完整BlockState及已加载Chunk实例。普通资源方块没有BlockEntity实例，同chunk同状态替换不声称可检测。Node的一个resourceRef冻结整批候选，30秒内可提交；执行不补扫、不追加候选或目标，不挖路／垫高／下坑／搭桥／传送。

### 可选陪伴拾取保护（2026-10-03已验证首批）

新增能力标记`companion-pickup`只供Node门控，不是可执行动作；`act.name:"companion-pickup"`明确返回UNSUPPORTED，不会落入通用移动分支。当前仍为33个MCP工具，标记本身不增加工具。服务端只扩展pickup-item，不新增自动挖矿、dig guard或矿石目录。

`companionGuard`格式为`{player,expectedEntityId,maxDistance}`，三个字段均必需；player为1–16字符游戏名、expectedEntityId为完整UUID、maxDistance为1.5–4格且服务端不补默认。开始本次拾取时绑定真实ServerPlayer实例；执行前与每tick核验该实例、UUID、维度、生命和连接。身体与指定掉落实体必须同时在该玩家**当前**位置的maxDistance半径内；初始身体已更远也拒绝。路线候选、剩余路点、下一驾驶步与带0.2到达裕量的站位均限制在玩家半径内，仍保留全部原平地／危险／租约核验。

玩家仍为同一存活实例而身体、掉落或路线超出该半径时，返回`COMPANION_OUT_OF_RANGE`；玩家离线、死亡、换维度、同名UUID变化或真实实例替换返回`STALE_COMPANION`。Node只可把前者作为结束该次旁路拾取、重新核验后回到跟随的信号，不重试同一失败物品；身份失效、危险、unknown、无路等不因陪伴模式自动重试。外部pause／stop／失租约仍废弃旧步骤与迟到回执，不借此恢复旧意图。

guard只阻止后续驾驶，不能回滚普通物理已经发生的碰撞拾取。每tick在picked成功之前先核验anchor；如果原生Post已证明获得物品、之后anchor越界或失效，则失败result仍保留实际pickedUpCount／stack与`pickup:"confirmed"`，不伪造0或以成功为由继续越界。没有Post就没有获得证据。指定物品过滤用于主动追逐，不改变原版可能自然拾取其它相碰物品的规则。

本批Java21 build为**387项离线检查**（前批330＋CompanionPickupTest57），日志见`output/server-escort-java.log`（本地证据未随仓库分发：`../output/server-escort-java.log`），其中保留首次测试helper编译错误及修正后的最终成功。Node可选拾取已接线，143项Node、23项真实程序矩阵、Claude-b／Codex各5阶段通过；证据见[跟随拾取验收](archive/server_escort_validation.md)，不把有限样本外推到任意玩法。

任务开箱额外携可选`targetToken`，原子旧调用仍兼容只比较方块字段。任务交物额外携`recipient`／`expectedEntityId`，游戏端在原生drop前再次核验玩家身份和1.5格可见距离；这只保证丢出时指向已授权接收者，不能推导后来一定由该玩家拾取。

原生菜单白名单为 ChestMenu、HopperMenu、DispenserMenu、ShulkerBoxMenu、AbstractFurnaceMenu；对应当前方块白名单为普通箱子／陷阱箱、木桶、漏斗、发射器／投掷器、潜影盒、熔炉／高炉／烟熏炉。其它 GUI、工作台、交易或内容 Mod 特殊菜单不宣称通用支持；继承白名单类仍需后续具体 Mod 验证。

内容Mod窄Adapter `IronFurnaceAdapter`（独立附属模组 `mcbot-iron-furnaces`，不在核心里；没装它时核心不认识铁炉）显式限定 Iron Furnaces4.3.2／MC1.21.1／NeoForge21.1.217 的`ironfurnaces:iron_furnace`、确切方块／实体／菜单类及55槽契约，只接受普通未点燃炉与普通菜单。机器库存19槽核对真实实体，玩家SlotItemHandler经InvWrapper核对实际Inventory与原索引；隐藏工厂／升级槽不成为任务来源。原生交互仍由Mod useWithoutItem→openMenu完成，不直接替它打开GUI；高级炉等级、Factory／发电、运行中的lit/type变化、GUI设置不自动支持。实际支持证据见[D验收](archive/server_content_D_validation.md)。

## Node 与宿主约定

持续陪伴工具仅在 `follow-companion` 能力存在时发布：`companion-mode` 接受 `{action:"follow"|"wait"|"pause"|"resume"|"stop"|"guard",player?,distance?,pickup?,guard?,say?}`，只有新follow允许指定player／distance／pickup。follow先核验附近玩家身份，返回受理状态，原生动作在后台持续；wait原地等候，两者都持有与有限任务共用的写锁。切换先确认旧动作停止。

跟随（和原地等待）是持续状态，不是任务（10-10 起）：用身体的工具（走路、采集、合成、建造、进食、表情、睡觉……，`mcp.ts`的`bodyTools`）开始前，运行端自动让开——确认身体停止、释放写锁、保留意图，状态为`paused`并带`suspendedFor`（工具名）和`reason`；该工具／反射结束、身体上没有别的东西在跑（没有运行中的操作和容器／采集／生存任务、没有打开的菜单、没睡着）并空闲约0.8秒后，运行端自己恢复同一个意图（重新核验会话和玩家身份），模型不用调`resume`。返回`running`、结果稍后用task事件到来的操作，在它终止时才恢复；同时有几个在跑，按最后一个结束算。睡觉在醒来后恢复。恢复时玩家不在附近：继续让开、给一次companion事件，玩家回到附近自动接上，不算受阻。让开期间任务让身体停止过（控制代次后移）不算失控，同一实例／会话／世界／维度即可沿用意图。模型显式`pause`是手动暂停，一直到`resume`（让开期间再pause也转成手动暂停）。只有这几种情况真正结束跟随：玩家叫停的`stop-action`（丢弃意图，不恢复）、`companion-mode stop`（结束跟随／等待，不打断正在做的其他任务，回执`state:"stopped"`并说明已结束；本来没有跟随时原样返回）、显式换成别的`follow`／`wait`。`guard`动作（要`guard`参数：布尔或保护选项）在当前跟随上开／关／改保护，选项逐项并到现有选项上；正在跟随时按新选项重启服务端的follow-companion，让开期间只改意图、恢复时生效；等待中没有保护，会报`INVALID_STATE`。

`get-companion-mode` 与 `get-status.companionMode` 给出 `{state,intent?,player?,distance?,guardEnabled?,suspendedFor?,stage?,operationId?,code?,reason?}`。state为idle／following／waiting／paused／blocked／stopped；intent为follow／wait，stage为starting／active；`guardEnabled`是跟随意图上的保护开关（保护进行时另带`guard`战斗状态）；`suspendedFor`有值表示跟随正为某个工具让开、会自动接上，没有就是手动暂停。让开和恢复都记`companion_state`事件。受理不代表已开始移动。后台500ms监视更新状态，不让模型循环发起有限跟随；靠近／走远的正常切换不唤醒模型，受阻后给一次companion事件。显式切换记录companion_state供后续上下文，非唤醒事件；已向模型交付的终态按session／operationId去重，查询和异步通知不会各触发一轮。

stop-action立即清除陪伴意图（反射抢占和`set-reflexes`改策略只取消正在做的任务，让开中的跟随意图保留）并推进身体控制代次；确认停止后无需等待旧动作HTTP回执才允许新任务，迟到回执由本地epoch及身体代次共同丢弃。后台观察也携观察开始时的epoch，暂停／切换前开始的旧观察不能误判新意图失控，转换中不启动新后台观察。失租约、宿主／Agent退出、身体会话变化终止意图且不保存为可恢复任务，重启只接受新的明确请求。持续路线采用文末统一导航预算；目标移动的重规划最少间隔500ms，行走3秒无进展触发有限重规划，搜索停驻另计；默认跟随只跟随，可选拾取由Node在原生follow与受保护pickup-item之间调度，见上节已验边界，不加入自动采矿／陪挖。显式有限采集另走以下入口。

follow的可选pickup仅在companion-pickup能力存在时发布，`items`明确1–8个物品ID、`radius`默认3且1.5–4，distance≤radius。靠近玩家waiting时选择当前可见白名单掉落，全程持外层token，单UUID子任务不另占锁或释放父锁、不发逐物品task事件。停止换代必须同一instance／session／world／dimension的下一代；观察revision独立防旧读穿越转换。暂停／恢复保留配置，wait／stop清除；范围越界复核同一玩家后回跟随，其他失败先确认停止再blocked。状态增加activity与pickup统计，格式见[运行端说明](../client-runtime/README.md)；外层按原生游标分组件变体累计，子任务不重复加数，自然收取其他UUID不导致单件任务误停，缺口标最后确认量。

有限采集入口仅在相关能力齐备时发布。discover-resources接受`{blockIds,radius?,maxResults?}`并返回冻结resourceRef；gather-resources接受`{resourceRef,item,count?|stacks?,say?,maxSteps?,timeoutMs?}`；collect-items接受同一数量／预算字段及`radius?`（默认4、1–6），只收本次观察中的固定UUID集合、不挖掘。两类任务返回running受理结果，由程序后台执行，聊天继续；与陪伴／容器任务／原子写入共用锁，stop-action同步撤销后续步骤，完成不自动恢复陪伴。

collect-items的授权范围是初始Bot位置为中心的radius球，冻结其中匹配物品的已观察UUID；gather-resources收取固定扫描区内的匹配地面物品及随后产生的掉落，收据位置按网格中心水平radius＋0.75格、距floor(center.y)最多3格核验，为方块内生成的掉落留边界余量，不借此增加待挖候选。拾到范围外、其它物品或不兼容变体时记录实际额外结果并停止，不能算入目标。

陪挖（`companionMiningGuard`）的单块子任务另有规则（2026-10-06）：Bot位置、路线和站位只能在绑定玩家的半径内；挖出的掉落物会弹出滑动，允许离玩家半径＋1.5格（`DROP_REACH_MARGIN`，三维距离），同时必须在源矿3格内。运行端认领掉落用同一余量。站不进圈内又够不着的掉落以拾取失败回到跟随，不追出圈外。见[陪挖验收](archive/companion_mining_validation.md)。

count和stacks必须二选一、1–256整数，最终解析目标最多256，不静默截断。用户省略数量时由Agent自主选择合理有限count并在say中说明；`1组`用授权地面源或首次真实原生拾取栈的有效maxStackSize。初始没有实际栈时，可先在冻结授权候选内挖取并收取首份原生掉落后固定variant／上限／目标，开工时如实说明数量未解析；不使用旧背包变体或从block ID猜上限。变体／上限变化停止，不能重新换算已承诺目标。

目标是`quantity:"newly-picked"`，不是补足背包，也不是破坏方块数。result区分targetCount、pickedUpCount、minedBlocks、steps、overage、totalNativePickedUpCount及unexpectedPickedUpCount；unknown／cancelled仅保留lastConfirmedPickedUpCount并标partial-or-unknown。自然一次拾取可能超过目标，按原生实际量报告overage，不截断收据。默认maxSteps64（1–256）、timeoutMs60000（1000–120000）；候选／动作预算不足给部分结果，不滚动采集。拾取前有界等待落地稳定：新onGround=true后至少200ms／4次采样；旧身体缺该字段时至少400ms／8次采样，整个等待最多2500ms并受任务期限限制。

已取得当前上下文、指定UUID的新增完整原生收据时，可处理自然拾取导致旧实体消失或已知拾取移动失败的竞争；没有收据、unknown／取消、保护拒绝、游标缺口或变体／会话变化不能吞错误。BLOCKED也可能表示受伤或危险，目标未到量时不会因此继续采集。普通跟随未迁移自动陪挖、战斗、任意矿石采集或整树识别。

此前有限采集批次最终Java21 build通过**330项离线检查**；历史B为80项、第二批交互为163项、持续陪伴为227项，均保留为各自当时的结果，不与当前重复相加。该采集批次程序矩阵及真实Claude-b四阶段的最终证据见[有限采集验收](archive/server_gather_validation.md)，不是当前可选陪伴拾取批次的实测证据。33工具是能力齐备时的接线数量，不代表逐一验收所有参数、任意Mod或自动陪挖。

`client-runtime --body server --connection-file ... --username Claude --world-id ...` 接此协议，原 `--body client`／默认路径保留。stdio MCP 仅发布 capabilities 允许的动作。

死亡后的独立显式入口（在仓库根目录运行）：

```pwsh
node client-runtime/dist/main.js --body server --respawn-only --connection-file <连接文件> --username Claude --world-id <世界标识>
```

此命令只执行 hello→respawn，不开启 MCP、不写租约控制文件、不调用 claim，不能带 --hosted。返回确认后还须显式启动新的 MCP 取得新 lease；原失效 MCP 保持终止态。重生请求超时先查 hello／实际角色，不盲目重试。

托管驱动器（`scripts/companion.mjs`，WebUI 启动托管也走它）从 2026-10-08 起在启动 Agent 之前做同样的 hello→respawn 一次（`respawnIfDead`）：角色死了就原生重生，下一轮提示 Agent 自己死过、东西可能掉在死的地方；活着的角色服务端用 INVALID_ARGUMENT 拒绝，驱动器当作“不用重生”；服务器没开或身份不符只记日志，照常启动。它不 claim、不重试，驱动器自己仍然不在托管途中重生；10-10 起 `start-server-play.mjs --wait`（WebUI 启动托管用它）在驱动器外面做：驱动器带 `--reconnect`，收到 `disconnect` 事件（死亡、换世界、游戏关了）就撤销（不带 leave）并以 75 退出，启动脚本每 2 秒重读连接文件再做一次 hello→respawn，能接管了（`alive` 或 `respawned`）才重新启动驱动器、重新 claim；`SINGLEPLAYER_NOT_LAN`、`GAME_PAUSED`、连不上都只是继续等。仍然不靠自动重新 claim 绕过租约：每次都是新驱动器的显式 claim。C 的真实模型陪玩与 D 的内容 Mod 验证分别验收，不由这些能力名称代表完成。

ServerBody 取得租约后，将本机 `runtimeDir/server-control-<username>.json` 原子写入：`{protocol:2,backend:"server",connectionFile,worldId,username,instanceId,sessionId,leaseId,stopToken,controllerId,chatCursor}`。不要写连接 token；宿主通过所选 connectionFile 读取。退出时只删除仍属于自身 lease 的文件，日志／MCP 工具不能泄漏 stopToken。宿主必须核对配置路径、世界、角色、服务实例与当前租约，避免旧控制文件影响其它任务。

普通 MCP stop 更新本地 generation，已发出的旧请求不能因迟到回执变成新动作；并发 stop 不等待 act 返回才能发送。宿主收到新的叫停事件后使用 revoke，让旧 MCP 进入终止态，并取消／结束旧 Agent 轮次；后续新任务明确重新接管。只取消模型推理不算停止身体。宿主 watch 从控制文件 chatCursor 起跳，跳过接管前历史与自己消息；watch 的非停止聊天仍由现有事件通道正常处理，避免重复唤醒。

R4增量：容器多步骤任务要求Body同时提供acquireTask/releaseTask。cancel先废弃旧步骤并保留写锁，只有最新匹配停止句柄的`stopped:true`确认才能收尾；停止失败不准新任务写入。停止确认后首新任务不等待旧HTTP回执，旧finally／旧停止确认不释放新任务锁。迟到可靠部分回执仍保留确认数量，迟到unknown不降级为确定失败或无副作用。`stopped:true`确认的是控制输入与任务被停止；正常重力／惯性不被冻结，最后实际物理位移另测，见[混合回归](archive/server_mixed_validation.md)。

明确的动作参数／BUSY 拒绝不废弃当前租约。心跳只核对 controlGeneration，不静默同步外部改变。停止请求未确认时，Node 终止旧控制并尽力 release，防止本地取消记录掩盖远端仍执行的动作；stop 的明确可恢复拒绝转为 STOP_UNCONFIRMED，其余保留原失联／失租约错误码。不自动重试 stop／act 或 claim。

停止导致 MCP 退出后，宿主可缓存刚撤销的只读 watch 能力，等新的人工任务再启动 Agent／MCP 并明确 claim；不得因退出自动恢复旧任务。新任务须只投递一次。只有最近一份失效租约可继续 watch；服务端另保留最多 64 份历史用于幂等撤销回执，不保留无界历史。新租约接管后旧能力不能观察或撤销新控制。

宿主在 Agent 取消收尾期间接受并排队新明确消息，watch 拒收则保留待投递消息；后续 stop 优先取消此前排队任务。ServerBody 明确空闲聊天使用120ms短合并、350ms上限，半句保留有界等待；旧 Mineflayer 批处理不变。已向模型交付的终态通过 `task-delivered-<username>.json` 按 journal session＋operationId 标记，宿主派发前过滤，不能用全局 consumed 游标误吞相邻聊天。模型事件只含摘要，完整终态另存本机 `operations-<username>.jsonl`（5MB轮转一份 previous）。进程强制退出遗留文件只有在 pid 已退出、控制者身份和原文件字节均匹配时才由宿主清理。

2026-10-03再补撤销请求在途竞态：开始revoke即保留新明确消息，等待撤销结束再尝试投递，不因stopped状态尚未收到回执而推进游标丢失。回执暂停的可控测试先失败后通过；并发Driver回归另行通过。

测试必须包含旧控制者、丢心跳、MCP 进程退出／卡住、迟到 act、同 ID 重试、角色保留与明确重新接管。RCON 只准备夹具和独立核对，产品请求不能调用 RCON。

## 生存Alpha第一批增量（2026-10-03）

新增原子能力`swap-inventory`／`eat-item`和只读`survival-state`／`assess-tool`。Node按能力提供`get-survival-state`、`assess-tool`、`prepare-item`、`eat-food`、`set-reflexes`，该批完整38个MCP工具。策略是运行端状态，不是服务端另起的控制者；游戏端不自发抢占或推进generation。

- `swap-inventory`：`{sourceSlot:0..35,hotbarSlot:0..8,expectedSource:{id,count,components,maxStackSize?},expectedTarget:{...}}`。不同逻辑槽，必须当前自身库存菜单、空carried，按真实backing identity映射原生槽，核验双向mayPickup/mayPlace和实际容量；使用原生SWAP，不直接赋值库存。成功核对完整交换；原生发出后的回执异常unknown，不重放。
- `eat-item`：`{slot:0..8,expectedItem,expectedCount,expectedComponents,expectedMaxStackSize?,timeoutMs?}`。原生主手使用与原生时长，绑定槽位、完整初始栈、本次Finish和最终结果；成功`consumedCount:1,consumption:"confirmed"`。已确认部分结果保留`lastConfirmedConsumedCount`，取消／错误不能改成无消费。停止撤销关联并结束原生use，旧Finish不能启动新动作。
- 自身库存观察的`componentsComplete:false`必须省略components并给出原因；已编码完整物品仍含精确components。未知不能伪造`{}`；涉及该栈的写入拒绝。当前未放宽容器／地面实体的完整快照要求。
- 工具policy为`fastest_valid|conserve_durability`，默认保留2耐久；dropPreference为`any|silk_touch|no_silk_touch`。返回eligible true/false/null及基础资格依据（2026-10-07 起模组方块和工具也按原生 isCorrectToolForDrops 判断，另标 `modHooks:"unassessed"`；模组附魔的掉落效果仍算未知），预计ticks不含所有玩家／Mod钩子，原生执行重查。nearby-resources保留0..8的recommendedToolSlot，另可带0..35的recommendedInventorySlot。
- `set-reflexes`使用预期revision避免旧决策覆盖；策略改变先阻断／取消旧任务并确认停写。默认自动进食，默认防卫仍未实现且公开supported:false。硬停清armed，查询不复活。普通进食借父token只在安全间隙执行，未知结果向同一仲裁器上报并解除自动授权；停止确认也不代表允许自动重试该未知动作。

该批实际证据和限制见[第一批验收](archive/server_survival_alpha_validation.md)；下节记录第二批新增合同，其实服验收另行记录。

## 生存Alpha第二批：导航与防卫合同

`navigation-3d`是能力标记，不是可执行原子动作。move／follow／approach／pickup复用同一个原生导航器。只读已加载地形，使用实际碰撞形状、站立支撑、身体扫掠和实体阻挡；以原生前进和跳跃输入执行，不传送、不挖路、不搭桥。半砖、楼梯、一格跳上与最多2.5格的有界下落分别经过起跳净空和落地核验。任意离地不等于获授权跳跃；硬停止清除前进和跳跃，已有惯性与重力仍按原版继续。

搜索分tick续算，单片最多64次展开，2ms是软时间目标（单次地形核验不可中途暂停），另有4096节点、32768候选边、192路点和地形读预算。有限动作总期限与行走无进展计时分开；搜索时停驻不触发行走卡住判定。实际预算诊断在完整动作回执的`navigation`中，不能把软目标说成硬实时保证。动态地形执行时重查，卡住／障碍仅有限重算。游泳、梯子、开门、跨沟跑酷和有伤下落未交付。

`survival-state`增加`dangers`及`threats`。前者包含火焰、液体、氧气、下落和默认低血事实；后者包含服务端tick、8格范围、complete标志及最多24个实体的UUID、类型、分类、敌对依据、是否锁定自己、距离、视线、存活、爆炸准备和防卫资格。未知Mod实体不能按名字猜敌对；当前原版明确敌对清单或原生攻击自身证据可获得资格，玩家及友军始终排除。单实体事实读取异常返回明确null、unknown、factsAvailable:false，整体complete:false，不能当作安全或拖垮全部观察。

- `defend-entity`：`{entityId,expectedDimension,slot,expectedItem,expectedCount,expectedComponents,expectedMaxStackSize?,maxDistance:1..3,minHealth:1..20,maxAttacks:1..3,timeoutMs:500..5000}`。只做近身有限防卫，不追击。当前手持、身份、维度、资格、视线、原生触及范围、攻击冷却、潜在群伤、生命阈值和租约在每次挥击前核验。未知Mod武器、未验证的附魔／行为组件拒绝；当前仅验证裸手与普通原版剑斧。
- 防卫回执分开返回`attemptedAttacks`、`confirmedHits`与`confirmedDamage`。伤害仅从绑定本次同步原生攻击的直接玩家伤害事件确认；挥击或目标血量净变化不能替代收据。取消保留可靠部分结果；原生调用后的未知副作用不得降级为确定失败。尚未终结时用unknown；已取消的终态保持cancelled并携sideEffects:unknown及可靠部分量，均禁止重放。
- 同步原生攻击scope保持到调用真正返回，撤销执行意图不能提前清掉它。攻击／伤害原生事件入口再查同一操作授权，并关闭本有限防卫scope的横扫。若Mod回调在原生调用内部重入stop／revoke等，先撤销授权但返回`STOP_UNCONFIRMED`，调用栈结束前不能确认停写或接新控制。同期已经发生的伤害Post仍可记入旧操作的可靠部分结果，scope结束后的迟到事件不计入；这类只读记账不恢复任何动作。
- `retreat-from-entity`：`{entityId,expectedDimension,distance?,timeoutMs?}`。默认目标敌我距离4格，允许1.5–6；自身从起点水平移动最多4格、高差最多2.5格，仍走同一导航和安全检查。每步核验同一威胁，禁止向其明显靠近。成功返回实际位置、距离、requestedDistance及travelLimit；无安全路或超时失败，不声称一定逃生。

有`defend-entity`能力时，MCP新增`defend-self({entityId?})`，完整工具数39；低层attack／retreat不额外发布给模型。显式与自动防卫共用威胁选择、背包准备、任务锁和原生回执。低血或点燃苦力怕先尝试安全退让；战斗中明确RETREAT_REQUIRED可转入一次重读后的退让，unknown不能借此继续执行。

`set-reflexes`新增autoDefend、defenseRadius（1–3，默认3）、lowHealth（1–20，默认8）、excludedEntityIds（最多64个UUID）、maxAttacks（1–3，默认2）和defenseTimeoutMs（500–5000，默认3000）。有效策略公开defenseSupported；旧身体没有该能力时autoDefend为false。变更仍带expectedRevision，先确认旧活动动作停止，再应用新策略，不恢复旧任务。

### 保护玩家（8h，2026-10-08）

能力标记`companion-guard`。`follow-companion`多一个可选参数`guard:{radius:3..12,lowHealth:4..16,bow,shield}`（都可省，默认 8、8、开、开），跟随运行中每个游戏刻由服务端判断，不经过模型：

- **打谁**：玩家身边`radius`格内的原版明确敌对生物，或者正在打玩家、打 Bot 的生物（Mod 生物只在后一种情况下算）；先打正在打玩家的，其次打 Bot 的，再按离玩家远近。玩家、有主人的动物、起了名字的、拴着的、村民和商人、不是怪物的傀儡、悦灵、盔甲架一律不算目标。
- **怎么打**：够得着（原生交互距离加视线）就用热栏里最好的原版剑或斧挥，冷却满了才挥，挥击在自己的原生攻击 scope 里，伤害只按原生事件记账，横扫照旧关闭；够不着就走过去，路线不出玩家身边`radius+4`格（最多 16）。远处的远程怪、苦力怕、飞行怪，或者走不到的，有弓有箭就拉满弓射（按原版箭的速度、阻力和重力算仰角，按目标速度提前量），弹道上 1.2 格内有玩家、宠物、村民就不放箭，一直拉着等。武器只认原版物品、原版附魔、已知数据组件；带火矢的弓不用。剑、弓在背包主栏时先换到热栏，盾在副手空着时换进副手。
- **盾**：等冷却时对着正在打 Bot 的怪举盾；血少撤退时也举。挥击前放下。苦力怕已点燃（快炸）、按剩余引信（30 减去已膨胀的 tick）以 0.2 格每 tick 的速度、不出玩家身边的范围、要跑到爆炸伤害范围（爆炸半径的两倍，带电再翻倍，另留 1 格）之外却跑不出去时，原地不动举盾面朝它（状态 `shielding`），正拉着的弓先放下；爆炸后或苦力怕不见了就放下盾。跑得出去照旧撤退，不举盾（举着东西不能冲刺）。“跑得出去”只按空地直线估算，墙和坑要试了才知道，所以两种情况也改成原地举盾：往外撤被拒绝（走不通）；引信只剩 `SHIELD_LEAD`（10）tick 而身体还在爆炸范围内（盾举起 5 tick 后才挡得住，留出余量）。爆炸伤害范围内（不再只是 5 格）的点燃苦力怕才触发。保护状态多 `shields`（开始举盾的次数）、`lastShield`（`OFF` 关了盾、`NO_SHIELD` 手上没盾）；盾因远程威胁举着时还有 `blocking`（`RANGED`、`PROJECTILE`），见下面「保护举盾挡远程」。
- **撤**：血量不高于`lowHealth`且 8 格内有怪时往外撤（玩家在怪的另一边就撤到玩家身边，否则背离怪走 5 格，都不出范围），回到`lowHealth+4`以上才再打；苦力怕点燃且在 5 格内时也先躲。
- 打不到的目标 5 秒内不再追；一场打了 15 秒没打中就放下。没事可做时交还给普通跟随，跟随路线重新算；保护跟随挨打不再结束跟随。
- 回执：`follow-companion`运行中的结果多一个`guard:{state,target,targetId,hits,damage,shots,kills,retreats,options}`，`state`是 idle／approaching／fighting／aiming／shooting／repositioning／shielding／retreating／evading；跟随本身的`state`多一个`guarding`。
- 兜底：Bot 造成的任何伤害（挥击、箭、其他）落到上面那些不算目标的实体上时，服务端直接取消这次伤害。

运行端：`companion-mode follow`默认带保护（`--guard on|off`、`--guard-radius`、`--guard-low-health`、`--guard-bow`、`--guard-shield`给默认值，WebUI「配置」页的「保护玩家」一栏和`scripts/start-server-play.mjs`的`--guard*`参数转过来），请求里`guard:false`关掉、对象逐项覆盖；身体没有该能力时不带，明确要求就拒绝。保护时运行端只把「开打（20 秒内只报一次）」「打完了，打倒几只」「血少在撤」「躲苦力怕」作为`guard`事件唤醒模型，`companion-mode`状态仍是 following／waiting，另带`guard`。保护进行时 3 格近身自卫不插手；自动进食和近身自卫遇到普通跟随／等待时改为先让开、处理完再恢复同一个意图（以前是取消）；让开期间任务在跑时，反射先取消那个任务（不重放），跟随意图保留。让开期间服务端的保护跟着跟随操作一起停了，只剩 3 格近身自卫。保护是跟随上的开关，用`companion-mode guard`改，不必重新follow。

同一仲裁器在普通观察之外独立采样紧凑生存状态；模式切换、慢普通观察与原生战斗等待不能挤掉感知。防卫抢占前阻断新普通写入，撤销容器／采集／陪伴／进食后等待身体停止确认，再获得写锁；不新增第二个控制者或偷偷接纳外部generation。人工停止解除armed，读状态与危险仍存在都不能重新授权。危险事件只按有意义的状态变化生成，不因距离微调、每次挥击、空气补回或跳跃下落数值变化反复唤醒模型。

分段时间字段sensedAt、stopRequestedAt、stopConfirmedAt、actionRequestedAt、actionAcceptedAt记录运行端时间；actionAcceptedAt是收到回执的时刻，不是服务器最后实际写入tick。真实反应延迟与更长运行的结果须看本批验收，工具数量不代表通用Mod、任意武器或全地形支持。

### 常驻保护（8m 第一步第一块，2026-10-10）

设计见[陪伴状态设计](companion_state_design.md)第 5 节。能力标记`guard-duty-fenced`（第一块用过的`guard-duty`已不再声明）：保护不再挂在`follow-companion`操作上，而是租约上的一项常驻职责，战斗逻辑和上面 8h 的一样（`GuardCombat`），并支持下面的请求排序和原子清除。

- **方法`guard`**（要租约，校验 instance／session／lease，不看`controlGeneration`；**不是操作**，不占操作 ID 预算）：`{player, expectedEntityId, options?}`打开或替换（`options`同 8h 的`guard`对象，省略用默认值），玩家不在 32 格内报`PLAYER_NOT_VISIBLE`，UUID 不符报`STALE_TARGET`；`{off:true}`关掉。所有请求还必须带`guardRevision`，回执带同一序号。运行中的普通操作不阻止配置；HTTP 队列仍可能报`BUSY`，原生写入尚未返回时不能确认停稳或开启替代职责。
- **配置排序**：每份新租约从 0 开始记录`guardRevision`；每次配置及`stop(clearGuard:true)`携带严格递增的正安全整数，不复用序号。`guard`的序号小于或等于已接受序号报`CANCELLED`；接受序号后即使后续参数／原生检查失败也不回退。顺序只看序号：后到的旧开启不能越过新的关闭或`stop(clearGuard)`；普通 stop 保留保护意图，所以它前后到达的配置（开或关）照常生效。运行端同时撤销等待观察／聊天的旧配置，并丢弃被取代的迟到回执，不自动重放开启。
- **生命周期**：普通`stop`（代次加一）保留保护意图，只打断正在进行的执行，后续 tick 可重新判断；`stop`带`clearGuard:true`及新`guardRevision`时，在同一服务端请求中停止操作并清保护，确认后才返回`stopped:true`；序号已被更新的设置超过时照样停止，但保留那个更新的设置。`revoke`、`release`、新的`claim`、租约过期、身体死亡／换维度／移除时也清掉。
- **原生撤销**：意图绑定原租约和身体会话，当前战斗另持可撤销的执行授权。普通 stop、off 或替换配置立即使旧攻击 scope 的授权失效；后续 tick 或新租约不能复活旧 scope。原生攻击回调内重入停止／关闭时先撤销，调用栈尚未退出仍报`STOP_UNCONFIRMED`，已发生的伤害仅保留为旧执行的只读回执。
- **观察**：保护开着时`observe`多一个`guard`：`{enabled:true, player, entityId, options, covering, reason?, returning, busyMs, state, target?, targetId?, hits, damage, shots, kills, retreats}`。`covering:false`时`reason`是`PLAYER_AWAY`（下线、换维度、超出 32 格）、`TOO_FAR`（Bot 离玩家超过 16 格）、`BUSY`（正在做的事不能打断）或`NO_CONTROL`；玩家回来后自动接着保护。`busyMs`是累计打架时长，以后给任务顺延期限用。
- **什么时候接管身体**：Bot 离玩家 16 格内，且此刻没有操作在跑（空闲，或运行端在原地等待），或者在跑的是不带自己保护的`follow-companion`；在吃东西、挖掘、自卫（原生使用或写入中）、睡觉、开着界面时不接管。这一块里别的任务（建筑、采集、走路、长途走、工作站……）还不能被打断，保护等它们做完（`reason:BUSY`），这期间只有 3 格近身自卫；任务打断在下一块做。
- **打完以后**：跟随时交还给跟随，跟随重新算路线，打架时挨的伤不再算作跟随受伤；空闲时走回开始打之前站的地方（1.2 格内算到，最多 15 秒，走不到就留在原地）。跟随在保护同一个玩家时挨打不会结束跟随。
- **运行端**：身体有`guard-duty-fenced`时，`companion-mode follow`的保护（默认开，`guard:false`关）变成在开始跟随时调`guard`，`follow-companion`不再带`guard`；跟随让开、改成原地等待都不动保护；`companion-mode guard`不需要先跟随，没跟随时带`player`；`companion-mode stop`发 off 关保护，`stop-action`使用上述原子停止并清除，反射引起的停止不关。关闭要收到确认才清本地已确认状态；关闭遭`BUSY`（HTTP 队列满）后可显式重试，即使此前开启尚未回执也必须发送关闭。正在停止时也可以发关闭或开启，不报`BUSY`。`guard`事件从观察里的`guard`生成，规则同 8h；服务端那边保护没了（换过控制权等）时发一条`guard`事件说明。保护覆盖时 3 格近身自卫不插手，不覆盖时照常；保护在打时普通进食等打完，紧急进食照旧。
- **兼容**：新运行端连接没有`guard-duty-fenced`的旧身体（包括只有`guard-duty`的版本）时，回退到`follow-companion.guard`路径；新服务端不再声明`guard-duty`，第一块的旧运行端连上新服务端时也自动回退到这条路径，不需要同步升级。
- **验证范围**：配置请求／回执乱序、关闭拒绝后重试、停止升级、租约边界及原生回调重入授权撤销均有离线回归；没有本次修复的隔离服实测或真实模型试玩证据，离线夹具不证明真实伤害事件顺序。

### 保护打断任务（8m 第一步第二块，2026-10-10）

能力标记`guard-duty-tasks`（和`guard-duty-fenced`一起声明）：常驻保护除了空闲、等待、跟随，也会在下面这些任务的安全时刻接管身体去打，打完把身体交还给任务，任务从身体所在处重新寻路、接着做。

| 正在跑的 | 什么时候能打断 |
| --- | --- |
| `follow-player`、`move-to-position`、`approach-container`、`approach-resource`、`sleep-in-bed`（走向床） | 站在地上时 |
| `travel-to` | 走路段，不在游泳过水时 |
| `build` | 地面层：没在挖、没有垫脚柱（站着的或留在屋顶上的）、没在回垫脚柱的路上、没在超时收尾 |
| `tend-crops`、`breed-animals` | 走路时，不在挖作物时 |
| `craft-item`、`smelt-item`、`produce-item`、`modify-item` | 走向工作站时；界面一开就等它做完（烧炼带`wait`时一直开着界面，期间不打断） |
| `pickup-item` | 一直可以；打完掉落物超出 8 格或被挪动时照常失败 |

不打断：`approach-player`（玩家一动就失败）、`retreat-from-entity`、`pillar-up`、`emote`手势（几秒就完）、挖掘、进食等原生使用、开着的界面、睡着。不能打断时观察里`guard.covering:false`、`reason:"BUSY"`，近身自卫照常。

- **期限顺延**：被打断的操作期限加上打架时长，累计最多再加一倍原期限，超过照常`TIMEOUT`（可再调一次接着做）。打架途中新开始的操作（例如采集两步之间）也算被打断，同样顺延。打完后任务的受伤基线从当前血量算起，打架挨的伤不让任务以`BLOCKED`结束；打架还没开始前在路上挨打照旧`BLOCKED`。
- **运行端**：`Body.fightMs()`把观察里各次保护的`busyMs`累加；运行端自己计时的采集（`GatherTasks`）和容器任务（`ContainerTasks`，总期限和每步等待都算）按增量顺延，同样最多一倍；陪挖仍用跟随自己的期限。`companion-mode`的说明和启动提示按新行为写。
- **验证范围**：离线：Java `GuardDutyTest` 31 项（含任务挂起、不打断时说明 BUSY、顺延上限），运行端`guard-fights.test.mjs`和容器任务期限顺延用例。隔离服`scripts/server-guard-duty-smoke.mjs` 8 项（2026-10-10）：等待中打完回原地 1.3 格内；地面盖 21 格圆石时第 3～4 格间刷尸壳，打完盖满、没有超时；8 格柱子在垫脚柱上时尸壳不挨打（BUSY），下来后打死、柱子盖完、垫脚挖回；玩家在 20 格外时`TOO_FAR`不打。尸壳不动（NoAI），测试玩家是协议机器人；合成界面开着时不打断只有离线检查；没有真实模型试玩。

### 打指定生物 hunt、金苹果（2026-10-11 试玩反馈）

- **能力`hunt`**（操作，同时一个）：`{type, count?, radius?, player?|center?, lowHealth?, survey?, timeoutMs?}`。在中心（默认 Bot 自己，或玩家、坐标）`radius`（1～16，默认 12）内找成年的该种生物，走过去用背包里最好的剑或斧（不在热栏就换进热栏），满蓄力一下一下砍，攻击走和自卫一样的原生攻击范围（只能伤到目标，不横扫），直到打死`count`只（1～16，默认 1）或附近没有了。永远不打：玩家、村民和商人、傀儡、有主人或拴着的、起了名字的、幼崽；苦力怕直接拒绝（`UNSUPPORTED`）。血量到`lowHealth`（默认 8）就停（`LOW_HEALTH`）。掉落只在走过时按原版拾取。`survey:true`只数（`total`、`huntable`、`babies`、`protected`）。结果：`killed`（只算自己砍过、随后死亡的）、`swings`、`damage`、走不到的个数和原因、背包变化。走路时可被常驻保护打断。运行端工具`hunt`，说明里要求只打玩家要求的。
- **金苹果**：金苹果、附魔金苹果的效果都是有益的，不再按“带效果的食物”拒绝；仍是贵重食物，自动进食只在血量紧急线才吃，模型可以按玩家要求指定槽位吃；和原版一样饱腹时也能吃。
- **验证**：隔离服`scripts/server-hunt-smoke.mjs` 8 项（2026-10-11）：只数不动；打 2 只成年羊、剩 1 只，剑从背包换到手上；起名字的和小羊没挨打；苦力怕拒绝；饱腹时吃附魔金苹果少一个、有伤害吸收。羊会走动，没有测会还手的怪，没有真实模型试玩。

### 跟随让开、自卫失败、没武器（试玩反馈修正）

玩家实测 Bot 一边跟随一边干活时的三个问题。只有离线测试，**未在真实游戏中验证**（没有隔离服实测，也没有真实模型试玩）。

- **让开不再作废刚找到的目标（能力`step-aside-stop`）**：以前跟随为工具让开要停一次身体（代次加一），而`discover-resources`的 resourceRef、`discover-containers`的 containerRef 在运行端和服务端都按发现时的代次核验，于是跟随中“先找再做”的`gather-resources`、`approach-container`和存取箱子必定`WORLD_CHANGED`。现在`stop`可带`stepAside:true`：照常取消操作、代次加一，但服务端把这之前发出的资源目标和容器目标继续认作当前控制。规则是`ControlSession.carries(g)`：从代次 g 到当前只有 step-aside 停止。普通`stop`（包括`stop-action`）、带`clearGuard`的`stop`（同时带`stepAside`也按普通算）、`claim`、`revoke`、`release`、身体变化都会截断。会话、维度和服务端 120 秒期限照旧核验。运行端`ServerBody.carries`按同一规则记账，资源引用和容器引用的上下文比较改用`sameControl`（实例、会话、世界、维度相同，代次相同或被承接），本地 30 秒期限不变。只有`CompanionMode`为工具或反射让开时才发`stepAside`，服务端没声明能力时不发，行为同旧版。
  - **玩家叫停照样作废**：①`stop-action`经`stopCurrent`同步清空本地引用（`gather.cancel()`、`tasks.cancel()`），再发不带`stepAside`的停止（带`clearGuard`），服务端截断承接；②让开的停止还在途中时到达的普通停止不合并进去，而是在它之后单独再停一次，所以照样截断；③`companion.stop`推进 epoch，途中的让开拿不到确认。即使有别的路径留下了本地引用，只要中间有过一次非让开的停止，运行端（`WORLD_CHANGED`）和服务端（`STALE_TARGET`）都会拒绝。
- **自卫确定失败后跟随照常接上**：跟随中近身自卫要先让开（停一次），身体正被跟随占着又会再停一次（代次加二）。以前自卫`failed`（比如没有能核验的武器）时把跟随转成手动暂停，下一次后台观察发现代次变了、又不是让开状态，就判`WORLD_CHANGED`。现在`failed`、`cancelled`和成功一样让跟随自己接上，只有`unknown`（没人确认的结果）才停在暂停、并停用自卫。
- **陪伴意图作废不再结束整个控制**：以前的升级链：`CompanionMode.fail`遇到`WORLD_CHANGED`／`CANCELLED`也按失控处理，调用`body.close()`（释放租约、`ServerBody`进入 closed）→ 下一次`RuntimeMonitor`读观察时`assertActive`报`LEASE_LOST`（“服务端控制权已结束；请显式重启接管，不得重放旧动作”）→ `disconnect`事件 → 带`--reconnect`的驱动器以 75 退出、重新接管，跟随和保护都没了。现在这两个码只结束跟随／等待（状态`stopped`并带码和原因），身体控制、租约和常驻保护都保留；失租约、过期、断线、回执无效、停止未确认等仍关闭身体。旧的跟随不会留下无主的移动：服务端只在 follow-companion 的代次仍是当前代次时驱动它。陪挖／陪捡的阻断收尾里，停止已确认后的代次异常也只结束意图。
- **暂停、受阻时接住同会话的新代次**：手动暂停（模型`pause`、或让开转成的手动暂停）和`blocked`时，身体上没有我们的东西在跑，代次只是因为别的任务停过身体才前进。同一实例、会话、世界、维度的较新代次直接沿用（后台观察和`resume`都是）；`resume`仍重新核验玩家身份。换会话、世界、维度照旧作废意图。玩家叫停不经过这里：`stop-action`直接清掉意图。
- **没武器时腾手空手打**：保护（`GuardCombat`）和`defend-self`都按这个顺序：背包里最好的可核验原版剑／斧 → 空着的热栏格 → 把手上那格的东西用原生 SWAP 挪进背包主区（9～35）第一个空格，空手打。挪开的东西不会被拿来打，未知 Mod 物品照旧不用。热栏和背包主区都满时照旧放弃：保护对这只怪暂时不打，观察的`guard.unarmed`为`NO_FREE_HAND`，运行端发一条`guard`事件说明；`defend-self`报`UNSAFE_WEAPON`，原因写明“热栏和背包主区都满，空不出手”。`defend-self`挪的是选中格，选中格组件不完整时换别的热栏格再选中，挪动走`swap-inventory`并核对两格的结果。
- **验证范围**：运行端`npm test`（Node 24.21）新增`companion-step-aside.test.mjs`（跟随中发现后采集／走近箱子能开始、叫停后仍拒绝、非让开停止仍拒绝、让开途中到达的停止单独执行、跟随＋自卫失败后恢复且不断开、手动暂停接住新代次、`WORLD_CHANGED`只结束跟随），`survival-defense.test.mjs`腾手三项，`companion-guard-duty.test.mjs`空手原因一项。Java 用例补在`ControlSessionTest`（承接链）、`ResourcePickupTest`（资源目标）、`GuardCombatTest`（腾手顺序、放弃和原因）。

### 玩家丢来的物品、附近实体的装备（2026-10-11）

背景：玩家把下界合金剑丢给 Bot，原版拾取后保护战斗也用上了，但模型不知道，还说“你没给我”；模型也看不到玩家和生物拿着、穿着什么。两个能力标记都是只读的（不是动作），旧运行端不认识新字段时按原样忽略（zod 默认丢掉多出的键），新运行端遇到不带标记的旧服务端也照常工作。

**`gift-receipts`：拾取收据记丢出者。** 原生拾取（`ItemEntityPickupEvent.Post`，以及背包类拾取槽在 Pre 里接走的那条路径）记收据时，读 `ItemEntity.getOwner()`（1.21.1 里就是丢出者 `thrower` 的 UUID 解析出的实体）。丢出者是玩家、且不是 Bot 自己时，收据多一个可选字段 `thrownBy`（玩家名）：`{seq,…,storedIn?,thrownBy?}`。采集的方块掉落、打怪掉落没有丢出者；Bot 自己 `drop-item`、递物没被接住又捡回来的，丢出者是 Bot 自己，都不带 `thrownBy`。死亡掉落（原版不记丢出者）、丢出者已下线（解析不到实体）时也没有这个字段；读取出错只丢掉名字，不影响收据本身。物品的 `target`（只许某人捡）不参与判断：指定给别人的物品 Bot 捡不到。

运行端（`EventJournal.useGifts`，只在 hello 带 `gift-receipts` 时开启）：

- 每个服务器实例（`instanceId`）的第一份观察是基线，之前的收据不算；之后只看 `seq` 更大的收据，同一条收据只通知一次（重复观察、`get-status` 和后台轮询都会 ingest，按 seq 去重）。
- `thrownBy` 是自己的名字或 `--bot-players` 里的名字时不算。
- 同一个人的物品从第一件起收集 2 秒，合成一条唤醒模型的 `gift` 事件；相同物品且组件相同的数量相加，进了背包类存储的单列：`muxue 丢给你：minecraft:netherite_sword ×1（已进背包）`、`muxue 丢给你：minecraft:bread ×5、minecraft:iron_sword ×1（带附魔、名字等属性）（已进背包）；minecraft:coal ×9（已放进 sophisticatedbackpacks:backpack）`。
- 驱动器把 `gift` 加进唤醒类型；启动提示：收到 gift 时在游戏里简短回应、道谢或确认收到，需要时再用 `list-inventory` 查背包。

**`assess-armour`：收到的护甲自己穿上（10-11 试玩：玩家丢钻石胸甲，Bot 不会自己换）。** 只读能力（不是动作，`atomicAction` 排除）。请求 `{instanceId,sessionId,leaseId,items:[物品ID,1..8个]}`；服务端在主背包 0..35 格里找这些 ID 的、能穿的东西，对照身上现在穿的，返回 `candidates:[{slot,item,count,part,verdict,reason,wearing?}]`。能穿的只有原版人形护甲（`ArmorItem` 的头、胸、腿、脚，不含鞘翅、南瓜、头颅、马铠、狼铠）和**副手空着时**的盾牌（`part:"offhand"`）。**“更好”只在服务端判断一处（`ArmourChoice.java`，原生读取在 `ArmourAssessment.java`）**：先比护甲值，再韧性（都是该部位属性修饰符的加法值），再附魔总等级，最后剩余耐久（不会坏的算最大）；四项全相同不换。`verdict`：`better`（`reason` 为 `slot-empty` 或 `better-stats`）、`not-better`（`same`／`worse`／`better-candidate`＝同部位另有更好的候选／`offhand-occupied`）、`blocked`（`new-binding`＝新的带绑定诅咒穿上脱不掉、`worn-binding`＝身上的带绑定诅咒脱不下、`no-room`＝被替下的那件没地方放）。同部位多个候选时只有最好的一个是 `better`。被替下的旧件放回新件原来的格子（`equip-item` 的原有行为），所以单件永远放得下；`no-room` 只在新件是一叠多件、背包又没有空格时出现。

运行端（`gift-gear.ts`，hello 同时带 `assess-armour`、`equip-item` 时由 `main.ts` 接到 `EventJournal.useGiftHandler`）：`gift` 事件发出前，把进了背包的礼物物品 ID 交给服务端评估；`better` 且身体不忙时用 `equip-item`（带评估的 `slot`，跟随／等待中靠 `beside-follow` 不停跟随）穿上，事件在原文后接 `已换上 X（替下 Y）`；其余结果也写进事件（不比身上的好、带绑定诅咒、放不下、副手有东西）。**忙**＝任务、采集、动作在跑，保护正在打，陪挖，或跟随被工具暂停：不打断，事件写 `可以换上 X，比身上的 Y好，但正在忙，没有换（空下来可以用 equip-item）`。评估或穿戴失败、8 秒内没结果时，事件照常发出（失败写“没成功”）。只处理玩家丢来的礼物，不是任何拾取。

**`entity-equipment`：附近实体的装备。** 观察 `entities` 里每个 `LivingEntity`（玩家、僵尸、骷髅、猪灵、凋灵骷髅、村民、盔甲架、马、狼……），只要有一个装备位不空，就带 `equipment`：

```json
{"mainhand":{"id":"minecraft:netherite_sword","count":1,"enchantments":["minecraft:sharpness 5"],"name":"屠龙","durability":"2000/2031"},
 "offhand":{"id":"minecraft:shield","count":1},
 "chest":{"id":"minecraft:iron_chestplate","count":1}}
```

- 装备位用原版 `EquipmentSlot` 名，顺序 `mainhand`、`offhand`、`head`、`chest`、`legs`、`feet`、`body`（马铠、狼铠等）；只列非空的。全部为空的实体不加字段。
- 每件：`id`、`count`；有附魔时 `enchantments`（`"id 等级"`，排序，和 `ItemDescriptions` 的写法一样）；有自定义名字时 `name`；掉过耐久时 `durability`（`"剩余/上限"`，和 `ItemDescriptions.describe` 一样，没有这个字段表示满耐久或不会损耗）。不给整份组件 / NBT。
- **上限**（`EquipmentView`）：`id` 和每条附魔最多 64 字符，名字最多 32 个字符（超出截断加 `…`），附魔最多列 4 条（多的数在 `enchantmentsMore`）；一个实体的装备最坏约 3.8 KB；每次观察最多给离 Bot 最近的 16 个实体带装备，装备 JSON 合计最多 8192 字节，超出的、或读取出错的实体带 `equipmentOmitted:true`（不是“没装备”）。`entities` 本身仍是 32 格内最多 64 个。典型场景（玩家拿附魔剑和盾、穿两三件钻石甲，一只穿铁甲拿铁剑的僵尸，一只拿弓的骷髅）约增加 620 字节（紧凑 JSON）。
- **同样带装备的其它读取**：`survival-state` 的 `threats.nearby` 里 `hostile`、`attacking_self`、`unknown` 的条目（最多 24 条，同样的上限）；`look-around` 的 `players`（最多 8 个）和每种生物最近那只的 `nearest`。
- **运行端**：观察、威胁的 zod schema 加可选的 `equipment`、`equipmentOmitted`，单个字段不合格只丢掉这个字段，不让整份观察失败。工具说明写明哪里有装备：`get-status`（紧凑视图前 16 个实体）、`find-entity`（按距离排序，用来看玩家拿着什么）、`look-around`、`get-survival-state`。`survival` 危险事件末尾加 `；装备：minecraft:zombie（穿 iron_helmet、iron_chestplate，拿 iron_sword），minecraft:skeleton（拿 bow）`，不进事件比较的键，装备变化不会再次唤醒。
- **验证范围**：离线：Java `EquipmentViewTest`（玩家装备、穿铁甲的僵尸、拿弓的骷髅、全空不出字段、16 个实体和 8 KB 截断、读取失败标记、`thrownBy` 判断）；运行端 `gifts-equipment.test.mjs`。从原生实体读装备位（`ItemDescriptions.equipment`）、`getOwner()` 取丢出者只有代码审阅，没有隔离服实测和真实模型试玩。

### 试玩反馈修正（2026-10-08）

10-08 小雪用 Claude（Haiku）实测时遇到的问题，按顺序修了五处；实测见`scripts/server-equip-swim-smoke.mjs`（隔离服：装着 SB 时 16 项；挪开客户端模组、加`--with-peer`时 15 项，含跟随下水）。

- **停托管不留假人**：驱动器退出（WebUI 停止、`stop-companion.ps1`）时`revoke`带`leave:true`，角色下线、原版照常存档，下次启动在原地上线。聊天叫停、换会话、托管出错重启这些不带`leave`，角色还在原地。驱动器异常退出没机会撤销时，角色仍留在服务器，等租约过期（不下线）。
- **穿装备**：新原子能力`equip-item`：`{slot:0..35,expectedItem,expectedCount>0,expectedComponents}`。物品要是原版判定穿在护甲槽的（头盔、胸甲、鞘翅、护腿、靴子、生物头颅）。要求自身物品栏、空光标。护甲槽空着就原生 QUICK_MOVE（shift 点击）；有东西就原生 PICKUP 三下（拿起新的、点护甲槽对换、放回原槽），和玩家在物品栏里换装一样；绑定诅咒的脱不下来先拒绝。回执`{part,slot,wearing,tookOff?,inventory}`；没动就`failed`+`FORBIDDEN`，光标里还留着东西就放回原槽并判`unknown`。穿在身上的护甲本来就在观察的`inventory`里：槽 36 靴子、37 护腿、38 胸甲、39 头盔、40 副手。可选`hand:"offhand"`（10-11 加）：任意非空物品（火把、食物、地图等）都放进副手，原生 PICKUP 点副手空槽，副手原来有的就对换、旧的放回新物品原来那格；副手是空的就两下（拿起、点副手槽）放完。绑定诅咒和原版一样只锁护甲槽，副手不限；副手里已经是同一种物品（同组件）时报 ALREADY_HELD，因为原版点击会把两堆合并而不是对换。不给`hand`时行为不变，护甲和盾照旧不用加；回执多一个`hand:"offhand"`，`wearing`是副手现在的物品，`tookOff`是换下的。Node 发布`equip-item`工具，参数是`item`和可选的`hand`，运行端从最新观察里挑主背包的那一格填守卫。
- **水里能走**：导航的前置条件不再拒绝「在水里」（岩浆、着火、骑乘等照旧拒绝）。身体在水里时不规划步行路线，像玩家一样按住跳浮上水面，朝岸边游：在身边 10 格内找能站的岸（从水面往下看每一列第一个不是空气的格子；第二轮起只要和水面齐平的，见下），选「离身体近、离目的地也近」的（到目的地的距离按一半算）；碰到岸边时原版的出水攀爬把身体送上去，上岸后照常规划步行路线。4 秒没进展就换下一处岸，换 4 次还出不去判`BLOCKED`，10 格内没有岸判`NO_PATH`。步行路线照旧不穿过水。`navigation`诊断多一个`swims`（找岸次数），`stage`多一个`swim`。`move-to-position`、`travel-to`可以从水里开始；`pillar-up`仍要求站在干地上。跟随、保护、拾取等用同一个导航，所以跟随时下了水也会自己游上岸再跟。
- 生存危险事件不再把「在水里」当成变化唤醒模型，只有空气不足（`oxygenLow`）才算。
- **自卫说清楚**：试玩里被蜘蛛打时小克说「已经处理掉了」，其实一下也没打；后来模型手动叫的自卫因为蜘蛛在 3 格外返回`NO_THREAT`，这一下把自动自卫整个停掉了（`armed:false`），之后旁边的僵尸也不管。现在：①NO_THREAT（什么都没做）不再停用自动自卫；②危险事件末尾加一句不参与去重的说明：每个威胁「会自动还手」还是「不还手（不在 3 格内／没有视线／没确认是敌对的／服务端给的原因）」，自动自卫停用时写明原因。13:37 那次蜘蛛在 3 格内却没自动还手，当时没留下原因，下一轮试玩看这句说明就能确定。
- **背上背包**（SB 适配）：新交互`sophisticatedbackpacks:backpack/take`（方块类、空手、潜行），把放着的背包连同内容捡到手上；带没验证过的升级的背包拒绝，和打开一样。然后`equip-item`穿上：SB 的背包物品声明穿在胸甲格，所以和胸甲二选一（服务器没装 Curios）；对换时只用左键点击，不会触发 SB 右键把东西塞进背包的行为。实测在同一脚本里（装着 SB 时 16 项）。

第二轮（同日傍晚试玩）：

- **盾牌放副手**：`equip-item`也接受原版判定拿在副手的物品（盾牌），放进槽 40；副手有东西就对换。
- **旁边有人也照打**：自卫原来在目标旁边有别的生物（试玩里是小雪）时拒绝出手（`COLLATERAL_RISK`）。原生横扫本来就被`SweepAttackEvent`取消、对目标以外的伤害也被拦下，只会打中目标，这项检查删掉。
- **自卫不再轻易关掉**：①`stop-action`只停正在做的事，确认停下后自动自卫马上恢复；叫停时正在打的那只怪先放 3 秒，它还在打就接着还手。②有明确结果的失败（拒绝、退路被堵）不再关掉自卫，只是对这只怪 3 秒内不再试，同样的失败 10 秒内只报一次；结果未知（`unknown`）的才停用。试玩里模型叫停卡住的移动后，被 5 只僵尸围着也不还手，就是因为①。
- **水里不再淹死**：身体空着（没有任务）、眼睛在水下时像玩家一样按住跳，浮在水面。试玩里小克沉到湖底站着，模型以为掉进了「地下水」，最后淹死。
- **上岸只选和水面齐平的岸**：比水面高一整格的岸从水里爬不上去（实测浮到差 0.14 格，原版玩家也一样），不再当成上岸点；只有这种岸时直接`NO_PATH`说明。紧挨着水的岸原版标成`WATER_BORDER`，也算能上的岸（原来漏掉了，只会选离水一格的）。游泳的进展只按离岸变近算，水面上下浮动不算；浮出水面一下不算上岸，不会清掉试过的岸。试玩里卡在岸边就是选了高一格的岸，又因为浮动一直算「有进展」不换岸。
- **追怪疾跑**：保护玩家时追怪和撤退都疾跑（饱食度 6 以上、不在水里、没在用物品、不是跳空隙），骷髅退着射也追得上。
- **胡萝卜、土豆能自动吃**：能种的原版食物（`ItemNameBlockItem`：胡萝卜、土豆、甜浆果）原来被当成「未验证」，现在和普通食物一样。
- **死后照样能下线**：宿主退出时驱动器先核对身体的会话编号，角色死了重生后编号变了，撤销就没发出去，留下假人。撤销现在不要求编号一致（服务端只认它自己退役的那份租约，别人接管了就不下线）。
- 实测：`server-equip-swim-smoke.mjs`装着 SB 21 项、挪开模组加`--with-peer`19 项；`server-guard-smoke.mjs`14 项（含疾跑）；`server-navigation-defense-smoke.mjs`55 项；`server-stroll-smoke.mjs`10 项。

### 瞬间动作旁边跟随（能力 beside-follow，2026-10-11）

- 服务端声明 `beside-follow` 后，`select-slot`、`equip-item` 可以在 `follow-companion` 运行时执行：跟随不停、不重发，运行端也不让开。两个动作都在服务端同步完成（`begin` 返回时已不是 running）；它们不移动身体，不改跟随的 `active`。
- 放行条件：当前正在 running 的非聊天动作全部是 `follow-companion`。运行端的 exclusive 槽和共享任务锁在这种情况下对这两个动作同样放行。
- 其余照旧：别的动作（如 `dig-block`、`build`）在跟随旁边仍返回 `BUSY`；`emote`、`look-at` 等仍让开跟随。万一服务端没有同步完成，回执按 `failed`（`INTERNAL`）处理。

### 死后原地复活、死因、断开前的陪伴状态（能力 last-death，2026-10-11 试玩反馈）

- 原版玩家死后 20 tick 会被移出世界（移除原因 `KILLED`），但仍留在玩家列表里，直到 `PERFORM_RESPAWN` 换成新实体。以前服务端把“已移除”当成身体不在了：死后超过 1 秒才复活时，会先让身体下线、再读死亡存档上线（聊天栏出现退出、加入）。现在 `KILLED` 的尸体照常原地复活（`NativeRespawn.present`）。
- `hello.lastDeath`：最近一次死亡的原版死亡消息（`message`，即聊天栏那句）、维度、位置和时间（毫秒），一直保留到下次死亡；从没死过时没有这个字段。只读，不影响控制。
- 托管重连（驱动器 `--reconnect`）启动时，驱动器不等玩家开口，马上给 Agent 一轮：复活的带上 30 分钟内的死因和死的地方；还有断开前的陪伴状态。
- 陪伴状态由运行端写在 `runtime/posture-<名字>.json`（跟随谁、原地等、保护谁，以及保护开没开）。身体丢了不清，只有明确结束才清：`companion-mode stop`、没跟随时 `guard:false`、`stop-action`、玩家叫停、托管真的停止。驱动器读一次就删，超过一小时、或早于最近一次叫停的不用。提示说明这是玩家要的持续状态，接上不算重放旧动作；程序不自动恢复跟随。

### 保护用弓（2026-10-11 试玩反馈修正）

- 保护接管身体前会检查“身体忙不忙”（吃东西、同步原生写入、睡觉、开着界面、正在用物品）。以前保护自己拉的弓、举的盾也算“正在用物品”，下一 tick 就把身体收回、弓放下，所以永远拉不满 20 tick。现在保护正在战斗时，它自己用的物品不算忙（`GuardDuty.bodyFree`）；别人在用的物品（比如正在吃）照旧算忙。
- 能不能射：依次试怪的中间、胸口、头（`AIM_HEIGHTS`），按原版箭的飞行（每 tick 移动后 0.99 阻力、0.05 重力，满弓初速 3）逐 tick 模拟，先碰到怪（碰撞箱外扩 0.3）而不是方块才射，弧线及没射中后再飞的两 tick 内不能经过玩家、宠物、村民（碰撞箱外扩 1 格）。都不行就不射，只拉着等。
- 诊断（只用于排查，不影响决定）：保护状态多 `draws`（开始拉弓的次数）、`lastEnd`（上一场战斗为什么结束，如 `NO_FOE`、`STALE`、`NO_PATH`、`INTERRUPTED`）、`lastDrop`（上次弓为什么没射就放下，如 `MELEE`、`NOT_VISIBLE`、`NO_CLEAR_SHOT`、`EVADING`）、`lastBreak`（保护为什么中途把身体还回去，如 `TOO_FAR`、`BUSY`）。一场战斗拉过弓却没射出时，服务端日志写一行 `MCBOT guard: drew the bow …`，最多每 10 秒一行。

### 保护用弓：站位不好时挪一步

- 现在的位置射不中（脚下的崖边、墙角挡住），就找一个能射中的地方：以脚为中心 1 到 4 格、八个方向共 32 个点，近的在前；点要在 `min(leash, ENGAGE_RANGE) - 1.5` 格内（`GuardDuty.ENGAGE_RANGE` 是身体离玩家超过多远保护就不接管身体，所以不能走出这个距离）、离怪 `BOW_MIN`（4）到 `BOW_MAX`（24）格（再近就改近战了）、不在刚走不通的点附近。服务端对每个点查：脚下和头顶是原版路径类型的“可行走”（不是水、火、仙人掌、悬崖）、比现在最多低 1 格，然后用射中判断同一套逐 tick 箭模拟（眼睛高度从那个点算，也查玩家、宠物、村民）；最多查 24 个，选最近的。
- 每秒最多找一次，一场战斗（同一个目标）最多挪 6 次；走路最多 6 秒；`NativeNavigation` 报走不通就记下这个点不再选（走不到的只是这个点，怪照样打，不记 `noPath`）。走的过程中途能射了就停下拉弓；怪进了近战范围就改近战。
- 状态：挪动时 `state:"repositioning"`，保护状态多 `repositions`（累计次数）和 `lastReposition`（`WALKING`、`ARRIVED`、`CLEAR`、`NO_SPOT` 没有可行点、`NO_CANDIDATE` 范围内没有候选、`NO_PATH`、`TIMEOUT`、`LIMIT`）；弓因此放下时 `lastDrop:"REPOSITION"`。

### 保护举盾挡远程（2026-10-11 试玩反馈）

状态：①②已实现，离线测试通过，待隔离服和真实游戏实测；③只有设计。

保护时骷髅、流浪者、沼骸等拉弓瞄准 Bot，或有弹射物飞向 Bot，Bot 转向它、举副手的盾挡这一箭；射完放下，照常去打（近战冲上去，或用弓射）。不靠生物名单，分三层：

- **① 原版判据（`Foe.charging`，`GuardCombat.windingUp`）**：怪自己的目标（`Mob.getTarget()`，不含“最近被打过”）是 Bot，并且手里的东西在蓄力——正在使用的物品是弓、弩、三叉戟（物品类是`ProjectileWeaponItem`，或使用动画是 BOW／CROSSBOW／SPEAR，模组武器只要沿用这些就算），或者手上拿着已装填的弩（`CrossbowItem.isCharged`，弩装填完举着瞄准的那段）。不看生物名，也不要求怪实现`RangedAttackMob`／`CrossbowAttackMob`。还要看得见 Bot（`visible`），隔着墙拉弓不算。进入`foes()`的条件没改（玩家身边`radius`格内，或打玩家／Bot 的怪，打 Bot 的要在 8 格内），所以离玩家远、离 Bot 又超过 8 格的瞄准者靠②。
- **② 来袭弹射物兜底（`GuardCombat.View.incoming`、`ticksToHit`）**：每个游戏刻查 Bot 身边`BOW_MAX`（24）格内的`Projectile`，按当前速度逐 tick 推算（箭按原版每 tick 先移动再乘 0.99 阻力、减 0.05 重力，其他直线），`SHIELD_LEAD`（10）tick 内会不会进入 Bot 的碰撞箱（外扩 0.3，和射箭的判断同一个边距）；已经在碰撞箱里的（插在身上、擦过）不算。下面这些不算（`GuardCombat.blockable`）：Bot 自己射的（带`mcbot_body_projectile`标签或主人是玩家）、玩家射的、主人是宠物或不是怪物的傀儡等友方（起了名字的怪物仍算敌人）、药水（溅射无视盾）、穿透箭（原版`isDamageSourceBlocked`挡不了）。“来得及”：会在`SHIELD_DELAY`（5，盾举起这么多 tick 才挡得住）tick 之后到才举；盾已经举着的就不看这个。幽灵火球、烈焰人火球、潜影贝子弹等没有“拉弓”动作的，只能靠这一层。
- **③ 附属模组登记（设计，没有写代码）**：见下。

**决定（`GuardCombat.tick` → `shieldAgainstRanged`）**：

- 位置：在苦力怕／低血撤退那段之后、挑目标（`choose`）之前，所以点燃的苦力怕、低血撤退优先（爆炸比一箭重；低血撤退本来就举着盾，只是朝最近的怪）。
- 有怪已经在近战够得着的范围里时不为远程停下来：先挥剑（贴身的骷髅点射一箭，不如尽快杀掉它；血少了自然进撤退）；等攻击冷却的间隙，对在拉弓的怪也举盾（原来只对打 Bot 的怪举）。这时`incoming`也不查。
- 举盾时：正在拉的 Bot 的弓先放下（`lastDrop:"SHIELD"`），停下脚步（举着盾不能冲刺），面朝来袭弹射物，没有弹射物就面朝最近的蓄力怪；同一时间只举一次，`shields`按举起算一次。状态`shielding`，保护状态多`blocking`（`RANGED`：蓄力怪，`PROJECTILE`：弹射物）。
- 放下：最后一次看到威胁（不再蓄力，或弹射物已过、没打中）之后再举`SHIELD_HOLD_MS`（`SHIELD_DELAY`×50 毫秒，约 5 tick）才放，之后照常打。盾举起不满 5 tick 挡不住东西，所以不会举一下就放；怪拉一下放一下弓也不会抖。有新威胁就继续举。
- 没盾（`lastShield:"NO_SHIELD"`）或`shield:false`（`lastShield:"OFF"`，此时不查弹射物）：不动，原来怎么打还怎么打，包括 Bot 自己拉弓对射。

**③ 附属模组登记（设计，未实现）**：原版判据和弹射物兜底处理不了的两类，将来由附属模组登记，核心里不放名单：

1. “这种怪在蓄力”：蓄力不是使用物品的怪（法师读条、自定义的蓄力标志）。附属提供只读判断`怪 → 是／否／不知道`，核心把“是”当作`charging`；目标是不是 Bot 仍由核心看`Mob.getTarget()`，附属不能自己声明谁是目标。
2. “这种弹射物盾挡不了”：魔法、穿盾的弹射物。附属提供只读判断`弹射物 → 盾能挡／挡不了／不知道`；“挡不了”的不进`Incoming`，Bot 不会白白站着挨打；“能挡”可补回核心默认认为挡不了的。

形式：`McbotApi`加一个`registerRangedThreat`，规则和其他适配一样——id 与别的适配共用命名空间、服务器启动后冻结（`Registered`多一项，旧构造器补空列表）、`installed()`要检查被适配模组的确切版本（`versionsMatch`）、方法抛异常当作“不知道”、先登记的优先、答“不知道”回到上面两层、`hello.adapters`列出、`registerHint`可附用法说明、WebUI 插件页的「给 AI 用」开关同样管它（见[Mod 适配](mod_adapters.md)）。这次不写代码的理由：现在没有哪个附属模组需要它，登记接口要进公开的`McbotApi`（加了就得兼容），等第一个要适配的模组（有蓄力怪或穿盾弹射物）出现，按它的实际行为定形状比现在猜稳。

**验证范围**：离线——`GuardCombatTest`（决策：蓄力怪举盾、射完放下去打、没蓄力不举、隔墙不举、弹射物来得及／来不及／已举着／飞偏、关盾或没盾照旧、苦力怕优先、近战优先、对射的弓放下又拉起；弹道推算几何）和`FollowCompanionTest`（经协议`act follow-companion`带`guard`，跟随驱动真实的`GuardCombat`，视图为脚本）。**没有验证**，要真实游戏：`foes()`从真实生物读出蓄力（骷髅、流浪者、沼骸、掠夺者的弩、溺尸的三叉戟）、`incoming`读真实弹射物（箭的速度和下坠是否与推算吻合）、盾真的挡下这一箭、朝向、骷髅射击循环里举放的节奏、Bot 和玩家同时被瞄准时站着不动是否碍事。

### 陪伴姿态（8m 第二步，约定，2026-10-11）

**状态（2026-10-11）：服务端已按本节实现，只有离线测试（`PostureTest`、`FollowCompanionTest`、`ControlSessionTest`），没进过游戏；运行端在做。** 合并后删掉被取代的旧小节（`follow-companion`、`step-aside-stop`、`beside-follow`）。实现时补定的细节已写进下文，标“实现补定”。设计见[陪伴状态设计](companion_state_design.md)第 7 节；只针对单人陪伴（一个真人、一个 Bot），多人问题见该文 7.9。

能力标记`server-posture`。跟随、等待、坐着不再是操作，而是租约上的一项常驻“姿态”，写法照常驻保护（`guard`）。同时删掉：`follow-companion`操作及其能力名，`companion-guard`的`follow-companion.guard`旧路径，`stop`的`stepAside`和能力`step-aside-stop`（`ControlSession.carries`），`beside-follow`。

**方法`posture`**（要租约，校验 instance／session／lease，不看`controlGeneration`；不是操作，不占操作 ID 预算）。三选一：
- `{action:"follow", player, expectedEntityId, distance?, wander?}`：跟随。`distance`为 1.5～6，默认 2.5；`wander`默认 true，就是原来跟随里站久了会走几步闲逛。`expectedEntityId`为玩家 UUID。玩家不在 32 格内（和保护的`PLAYER_AWAY`同一个范围）报`PLAYER_NOT_VISIBLE`，UUID 不符报`STALE_TARGET`。
- `{action:"wait"}`：原地等。不记位置，身体空闲时由原有的待机看人接管。姿态是`seated`时发`wait`，姿态保持`seated`（带上新的序号）；身体坐着但姿态不是`seated`时，照常变成`wait`，身体不站起来。
- `{off:true}`：清掉姿态，包括`seated`，但不让身体站起来。

所有请求都带`postureRevision`，排序规则和`guardRevision`完全一样：
- 每份新租约从 0 开始，严格递增；
- 序号小于或等于已接受的报`CANCELLED`；
- 序号接受后，后面的检查即使失败也不回退。
回执是姿态快照，形状同下面观察里的`posture`；关掉时回`{posture:null,postureRevision}`。新设的姿态在下一个游戏刻才算出真正的`state`：有操作在跑时，回执里的`state`可能还是`following`，下一次观察变成`suspended`。

**姿态和保护是同一个玩家**：运行端开跟随时，同时把保护设给这个玩家；服务端不核对两者是否一致，单人场景下不会出现不一致。

**`seated`**：
- 不由`posture`方法设，而是由`sit`操作成功后服务端设为`seated`（记下座位方块），原来的跟随或等待就此结束；
- `stand-up`操作成功后，姿态清空；
- 坐着时被保护叫起来（`wouldFight`）不清`seated`：打完走回座位，用和`sit`一样的原生右键坐下；
- 走回座位途中`state`仍是`seated`，另带`returning:true`；观察顶层的`sitting`为 false。检查和右键与`sit`操作相同（`NativeSeat.requireCanSit`、`requireFreeSeat`、`sitDown`）。
- 座位方块不在了、被占了、走不到时，姿态改成`wait`，`reason`给出`sit`的同名码，例如`SEAT_OCCUPIED`、`EMPTY_HAND_REQUIRED`、`NO_LINE_OF_SIGHT`。方块已经不是座位（`STALE_TARGET`）报`NO_SEAT`；超过`GuardDuty.BACK_LIMIT_MS`（15 秒，和保护打完走回原位的上限同一个）还没坐回去报`NO_PATH`。实现补定；
- `posture follow`会让身体站起来去跟。

**观察**：有姿态时`observe`多一个`posture`，没有姿态时不带这个字段：

```
{action:"follow"|"wait"|"seated", postureRevision, state, player?, entityId?, distance?, wander?,
 arrived?, strolling?, suspendedFor?, resumeInMs?, seat?:{x,y,z}, reason?}
```

`state`的取值：

| state | 意思 |
| --- | --- |
| `following` | 在跟。`arrived:true`表示已经站在玩家身边，`strolling:true`表示在闲逛 |
| `waiting` | 原地等（`action:"wait"`） |
| `seated` | 坐在座位上 |
| `guarding` | 常驻保护占着身体在打；打完回到原来的状态 |
| `suspended` | 有操作在跑，姿态让给它：`suspendedFor`是操作名。操作结束后，身体空闲满`RESUME_AFTER_MS`（3000）才接上，期间`resumeInMs`是剩余毫秒；中间来了新操作就重新计时 |
| `away` | 跟的人下线、死了、换了维度，或离开 32 格（`GuardDuty.PLAYER_RANGE`，保护判断玩家在不在也用它）；回来自动接上。`reason`为`PLAYER_AWAY` |
| `blocked` | 走不到玩家身边；每隔 3 秒（`FollowCompanion.UNREACHABLE_RETRY_MS`），或玩家挪开 2 格（`UNREACHABLE_SHIFT`）就再试。`reason`是导航给的码：`NO_PATH`，或此刻不能走路时的`BLOCKED`（在岩浆里、骑着东西等）；某一刻内部出错时为`INTERNAL`，下一刻照常再试 |

**每个游戏刻谁驱动身体**，按这个顺序：
1. 常驻保护（`tickDuty`）；
2. 正在跑的操作；
3. 姿态。

不让姿态挂起的操作：`send-chat`、`select-slot`、`equip-item`。这些操作不移动身体，也不重新计时，相当于原来`beside-follow`的名单。名单只在服务端存一份（`Posture.KEEPS`），第三步再加`look-at`、`emote`。坐着时能用的操作（见`stand-up`那一行）不会让`seated`挂起；不能用的照旧报`SEATED`。

“有操作在跑”看的是会话里状态为 running 的操作（`ControlSession.running()`），所以进食、自卫这类生存动作也会让姿态挂起。`select-slot`、`equip-item`不再有特殊放行：别的操作在跑时它们照常报`BUSY`；没有操作在跑时，跟随不是操作，本来就不挡它们。实现补定：任何一次`stop`（包括操作结束时的收尾）之后，姿态也要等`RESUME_AFTER_MS`才再动；这段时间跟随显示`suspended`，等待和坐着本来就不动，`state`不变。

**跟随失败不再结束跟随**：
- 跟随中挨打不再报`BLOCKED`：没开保护时由运行端的近身自卫处理；
- 走不到报`blocked`，玩家走远或下线报`away`，都会自己接上；
- 玩家重新登录，UUID 相同而实体换了，照常接着跟；
- UUID 不同（名字相同但不是同一个人）才结束姿态，观察的`posture`消失，运行端从回执的上一个状态判断原因。

**生命周期**：
- 普通`stop`（取消任务、反射抢占、`stop-action`以外的停止）只停操作，不碰姿态；
- `stop`带`clearPosture:true`和新的`postureRevision`时，在同一请求里同时清姿态。`stop-action`、玩家叫停、`companion-mode stop`、托管结束都走这条，和`clearGuard`一起发；
- `revoke`、`release`、新的`claim`、租约过期、身体死亡、身体换维度或被移除时，姿态和保护一起清掉。死亡会让`connected()`变成 false，所以复活后要由运行端恢复，见下面“死亡掉落”。

**死亡掉落**（同一能力`server-posture`，扩展`hello.lastDeath`）：
- Bot 死亡时，原版掉出的物品实体（`LivingDropsEvent`）都打上标签`mcbot_body_death_drop`。
- `lastDeath`多一个`drops`，开了 keepInventory、或没掉任何东西时为`{count:0}`：
  ```
  drops:{count, items:[{id,count}], despawnAt, remaining}
  ```
  - `items`：相同物品合并，最多 16 条；
  - `despawnAt`：死亡时刻加上 300000 ms，即原版`ItemEntity.LIFETIME`的 6000 tick 乘以 50 ms。服务器卡顿时物品实际消失得更晚，所以这个时刻偏保守；
  - `remaining`：读取时还在、且区块已加载的带标签物品数；区块没加载时为 null，表示不知道。掉进岩浆、虚空而没了的不算。
- 观察里的地面物品，带这个标签的多一个`deathDrop:true`。
- 捡回去仍用`pickup-item`，规则不变：物品要在 Bot 8 格内。

**运行端怎么恢复**（R5，规则写在这里，供两边对照）：
- 重新认领控制后，先看`lastDeath.drops`。满足下面所有条件，就先用`travel-to`走到死亡地点：
  - `count>0`；
  - `remaining`不是 0；
  - 现在还没到`despawnAt`；
  - 死亡地点和身体在同一维度，且在`travel-to`的 2000 格以内；
  - `timeoutMs`取到`despawnAt`的剩余时间，并且不超过`travel-to`的上限。
- 到了以后，逐个`pickup-item`去捡带`deathDrop`的物品。
- 下面任一情况就停下不捡，改为恢复姿态，并告诉模型东西掉在哪、还剩几分钟：
  - 那里有保护会打的怪：`survival-state`的`threats`里，`hostile`且有防卫资格的；
  - 走不到；
  - 时间到了。
- 不满足上面的条件时，直接恢复姿态，同样告诉模型。
- 恢复姿态用`runtime/posture-<名字>.json`：重新设`posture`和`guard`，再告诉模型一声。玩家叫停过，或者文件已经过期（原有规则）时不恢复。
- 捡装备这段路上没有姿态，常驻保护照常：玩家在 16 格内时仍会出手。

**常驻保护打完以后**：
- 姿态是`follow`时，交还给跟随，跟随重新算路线。这和原来一样，只是不再经过`follow-companion`操作；
- 姿态是`wait`时，走回开始打之前站的地方（10-10 定的规则）；
- 姿态是`seated`时，走回座位坐下；
- 没有姿态时，照旧走回原地。
保护接管身体的条件里，“在跑的是`follow-companion`”换成“没有操作在跑、由姿态驱动”。

## 手持物品使用（2026-10-06）

设计见 [use_item_design.md](use_item_design.md)，实测见 [验收记录](archive/use_item_validation.md)。

- `hello` 新增 `interactions`：当前已安装、版本核对通过的交互 ID 列表。只有存在方块类交互时才声明 `use-item-on-block`，只有存在物品类交互时才声明 `use-item`。首批内置 `minecraft:composter/add`（拿可堆肥物品右键堆肥桶），没有物品类交互，所以不声明 `use-item`。
- `use-item-on-block`：`{x,y,z,interaction,expectedBlock,expectedProperties,face?,timeoutMs?}` 加上二选一的手持守卫：`{slot:0..8,expectedItem,expectedCount>0,expectedComponents}`，或 `{emptyHand:true}`（只有交互声明必须空手时才允许，服务端自己挑空快捷栏槽，用完切回原来的选中槽）。不支持 `targetToken`。
- `use-item`：`{interaction,slot,expectedItem,expectedCount>0,expectedComponents,timeoutMs?}`，主手对空使用。开始了按住使用（弓、盾、食物）会立即停止并判为 unknown；吃东西继续用 `eat-item`。
- 发包前拒绝（不产生任何原生效果）：交互没登记或版本不对、交互不适用这个方块、手持物品不被接受、要求空手却给了物品（或反过来）、交互的前置检查不满足（`INTERACTION_NOT_READY`，例如堆肥桶 level≥7），以及原有的 `STALE_BLOCK`／`STALE_ITEM`／`OUT_OF_REACH`／`NO_LINE_OF_SIGHT`。
- 发包后按前后快照判定：快照包含方块 ID 和属性、适配器摘要、整个背包（带完整组件）、当前菜单类型、目标周围 2 格内的掉落物。
  - `succeeded`：所有变化都在交互声明的范围内（允许变的方块属性和摘要字段、手持物品消耗数量的上下限、是否允许耐久损耗、允许多出的物品、是否允许打开菜单），并通过适配器自己的数值检查。
  - `failed` + `NO_EFFECT`：前后快照完全一样（包括被保护事件取消的情况）。回执不带 inventory。
  - `unknown` + `NATIVE_UNKNOWN`：其他所有情况。回执带 `unexpected`（逐条原因）、`inventory`、`before`、`after`，不自动重试。
  - 打开了没有适配器菜单契约核验的菜单：立即原生关闭，判为 unknown。
- Node 只向模型发布一个 `interact-block` 工具（参数：坐标、交互 ID、`item` 或 `emptyHand`、可选 `face`），由运行端读最新观察来填方块守卫、挑快捷栏槽；物品不在快捷栏时返回 `NOT_IN_HOTBAR`，提示先 `prepare-item`。`use-item-on-block`／`use-item` 本身不作为模型工具。
