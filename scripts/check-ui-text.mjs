#!/usr/bin/env node
// 界面文案检查（规范见 docs/ui_text.md）：从 WebUI、绿色版使用说明和 compat.json 的展示字段里取出中文文案，
// 查规范禁止的口语词。只看字符串和页面文字，不看代码注释；给 AI 的说明、Bot 的人设示例不在检查范围。
// 用法：node scripts/check-ui-text.mjs [--list]；--list 列出取到的全部中文文案（人工通读用）。有违规时列出来并以 1 退出。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 检查的文件：WebUI 页面和接口、托管启动脚本（等待提示显示在页面上）、打包脚本（使用说明）。 */
export const UI_FILES = ['scripts/webui-page.html', 'scripts/webui.mjs', 'scripts/webui-profiles.mjs', 'scripts/webui-games.mjs', 'scripts/webui-plugins.mjs', 'scripts/webui-memory.mjs',
  'scripts/agent-models.mjs', 'scripts/start-server-play.mjs', 'scripts/package.mjs'];
/** compat.json 里会展示给用户的字段。 */
const COMPAT_FIELDS = ['name', 'what', 'evidence', 'where', 'login'];

/**
 * 禁用词：[正则, 建议]。只收口语里才有、书面语里不会误伤的写法；
 * 规范里的其他要求（句式、用词统一）靠 --list 人工通读。
 */
export const BANNED = [
  [/装好/, '已安装／安装完成'], [/没装|没安装/, '未安装'], [/要修/, '需修复'], [/要更新/, '需更新'],
  [/读不了|读不到/, '无法读取'], [/连不上|连不进/, '无法连接'], [/找不到/, '未找到'], [/看不出/, '无法识别'],
  [/开着/, '运行中／已开启'], [/没开(?!始)/, '未开启／未启动'], [/没起来/, '未启动'], [/对不上/, '不一致／不匹配'],
  [/不对/, '错误／不正确'], [/一下/, '删去或改为具体动作'], [/东西/, '具体名词'], [/弄|搞/, '具体动词'],
  [/[啦呀吧哦呢嘛咯]([，。！？；、）」\s]|$)/, '删去语气词'], [/[嗯哈]/, '删去语气词'], [/啥|咋|干嘛/, '什么／如何／为何'],
  [/别(?=[^一-鿿]|[人的处])/, '其他'], [/别[去再动改点删让]/, '请勿'], [/不用(?!于)/, '无需'],
  [/好了/, '已完成'], [/搞定|没问题/, '已完成'], [/咱们|你/, '省略人称或用“请”'], [/一个劲|老是|总是/, '删去'],
  [/挺|蛮|特别/, '删去程度副词'], [/放进|丢进|扔进/, '复制到／安装到'], [/点一下|点开/, '点击'], [/先.{0,6}再说/, '改为明确条件'],
];

/** 从 JS 源码里取出字符串和模板字面量（跳过注释和正则），带行号。 */
export function jsStrings(src, lineBase = 1) {
  const out = [];
  let i = 0, line = lineBase, prev = '';
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; line += (src.slice(i, end).match(/\n/g) || []).length; i = end; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const start = line; let j = i + 1, text = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') { text += src[j + 1] === 'n' ? '\n' : src[j + 1]; j += 2; continue; }
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
          // 模板里的表达式：按花括号配对跳过，表达式里的字符串另算
          let depth = 1, k = j + 2;
          while (k < n && depth) { if (src[k] === '{') depth++; else if (src[k] === '}') depth--; k++; }
          out.push(...jsStrings(src.slice(j + 2, k - 1), line));
          text += '…'; line += (src.slice(j, k).match(/\n/g) || []).length; j = k; continue;
        }
        if (src[j] === '\n') line++;
        text += src[j]; j++;
      }
      out.push({ line: start, text }); i = j + 1; prev = 'str'; continue;
    }
    if (c === '/' && (/[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || prev === '' || /^(return|typeof|case|in|of)$/.test(prev))) {
      // 正则字面量
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break; j++; }
      i = j + 1; prev = 'regex'; continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_$0-9]/.test(c)) { let j = i; while (j < n && /[A-Za-z_$0-9]/.test(src[j])) j++; prev = src.slice(i, j); i = j; continue; }
    prev = c; i++;
  }
  return out;
}

/** 页面：标签之间的文字和属性值（placeholder、title 等），<script> 里按 JS 取字符串，跳过 <style> 和 HTML 注释。 */
export function htmlStrings(src) {
  const out = [];
  const lineAt = (idx) => src.slice(0, idx).split('\n').length;
  const scriptRe = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = scriptRe.exec(src))) out.push(...jsStrings(m[1], lineAt(m.index + 8)));
  const markup = src.replace(/<script>[\s\S]*?<\/script>|<style>[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, ' '));
  for (const t of markup.matchAll(/>([^<>]+)</g)) if (t[1].trim()) out.push({ line: lineAt(t.index), text: t[1].trim() });
  for (const a of markup.matchAll(/\s[a-z-]+="([^"]*)"/g)) if (a[1].trim()) out.push({ line: lineAt(a.index), text: a[1] });
  return out;
}

function compatStrings(file) {
  const src = fs.readFileSync(file, 'utf8'), data = JSON.parse(src), out = [];
  const lineOf = (text) => src.split('\n').findIndex((l) => l.includes(JSON.stringify(text).slice(1, -1))) + 1;
  const walk = (v, key) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    else if (typeof v === 'string' && COMPAT_FIELDS.includes(key)) out.push({ line: lineOf(v), text: v });
  };
  walk(data, '');
  return out;
}

const CJK = /[一-鿿]/;

export function collect(base = root) {
  const items = [];
  for (const rel of UI_FILES) {
    const src = fs.readFileSync(path.join(base, rel), 'utf8');
    for (const s of rel.endsWith('.html') ? htmlStrings(src) : jsStrings(src)) if (CJK.test(s.text)) items.push({ file: rel, ...s });
  }
  for (const s of compatStrings(path.join(base, 'compat.json'))) if (CJK.test(s.text)) items.push({ file: 'compat.json', ...s });
  return items;
}

export function checkUiText(items = collect()) {
  const problems = [];
  for (const it of items) for (const [re, hint] of BANNED) {
    const m = re.exec(it.text);
    if (m) problems.push({ ...it, word: m[0].trim(), hint });
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const items = collect();
  if (process.argv.includes('--list')) for (const it of items) console.log(`${it.file}:${it.line}\t${it.text.replace(/\n/g, '⏎')}`);
  const problems = checkUiText(items);
  for (const p of problems) console.log(`${p.file}:${p.line}  「${p.word}」→ ${p.hint}\n    ${p.text.replace(/\n/g, '⏎').slice(0, 160)}`);
  console.log(problems.length ? `\n界面文案有 ${problems.length} 处口语用词（共检查 ${items.length} 条）` : `界面文案检查通过（${items.length} 条）`);
  process.exit(problems.length ? 1 : 0);
}
