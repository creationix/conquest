// Territory outlines: trace the boundary of a set of grid cells into closed
// rectilinear loops, inset them a little so neighbors read as separate shapes,
// and build Path2D objects with rounded corners. iOS 15 has no roundRect, so
// rounding is done with arcTo.

import type { MapData } from '../engine/map.ts';

export type Pt = { x: number; y: number };

/** Closed loops of grid-corner points around the given cells (clockwise on screen). */
export function traceLoops(map: MapData, owned: (cell: number) => boolean): Pt[][] {
  const { width, height } = map;
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && owned(y * width + x);
  // Directed boundary edges keyed by start corner; interior on the right.
  const edges = new Map<string, Pt[]>();
  const add = (a: Pt, b: Pt) => {
    const k = a.x + ',' + a.y;
    const list = edges.get(k);
    if (list) list.push(b);
    else edges.set(k, [b]);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) add({ x, y }, { x: x + 1, y });
      if (!inside(x + 1, y)) add({ x: x + 1, y }, { x: x + 1, y: y + 1 });
      if (!inside(x, y + 1)) add({ x: x + 1, y: y + 1 }, { x, y: y + 1 });
      if (!inside(x - 1, y)) add({ x, y: y + 1 }, { x, y });
    }
  }
  const loops: Pt[][] = [];
  const take = (k: string, prevDir: Pt | null): Pt | undefined => {
    const list = edges.get(k);
    if (!list || !list.length) return undefined;
    // At pinch points (two cells touching diagonally) prefer turning right,
    // which keeps diagonal-only contacts as separate lobes.
    let idx = 0;
    if (list.length > 1 && prevDir) {
      const [x, y] = k.split(',').map(Number);
      idx = list.findIndex((p) => {
        const d = { x: p.x - x, y: p.y - y };
        return prevDir.x * d.y - prevDir.y * d.x > 0;
      });
      if (idx < 0) idx = 0;
    }
    const [p] = list.splice(idx, 1);
    if (!list.length) edges.delete(k);
    return p;
  };
  while (edges.size) {
    const startKey = edges.keys().next().value as string;
    const [sx, sy] = startKey.split(',').map(Number);
    const loop: Pt[] = [{ x: sx, y: sy }];
    let cur = { x: sx, y: sy };
    let dir: Pt | null = null;
    for (let guard = 0; guard < 100000; guard++) {
      const next = take(cur.x + ',' + cur.y, dir);
      if (!next) break;
      dir = { x: next.x - cur.x, y: next.y - cur.y };
      cur = next;
      if (cur.x === sx && cur.y === sy) break;
      loop.push(cur);
    }
    loops.push(simplify(loop));
  }
  return loops;
}

/** Drop collinear points. */
function simplify(loop: Pt[]): Pt[] {
  const out: Pt[] = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = loop[(i + n - 1) % n];
    const b = loop[i];
    const c = loop[(i + 1) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross !== 0) out.push(b);
  }
  return out;
}

/**
 * Inset a rectilinear loop by `d` (in cell units). Interior is on the right of
 * travel direction for screen coordinates (y down), so the inward normal of a
 * segment heading (dx, dy) is (-dy, dx).
 */
export function inset(loop: Pt[], d: number): Pt[] {
  const n = loop.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = loop[(i + n - 1) % n];
    const b = loop[i];
    const c = loop[(i + 1) % n];
    const d1 = norm(b.x - a.x, b.y - a.y);
    const d2 = norm(c.x - b.x, c.y - b.y);
    const n1 = { x: -d1.y, y: d1.x };
    const n2 = { x: -d2.y, y: d2.x };
    out.push({ x: b.x + (n1.x + n2.x) * d, y: b.y + (n1.y + n2.y) * d });
  }
  return out;
}

function norm(x: number, y: number): Pt {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

/** Append a rounded closed loop to a path, scaled by `s` cells-to-pixels. */
export function roundedLoop(path: Path2D | CanvasRenderingContext2D, loop: Pt[], s: number, convexR: number, concaveR: number) {
  const n = loop.length;
  if (n < 3) return;
  const mid = (p: Pt, q: Pt) => ({ x: ((p.x + q.x) / 2) * s, y: ((p.y + q.y) / 2) * s });
  const start = mid(loop[n - 1], loop[0]);
  path.moveTo(start.x, start.y);
  for (let i = 0; i < n; i++) {
    const a = loop[(i + n - 1) % n];
    const b = loop[i];
    const c = loop[(i + 1) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const lenIn = Math.hypot(b.x - a.x, b.y - a.y);
    const lenOut = Math.hypot(c.x - b.x, c.y - b.y);
    const want = cross > 0 ? convexR : concaveR;
    const r = Math.min(want, lenIn / 2, lenOut / 2) * s;
    const m = mid(b, c);
    path.arcTo(b.x * s, b.y * s, m.x, m.y, r);
  }
  path.closePath();
}

export interface Shape {
  loops: Pt[][];
  path: Path2D;
  /** Bounds in cell units. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function territoryShape(map: MapData, id: number, scale: number, gap: number): Shape {
  const loops = traceLoops(map, (c) => map.cells[c] === id).map((l) => inset(l, gap));
  const path = new Path2D();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const loop of loops) {
    roundedLoop(path, loop, scale, 0.42, 0.22);
    for (const p of loop) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  return { loops, path, minX, minY, maxX, maxY };
}

/** Land outline (all territories merged), for coast glow and shadows. */
export function landPath(map: MapData, scale: number, grow: number): Path2D {
  const loops = traceLoops(map, (c) => map.cells[c] >= 0).map((l) => inset(l, -grow));
  const path = new Path2D();
  for (const loop of loops) roundedLoop(path, loop, scale, 0.6 + grow, 0.3);
  return path;
}
