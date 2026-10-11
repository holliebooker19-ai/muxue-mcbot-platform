#!/usr/bin/env node
// 通用工作站 B、C 阶段实测：平坦隔离服
//   1. workstation-options 列出附近 8 种工作站，石台阶的做法里有工作台和切石机；
//   2. 切石机：3 块石头切 6 个石台阶；没石头报缺料；木板不在切石机做，提示用 craft-item；
//   3. 酿造台：3 瓶水→粗制→迅捷，两段，自动加烈焰粉；缺材料时列出要地狱疣；
//   4. 附魔台：预览三个选项；maxLevels 不够拒绝且不动；选第 1 个附魔，花 1 级和 1 个青金石；
//   5. 铁砧：磨损的铁剑加铁锭修理并改名，先预览看花费，expect 对上才做；旧 ref 失效；
//   6. 砂轮：去掉附魔；锻造台：钻石剑升级下界合金剑；织布机：白旗加红色条纹。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、平坦世界、没装要求客户端的 Mod。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-station-smoke.mjs --allow-fixture');
  process.exit(flags.includes('--help') ? 0 : 1);
}
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确设置绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
assert(!serverDir.toLowerCase().startsWith(path.resolve('G:/mc/mcbot').toLowerCase()), '拒绝旧私库服务器');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const { rcon, readServerProps } = await import('./rcon.mjs');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568');
const connection = await readJson(path.join(serverDir, 'config/mcbot-server-control/connection.json'));
const { Client } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');

const dir = path.join(root, 'output', `server-station-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], runs: {}, limitations: ['没有使用真实模型。', '制图台没有实测（要先有一张已绘制的地图）。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 2500) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) { const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Invalid|Expected/i.test(reply), 'Fixture rejected: ' + text + ' → ' + reply); return reply; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}
async function settle(op, ms = 90000) {
  const deadline = Date.now() + ms;
  while (!op.error && op.value.status === 'running' && Date.now() < deadline) { await wait(500); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  return op;
}
const codeOf = op => op.error ? op.value.code : op.value.result?.code ?? op.value.summary;
const options = async args => (await settle(await tool('workstation-options', args))).value.result ?? {};
/** Inventory by item identity with components (potion type, enchantments, name). */
const held = async () => { const n = {}; for (const s of (await options({ subjects: '*' })).subjects ?? []) n[s.item] = (n[s.item] ?? 0) + s.count; return n; };
const ref = async item => ((await options({ subjects: item })).subjects ?? [])[0]?.ref;
const give = async (item, count = 1) => fixture(`give Claude ${item} ${count}`);
const levels = async () => Number((await command('xp query Claude levels')).match(/(\d+) experience levels/)?.[1] ?? NaN);

// 高台 y=200（人站 201），场地 X/Z 3900 附近
const [X0, X1, Z0, Z1, Y, M] = [3892, 3908, 3892, 3908, 200, 3];
const start = [3900.5, Y + 1, 3900.5];
const stations = { stonecutter: [3903, 3900], brewing_stand: [3897, 3900], enchanting_table: [3900, 3903], anvil: [3900, 3897],
  grindstone: [3903, 3903], smithing_table: [3897, 3897], loom: [3903, 3897], cartography_table: [3897, 3903] };
try {
  await fixture(`forceload add ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
  await command('time set day'); await command('weather clear'); await command('gamerule doMobSpawning false');
  await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 8} ${Z1 + M} air`);
  await fixture(`fill ${X0} ${Y} ${Z0} ${X1} ${Y} ${Z1} stone`);
  for (const [name, [x, z]] of Object.entries(stations)) await fixture(`setblock ${x} ${Y + 1} ${z} ${name}${name === 'grindstone' ? '[face=floor]' : ''}`);
  client = new Client({ name: 'server-station-smoke', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()] });
  transport.stderr?.on('data', data => { fs.appendFile(path.join(dir, 'runtime-stderr.log'), redact(data.toString())).catch(() => {}); });
  await client.connect(transport);
  // The body comes online with the controller; only then can it be moved and cleared.
  await tool('get-status');
  await command(`tp Claude ${start.join(' ')}`); await wait(1500);
  await command('clear Claude'); await command('xp set Claude 0 levels'); await command('xp set Claude 0 points');
  const names = (await client.listTools()).tools.map(t => t.name);
  check('workstation-options、produce-item、modify-item 已发布', ['workstation-options', 'produce-item', 'modify-item'].every(n => names.includes(n)), names);

  // 1. 查询
  const slab = await options({ item: 'minecraft:stone_slab', count: 6 });
  report.runs.options = slab;
  const ids = (slab.stations ?? []).map(s => s.station);
  check('附近 8 种工作站都列出来了', Object.keys(stations).every(n => ids.includes('minecraft:' + n)), slab.stations);
  check('石台阶的做法：工作台合成和切石机都有', (slab.ways ?? []).some(w => w.tool === 'craft-item') && (slab.ways ?? []).some(w => w.tool === 'produce-item' && w.station === 'minecraft:stonecutter'), slab.ways);

  // 2. 切石机
  await give('stone', 3);
  const cut = await settle(await tool('produce-item', { item: 'minecraft:stone_slab', count: 6 }));
  report.runs.cut = cut.value;
  let inv = await held();
  check('切石机：3 块石头切出 6 个石台阶', cut.value.status === 'succeeded' && cut.value.result?.made === 6 && inv['minecraft:stone_slab'] === 6 && !inv['minecraft:stone'], { op: cut.value, inv });
  const noStone = await settle(await tool('produce-item', { item: 'minecraft:stone_stairs', count: 4 }));
  check('没石头：报 MISSING_MATERIALS', codeOf(noStone) === 'MISSING_MATERIALS' && (noStone.value.result?.missing ?? []).length > 0, noStone.value);
  const planks = await settle(await tool('produce-item', { item: 'minecraft:oak_planks' }));
  check('木板不在切石机做：NO_RECIPE，提示用 craft-item', codeOf(planks) === 'NO_RECIPE' && /craft-item/.test(planks.value.summary ?? planks.value.message ?? JSON.stringify(planks.value)), planks.value);

  // 3. 酿造
  await command('clear Claude');
  const brewMissing = await settle(await tool('produce-item', { item: 'minecraft:potion', potion: 'minecraft:swiftness', count: 1 }));
  report.runs.brewMissing = brewMissing.value;
  check('什么都没有时酿迅捷：MISSING_MATERIALS，列出水瓶、地狱疣、糖', codeOf(brewMissing) === 'MISSING_MATERIALS' && ['nether_wart', 'sugar', 'water'].every(w => JSON.stringify(brewMissing.value.result?.missing ?? []).includes(w)), brewMissing.value);
  await give('potion[potion_contents={potion:"minecraft:water"}]', 3); await give('nether_wart', 1); await give('sugar', 1); await give('blaze_powder', 1);
  const brew = await settle(await tool('produce-item', { item: 'minecraft:potion', potion: 'minecraft:swiftness', count: 3, wait: true }), 120000);
  report.runs.brew = brew.value;
  inv = await held();
  check('酿造：3 瓶水两段酿成 3 瓶迅捷药水，自动放了烈焰粉', brew.value.status === 'succeeded' && brew.value.result?.made === 3 && inv['minecraft:potion[potion=minecraft:swiftness]'] === 3 && !inv['minecraft:nether_wart'] && !inv['minecraft:sugar'] && brew.value.result?.fuelAdded === 1, { op: brew.value, inv });

  // 4. 附魔台
  await command('clear Claude'); await give('iron_sword', 1); await give('lapis_lazuli', 3); await command('xp set Claude 30 levels');
  const sword = await ref('minecraft:iron_sword');
  const look = await settle(await tool('modify-item', { subject: sword, action: { kind: 'enchant' }, preview: true }));
  report.runs.enchantPreview = look.value;
  inv = await held();
  check('附魔预览：列出 3 个选项，东西都拿回来了', look.value.status === 'succeeded' && (look.value.result?.options ?? []).length === 3 && inv['minecraft:iron_sword'] === 1 && inv['minecraft:lapis_lazuli'] === 3, { op: look.value, inv });
  const tooMuch = await settle(await tool('modify-item', { subject: sword, action: { kind: 'enchant', option: 1 } }));
  inv = await held();
  check('maxLevels 默认 0：OVER_LIMIT，剑没变、等级没变', codeOf(tooMuch) === 'OVER_LIMIT' && inv['minecraft:iron_sword'] === 1 && await levels() === 30, { op: tooMuch.value, inv });
  const enchant = await settle(await tool('modify-item', { subject: sword, action: { kind: 'enchant', option: 1 }, maxLevels: 1 }));
  report.runs.enchant = enchant.value;
  inv = await held();
  const enchanted = Object.keys(inv).find(k => k.startsWith('minecraft:iron_sword[enchantments='));
  check('选第 1 个附魔：剑有了附魔，花 1 级、1 个青金石', enchant.value.status === 'succeeded' && enchanted && await levels() === 29 && inv['minecraft:lapis_lazuli'] === 2, { op: enchant.value, inv });
  const stale = await settle(await tool('modify-item', { subject: sword, action: { kind: 'enchant' }, preview: true }));
  check('附魔后旧 ref 失效：STALE_SUBJECT', codeOf(stale) === 'STALE_SUBJECT', stale.value);

  // 5. 砂轮：去掉刚才的附魔
  const enchantedRef = await ref('minecraft:iron_sword');
  const grind = await settle(await tool('modify-item', { subject: enchantedRef, action: { kind: 'grind' } }));
  report.runs.grind = grind.value;
  inv = await held();
  check('砂轮：附魔去掉了，变回普通铁剑', grind.value.status === 'succeeded' && inv['minecraft:iron_sword'] === 1, { op: grind.value, inv });

  // 6. 铁砧：修理并改名
  await command('clear Claude'); await give('iron_sword[damage=200]', 1); await give('iron_ingot', 2); await command('xp set Claude 30 levels');
  const worn = await ref('minecraft:iron_sword');
  const anvilLook = await settle(await tool('modify-item', { subject: worn, action: { kind: 'anvil', with: 'minecraft:iron_ingot', rename: 'Xiaoke' }, preview: true }));
  report.runs.anvilPreview = anvilLook.value;
  const cost = anvilLook.value.result?.levelCost, expect = anvilLook.value.result?.result?.item;
  check('铁砧预览：显示修好改名后的剑和花费', anvilLook.value.status === 'succeeded' && cost > 0 && /name=Xiaoke/.test(expect ?? ''), anvilLook.value);
  const wrong = await settle(await tool('modify-item', { subject: worn, action: { kind: 'anvil', with: 'minecraft:iron_ingot', rename: 'Xiaoke' }, maxLevels: cost, expect: 'minecraft:iron_sword' }));
  check('expect 和实际结果不同：PREVIEW_CHANGED，不做', codeOf(wrong) === 'PREVIEW_CHANGED', wrong.value);
  const anvil = await settle(await tool('modify-item', { subject: worn, action: { kind: 'anvil', with: 'minecraft:iron_ingot', rename: 'Xiaoke' }, maxLevels: cost, expect }));
  report.runs.anvil = anvil.value;
  inv = await held();
  check('铁砧：修好并改名为 Xiaoke，花了预览的等级，用掉铁锭', anvil.value.status === 'succeeded' && inv[expect] === 1 && await levels() === 30 - cost && (inv['minecraft:iron_ingot'] ?? 0) < 2, { op: anvil.value, inv, cost });

  // 7. 锻造台
  await command('clear Claude'); await give('diamond_sword', 1); await give('netherite_upgrade_smithing_template', 1); await give('netherite_ingot', 1);
  const smith = await settle(await tool('modify-item', { subject: await ref('minecraft:diamond_sword'), action: { kind: 'smith', template: 'minecraft:netherite_upgrade_smithing_template', addition: 'minecraft:netherite_ingot' } }));
  report.runs.smith = smith.value;
  inv = await held();
  check('锻造台：钻石剑升级成下界合金剑，模板和锭用掉', smith.value.status === 'succeeded' && inv['minecraft:netherite_sword'] === 1 && !inv['minecraft:diamond_sword'] && !inv['minecraft:netherite_ingot'], { op: smith.value, inv });

  // 8. 织布机
  await command('clear Claude'); await give('white_banner', 1); await give('red_dye', 1);
  const banner = await ref('minecraft:white_banner');
  const loomLook = await settle(await tool('modify-item', { subject: banner, action: { kind: 'loom', dye: 'minecraft:red_dye' }, preview: true }));
  report.runs.loomPreview = loomLook.value;
  check('织布机预览：列出能织的图案', loomLook.value.status === 'succeeded' && (loomLook.value.result?.options ?? []).includes('minecraft:stripe_bottom'), loomLook.value);
  const loom = await settle(await tool('modify-item', { subject: banner, action: { kind: 'loom', dye: 'minecraft:red_dye', pattern: 'stripe_bottom' } }));
  report.runs.loom = loom.value;
  inv = await held();
  check('织布机：白旗织上红色底边条纹，染料用掉', loom.value.status === 'succeeded' && Object.keys(inv).some(k => k.startsWith('minecraft:white_banner[') && k.includes('banner_patterns')) && !inv['minecraft:red_dye'], { op: loom.value, inv });
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1; console.error(report.error);
} finally {
  try { await tool('stop-action'); } catch {}
  try { await client?.close(); } catch {}
  try {
    await command(`tp Claude 3800.5 -60 3800.5`); await wait(500);
    await command(`fill ${X0 - M} ${Y - 2} ${Z0 - M} ${X1 + M} ${Y + 8} ${Z1 + M} air`);
    await command(`kill @e[type=item,x=3900,y=${Y},z=3900,distance=..30]`); await command(`kill @e[type=experience_orb,x=3900,y=${Y},z=3900,distance=..30]`);
    await command(`forceload remove ${X0 - M} ${Z0 - M} ${X1 + M} ${Z1 + M}`);
    await command('clear Claude'); await command('xp set Claude 0 levels');
  } catch {}
  await save(); console.log('报告：' + path.relative(root, path.join(dir, 'report.json')));
}
