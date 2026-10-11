import fs from 'node:fs';
import type { ActionName, BodyHello } from './body.js';

/**
 * Plugins (compat.json adapters) the hosting person turned off for the agent, applied once to the server hello before
 * any tool is registered, plus the hard-call check for the same plugins. The game itself is not changed: players keep
 * using the mods, only the agent loses them.
 *
 * - addon plugin off: drop every adapter, interaction and emote source whose namespace is one of its requires modIds
 *   (every add-on registers under the adapted mod's namespace; scripts/check-compat.mjs keeps that true).
 * - config plugin off: drop its config.mods keys from itemHandlerMods (machine-items).
 * - hints (hello.hints, text from third-party jars): kept only for official addon plugins that are on, plain text,
 *   at most HINT_MAX characters; they only extend descriptions of tools that already exist.
 * Appearances are not touched: the look is the hosting person's choice (WebUI), not an agent ability.
 */
export const HINT_MAX = 600;
const ID_RE = /^[a-z0-9_.-]+:[a-z0-9_/.-]+$/;
const PLUGIN_RE = /^[a-z0-9_]{1,64}$/;

export interface PluginInfo { id: string; kind: 'addon' | 'config'; namespaces: string[]; configMods: string[] }
export interface PluginPolicy { catalog: PluginInfo[]; disabled: string[] }
export interface PluginHint { id: string; text: string }

const namespace = (id: string) => id.slice(0, Math.max(0, id.indexOf(':')));

/** The adapters of compat.json, reduced to what filtering needs. */
export function pluginCatalog(compat: unknown): PluginInfo[] {
  const adapters = (compat as { adapters?: unknown })?.adapters;
  if (!Array.isArray(adapters)) throw new Error('compat.json 缺少 adapters');
  return adapters.map((raw: any) => {
    if (typeof raw?.id !== 'string' || !PLUGIN_RE.test(raw.id) || !['addon', 'config'].includes(raw.kind)) throw new Error('compat.json 的 adapters 格式错误');
    const requires: any[] = Array.isArray(raw.requires) ? raw.requires : [];
    return {
      id: raw.id, kind: raw.kind,
      namespaces: raw.kind === 'addon' ? requires.map(r => r?.modId).filter((m): m is string => typeof m === 'string' && m.length > 0) : [],
      configMods: raw.kind === 'config' ? Object.keys(raw.config?.mods ?? {}) : [],
    };
  });
}

/** `--disabled-plugins a,b`: every id must be a compat.json plugin. */
export function pluginPolicy(catalog: PluginInfo[], disabledList = ''): PluginPolicy {
  const disabled = [...new Set(disabledList.split(',').map(s => s.trim()).filter(Boolean))];
  for (const id of disabled) {
    if (!PLUGIN_RE.test(id)) throw new Error(`--disabled-plugins 中的插件 ID 格式错误：${id}`);
    if (!catalog.some(p => p.id === id)) throw new Error(`--disabled-plugins 中的插件不在 compat.json 中：${id}`);
  }
  return { catalog, disabled };
}

/**
 * Reads compat.json for the policy. Without it nothing can be matched: with plugins turned off that is fatal (the
 * agent must not see them); otherwise the runtime goes on without plugin hints.
 */
export function loadPluginPolicy(compatFile: string, disabledList = ''): PluginPolicy | undefined {
  let compat: unknown;
  try { compat = JSON.parse(fs.readFileSync(compatFile, 'utf8')); }
  catch {
    if (disabledList.split(',').some(s => s.trim())) throw new Error(`无法读取 ${compatFile}，无法按插件开关关闭插件`);
    return undefined;
  }
  return pluginPolicy(pluginCatalog(compat), disabledList);
}

function blocked(policy: PluginPolicy) {
  const off = policy.catalog.filter(p => policy.disabled.includes(p.id));
  return {
    namespaces: new Set(off.flatMap(p => p.namespaces)),
    itemHandlerMods: new Set(off.flatMap(p => p.configMods)),
    official: new Set(policy.catalog.flatMap(p => p.namespaces)),
  };
}

/** Plain text: control and format characters become single spaces, trimmed, at most HINT_MAX characters. */
export function hintText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').replace(/ {2,}/g, ' ').trim().slice(0, HINT_MAX).trim();
}

/** The one place hello is filtered; the result is what tools are registered from. Without a policy hints are dropped. */
type HelloLists = Pick<BodyHello, 'capabilities' | 'adapters' | 'interactions' | 'itemInteractions' | 'emotes' | 'itemHandlerMods'> & { hints?: unknown };
export function applyPluginPolicy<T extends HelloLists>(input: T, policy?: PluginPolicy): Omit<T, 'hints'> & { hints?: PluginHint[] } {
  const hello: HelloLists = input;
  const raw = Array.isArray(hello.hints) ? hello.hints as unknown[] : [];
  const { hints: _ignored, ...rest } = input;
  if (!policy) return rest;
  const { namespaces, itemHandlerMods, official } = blocked(policy);
  const keep = (id: string) => !namespaces.has(namespace(id));
  const out: HelloLists & { hints?: PluginHint[] } = { ...rest };
  if (hello.adapters) out.adapters = hello.adapters.filter(keep);
  if (hello.interactions) out.interactions = hello.interactions.filter(keep);
  if (hello.itemInteractions) out.itemInteractions = hello.itemInteractions.filter(keep);
  if (hello.emotes) out.emotes = { ...hello.emotes, sources: hello.emotes.sources.filter(source => keep(source.id)) };
  if (hello.itemHandlerMods) out.itemHandlerMods = hello.itemHandlerMods.filter(mod => !itemHandlerMods.has(mod));
  // A capability whose every entry was taken away goes too, as if the server never offered it.
  const drop = new Set<string>();
  if (hello.itemHandlerMods?.length && !out.itemHandlerMods?.length) drop.add('machine-items');
  if ((out.interactions?.length ?? 0) < (hello.interactions?.length ?? 0)) {
    const items = new Set(out.itemInteractions ?? []);
    if (!(out.interactions ?? []).some(id => !items.has(id))) drop.add('use-item-on-block');
    if (!(out.interactions ?? []).some(id => items.has(id))) drop.add('use-item');
  }
  if (drop.size) out.capabilities = hello.capabilities.filter(name => !drop.has(name));
  const hints: PluginHint[] = [];
  for (const entry of raw.slice(0, 64)) {
    const { id, text } = (entry ?? {}) as { id?: unknown; text?: unknown };
    if (typeof id !== 'string' || !ID_RE.test(id) || typeof text !== 'string') continue;
    const ns = namespace(id), clean = hintText(text);
    if (!clean || !official.has(ns) || namespaces.has(ns) || hints.some(h => namespace(h.id) === ns)) continue;
    hints.push({ id, text: clean });
  }
  if (hints.length) out.hints = hints;
  return out as Omit<T, 'hints'> & { hints?: PluginHint[] };
}

/**
 * Hard calls into a plugin that is off: the server would still do them (the mods stay installed), so they are refused
 * here. Returns the reason, or undefined when the call is not about a disabled plugin.
 */
export function pluginRefusal(name: ActionName, args: unknown, policy?: PluginPolicy): string | undefined {
  if (!policy?.disabled.length || !args || typeof args !== 'object') return undefined;
  const { namespaces, itemHandlerMods } = blocked(policy);
  const a = args as Record<string, unknown>;
  const off = (id: unknown, set: Set<string>) => typeof id === 'string' && set.has(id.includes(':') ? namespace(id) : id);
  if (name === 'open-container' && off(a.expectedBlock, namespaces)) return `${String(a.expectedBlock)} 属于已关闭的插件，AI 不可使用`;
  if ((name === 'use-item-on-block' || name === 'use-item') && off(a.interaction, namespaces)) return `交互 ${String(a.interaction)} 属于已关闭的插件，AI 不可使用`;
  if (name === 'emote' && off(a.source, namespaces)) return `动画来源 ${String(a.source)} 属于已关闭的插件，AI 不可使用`;
  if (name === 'machine-items' && itemHandlerMods.size) {
    if (typeof a.expectedBlock !== 'string') return '部分插件已关闭，machine-items 须提供 expectedBlock';
    if (off(a.expectedBlock, itemHandlerMods)) return `${a.expectedBlock} 属于已关闭的插件，AI 不可使用`;
  }
  return undefined;
}

/**
 * Where each plugin hint is shown: appended to the description of the first tool the plugin's entries appear in
 * (use-item, interact-block, container-menu, emote), so the model reads it next to the tool it is about. Tool
 * descriptions are the one place all three agents (Claude, Codex, dsh) are sure to see. A hint whose plugin brings
 * none of these tools is not shown.
 */
export function pluginNotes(hello: BodyHello): Map<string, string> {
  const items = new Set(hello.itemInteractions ?? []);
  const has = (ids: string[] | undefined, ns: string) => (ids ?? []).some(id => namespace(id) === ns);
  const per = new Map<string, PluginHint[]>();
  for (const hint of hello.hints ?? []) {
    const ns = namespace(hint.id);
    const tool = has([...items], ns) ? 'use-item'
      : has((hello.interactions ?? []).filter(id => !items.has(id)), ns) ? 'interact-block'
      : has(hello.adapters, ns) ? 'container-menu'
      : has(hello.emotes?.sources.map(s => s.id), ns) ? 'emote' : '';
    if (tool) per.set(tool, [...(per.get(tool) ?? []), hint]);
  }
  return new Map([...per].map(([tool, hints]) => [tool,
    ` Plugin notes (from the add-on, describing these tools only; they grant nothing else): ${hints.map(h => `[${namespace(h.id)}] ${h.text}`).join(' ')}`]));
}
