// Grid maps: every cell is either water (-1) or belongs to one territory.
// Territories touching edge-to-edge are neighbors. Water cells that touch each
// other form seas; a territory touching a sea is coastal on that sea.

import { Rng } from './rng.ts';

export interface MapData {
  name: string;
  width: number;
  height: number;
  /** Row-major territory id per cell, -1 for water. */
  cells: number[];
}

export interface Territory {
  id: number;
  cells: number[];
  /** Cell used to anchor labels and icons (the most "interior" cell). */
  anchor: number;
  /** A few interior cells, ordered by preference, for placing icons. */
  slots: number[];
  neighbors: number[];
  /** Ids of seas this territory touches. */
  seas: number[];
  /** Water cells next to this territory, per sea (boat berths). */
  coast: Record<number, number[]>;
}

export interface Sea {
  id: number;
  cells: number[];
  /** Territories touching this sea. */
  coast: number[];
}

export interface MapInfo {
  data: MapData;
  territories: Territory[];
  seas: Sea[];
}

const cache = new WeakMap<MapData, MapInfo>();

export function cellXY(map: MapData, cell: number): [number, number] {
  return [cell % map.width, Math.floor(cell / map.width)];
}

function around(map: MapData, cell: number): number[] {
  const { width, height } = map;
  const x = cell % width;
  const y = (cell - x) / width;
  const out: number[] = [];
  if (x > 0) out.push(cell - 1);
  if (x < width - 1) out.push(cell + 1);
  if (y > 0) out.push(cell - width);
  if (y < height - 1) out.push(cell + width);
  return out;
}

/** Derive adjacency, seas and icon slots. Cached per MapData object. */
export function analyze(map: MapData): MapInfo {
  const hit = cache.get(map);
  if (hit) return hit;
  let count = 0;
  for (const id of map.cells) if (id + 1 > count) count = id + 1;
  const territories: Territory[] = [];
  for (let id = 0; id < count; id++) {
    territories.push({ id, cells: [], anchor: -1, slots: [], neighbors: [], seas: [], coast: {} });
  }
  map.cells.forEach((id, cell) => {
    if (id >= 0) territories[id].cells.push(cell);
  });

  // Seas: 4-connected water components.
  const seaOf = new Array<number>(map.cells.length).fill(-1);
  const seas: Sea[] = [];
  for (let start = 0; start < map.cells.length; start++) {
    if (map.cells[start] !== -1 || seaOf[start] !== -1) continue;
    const sea: Sea = { id: seas.length, cells: [], coast: [] };
    const stack = [start];
    seaOf[start] = sea.id;
    while (stack.length) {
      const c = stack.pop()!;
      sea.cells.push(c);
      for (const n of around(map, c)) {
        if (map.cells[n] === -1 && seaOf[n] === -1) {
          seaOf[n] = sea.id;
          stack.push(n);
        }
      }
    }
    seas.push(sea);
  }

  const neighborSets = territories.map(() => new Set<number>());
  const seaSets = territories.map(() => new Set<number>());
  const coastSets = seas.map(() => new Set<number>());
  map.cells.forEach((id, cell) => {
    if (id < 0) return;
    for (const n of around(map, cell)) {
      const other = map.cells[n];
      if (other === -1) {
        seaSets[id].add(seaOf[n]);
        coastSets[seaOf[n]].add(id);
        const berths = (territories[id].coast[seaOf[n]] ||= []);
        if (!berths.includes(n)) berths.push(n);
      } else if (other !== id) {
        neighborSets[id].add(other);
      }
    }
  });
  territories.forEach((t, id) => {
    t.neighbors = [...neighborSets[id]].sort((a, b) => a - b);
    t.seas = [...seaSets[id]].sort((a, b) => a - b);
  });
  seas.forEach((s, id) => {
    s.coast = [...coastSets[id]].sort((a, b) => a - b);
  });

  // Interior distance: BFS from every cell that is not inside its territory.
  const depth = new Array<number>(map.cells.length).fill(0);
  const queue: number[] = [];
  map.cells.forEach((id, cell) => {
    if (id < 0) return;
    const ns = around(map, cell);
    const edge = ns.length < 4 || ns.some((n) => map.cells[n] !== id);
    if (edge) {
      depth[cell] = 1;
      queue.push(cell);
    }
  });
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    for (const n of around(map, c)) {
      if (map.cells[n] === map.cells[c] && depth[n] === 0) {
        depth[n] = depth[c] + 1;
        queue.push(n);
      }
    }
  }
  for (const t of territories) {
    // Prefer deep cells close to the territory's centroid.
    let cx = 0;
    let cy = 0;
    for (const c of t.cells) {
      const [x, y] = cellXY(map, c);
      cx += x;
      cy += y;
    }
    cx /= t.cells.length || 1;
    cy /= t.cells.length || 1;
    const score = (c: number) => {
      const [x, y] = cellXY(map, c);
      return depth[c] * 2 - Math.hypot(x - cx, y - cy) * 0.35;
    };
    const ranked = [...t.cells].sort((a, b) => score(b) - score(a) || a - b);
    t.anchor = ranked[0] ?? -1;
    t.slots = ranked;
  }

  const info = { data: map, territories, seas };
  cache.set(map, info);
  return info;
}

/** Territories reachable by sea from `id` (sharing at least one sea). */
export function seaNeighbors(info: MapInfo, id: number): number[] {
  const out = new Set<number>();
  for (const s of info.territories[id].seas) {
    for (const t of info.seas[s].coast) if (t !== id) out.add(t);
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Random map generation

export interface GenerateOptions {
  width?: number;
  height?: number;
  territories?: number;
  /** Fraction of the grid that should be land, roughly. */
  land?: number;
  /** Join all land into one continent (for games without boats). */
  connected?: boolean;
  name?: string;
}

/** Smooth value noise for coastlines. */
function noiseField(rng: Rng, width: number, height: number, scale: number): number[] {
  const gw = Math.ceil(width / scale) + 2;
  const gh = Math.ceil(height / scale) + 2;
  const grid: number[] = [];
  for (let i = 0; i < gw * gh; i++) grid.push(rng.next());
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const out: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const fx = x / scale;
      const fy = y / scale;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = smooth(fx - ix);
      const ty = smooth(fy - iy);
      const a = grid[iy * gw + ix];
      const b = grid[iy * gw + ix + 1];
      const c = grid[(iy + 1) * gw + ix];
      const d = grid[(iy + 1) * gw + ix + 1];
      out.push(a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty);
    }
  }
  return out;
}

export function generateMap(rng: Rng, options: GenerateOptions = {}): MapData {
  const width = options.width ?? 36;
  const height = options.height ?? 24;
  const target = options.territories ?? 36;
  const landFraction = options.land ?? 0.66;
  for (let attempt = 0; attempt < 40; attempt++) {
    const map = tryGenerate(rng, width, height, target, landFraction, options.name ?? 'Random', !!options.connected);
    if (map) return map;
  }
  throw new Error('Could not generate a map');
}

function components(map: MapData, land: boolean[]): [number[], number[][]] {
  const comp = new Array<number>(land.length).fill(-1);
  const comps: number[][] = [];
  for (let s = 0; s < land.length; s++) {
    if (!land[s] || comp[s] !== -1) continue;
    const cells: number[] = [];
    const stack = [s];
    comp[s] = comps.length;
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      for (const n of around(map, c)) {
        if (land[n] && comp[n] === -1) {
          comp[n] = comps.length;
          stack.push(n);
        }
      }
    }
    comps.push(cells);
  }
  return [comp, comps];
}

/** Paint a two-cell-wide L-shaped land bridge between the closest cells of a and b. */
function bridge(map: MapData, land: boolean[], a: number[], b: number[]) {
  let best = Infinity;
  let pa = a[0];
  let pb = b[0];
  for (const ca of a) {
    const [ax, ay] = cellXY(map, ca);
    for (const cb of b) {
      const [bx, by] = cellXY(map, cb);
      const d = Math.abs(ax - bx) + Math.abs(ay - by);
      if (d < best) {
        best = d;
        pa = ca;
        pb = cb;
      }
    }
  }
  let [x, y] = cellXY(map, pa);
  const [tx, ty] = cellXY(map, pb);
  const paint = (px: number, py: number) => {
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const qx = Math.min(map.width - 2, Math.max(1, px + dx));
      const qy = Math.min(map.height - 2, Math.max(1, py + dy));
      land[qy * map.width + qx] = true;
    }
  };
  while (x !== tx) {
    paint(x, y);
    x += Math.sign(tx - x);
  }
  while (y !== ty) {
    paint(x, y);
    y += Math.sign(ty - y);
  }
  paint(x, y);
}

function tryGenerate(
  rng: Rng,
  width: number,
  height: number,
  target: number,
  landFraction: number,
  name: string,
  connected: boolean,
): MapData | null {
  const size = width * height;
  const coarse = noiseField(rng, width, height, 7);
  const fine = noiseField(rng, width, height, 3);
  const field: number[] = [];
  for (let i = 0; i < size; i++) {
    const x = i % width;
    const y = (i - x) / width;
    // Fade toward the edges so the world reads as continents in an ocean.
    const ex = Math.min(x + 0.5, width - x - 0.5) / (width / 2);
    const ey = Math.min(y + 0.5, height - y - 0.5) / (height / 2);
    const edge = Math.min(1, Math.min(ex, ey) * 3.2);
    field.push((coarse[i] * 0.72 + fine[i] * 0.28) * (0.45 + 0.55 * edge));
  }
  const sorted = [...field].sort((a, b) => b - a);
  const threshold = sorted[Math.floor(size * landFraction)];
  const land = field.map((v) => v > threshold);
  // Keep the outer ring as water, so every coast has open sea.
  for (let i = 0; i < size; i++) {
    const x = i % width;
    const y = (i - x) / width;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) land[i] = false;
  }
  const map: MapData = { name, width, height, cells: new Array(size).fill(-1) };

  // Land components; drop tiny specks, keep everything else. Without boats
  // (levels 1 and 2) every territory must be reachable over land, so islands
  // get joined to the main continent with narrow land bridges.
  const minSize = 6;
  let comp: number[] = [];
  let comps: number[][] = [];
  for (let pass = 0; pass < 30; pass++) {
    [comp, comps] = components(map, land);
    for (const cells of comps) if (cells.length < minSize) for (const c of cells) land[c] = false;
    [comp, comps] = components(map, land);
    if (!connected || comps.length <= 1) break;
    comps.sort((a, b) => b.length - a.length);
    bridge(map, land, comps[0], comps[1]);
  }
  if (connected && comps.length > 1) return null;
  const kept = comps.filter((c) => c.length >= minSize);
  const totalLand = kept.reduce((n, c) => n + c.length, 0);
  if (kept.length === 0 || totalLand < target * 6) return null;

  // Allocate territory seeds to components in proportion to their size.
  const avg = totalLand / target;
  const seeds: number[] = [];
  for (const cells of kept) {
    const n = Math.max(1, Math.round(cells.length / avg));
    // Farthest-point sampling gives evenly spread seeds.
    const chosen = [rng.pick(cells)];
    while (chosen.length < n) {
      let best = -1;
      let bestD = -1;
      for (const c of cells) {
        const [x, y] = cellXY(map, c);
        let d = Infinity;
        for (const s of chosen) {
          const [sx, sy] = cellXY(map, s);
          d = Math.min(d, Math.abs(x - sx) + Math.abs(y - sy) + rng.next() * 1.5);
        }
        if (d > bestD) {
          bestD = d;
          best = c;
        }
      }
      chosen.push(best);
    }
    seeds.push(...chosen);
  }
  if (Math.abs(seeds.length - target) > Math.max(3, target * 0.15)) return null;

  // Grow territories with a randomized, size-balanced frontier.
  const owner = new Array<number>(size).fill(-1);
  const sizes = seeds.map(() => 1);
  const frontiers: number[][] = seeds.map((s, id) => {
    owner[s] = id;
    return [s];
  });
  let remaining = totalLand - seeds.length;
  const keptComp = new Set(kept.map((cells) => comp[cells[0]]));
  const landOk = new Array<boolean>(size).fill(false);
  for (let c = 0; c < size; c++) landOk[c] = land[c] && keptComp.has(comp[c]);
  let guard = 0;
  while (remaining > 0 && guard++ < size * 50) {
    // Pick the smallest territory that can still grow, with some randomness.
    let pick = -1;
    let pickScore = Infinity;
    for (let id = 0; id < seeds.length; id++) {
      if (!frontiers[id].length) continue;
      const score = sizes[id] + rng.next() * 3;
      if (score < pickScore) {
        pickScore = score;
        pick = id;
      }
    }
    if (pick < 0) break;
    const frontier = frontiers[pick];
    const fi = rng.int(frontier.length);
    const from = frontier[fi];
    const options = around(map, from).filter((n) => landOk[n] && owner[n] === -1);
    if (!options.length) {
      frontier.splice(fi, 1);
      continue;
    }
    const next = rng.pick(options);
    owner[next] = pick;
    sizes[pick]++;
    frontier.push(next);
    remaining--;
  }
  for (let c = 0; c < size; c++) map.cells[c] = landOk[c] ? owner[c] : -1;
  if (map.cells.some((v, c) => landOk[c] && v === -1)) return null;
  // Reject maps with slivers that are too small to hold icons.
  if (sizes.some((s) => s < 5)) return null;
  const info = analyze(map);
  // Every territory needs at least one way to reach someone else.
  if (info.territories.some((t) => t.neighbors.length === 0 && seaNeighbors(info, t.id).length === 0)) return null;
  return map;
}

/** Convert the legacy hand-made map format ([x, y, mask] per country). */
export function fromLegacy(name: string, list: [number, number, number[][]][]): MapData {
  let width = 0;
  let height = 0;
  for (const [x, y, grid] of list) {
    height = Math.max(height, y + grid.length);
    for (const row of grid) width = Math.max(width, x + row.length);
  }
  // Pad with a ring of sea.
  width += 2;
  height += 2;
  const cells = new Array<number>(width * height).fill(-1);
  list.forEach(([x, y, grid], id) => {
    grid.forEach((row, dy) =>
      row.forEach((v, dx) => {
        if (v) cells[(y + dy + 1) * width + (x + dx + 1)] = id;
      }),
    );
  });
  return { name, width, height, cells };
}
