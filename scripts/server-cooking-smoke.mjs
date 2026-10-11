#!/usr/bin/env node
// 第 8 步示例适配①：用森罗厨房的炒锅做一道糖醋里脊（放油、加料、翻炒、出锅），全程走真实 MCP 的 interact-block。
// 翻炒用 repeatUntil 由程序连续完成。不启停服务器、不调用模型、不计算哈希。
// 需要：隔离服 mods 里有 kaleidoscopecookery 1.6.0、mcbot-server-control 和 mcbot-kaleidoscope-cookery 附属模组。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2);
if (flags.includes('--help') || !flags.includes('--allow-fixture')) {
  console.log('MC_SERVER_DIR=<隔离服绝对路径> node scripts/server-cooking-smoke.mjs --allow-fixture');
  console.log('固定25568/25578/8766；夹具区 x6400 z6400。');
  process.exit(flags.includes('--help') ? 0 : 1);
}
assert(process.env.MC_SERVER_DIR && path.isAbsolute(process.env.MC_SERVER_DIR), '必须明确设置绝对路径MC_SERVER_DIR');
const serverDir = path.resolve(process.env.MC_SERVER_DIR);
assert(!serverDir.toLowerCase().startsWith(path.resolve('G:/mc/mcbot').toLowerCase()), '拒绝旧私库服务器');
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const { rcon, readServerProps } = await import('./rcon.mjs');
const props = readServerProps(serverDir);
assert.equal(props['server-port'], '25568'); assert.equal(props['rcon.port'], '25578');
const connection = await readJson(path.join(serverDir, 'config/mcbot-server-control/connection.json'));
assert.equal(connection.username, 'Claude');
const { Client } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { StdioClientTransport } = await import('../client-runtime/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');

const dir = path.join(root, 'output', `server-cooking-${new Date().toISOString().replaceAll(':', '-')}`);
const runtime = path.join(dir, 'runtime'); await fs.mkdir(runtime, { recursive: true });
const secrets = [connection.token, props['rcon.password']].filter(Boolean);
const redact = text => { let value = String(text); for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value; };
const report = { started: new Date().toISOString(), serverDir, checks: [], calls: [], cleanup: [],
  limitations: ['没有使用真实模型和测试玩家。', '只做了糖醋里脊这一道带碗的菜；炒糊、无载具出锅（潜行加锅铲）不在本适配范围。'] };
const save = () => fs.writeFile(path.join(dir, 'report.json'), redact(JSON.stringify(report, null, 2)) + '\n');
function check(name, passed, detail) { report.checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); assert(passed, name + (detail ? ' ' + redact(JSON.stringify(detail)).slice(0, 1500) : '')); console.log('PASS ' + name); }
const command = async text => (await rcon([text], { serverDir, timeoutMs: 5000 }))[0];
async function fixture(text) {
  const list = (await command('list')).trim().match(/:\s*([^\r\n]*)$/)?.[1].split(',').map(n => n.trim()).filter(Boolean) ?? [];
  assert(list.every(name => name === 'Claude'), '有其他玩家在线，拒绝修改夹具');
  const reply = await command(text); report.calls.push({ fixture: text, reply: redact(reply) });
  assert(!/not loaded|Unknown or incomplete|Incorrect argument|Malformed|No entity was found|Unknown block|Unknown item/i.test(reply), '夹具命令被拒绝：' + redact(reply)); return reply;
}
let client;
async function tool(name, args = {}) {
  const reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  const value = JSON.parse(reply.content[0].text); report.calls.push({ tool: name, args, error: !!reply.isError, value });
  return { error: !!reply.isError, value };
}
async function hello() {
  const response = await fetch(connection.endpoint, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'hello', params: {} }) });
  return (await response.json()).result;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const count = (inventory, id) => inventory.filter(s => s.id === id).reduce((n, s) => n + s.count, 0);
const inventory = async () => (await tool('get-status', { details: true })).value.inventory;
const refusal = result => result.error ? result.value.code : result.value.status === 'failed' ? result.value.result?.code ?? result.value.code : null;
const POT = { x: 6402, y: 201, z: 6400 };
async function pot(interaction, item, extra = {}) {
  const reply = await tool('interact-block', { ...POT, interaction, item, ...extra });
  // unknown receipts: keep the server's list of out-of-envelope effects for the report
  if (!reply.error && reply.value.status === 'unknown') reply.value.unexpected = (await tool('get-operation', { operationId: reply.value.operationId, details: true })).value.result?.unexpected;
  return reply;
}
const ok = r => !r.error && r.value.status === 'succeeded';
let forced = [];
try {
  const h = await hello();
  const ids = ['add_oil', 'add_ingredient', 'stir', 'take_out'].map(s => `kaleidoscope_cookery:pot/${s}`);
  check('附属模组登记的四个炒锅交互都可用', ids.every(id => h.interactions.includes(id)), { interactions: h.interactions });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'client-runtime/dist/main.js'), '--body', 'server', '--connection-file', path.join(serverDir, 'config/mcbot-server-control/connection.json'),
    '--username', 'Claude', '--world-id', connection.worldId, '--runtime-dir', runtime, '--controller-id', randomUUID()], cwd: root, stderr: 'pipe' });
  client = new Client({ name: 'cooking-fixture', version: '1' }); await client.connect(transport);
  const survival = (await tool('get-status', { include: ['survival'], details: false })).value.survival;
  await tool('set-reflexes', { expectedRevision: survival.policy.revision, autoEat: false, autoDefend: false, armed: false }); await tool('stop-action');

  await fixture('forceload add 6392 6392 6415 6415'); forced.push('6392 6392 6415 6415');
  await fixture('fill 6396 200 6396 6412 200 6406 minecraft:stone');
  await fixture('fill 6396 201 6396 6412 204 6406 minecraft:air');
  await fixture('gamemode survival Claude'); await fixture('clear Claude');
  await fixture('tp Claude 6400.5 201 6400.5'); await wait(300);
  for (const [slot, item] of [[0, 'kaleidoscope_cookery:oil 2'], [1, 'minecraft:sugar 3'], [2, 'minecraft:porkchop 3'], [3, 'kaleidoscope_cookery:kitchen_shovel 1'], [4, 'minecraft:bowl 2']])
    await fixture(`item replace entity Claude hotbar.${slot} with ${item}`);
  await fixture('setblock 6402 200 6400 minecraft:magma_block');
  await fixture('setblock 6402 201 6400 kaleidoscope_cookery:pot'); await wait(300);

  // 1. 顺序不对时在右键前拒绝
  const early = await pot('kaleidoscope_cookery:pot/add_ingredient', 'minecraft:sugar');
  check('没放油就加料：INTERACTION_NOT_READY，糖没少', refusal(early) === 'INTERACTION_NOT_READY' && count(await inventory(), 'minecraft:sugar') === 3, early.value);
  // 2. 放油
  const oil = await pot('kaleidoscope_cookery:pot/add_oil', 'kaleidoscope_cookery:oil');
  check('放油：succeeded，油 2→1，锅显示有油', ok(oil) && oil.value.result.summary?.hasOil === true && count(await inventory(), 'kaleidoscope_cookery:oil') === 1, oil.value);
  const oilAgain = await pot('kaleidoscope_cookery:pot/add_oil', 'kaleidoscope_cookery:oil');
  check('再放一次油：INTERACTION_NOT_READY', refusal(oilAgain) === 'INTERACTION_NOT_READY', oilAgain.value);
  // 3. 加料：3 糖 + 3 猪排
  for (const [item, n] of [['minecraft:sugar', 3], ['minecraft:porkchop', 3]]) for (let i = 0; i < n; i++) {
    const added = await pot('kaleidoscope_cookery:pot/add_ingredient', item);
    check(`加 ${item} 第${i + 1}个：succeeded`, ok(added), added.value);
  }
  const inv = await inventory();
  check('糖和猪排都进了锅', count(inv, 'minecraft:sugar') === 0 && count(inv, 'minecraft:porkchop') === 0);
  const tooEarly = await pot('kaleidoscope_cookery:pot/take_out', 'minecraft:bowl');
  check('还没炒就拿碗出锅：INTERACTION_NOT_READY，碗没少', refusal(tooEarly) === 'INTERACTION_NOT_READY' && count(await inventory(), 'minecraft:bowl') === 2, tooEarly.value);
  // 4. 翻炒：一次调用，程序连续翻到剩余次数为 0
  const stirred = await pot('kaleidoscope_cookery:pot/stir', 'kaleidoscope_cookery:kitchen_shovel', { repeatUntil: { field: 'stirsLeft', equals: 0, intervalMs: 300 } });
  check('repeatUntil 翻炒：一次工具调用里翻到 stirsLeft=0，菜谱认成糖醋里脊', ok(stirred) && stirred.value.repeat?.reached === true && stirred.value.result.summary?.status === 'cooking' &&
    stirred.value.result.summary?.result === 'kaleidoscope_cookery:sweet_and_sour_pork' && stirred.value.result.summary?.carrier === 'minecraft:bowl', { repeat: stirred.value.repeat, summary: stirred.value.result?.summary });
  report.stirAttempts = stirred.value.repeat.attempts;
  const extra = await pot('kaleidoscope_cookery:pot/stir', 'kaleidoscope_cookery:kitchen_shovel');
  check('翻够了再翻：INTERACTION_NOT_READY，并告诉要等几秒', refusal(extra) === 'INTERACTION_NOT_READY' && /wait \d+s/.test(extra.value.message ?? extra.value.summary ?? JSON.stringify(extra.value)), extra.value);
  const cooking = await pot('kaleidoscope_cookery:pot/take_out', 'minecraft:bowl');
  check('炒的过程中出锅：INTERACTION_NOT_READY', refusal(cooking) === 'INTERACTION_NOT_READY', cooking.value);
  // 5. 等炒完（菜谱 10 秒）再用碗出锅
  const seconds = stirred.value.result.summary.secondsLeft;
  await wait((seconds + 2) * 1000);
  const served = await pot('kaleidoscope_cookery:pot/take_out', 'minecraft:bowl');
  const after = await inventory();
  check('出锅：succeeded，用掉 1 个碗，拿到糖醋里脊，锅回到空锅', ok(served) && count(after, 'minecraft:bowl') === 1 && count(after, 'kaleidoscope_cookery:sweet_and_sour_pork') === 1 &&
    served.value.result.summary?.status === 'put_ingredient' && served.value.result.summary?.inputs?.length === 0, { receipt: served.value, bowls: count(after, 'minecraft:bowl') });
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error.stack ?? error.message); process.exitCode = 1; console.error(redact(error.message));
} finally {
  for (const pos of ['6402 201 6400', '6402 200 6400']) { try { await command(`setblock ${pos} minecraft:air`); report.cleanup.push({ cleared: pos }); } catch (error) { report.cleanup.push({ clearFailed: pos, error: redact(error.message) }); } }
  try { await command('clear Claude'); report.cleanup.push({ cleared: 'Claude inventory' }); } catch {}
  for (const range of forced) { try { await command(`forceload remove ${range}`); report.cleanup.push({ forceloadRemoved: range }); } catch (error) { report.cleanup.push({ forceloadRemoveFailed: range, error: redact(error.message) }); } }
  try { await client?.close(); } catch {}
  report.finished = new Date().toISOString(); await save();
  console.log(`${report.result}: ${report.checks.filter(c => c.passed).length} checks; report ${path.relative(root, dir)}/report.json`);
}
