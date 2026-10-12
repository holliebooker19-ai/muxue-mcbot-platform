#!/usr/bin/env node
// 建筑实测（第 8i 步）：平坦隔离服上用 build 盖 3x3 小亭（地板、四根原木柱、横梁、楼梯双坡顶、灯笼），
//   缺料时不动手、dryRun 列材料、按蓝图盖完逐格核对、再盖一次不变、转 90° 楼梯朝向跟着转、改错的楼梯修回来、
//   门／墙上火把／横放原木的状态。垫高用背包里的泥土，盖完要挖回来。
// 不启停服务器、不调用模型、不计算哈希。需要：隔离服开着、世界是平坦的 world、没有真人在线。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-build-smoke.mjs --allow-fixture [--only pavilion,door] [--house <本机蓝图 JSON> [--house-from <层>]]');
  process.exit(flags.includes('--help') ? 0 : 1);
}
const flag = name => { const i = flags.indexOf(name); return i >= 0 ? flags[i + 1] : undefined; };
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确设置绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
assert(!serverDir.toLowerCase().startsWith(path.resolve('G:/mc/mcbot').toLowerCase()), '拒绝旧私库服务器');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const { rcon, readServerProps } = await import('./rcon.mjs');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568');
assert.equal(props['level-name'], 'world', '要在平坦世界 world 上跑');
const connection = await readJson(path.join(serverDir, 'config/mcbot-server-control/connection.json'));
const { Client } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');

const dir = path.join(root, 'output', `server-build-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'), blueprints = path.join(dir, 'blueprints');
await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], builds: {}, limitations: ['没有使用真实模型。', '平坦世界、白天、关了刷怪。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) {
  report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) });
  console.log((passed ? 'PASS ' : 'FAIL ') + name);
  assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 3000) : ''));
}
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) { const reply = await command(text); assert(!/not loaded|Unknown or incomplete|Incorrect argument|Invalid|Expected/i.test(reply), 'Fixture rejected: ' + text + ' → ' + reply); return reply; }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = reply.content[0].text; let value; try { value = JSON.parse(text); } catch { value = { text }; }
  return { error: !!reply.isError, value };
}
async function settle(op, ms) {
  const deadline = Date.now() + ms;
  while (!op.error && op.value.status === 'running' && Date.now() < deadline) { await wait(1000); op = await tool('get-operation', { operationId: op.value.operationId, details: true }); }
  return op;
}
const isBlock = async (x, y, z, state) => (await command(`execute if block ${x} ${y} ${z} ${state}`)).includes('passed');
async function count(item) { const m = (await command(`clear Claude ${item} 0`)).match(/(\d+)/); return m ? Number(m[1]) : 0; }
async function build(name, args, ms = 400000) {
  const started = Date.now();
  let op = await settle(await tool('build', args), ms);
  // The tool waits a little itself and may hand back the short model view: read the full result once more.
  if (!op.error && op.value.operationId && op.value.status !== 'running') op = await tool('get-operation', { operationId: op.value.operationId, details: true });
  const result = { status: op.error ? 'error' : op.value.status, summary: op.value.summary ?? op.value.message ?? op.value.text, result: op.value.result ?? op.value, ms: Date.now() - started };
  report.builds[name] = result; await save();
  console.log(name, JSON.stringify({ status: result.status, summary: result.summary, ms: result.ms }));
  return result;
}

// 3x3 小亭，相对最小角：地板、四角原木柱 3 高、横梁一圈、双坡楼梯顶（山墙和屋脊半砖）、地板中间一盏灯笼。
const pavilion = {
  shapes: [
    { shape: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 2, y: 0, z: 2 }, block: 'spruce_planks' },
    { shape: 'walls', from: { x: 0, y: 4, z: 0 }, to: { x: 2, y: 4, z: 2 }, block: 'oak_planks' },
    { shape: 'roof', from: { x: 0, y: 5, z: 0 }, to: { x: 2, y: 5, z: 2 }, block: 'oak_stairs', ridge: 'x' },
  ],
  blocks: [
    ...[[0, 0], [2, 0], [0, 2], [2, 2]].flatMap(([x, z]) => [1, 2, 3].map(y => ({ x, y, z, block: 'oak_log[axis=y]' }))),
    { x: 1, y: 1, z: 1, block: 'lantern[hanging=false]' },
  ],
};
const materials = { spruce_planks: 9, oak_log: 12, oak_planks: 10, oak_stairs: 6, oak_slab: 3, lantern: 1 };
const only = flag('--only')?.split(',');
const want = name => !only || only.includes(name);
const ground = -60; // flat world: grass at -61, feet at -60
const A = { x: 2400, y: ground, z: 2400 }, B = { x: 2410, y: ground, z: 2400 }, D = { x: 2400, y: ground, z: 2410 };
/** Every cell of the pavilion at `o`, turned like the server would (rotation 0 or 90). */
function pavilionCells(o, rotation) {
  const turn = ([x, y, z]) => rotation === 90 ? [2 - z, y, x] : [x, y, z];
  const facing = f => rotation === 90 ? ({ south: 'west', north: 'east' })[f] : f;
  const cells = [];
  for (let x = 0; x <= 2; x++) for (let z = 0; z <= 2; z++) cells.push([[x, 0, z], 'minecraft:spruce_planks']);
  for (const [x, z] of [[0, 0], [2, 0], [0, 2], [2, 2]]) for (const y of [1, 2, 3]) cells.push([[x, y, z], 'minecraft:oak_log[axis=y]']);
  for (let x = 0; x <= 2; x++) for (let z = 0; z <= 2; z++) if (x !== 1 || z !== 1) cells.push([[x, 4, z], 'minecraft:oak_planks']);
  for (let x = 0; x <= 2; x++) { cells.push([[x, 5, 0], `minecraft:oak_stairs[facing=${facing('south')},half=bottom]`]); cells.push([[x, 5, 2], `minecraft:oak_stairs[facing=${facing('north')},half=bottom]`]); cells.push([[x, 6, 1], 'minecraft:oak_slab[type=bottom]']); }
  cells.push([[0, 5, 1], 'minecraft:oak_planks'], [[2, 5, 1], 'minecraft:oak_planks'], [[1, 1, 1], 'minecraft:lantern[hanging=false]']);
  return cells.map(([p, state]) => { const [x, y, z] = turn(p); return { x: o.x + x, y: o.y + y, z: o.z + z, state }; });
}
async function wrongCells(cells) { const bad = []; for (const c of cells) if (!(await isBlock(c.x, c.y, c.z, c.state))) bad.push({ ...c, actual: await command(`data get block ${c.x} ${c.y} ${c.z}`).catch(() => '') }); return bad; }

try {
  await command('time set day'); await command('weather clear'); await command('gamerule doMobSpawning false');
  await fixture('forceload add 2380 2380 2430 2430');
  await fixture('fill 2385 -60 2385 2425 -45 2425 air'); await fixture('fill 2385 -61 2385 2425 -61 2425 grass_block');
  await fixture('kill @e[type=item,x=2380,y=-70,z=2380,dx=50,dy=40,dz=50]');
  const { respawnIfDead } = await import('./server-body-control.mjs');
  console.log('respawn: ' + await respawnIfDead({ connectionFile: path.join(serverDir, 'config/mcbot-server-control/connection.json'), username: 'Claude', worldId: connection.worldId }));
  client = new Client({ name: 'server-build-smoke', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, cwd: root, stderr: 'pipe',
    args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
      '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--blueprint-dir', blueprints, '--controller-id', randomUUID()] });
  transport.stderr?.on('data', chunk => fs.appendFile(path.join(dir, 'runtime-stderr.txt'), redact(chunk)).catch(() => {}));
  await client.connect(transport);
  // The body joins when the runtime claims it: move it and empty its inventory only now.
  await fixture('tp Claude 2398.5 -60 2398.5'); await fixture('clear Claude'); await wait(1500);
  const names = (await client.listTools()).tools.map(t => t.name);
  check('build、blueprints 已发布', ['build', 'blueprints'].every(n => names.includes(n)), names);
  const saved = await tool('blueprints', { action: 'save', name: '小亭', description: '3x3 测试小亭', ...pavilion });
  check('小亭存成蓝图（3x7x3，41 格）', !saved.error && saved.value.size?.x === 3 && saved.value.size?.y === 7 && saved.value.blocks === 41, saved.value);

  if (want('pavilion')) {
    const missing = await build('missing', { blueprint: { name: '小亭', origin: A } }, 30000);
    check('缺材料：MISSING_MATERIALS，列出缺什么，世界没动', missing.status === 'failed' && /MISSING_MATERIALS/.test(missing.summary) && missing.result.missing?.some(m => m.item === 'minecraft:oak_stairs' && m.need === 6) && await isBlock(A.x, A.y, A.z, 'air'), missing);
    for (const [item, n] of Object.entries(materials)) await fixture(`give Claude minecraft:${item} ${n}`);
    await fixture('give Claude minecraft:dirt 16');
    const plan = await tool('build', { blueprint: { name: '小亭', origin: A }, dryRun: true });
    const planned = plan.value.result ?? plan.value;
    check('dryRun：要放 41 格、材料都够、什么都没动', planned.toPlace === 41 && planned.missing?.length === 0 && planned.materials?.find(m => m.item === 'minecraft:oak_log')?.need === 12 && await isBlock(A.x, A.y, A.z, 'air'), planned);
    const built = await build('pavilion', { blueprint: { name: '小亭', origin: A } });
    const bad = await wrongCells(pavilionCells(A, 0));
    check('盖完小亭：41 格逐格对上（含楼梯朝南／朝北、原木竖放、屋脊下半砖、灯笼）', built.status === 'succeeded' && bad.length === 0, { built, bad: bad.slice(0, 8) });
    check('用了泥土垫高，盖完都挖回来了（没有留下垫脚）', built.result.scaffoldUsed > 0 && built.result.scaffoldLeft?.length === 0, built.result);
    let dirtLeft = 0; for (let x = 2394; x <= 2408; x++) for (let z = 2394; z <= 2408; z++) for (let y = -60; y <= -50; y++) if (await isBlock(x, y, z, 'dirt')) dirtLeft++;
    await wait(1500);
    check('场地上没有泥土，背包里泥土还剩至少 14 个', dirtLeft === 0 && await count('minecraft:dirt') >= 14, { dirtLeft, dirt: await count('minecraft:dirt') });
    const again = await build('again', { blueprint: { name: '小亭', origin: A } }, 60000);
    check('再盖一次：41 格都已经对了，什么都不放', again.status === 'succeeded' && again.result.already === 41 && again.result.placed === 0, again.result);
    await fixture(`setblock ${A.x + 1} ${A.y + 5} ${A.z} minecraft:oak_stairs[facing=east,half=bottom]`);
    await fixture('give Claude minecraft:oak_stairs 1');
    const fixed = await build('fix', { blueprint: { name: '小亭', origin: A } }, 120000);
    check('朝向错的楼梯（replace 默认 soft）：挖掉重放，朝南', fixed.status === 'succeeded' && fixed.result.dug === 1 && fixed.result.placed === 1 && await isBlock(A.x + 1, A.y + 5, A.z, 'oak_stairs[facing=south,half=bottom]'), fixed.result);
  }
  if (want('rotated')) {
    for (const [item, n] of Object.entries(materials)) await fixture(`give Claude minecraft:${item} ${n}`);
    await fixture('give Claude minecraft:dirt 16');
    const turned = await build('rotated', { blueprint: { name: '小亭', origin: B, rotation: 90 } });
    const bad = await wrongCells(pavilionCells(B, 90));
    check('转 90° 盖：楼梯朝向跟着转（朝南→朝西、朝北→朝东），屋脊沿 z', turned.status === 'succeeded' && bad.length === 0, { turned, bad: bad.slice(0, 8) });
  }
  if (want('door')) {
    // 一面 3 宽 3 高的圆石墙，中间下面两格留门洞放橡木门（朝南、门轴在左），墙南面上方挂火把，墙顶一根横放的原木；
    // 墙西边贴着一根不写朝向的原木柱（10-12 试玩：点在墙侧面放成了横的），要按 /setblock 默认竖着放。
    const o = D;
    const wall = [];
    for (let x = 0; x <= 2; x++) for (let y = 0; y <= 2; y++) if (!(x === 1 && y < 2)) wall.push({ x: o.x + x, y: o.y + y, z: o.z, block: 'cobblestone' });
    const blocks = [...wall,
      { x: o.x + 1, y: o.y, z: o.z, block: 'oak_door[facing=south,half=lower,hinge=left]' },
      { x: o.x + 2, y: o.y + 1, z: o.z + 1, block: 'wall_torch[facing=south]' },
      ...[0, 1, 2].map(x => ({ x: o.x + x, y: o.y + 3, z: o.z, block: 'oak_log[axis=x]' })),
      ...[0, 1, 2].map(y => ({ x: o.x - 1, y: o.y + y, z: o.z, block: 'oak_log' })),
    ];
    await fixture('give Claude minecraft:cobblestone 7'); await fixture('give Claude minecraft:oak_door 1'); await fixture('give Claude minecraft:torch 1'); await fixture('give Claude minecraft:oak_log 6');
    await fixture('give Claude minecraft:dirt 8');
    const built = await build('door', { blocks });
    const expect = [
      ...wall.map(c => ({ ...c, state: 'cobblestone' })),
      { x: o.x + 1, y: o.y, z: o.z, state: 'oak_door[facing=south,half=lower,hinge=left]' },
      { x: o.x + 1, y: o.y + 1, z: o.z, state: 'oak_door[facing=south,half=upper,hinge=left]' },
      { x: o.x + 2, y: o.y + 1, z: o.z + 1, state: 'wall_torch[facing=south]' },
      ...[0, 1, 2].map(x => ({ x: o.x + x, y: o.y + 3, z: o.z, state: 'oak_log[axis=x]' })),
      ...[0, 1, 2].map(y => ({ x: o.x - 1, y: o.y + y, z: o.z, state: 'oak_log[axis=y]' })),
    ];
    const bad = await wrongCells(expect);
    check('门（朝南、门轴在左，上半自动出现）、墙上火把朝南、横放原木、不写朝向的原木柱竖着，都对', built.status === 'succeeded' && bad.length === 0, { built, bad });
  }
  // --house <蓝图 JSON>：整栋按层分段盖（每段先 dryRun 看缺什么、补料，再 build，没盖完接着调），最后逐格核对；只记录不判定。
  // 图纸只从本机路径读，报告里不存方块清单。
  const houseFile = flag('--house');
  if (houseFile) {
    const house = await readJson(houseFile);
    const o = { x: 2440, y: ground, z: 2380 };
    await fixture(`forceload add ${o.x - 10} ${o.z - 10} ${o.x + house.size.x + 10} ${o.z + house.size.z + 10}`);
    await fixture(`fill ${o.x - 6} ${ground} ${o.z - 6} ${o.x + house.size.x + 6} ${ground + 20} ${o.z + house.size.z + 6} air`);
    await fixture(`fill ${o.x - 6} ${ground - 1} ${o.z - 6} ${o.x + house.size.x + 6} ${ground - 1} ${o.z + house.size.z + 6} grass_block`);
    await command(`kill @e[type=item,x=${o.x - 10},y=${ground - 5},z=${o.z - 10},dx=${house.size.x + 20},dy=40,dz=${house.size.z + 20}]`); // 前几轮掉的东西
    await fixture(`tp Claude ${o.x - 3} ${ground} ${o.z - 3}`);
    const cells = house.blocks.map(([x, y, z, state]) => ({ x: o.x + x, y: o.y + y, z: o.z + z, block: state }));
    // --house-from <层>：这层以下用指令直接摆好（试上层时省掉盖一楼的时间），Bot 从这层开始盖；核对只算它盖的。
    const from = Number(flag('--house-from') ?? 0);
    // 挂着、贴着的（门、灯笼、火把……）等托着它的方块都摆好再摆，门两个半扇都摆，不然一有方块更新就掉成物品。
    const attached = /door|torch|lantern|ladder|button|lever|sign|banner|carpet|pressure_plate|rail|flower_pot|candle|chain|skull|head|bell|tripwire_hook/;
    const preset = cells.filter(c => c.y - o.y < from).sort((a, b) => (attached.test(a.block) - attached.test(b.block)) || a.y - b.y);
    for (const c of preset) {
      const state = c.block.includes(':') ? c.block : `minecraft:${c.block}`;
      await fixture(`setblock ${c.x} ${c.y} ${c.z} ${state}`);
      if (/_door\[/.test(state) && state.includes('half=lower')) await fixture(`setblock ${c.x} ${c.y + 1} ${c.z} ${state.replace('half=lower', 'half=upper')}`);
    }
    const slices = [[0, 0], [1, 3], [4, 5], [6, 9], [10, 13]].filter(([, high]) => high >= from).map(([low, high]) => [Math.max(low, from), high]);
    const started = Date.now(); const houseReport = { file: path.basename(houseFile), cells: cells.filter(c => c.y - o.y >= from).length, from, slices: [] };
    for (const [low, high] of slices) {
      const blocks = cells.filter(c => c.y - o.y >= low && c.y - o.y <= high);
      await fixture('clear Claude');
      // 连着盖很久会饿：每段开始前补满饱食和血（饿掉血会让 build 按受伤停下）。
      await fixture('effect give Claude minecraft:saturation 1 20 true'); await fixture('effect give Claude minecraft:instant_health 1 5 true');
      const plan = await tool('build', { blocks, dryRun: true });
      const planned = plan.value.result ?? plan.value;
      for (const m of planned.missing ?? []) await fixture(`give Claude ${m.item} ${m.need - m.have}`);
      await fixture('give Claude minecraft:dirt 64');
      const slice = { layers: `${low}-${high}`, cells: blocks.length, calls: [] };
      for (let call = 0; call < 6; call++) {
        if (call > 0) {
          await fixture('effect give Claude minecraft:saturation 1 20 true');
          // 上一次调用中途少了的料（不该少，记下来）补上，免得这段因为缺料直接停。
          const again = await tool('build', { blocks, dryRun: true });
          for (const m of (again.value.result ?? again.value).missing ?? []) { await fixture(`give Claude ${m.item} ${m.need - m.have}`); (slice.toppedUp ??= []).push(m); }
        }
        const result = await build(`house-${low}-${high}-${call}`, { blocks }, 620000);
        slice.calls.push({ status: result.status, summary: result.summary, ms: result.ms, placed: result.result.placed, scaffoldUsed: result.result.scaffoldUsed, helpersUsed: result.result.helpersUsed, skippedWhy: result.result.skippedWhy, wrongState: result.result.wrongState?.length });
        slice.calls.at(-1).trace = result.result.trace;
        if (result.status === 'succeeded' || !/TIMEOUT/.test(result.summary ?? '')) break;
      }
      slice.dirtAfter = await count('minecraft:dirt'); // 开始给了 64：少的就是垫脚没捡回来的
      houseReport.slices.push(slice); report.house = houseReport; await save();
    }
    // Properties the neighbours decide (pane and fence links, stair corners...) are not what build promises: not compared.
    const AUTO = new Set(['waterlogged', 'shape', 'north', 'south', 'east', 'west', 'up', 'powered', 'occupied', 'open', 'in_wall', 'snowy', 'distance', 'persistent', 'lit', 'attached', 'bottom', 'leaves', 'age', 'level', 'power', 'layers', 'rotation']);
    const placedState = text => {
      const [, name, props] = text.match(/^([^[]+)(?:\[(.*)\])?$/);
      const kept = (props ?? '').split(',').filter(p => p && !AUTO.has(p.split('=')[0]));
      return `${name.includes(':') ? name : `minecraft:${name}`}${kept.length ? `[${kept.join(',')}]` : ''}`;
    };
    const wrongByBlock = {};
    for (const c of cells) {
      if (c.y - o.y < from) continue;
      const state = placedState(c.block);
      if (!(await isBlock(c.x, c.y, c.z, state))) wrongByBlock[c.block.replace(/\[.*$/, '')] = (wrongByBlock[c.block.replace(/\[.*$/, '')] ?? 0) + 1;
    }
    const wrong = Object.values(wrongByBlock).reduce((a, b) => a + b, 0);
    // 地面以上还立着的泥土＝没拆掉的垫脚（蓝图里的泥土都在第 0 层）；fill 换成自己会回报格数，世界不变。
    const dirt = await command(`fill ${o.x - 6} ${ground + 1} ${o.z - 6} ${o.x + house.size.x + 6} ${ground + 19} ${o.z + house.size.z + 6} minecraft:dirt replace minecraft:dirt`);
    const dirtLeft = Number(dirt.match(/(\d+)/)?.[1] ?? 0);
    Object.assign(houseReport, { minutes: Math.round((Date.now() - started) / 6000) / 10, right: houseReport.cells - wrong, wrong, wrongByBlock, dirtLeft });
    report.house = houseReport; await save();
    console.log('house', JSON.stringify({ right: houseReport.right, wrong, minutes: houseReport.minutes, dirtLeft, wrongByBlock }));
  }
} finally {
  report.finished = new Date().toISOString(); await save().catch(() => {});
  await client?.close().catch(() => {});
  console.log('report: ' + path.join(dir, 'report.json'));
}
