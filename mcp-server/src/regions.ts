// 登记的保护区域（家、建筑、农场、禁动区）。数据存为可读 JSON，多个 Bot 共用同一个文件：
// 每次修改前重新读取文件，写入时先写临时文件再改名，避免写一半的文件被别人读到
import { JsonFile } from './json-file.js';

export const REGION_KINDS = ['home', 'build', 'farm', 'no-touch'] as const;
export type RegionKind = typeof REGION_KINDS[number];

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface Region {
  name: string;
  kind: RegionKind;
  worldId: string;
  dimension: string;
  min: Point3;
  max: Point3;
  note: string;
  source: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
}

interface RegionFile {
  version: 1;
  regions: Region[];
}

export const MAX_REGION_SPAN = 512;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u;

export function normalizeDimension(dim: string): string {
  return dim.replace(/^minecraft:/, '');
}

export function boxOf(a: Point3, b: Point3): { min: Point3; max: Point3 } {
  const min = { x: Math.floor(Math.min(a.x, b.x)), y: Math.floor(Math.min(a.y, b.y)), z: Math.floor(Math.min(a.z, b.z)) };
  const max = { x: Math.floor(Math.max(a.x, b.x)), y: Math.floor(Math.max(a.y, b.y)), z: Math.floor(Math.max(a.z, b.z)) };
  return { min, max };
}

export function regionContains(r: Pick<Region, 'min' | 'max'>, p: Point3): boolean {
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
  return x >= r.min.x && x <= r.max.x && y >= r.min.y && y <= r.max.y && z >= r.min.z && z <= r.max.z;
}

export class RegionStore {
  private readonly data: JsonFile<RegionFile>;

  constructor(readonly file: string | null, readonly worldId: string, readonly owner: string) {
    this.data = new JsonFile<RegionFile>(
      file,
      () => ({ version: 1, regions: [] }),
      (d): d is RegionFile => Boolean(d && (d as RegionFile).version === 1 && Array.isArray((d as RegionFile).regions))
    );
  }

  get configured(): boolean {
    return Boolean(this.file && this.worldId);
  }

  private load(): RegionFile {
    return this.data.read();
  }

  // 读取失败时视为"有保护但不知道在哪"：返回 null，调用方应拒绝改动方块
  activeRegions(dimension: string): Region[] | null {
    if (!this.configured) return [];
    try {
      const dim = normalizeDimension(dimension);
      return this.load().regions.filter((r) => r.active && r.worldId === this.worldId && r.dimension === dim);
    } catch {
      return null;
    }
  }

  regionsAt(dimension: string, p: Point3): Region[] | null {
    const list = this.activeRegions(dimension);
    return list && list.filter((r) => regionContains(r, p));
  }

  list(includeInactive = false): Region[] {
    if (!this.configured) return [];
    return this.load().regions.filter((r) => r.worldId === this.worldId && (includeInactive || r.active));
  }

  upsert(input: { name: string; kind: RegionKind; dimension: string; from: Point3; to: Point3; note?: string; source: string }): Region {
    if (!this.configured) throw new Error('没有配置 --world-id，不能登记区域（服务器地址不能用来区分存档）');
    if (!NAME_RE.test(input.name)) throw new Error('区域名只能用文字、数字、下划线和连字符，最长 40 个字');
    if (!input.source.trim()) throw new Error('请写明来源（例如：玩家在聊天里要求）');
    for (const v of [input.from, input.to]) {
      for (const n of [v.x, v.y, v.z]) {
        if (!Number.isFinite(n)) throw new Error('坐标必须是有限数字');
      }
    }
    const { min, max } = boxOf(input.from, input.to);
    const spans = [max.x - min.x, max.y - min.y, max.z - min.z];
    if (spans.some((s) => s + 1 > MAX_REGION_SPAN)) throw new Error(`区域每边最多 ${MAX_REGION_SPAN} 格`);
    if (min.y < -64 || max.y > 319) throw new Error('y 超出世界高度范围（-64~319）');

    return this.data.update((data) => {
      const now = new Date().toISOString();
      const dim = normalizeDimension(input.dimension);
      const existing = data.regions.find((r) => r.worldId === this.worldId && r.name === input.name);
      const region: Region = {
        name: input.name,
        kind: input.kind,
        worldId: this.worldId,
        dimension: dim,
        min,
        max,
        note: input.note ?? '',
        source: input.source,
        createdBy: existing?.createdBy ?? this.owner,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        active: true
      };
      if (existing) Object.assign(existing, region);
      else data.regions.push(region);
      return region;
    });
  }

  deactivate(name: string, source: string): Region {
    if (!this.configured) throw new Error('没有配置 --world-id');
    if (!source.trim()) throw new Error('请写明是谁要求取消保护');
    return this.data.update((data) => {
      const region = data.regions.find((r) => r.worldId === this.worldId && r.name === name && r.active);
      if (!region) throw new Error(`没有生效中的区域 ${name}`);
      region.active = false;
      region.updatedAt = new Date().toISOString();
      region.source = `${region.source}；取消：${source}`;
      return region;
    });
  }
}
