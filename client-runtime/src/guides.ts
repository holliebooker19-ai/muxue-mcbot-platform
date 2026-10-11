/**
 * Play guides (docs/prompt_slimming_plan.md): what the model needs while doing one kind of play, given the first time it
 * comes up in a session, attached to that tool result or event, instead of in the startup prompt every session carries.
 * What it must know before choosing a tool stays in the tool's description. Written as facts, not orders (Claude Code's
 * advice for injected context). After the conversation is compacted they are given once more, as Claude Code re-attaches
 * the skills used so far.
 */
export interface Guide {
  id: string;
  text: string;
  /** Tool calls that bring it, optionally only with some arguments. */
  tools?: Record<string, ((args: Record<string, unknown>) => boolean) | true>;
  /** Events that bring it, optionally only those whose text matches. */
  events?: Record<string, RegExp | true>;
}

export const GUIDES: readonly Guide[] = [
  { id: 'companion', tools: { 'companion-mode': args => args.action === 'follow' },
    text: '跟随说明：跟随是持续状态，提交后本轮就可以结束。做别的事（走路、采集、建造、吃东西、睡觉……）时它自己让开，做完几秒后自己接上，不需要 pause 或 resume；玩家在同一个世界里走远了，它自己过去找，看见就接着跟（你发别的任务时这一趟会让开），玩家下线或去了别的维度就等玩家回来；跟随中不用 go-to 去找被跟的玩家。只有玩家叫停、companion-mode stop（保护一起关，正在做的事不受影响）或换成别的 follow／wait 才结束；玩家说“别跟了”“不用跟着”就是 stop。手动 pause 的会一直停着，要 resume 才继续。受阻时会收到一次事件，玩家明确说继续才 resume。保护是单独的开关（action guard）。顺手挖矿、捡东西要玩家明确说了才开。' },
  { id: 'guard', events: { guard: true },
    text: '保护说明：程序自己打靠近玩家的怪，血少了往玩家那边撤，不需要发攻击工具。离玩家 16 格内、跟随或站着时会去打；走路、砍树、在地面盖房子、种地时先停下去打，打完自己接着做；挖方块、吃东西、开着箱子或工作台、在垫脚柱或屋顶上时，先做完手上这一下。guard 事件可以简短说一句，不用每次都说，也不因此停止或重发跟随。玩家说别打了，才用 companion-mode guard 带 guard:false。' },
  { id: 'sit', tools: { sit: true },
    text: '坐下说明：坐下后跟随结束，保护还开着；附近有怪时程序会让你站起来打，打完自己走回座位坐下（回不去就改成原地等，并发一条事件）。起身用 get-up，起身后要再跟着玩家需要重新 companion-mode follow。' },
  { id: 'sleep', events: { player_sleep: true, bedtime: true }, tools: { 'sleep-in-bed': true },
    text: '睡觉说明：正陪着的玩家上床（player_sleep）时，用 sleep-in-bed（player 填那位玩家）去附近空床躺下；收到 bedtime（天黑且在家附近）时可以先跟玩家说一声再去睡。睡着时跟随让开，醒来后自己接上。没有空床或失败就照实说，不自己放床。' },
  { id: 'workstation', tools: { 'craft-item': true, 'smelt-item': true, 'produce-item': true, 'modify-item': true },
    text: '合成和机器说明：烧炼、酿造放好就去做别的，好了会收到 machine 事件（也会说没燃料或读不到），再回去取（烧炼用 smelt-item 带 furnace、不带 input；酿造按事件说的接着调）。缺材料时按回执的 missing 告诉玩家缺什么，不猜。几步连着的事，先从箱子里一次取齐再连着做。不知道一样东西怎么做，先用 workstation-options 查。' },
  { id: 'build', tools: { build: true },
    text: '建筑说明：dryRun 列出的缺料照实告诉玩家，或从箱子取、合成。背包里留些泥土或木板，够不着时用来垫高，盖完会收回。挡路的草花和朝向不对的同种方块会自动处理；要拆掉别的方块（replace:all）先问玩家。INCOMPLETE 或 TIMEOUT 按回执说明情况，用同样的参数再调一次会接着盖。' },
  { id: 'farm', tools: { 'tend-crops': true, 'breed-animals': true, hunt: true },
    text: '种地和动物说明：玩家说“我的地”时 tend-crops 的 player 填玩家。开新地：先挖坑、use-bucket 倒水，再 tend-crops 填 till（要锄头，可以同时填 plant 播种）。骨粉、播新种子、打动物都要玩家说了才做。hunt 的掉落用 collect-items 捡。' },
  { id: 'gift', events: { gift: true },
    text: '礼物说明：gift 是玩家丢给你、你已经捡起来的东西。要不要道谢、怎么说，按你的人设和当时的情况定，不必每次都说；需要时再用 get-status 带 include:["inventory"] 查背包。' },
  { id: 'scene', events: { scene: true },
    text: '景色说明：scene（日落、下雨等）只是景色变化，想说就随口说一句，不用每次都说。' },
  { id: 'danger', events: { survival: /^危险状态变化/ },
    text: '危险事件说明：这类事件只说明附近情况变了，不代表已经打过。会不会还手看事件末尾的「自卫」说明，真打了会另有 task 事件；没打过就不说“处理掉了”。' },
  { id: 'interrupted', events: { survival: /停止原任务/ },
    text: '任务被停说明：进食或自卫停掉的任务不会自己重做。先核对还差多少（看任务回执或查状态），再按剩下的发新任务。' },
];

/** Which guides this session has had; cleared when the conversation is compacted (compactions() changes). */
export class GuideBook {
  private shown = new Set<string>();
  private seenCompactions?: number;
  private readonly guides: Guide[];
  constructor(guides: readonly Guide[] = GUIDES, private readonly compactions: () => number | undefined = () => undefined) { this.guides = [...guides]; }
  /** Guides known only once the body said what it has (the plugin notes); one already there by id is kept. */
  add(guides: readonly Guide[]): void { for (const guide of guides) if (!this.guides.some(known => known.id === guide.id)) this.guides.push(guide); }
  /** The guide this tool call brings, once per session (and once more after each compaction). */
  forTool(name: string, args: Record<string, unknown> = {}): string | undefined {
    return this.take(guide => { const when = guide.tools?.[name]; return when === true || (typeof when === 'function' && when(args)); });
  }
  /** The guide this event brings, the same way. */
  forEvent(type: string, text: string): string | undefined {
    return this.take(guide => { const when = guide.events?.[type]; return when === true || (when instanceof RegExp && when.test(text)); });
  }
  private take(matches: (guide: Guide) => boolean): string | undefined {
    const count = this.compactions();
    if (count !== undefined && count !== this.seenCompactions) { if (this.seenCompactions !== undefined) this.shown.clear(); this.seenCompactions = count; }
    // Every guide this call brings (a tool with the notes of two plugins gives both).
    const due = this.guides.filter(item => !this.shown.has(item.id) && matches(item));
    if (!due.length) return undefined;
    for (const guide of due) this.shown.add(guide.id);
    return due.map(guide => guide.text).join('\n');
  }
}
