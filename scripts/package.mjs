#!/usr/bin/env node
// 打绿色版：便携 Node、构建好的运行端（只带运行依赖）、WebUI 和托管脚本、我们自己的 jar，解压后双击「启动 mcbot.cmd」。
// 用法：node scripts/package.mjs [--out output/package] [--node <node.exe>] [--skip-build] [--no-zip]
// 不联网：运行依赖复制 client-runtime 已装好的，再 npm prune 掉开发依赖；jar 要先用 gradle 构建好（缺了会说是哪个）。
// Node 要用官方 zip 版（带 LICENSE）：解压到 runtime/node-dist/node-v<版本>-win-x64，或用 --node 指定。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCompat, checkCompat } from './check-compat.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 绿色版里跑的入口；它们 import 的同目录脚本会自动带上
const ENTRIES = ['webui.mjs', 'start-server-play.mjs', 'companion.mjs'];
const ASSETS = ['webui-page.html'];
const TOP_FILES = ['compat.json', 'LICENSE', 'NOTICE', 'CLAUDE.md'];

/** 默认用 runtime/node-dist 里解压好的官方 Node（版本最新的那个）；没有就用当前的 Node。 */
function defaultNode() {
  const dir = path.join(ROOT, 'runtime', 'node-dist');
  let found = [];
  try { found = fs.readdirSync(dir).filter((n) => /^node-v\d+\.\d+\.\d+-win-x64$/.test(n) && fs.existsSync(path.join(dir, n, 'node.exe'))); } catch { /* 没有就用当前的 */ }
  const key = (n) => n.match(/\d+/g).slice(0, 3).map(Number);
  found.sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  return found.length ? path.join(dir, found.at(-1), 'node.exe') : process.execPath;
}

export function parsePackageArgs(argv) {
  const o = { out: path.join(ROOT, 'output', 'package'), node: defaultNode(), build: true, zip: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--node') o.node = path.resolve(argv[++i]);
    else if (a === '--skip-build') o.build = false;
    else if (a === '--no-zip') o.zip = false;
    else throw new Error(`不支持的参数：${a}（可用参数：--out、--node、--skip-build、--no-zip）`);
  }
  return o;
}

/** scripts 下从入口出发 import 到的同目录脚本（相对路径的静态和动态 import）。 */
export function scriptClosure(dir, entries) {
  const seen = new Set();
  const visit = (rel) => {
    const norm = path.normalize(rel);
    if (seen.has(norm)) return;
    const file = path.join(dir, norm);
    if (!fs.existsSync(file)) throw new Error(`scripts/${norm} 不存在`);
    seen.add(norm);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.normalize(path.join(path.dirname(norm), m[1]));
      if (target.startsWith('..')) throw new Error(`scripts/${norm} 引用了 scripts 以外的 ${m[1]}，绿色版中不包含该文件`);
      visit(target);
    }
  };
  for (const e of entries) visit(e);
  return [...seen].sort();
}

// Windows 上 npm 是 npm.cmd，要经 cmd 跑；参数都是这里写死的，不含用户输入
const run = (cmd, args, cwd) => {
  const [exe, all] = process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd, ...args]] : [cmd, args];
  const r = spawnSync(exe, all, { cwd, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败（退出码 ${r.status}）`);
};
const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); };

// cmd 文件只写 ASCII（cmd 按系统代码页读），中文提示交给 Node 输出。
const LAUNCHER = [
  '@echo off',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  '"%~dp0node\\node.exe" "%~dp0scripts\\webui.mjs" --open',
  'if errorlevel 1 pause',
  '',
].join('\r\n');

function readme(compat, version, jars) {
  const p = compat.platform;
  return [
    `mcbot ${version}（Windows 绿色版）`,
    '',
    '使本机的 AI（Claude Code、Codex、DeepSeek Harness）在 Minecraft 中控制一个游戏伙伴。',
    '',
    `支持：Minecraft ${p.minecraft}，NeoForge ${p.loaderMin} 及以上（${p.loaderMin.split('.').slice(0, 2).join('.')} 系列），独立服务器或已对局域网开放的单人世界。`,
    '',
    '使用方法',
    '1. 在本机安装并登录一个 Agent：Claude Code、Codex 或 DeepSeek Harness。程序不会代为登录。',
    '2. 双击「启动 mcbot.cmd」，浏览器将打开 WebUI。',
    '3. 在「配置」页新建配置，在「连接配置」中选择游戏目录（服务器目录或启动器实例）。',
    '4. 在「插件」中安装核心模组和所需插件。修改前请备份存档。',
    '   也可手动将 mods 文件夹中的 jar 复制到游戏的 mods 中。必装：' + jars.core,
    '   可选插件（需同时安装对应模组的指定版本）：' + (jars.addons.join('、') || '无'),
    '5. 启动服务器，或进入单人世界后按 Esc 选择「对局域网开放」。',
    '6. 点击「保存并启动托管」。',
    '',
    '连接文件（config/mcbot-server-control/connection.json）中含有控制令牌，仅保存在本机，请勿发送给他人。',
    '支持的模组及确切版本见 compat.json；对于清单以外的模组，Bot 将拒绝操作。',
    '',
    '本安装包附带 Node.js（node 文件夹，MIT 许可，见 node/LICENSE）。本项目以 Apache License 2.0 发布，见 LICENSE、NOTICE。',
    '',
  ].join('\r\n');
}

export function buildPackage(opts) {
  const compat = loadCompat();
  const problems = checkCompat(compat);
  if (problems.length) throw new Error(`compat.json 与代码不一致，请先修复：\n- ${problems.join('\n- ')}`);
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'client-runtime', 'package.json'), 'utf8')).version;
  const nodeVersion = spawnSync(opts.node, ['--version'], { encoding: 'utf8' }).stdout?.trim() || '';
  const major = Number(/^v(\d+)\./.exec(nodeVersion)?.[1] || 0);
  if (major < Number(compat.platform.node)) throw new Error(`待打包的 Node 版本为 ${nodeVersion || '无法读取'}，最低要求 ${compat.platform.node}（使用 --node 指定）`);
  const nodeLicense = path.join(path.dirname(opts.node), 'LICENSE');
  if (!fs.existsSync(nodeLicense)) throw new Error(`${path.dirname(opts.node)} 中缺少 Node 的 LICENSE，请使用官方发行包中的 node.exe`);

  const jarFiles = [compat.core, ...compat.adapters.filter((a) => a.kind === 'addon')].map((a) => ({ id: a.id, jar: a.jar, from: path.join(ROOT, a.project, 'build', 'libs', a.jar) }));
  const missing = jarFiles.filter((j) => !fs.existsSync(j.from));
  if (missing.length) throw new Error(`以下 jar 尚未构建（请在对应目录运行 gradlew build --no-daemon，附属模组须在核心之后构建）：\n- ${missing.map((j) => path.relative(ROOT, j.from)).join('\n- ')}`);

  if (opts.build) run('npm', ['run', 'build'], path.join(ROOT, 'client-runtime'));
  const dist = path.join(ROOT, 'client-runtime', 'dist', 'main.js');
  if (!fs.existsSync(dist)) throw new Error('client-runtime 尚未构建（npm run build）');

  const name = `mcbot-${version}-win-x64`;
  const stage = path.join(opts.out, name);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  copy(opts.node, path.join(stage, 'node', 'node.exe'));
  copy(nodeLicense, path.join(stage, 'node', 'LICENSE'));

  const rt = path.join(stage, 'client-runtime');
  for (const f of ['package.json', 'package-lock.json', 'README.md', 'tool-registry.json', 'player-stop.json']) copy(path.join(ROOT, 'client-runtime', f), path.join(rt, f));
  copy(path.join(ROOT, 'client-runtime', 'dist'), path.join(rt, 'dist'));
  // 复制本机装好的依赖（npm ci 装的、和 lock 一致），再删掉开发依赖；prune 只删不下载
  const modules = path.join(ROOT, 'client-runtime', 'node_modules');
  if (!fs.existsSync(modules)) throw new Error('client-runtime 尚未安装依赖（npm ci）');
  copy(modules, path.join(rt, 'node_modules'));
  run('npm', ['prune', '--omit=dev', '--offline', '--no-audit', '--no-fund', '--ignore-scripts'], rt);

  const scripts = scriptClosure(path.join(ROOT, 'scripts'), ENTRIES);
  for (const rel of [...scripts, ...ASSETS]) copy(path.join(ROOT, 'scripts', rel), path.join(stage, 'scripts', rel));
  for (const f of TOP_FILES) copy(path.join(ROOT, f), path.join(stage, f));
  for (const j of jarFiles) copy(j.from, path.join(stage, 'mods', j.jar));
  fs.writeFileSync(path.join(stage, '启动 mcbot.cmd'), LAUNCHER);
  fs.writeFileSync(path.join(stage, '使用说明.txt'), '﻿' + readme(compat, version, { core: compat.core.jar, addons: jarFiles.slice(1).map((j) => j.jar) }));

  let zip = '';
  if (opts.zip) {
    zip = path.join(opts.out, `${name}.zip`);
    fs.rmSync(zip, { force: true });
    // Windows 10 起自带 tar（bsdtar），-a 按扩展名打 zip。文件名要明说 UTF-8，不然按系统代码页写（日文系统写不了简体字）；
    // 用 System32 里的那个，Git Bash 的 GNU tar 不会打 zip，还会把 G: 当成远程主机
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const r = spawnSync(tar, ['-a', '-c', '-f', zip, '--options', 'hdrcharset=UTF-8', '-C', opts.out, name], { stdio: 'inherit', windowsHide: true });
    if (r.status !== 0) throw new Error('生成 zip 失败');
  }
  const size = (p) => { let n = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, e.name); if (e.isDirectory()) walk(q); else n += fs.statSync(q).size; } }; walk(p); return n; };
  return { name, stage, zip, version, node: nodeVersion, scripts, jars: jarFiles.map((j) => j.jar), stageBytes: size(stage), zipBytes: zip ? fs.statSync(zip).size : 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = buildPackage(parsePackageArgs(process.argv.slice(2)));
    const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    console.log(`\n绿色版 ${r.name}：Node ${r.node}，脚本 ${r.scripts.length} 个，jar ${r.jars.length} 个`);
    console.log(`目录 ${r.stage}（${mb(r.stageBytes)}）`);
    if (r.zip) console.log(`压缩包 ${r.zip}（${mb(r.zipBytes)}）`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
