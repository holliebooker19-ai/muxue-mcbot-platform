import fs from 'node:fs';
import path from 'node:path';
import { BodyError, type Position } from './body.js';

/**
 * Blueprints and shapes for `build`. A blueprint is a JSON file (the private repo's design format, version 1):
 * blocks are [x, y, z, "block[state]"] relative to the minimum corner, names with or without "minecraft:".
 * They live in one directory (default <runtime>/blueprints, or --blueprint-dir). Everything here only turns designs
 * into absolute cells; the server parses the states, turns them with the game's own rotation and places them.
 */
export interface Blueprint {
  version: 1; name: string; description: string; size: Position;
  blocks: [number, number, number, string][]; createdAt: string; source: string;
}
export interface Cell { x: number; y: number; z: number; state: string; rotation?: Rotation }
export type Rotation = 0 | 90 | 180 | 270;
export type ShapeKind = 'fill' | 'hollow' | 'walls' | 'line' | 'roof';
export interface Shape { shape: ShapeKind; from: Position; to: Position; block: string; ridge?: 'x' | 'z'; ridgeBlock?: string; gableBlock?: string }

export const MAX_CELLS = 4096;
const NAME = /^[\p{L}\p{N}_-]{1,40}$/u;
const STATE = /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+(?:\[[a-z0-9_]+=[a-z0-9_]+(?:,[a-z0-9_]+=[a-z0-9_]+)*\])?$/;
export const validState = (text: string) => STATE.test(text);

const floor = (p: Position) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
function box(from: Position, to: Position) {
  const a = floor(from), b = floor(to);
  return { x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x), y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y), z1: Math.min(a.z, b.z), z2: Math.max(a.z, b.z) };
}

/** Turn a point of a blueprint of this size clockwise seen from above (north becomes east, as the game's Rotation). */
export function rotatePos(p: Position, rotation: Rotation, size: Position): Position {
  switch (rotation) {
    case 90: return { x: size.z - 1 - p.z, y: p.y, z: p.x };
    case 180: return { x: size.x - 1 - p.x, y: p.y, z: size.z - 1 - p.z };
    case 270: return { x: p.z, y: p.y, z: size.x - 1 - p.x };
    default: return { ...p };
  }
}
export const rotatedSize = (size: Position, rotation: Rotation): Position => rotation === 90 || rotation === 270 ? { x: size.z, y: size.y, z: size.x } : { ...size };

/** Stairs name → the full block of the same material (oak_stairs → oak_planks, stone_brick_stairs → stone_bricks). */
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped'];
export function roofMaterials(stairs: string): { slab: string; full: string } {
  const namespace = stairs.includes(':') ? stairs.slice(0, stairs.indexOf(':') + 1) : '';
  const base = stairs.slice(namespace.length).replace(/_stairs$/, '');
  const full = WOODS.includes(base) ? `${base}_planks` : /(brick|tile)$/.test(base) ? `${base}s` : base === 'quartz' || base === 'purpur' ? `${base}_block` : base;
  return { slab: `${namespace}${base}_slab`, full: `${namespace}${full}` };
}

/**
 * Gable roof of stairs: from/to is the bottom layer (one wider than the walls makes eaves); each layer steps in and up,
 * stairs face the ridge, an odd middle row gets ridgeBlock (default the same material's bottom slab), the triangle ends
 * gableBlock (default the full block; "none" leaves them open; they also hold the stairs up).
 */
export function roofCells(s: Shape): Cell[] {
  const { x1, x2, y1, z1, z2 } = box(s.from, s.to);
  const stairs = s.block.replace(/\[.*$/, '');
  if (!/_stairs$/.test(stairs)) throw new BodyError('INVALID_ARGUMENT', `roof 的 block 要写楼梯，比如 oak_stairs（现在是 ${s.block}）`);
  const material = roofMaterials(stairs);
  const ridgeBlock = s.ridgeBlock ?? `${material.slab}[type=bottom]`;
  const gable = s.gableBlock === 'none' ? null : s.gableBlock ?? material.full;
  const ridge = s.ridge ?? (x2 - x1 >= z2 - z1 ? 'x' : 'z');
  const at = (a: number, y: number, b: number, state: string): Cell => ridge === 'x' ? { x: a, y, z: b, state } : { x: b, y, z: a, state };
  const [a1, a2, b1, b2] = ridge === 'x' ? [x1, x2, z1, z2] : [z1, z2, x1, x2];
  const [low, high] = ridge === 'x' ? ['south', 'north'] : ['east', 'west'];
  const out: Cell[] = [];
  for (let k = 0; ; k++) {
    const bl = b1 + k, br = b2 - k, y = y1 + k;
    if (bl > br) break;
    if (bl === br) { for (let a = a1; a <= a2; a++) out.push(at(a, y, bl, ridgeBlock)); break; }
    for (let a = a1; a <= a2; a++) {
      out.push(at(a, y, bl, `${stairs}[facing=${low},half=bottom]`));
      out.push(at(a, y, br, `${stairs}[facing=${high},half=bottom]`));
    }
    if (gable) for (let b = bl + 1; b < br; b++) { out.push(at(a1, y, b, gable)); if (a2 !== a1) out.push(at(a2, y, b, gable)); }
  }
  return out;
}

export function shapeCells(s: Shape): Cell[] {
  const { x1, x2, y1, y2, z1, z2 } = box(s.from, s.to);
  if (s.shape === 'roof') return roofCells(s);
  if (s.shape === 'line') {
    const a = floor(s.from), b = floor(s.to), n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z));
    return Array.from({ length: n + 1 }, (_, i) => { const t = n ? i / n : 0; return { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t), z: Math.round(a.z + (b.z - a.z) * t), state: s.block }; });
  }
  const volume = (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1);
  if (volume > MAX_CELLS) throw new BodyError('INVALID_ARGUMENT', `区域太大：${volume} 格，一次最多 ${MAX_CELLS} 格`);
  const out: Cell[] = [];
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
    const side = x === x1 || x === x2 || z === z1 || z === z2;
    if (s.shape === 'fill' || (s.shape === 'walls' && side) || (s.shape === 'hollow' && (side || y === y1 || y === y2))) out.push({ x, y, z, state: s.block });
  }
  return out;
}

export class BlueprintShelf {
  constructor(readonly dir: string) {}
  private file(name: string): string {
    if (!NAME.test(name)) throw new BodyError('INVALID_ARGUMENT', `蓝图名只能用字母、数字、中文、下划线和横线，最多 40 个字：${name}`);
    return path.join(this.dir, `${name}.json`);
  }
  load(name: string): Blueprint {
    let raw: string;
    try { raw = fs.readFileSync(this.file(name), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BodyError('NOT_FOUND', `没有叫「${name}」的蓝图（blueprints list 看有哪些）`); throw error; }
    const data = JSON.parse(raw.replace(/^﻿/, '')) as Blueprint;
    if (data?.version !== 1 || !Array.isArray(data.blocks) || !data.size) throw new BodyError('INVALID_ARGUMENT', `蓝图文件格式不对：${name}`);
    return data;
  }
  list(): Blueprint[] {
    let names: string[];
    try { names = fs.readdirSync(this.dir).filter(f => f.endsWith('.json')); } catch { return []; }
    const out: Blueprint[] = [];
    for (const f of names) { try { out.push(this.load(f.slice(0, -5))); } catch {} }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  save(name: string, description: string, cells: Cell[], overwrite: boolean): Blueprint {
    if (!cells.length) throw new BodyError('INVALID_ARGUMENT', '蓝图里没有方块');
    const file = this.file(name);
    if (!overwrite && fs.existsSync(file)) throw new BodyError('ALREADY_EXISTS', `已经有叫「${name}」的蓝图了；要覆盖就加 overwrite: true`);
    const min = { x: Math.min(...cells.map(c => c.x)), y: Math.min(...cells.map(c => c.y)), z: Math.min(...cells.map(c => c.z)) };
    const map = new Map<string, [number, number, number, string]>();
    for (const c of cells) { const p = [c.x - min.x, c.y - min.y, c.z - min.z] as const; map.set(p.join(','), [p[0], p[1], p[2], c.state]); }
    const blocks = [...map.values()];
    const size = { x: Math.max(...blocks.map(b => b[0])) + 1, y: Math.max(...blocks.map(b => b[1])) + 1, z: Math.max(...blocks.map(b => b[2])) + 1 };
    const blueprint: Blueprint = { version: 1, name, description, size, blocks, createdAt: new Date().toISOString(), source: 'build tool' };
    fs.mkdirSync(this.dir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(blueprint) + '\n'); fs.renameSync(temporary, file);
    return blueprint;
  }
}

/** A blueprint put down with its minimum corner (after turning) at origin; each cell carries the turn for its state. */
export function placeBlueprint(blueprint: Blueprint, origin: Position, rotation: Rotation): Cell[] {
  const o = floor(origin);
  return blueprint.blocks.map(([x, y, z, state]) => {
    const p = rotatePos({ x, y, z }, rotation, blueprint.size);
    return { x: p.x + o.x, y: p.y + o.y, z: p.z + o.z, state, ...(rotation ? { rotation } : {}) };
  });
}

/** Blueprint, then shapes, then single blocks; a later cell at the same spot wins. "air" clears. */
export function resolveCells(input: { blueprint?: { blueprint: Blueprint; origin: Position; rotation: Rotation }; shapes?: Shape[]; blocks?: Cell[] }): Cell[] {
  const cells = new Map<string, Cell>();
  const put = (c: Cell) => {
    if (!validState(c.state)) throw new BodyError('INVALID_ARGUMENT', `方块写法不对：${c.state}（比如 oak_stairs[facing=east,half=bottom]）`);
    const p = floor(c); cells.set(`${p.x},${p.y},${p.z}`, { ...c, ...p });
  };
  if (input.blueprint) for (const c of placeBlueprint(input.blueprint.blueprint, input.blueprint.origin, input.blueprint.rotation)) put(c);
  for (const s of input.shapes ?? []) for (const c of shapeCells(s)) put(c);
  for (const c of input.blocks ?? []) put(c);
  if (cells.size > MAX_CELLS) throw new BodyError('INVALID_ARGUMENT', `目标太多：${cells.size} 格，一次最多 ${MAX_CELLS} 格，请分批`);
  return [...cells.values()];
}
