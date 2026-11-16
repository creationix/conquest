// Canvas map renderer.
//
// The board (sea, coastline, territories, tokens) is painted into an offscreen
// cache whenever the game state changes. Each animation frame only blits that
// cache and draws highlights and effects on top, which keeps an iPad mini 4
// smooth. All geometry is in "cell" units; the camera maps cells to pixels.

import { analyze, cellXY, type MapData, type MapInfo } from '../engine/map.ts';
import { COLORS, type GameState, type LoggedEvent, type Site } from '../engine/types.ts';
import { landPath, territoryShape, type Shape } from './geometry.ts';
import { GOOD_COLORS, iconPath, type IconName } from './icons.ts';

export interface Highlight {
  /** Territories that can be tapped right now; everything else is dimmed. */
  selectable?: Set<number> | null;
  selected?: number[];
  target?: number;
  arrows?: { from: number; to: number; color: string }[];
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Anim {
  start: number;
  duration: number;
  draw: (ctx: CanvasRenderingContext2D, t: number) => void;
}

const NEUTRAL = { fill: '#d9ccab', dark: '#7d6c4b' };
const SEA_TOP = '#123a49';
const SEA_BOTTOM = '#0a2230';

export function ownerColors(owner: number, state: GameState | null) {
  if (owner < 0 || !state) return NEUTRAL;
  const c = COLORS[state.players[owner].color] ?? COLORS[0];
  return { fill: c.fill, dark: c.dark };
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (x: number) => Math.round(amount < 0 ? x * (1 + amount) : x + (255 - x) * amount);
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class MapRenderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  state: GameState | null = null;
  map: MapData | null = null;
  info: MapInfo | null = null;
  shapes: Shape[] = [];
  land: Path2D | null = null;
  coast: Path2D | null = null;
  highlight: Highlight = {};
  insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  onTap: (territory: number) => void = () => {};

  private cache = document.createElement('canvas');
  private cacheKey = '';
  private cacheScale = 0;
  private dpr = 1;
  private width = 1;
  private height = 1;
  private cam = { scale: 20, x: 0, y: 0 };
  /** Portrait screens show landscape maps turned a quarter turn (north on the right). */
  rotated = false;
  private fitScale = 20;
  private anims: Anim[] = [];
  private raf = 0;
  private boatCells = new Map<number, number>();
  private slotsCache = new Map<string, number[]>();
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number; t: number }>();
  private pinch: { dist: number; scale: number; cx: number; cy: number; camX: number; camY: number } | null = null;
  private moved = false;
  private zoomTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.bindInput();
    const onResize = () => this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(onResize);
      this.resizeObserver.observe(canvas);
    }
    window.addEventListener('resize', onResize);
    this.resize();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
  }

  // -------------------------------------------------------------------------
  // Public API

  setState(state: GameState) {
    const newMap = state.map !== this.map && JSON.stringify(state.map.cells) !== JSON.stringify(this.map?.cells);
    this.state = state;
    if (newMap || !this.map) {
      this.map = state.map;
      this.info = analyze(state.map);
      this.shapes = this.info.territories.map((t) => territoryShape(state.map, t.id, 1, 0.07));
      this.land = landPath(state.map, 1, 0.12);
      this.coast = landPath(state.map, 1, 0.4);
      this.slotsCache.clear();
      this.fit(true);
    } else {
      this.map = state.map;
    }
    this.cacheKey = '';
    this.requestDraw();
  }

  setHighlight(h: Highlight) {
    this.highlight = h;
    this.requestDraw();
  }

  /** Map scale (px per cell) that these insets would give. */
  scaleFor(o: Insets): number {
    if (!this.map) return 0;
    const w = this.width - o.left - o.right;
    const hh = this.height - o.top - o.bottom;
    const rotate = this.map.width > this.map.height && this.height > this.width * 1.1;
    const vw = rotate ? this.map.height : this.map.width;
    const vh = rotate ? this.map.width : this.map.height;
    return Math.min(w / vw, hh / vh);
  }

  /** Reserve screen edges for the HUD; with several options, use the one giving the biggest map. */
  setInsets(options: Insets | Insets[]) {
    const list = Array.isArray(options) ? options : [options];
    let insets = list[0];
    let best = -1;
    for (const o of list) {
      const scale = this.scaleFor(o);
      if (scale > best) {
        best = scale;
        insets = o;
      }
    }
    const changed = JSON.stringify(insets) !== JSON.stringify(this.insets);
    this.insets = insets;
    // Refit as the HUD changes size, unless someone zoomed in to look closer.
    if (changed && !this.zoomed) this.fit(true);
  }

  /** Zoom so the whole map fits the area not covered by the HUD. */
  fit(instant = false) {
    if (!this.map) return;
    const { top, right, bottom, left } = this.insets;
    const w = Math.max(100, this.width - left - right);
    const h = Math.max(100, this.height - top - bottom);
    const landscapeMap = this.map.width > this.map.height;
    // Decide by the whole screen, so the map does not flip as panels resize.
    const rotate = landscapeMap && this.height > this.width * 1.1;
    if (rotate !== this.rotated) {
      this.rotated = rotate;
      instant = true;
    }
    const scale = Math.min(w / this.viewW, h / this.viewH);
    this.fitScale = scale;
    const target = {
      scale,
      x: left + (w - this.viewW * scale) / 2,
      y: top + (h - this.viewH * scale) / 2,
    };
    if (instant || reducedMotion()) {
      this.cam = target;
      this.requestDraw();
      return;
    }
    const from = { ...this.cam };
    this.addAnim(350, (_ctx, t) => {
      const e = 1 - Math.pow(1 - t, 3);
      this.cam = {
        scale: from.scale + (target.scale - from.scale) * e,
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
      };
    }, true);
  }

  zoomBy(factor: number) {
    this.zoomAt(this.width / 2, this.height / 2, factor);
  }

  get zoomed() {
    return this.cam.scale > this.fitScale * 1.05;
  }

  private get viewW() {
    return this.rotated ? this.map!.height : this.map!.width;
  }

  private get viewH() {
    return this.rotated ? this.map!.width : this.map!.height;
  }

  /** World (cell units) to screen CSS pixels. */
  private toScreen(x: number, y: number) {
    const vx = this.rotated ? this.map!.height - y : x;
    const vy = this.rotated ? x : y;
    return { x: this.cam.x + vx * this.cam.scale, y: this.cam.y + vy * this.cam.scale };
  }

  /** Apply the world-to-canvas transform (in device pixels). */
  private worldTransform(ctx: CanvasRenderingContext2D) {
    const k = this.dpr * this.cam.scale;
    ctx.setTransform(k, 0, 0, k, this.dpr * this.cam.x, this.dpr * this.cam.y);
    if (this.rotated) ctx.transform(0, 1, -1, 0, this.map!.height, 0);
  }

  /** Move to a world point with screen-upright axes, for text. */
  private upright(ctx: CanvasRenderingContext2D, x: number, y: number) {
    ctx.translate(x, y);
    if (this.rotated) ctx.rotate(-Math.PI / 2);
  }

  /** Screen position (CSS px) of a territory's anchor, for popovers. */
  anchorOf(t: number): { x: number; y: number } {
    if (!this.info || !this.map) return { x: 0, y: 0 };
    const [cx, cy] = cellXY(this.map, this.info.territories[t].anchor);
    return this.toScreen(cx + 0.5, cy + 0.5);
  }

  /** Turn new log entries into animations. */
  animateEvents(events: LoggedEvent[]) {
    if (!this.state || !this.info || reducedMotion()) return;
    let delay = 0;
    for (const { event } of events) {
      switch (event.kind) {
        case 'pick':
        case 'stockpile':
          this.ripple(event.territory, ownerColors(event.player, this.state).fill, delay);
          break;
        case 'build':
          this.ripple(event.territory, '#fff4c8', delay);
          break;
        case 'produce': {
          this.floatLabel(event.territory, `+${event.amount}`, GOOD_COLORS[event.good], event.good, delay);
          delay += 90;
          break;
        }
        case 'horse':
          this.floatLabel(event.territory, '+1', GOOD_COLORS.horses, 'horse', delay);
          delay += 90;
          break;
        case 'ship':
          if (event.move.kind !== 'stockpile') this.arrow(event.move.from, event.move.to, '#ffe7a8', delay, 900);
          else this.ripple(event.move.to, '#f5c542', delay);
          break;
        case 'battle': {
          const from = this.attackSource(event.attacker, event.target, event.force);
          const color = ownerColors(event.attacker, this.state).fill;
          if (from >= 0) this.arrow(from, event.target, color, delay, 650);
          this.burst(event.target, event.won ? color : '#ffffff', event.won ? 'Conquered!' : 'Repelled!', delay + 550);
          delay += 900;
          break;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Layout & camera

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.fit(true);
    this.requestDraw();
  }

  private zoomAt(px: number, py: number, factor: number) {
    const min = this.fitScale;
    const max = this.fitScale * 4;
    const scale = Math.min(max, Math.max(min, this.cam.scale * factor));
    const k = scale / this.cam.scale;
    this.cam.x = px - (px - this.cam.x) * k;
    this.cam.y = py - (py - this.cam.y) * k;
    this.cam.scale = scale;
    if (scale <= min * 1.001) this.fit(true);
    this.clampCamera();
    this.requestDraw();
    // Repaint the cache at the new resolution once zooming settles.
    if (this.zoomTimer) clearTimeout(this.zoomTimer);
    this.zoomTimer = setTimeout(() => this.requestDraw(), 200);
  }

  private clampCamera() {
    if (!this.map) return;
    const w = this.viewW * this.cam.scale;
    const h = this.viewH * this.cam.scale;
    const pad = 40;
    if (w <= this.width) this.cam.x = Math.min(Math.max(this.cam.x, 0), this.width - w);
    else this.cam.x = Math.min(pad, Math.max(this.width - w - pad, this.cam.x));
    if (h <= this.height) this.cam.y = Math.min(Math.max(this.cam.y, 0), this.height - h);
    else this.cam.y = Math.min(pad, Math.max(this.height - h - pad, this.cam.y));
  }

  // -------------------------------------------------------------------------
  // Input

  private bindInput() {
    const c = this.canvas;
    const pos = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('pointerdown', (e) => {
      const p = pos(e);
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.pointers.set(e.pointerId, { ...p, sx: p.x, sy: p.y, t: performance.now() });
      if (this.pointers.size === 1) this.moved = false;
      if (this.pointers.size === 2) this.startPinch();
    });
    c.addEventListener('pointermove', (e) => {
      const ptr = this.pointers.get(e.pointerId);
      if (!ptr) return;
      const p = pos(e);
      const dx = p.x - ptr.x;
      const dy = p.y - ptr.y;
      ptr.x = p.x;
      ptr.y = p.y;
      if (Math.hypot(p.x - ptr.sx, p.y - ptr.sy) > 10) this.moved = true;
      if (this.pointers.size >= 2 && this.pinch) {
        this.updatePinch();
      } else if (this.pointers.size === 1 && this.moved && this.zoomed) {
        this.cam.x += dx;
        this.cam.y += dy;
        this.clampCamera();
        this.requestDraw();
      }
    });
    const end = (e: PointerEvent) => {
      const ptr = this.pointers.get(e.pointerId);
      if (!ptr) return;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (e.type === 'pointerup' && !this.moved && this.pointers.size === 0 && performance.now() - ptr.t < 800) {
        this.tap(ptr.x, ptr.y);
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
    // Safari's own pinch gestures fight with ours.
    c.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  private startPinch() {
    const [a, b] = [...this.pointers.values()];
    this.moved = true;
    this.pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      scale: this.cam.scale,
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      camX: this.cam.x,
      camY: this.cam.y,
    };
  }

  private updatePinch() {
    const pinch = this.pinch!;
    const [a, b] = [...this.pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const scale = Math.min(this.fitScale * 4, Math.max(this.fitScale, pinch.scale * (dist / pinch.dist)));
    const k = scale / pinch.scale;
    this.cam.scale = scale;
    this.cam.x = cx - (pinch.cx - pinch.camX) * k;
    this.cam.y = cy - (pinch.cy - pinch.camY) * k;
    this.clampCamera();
    this.requestDraw();
    if (this.zoomTimer) clearTimeout(this.zoomTimer);
    this.zoomTimer = setTimeout(() => this.requestDraw(), 200);
  }

  private tap(x: number, y: number) {
    if (!this.map) return;
    const vx = (x - this.cam.x) / this.cam.scale;
    const vy = (y - this.cam.y) / this.cam.scale;
    const cx = Math.floor(this.rotated ? vy : vx);
    const cy = Math.floor(this.rotated ? this.map.height - vx : vy);
    if (cx < 0 || cy < 0 || cx >= this.map.width || cy >= this.map.height) return this.onTap(-1);
    const cell = cy * this.map.width + cx;
    let t = this.map.cells[cell];
    if (t < 0) t = this.boatCells.get(cell) ?? -1;
    if (t < 0) {
      // Forgive taps just off the coast: use the nearest land cell.
      let best = Infinity;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= this.map.width || ny >= this.map.height) continue;
        const id = this.map.cells[ny * this.map.width + nx];
        const d = Math.abs(dx) + Math.abs(dy);
        if (id >= 0 && d < best) {
          best = d;
          t = id;
        }
      }
    }
    this.onTap(t);
  }

  // -------------------------------------------------------------------------
  // Drawing

  requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame((now) => {
      this.raf = 0;
      this.draw(now);
    });
  }

  private addAnim(duration: number, draw: Anim['draw'], camera = false, delay = 0) {
    const anim: Anim = { start: performance.now() + delay, duration, draw };
    if (camera) {
      // Only one camera tween at a time.
      this.anims = this.anims.filter((a) => !cameraAnims.has(a.draw));
      cameraAnims.add(draw);
    }
    this.anims.push(anim);
    this.requestDraw();
  }

  private draw(now: number) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.map || !this.state) return;

    // Camera tweens update before anything is painted.
    for (const a of this.anims) {
      const t = (now - a.start) / a.duration;
      if (t >= 0 && isCameraAnim(a)) a.draw(ctx, Math.min(1, t));
    }
    const active: Anim[] = [];
    for (const a of this.anims) if (now < a.start) active.push(a);

    this.ensureCache();
    const cs = this.cacheScale;
    this.worldTransform(ctx);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.cache, 0, 0, this.cache.width / cs, this.cache.height / cs);
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    this.drawHighlight(ctx, pulse);

    for (const a of this.anims) {
      const t = (now - a.start) / a.duration;
      if (t < 0) continue;
      if (t <= 1) {
        if (!isCameraAnim(a)) {
          ctx.save();
          a.draw(ctx, t);
          ctx.restore();
        }
        active.push(a);
      }
    }
    this.anims = this.anims.filter((a) => active.includes(a));

    const pulsing = !!(this.highlight.selected?.length || this.highlight.target !== undefined || this.highlight.arrows?.length);
    if (this.anims.length || pulsing) this.requestDraw();
  }

  private drawHighlight(ctx: CanvasRenderingContext2D, pulse: number) {
    const h = this.highlight;
    const lw = 1 / this.cam.scale;
    if (h.selectable) {
      ctx.fillStyle = 'rgba(4, 16, 24, 0.42)';
      this.shapes.forEach((shape, id) => {
        if (!h.selectable!.has(id)) ctx.fill(shape.path);
      });
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = lw * 1.5;
      ctx.setLineDash([lw * 5, lw * 4]);
      for (const id of h.selectable) ctx.stroke(this.shapes[id].path);
      ctx.setLineDash([]);
    }
    for (const id of h.selected ?? []) {
      const shape = this.shapes[id];
      if (!shape) continue;
      ctx.strokeStyle = `rgba(255, 231, 168, ${0.55 + 0.45 * pulse})`;
      ctx.lineWidth = lw * (3 + pulse * 2);
      ctx.stroke(shape.path);
      ctx.fillStyle = `rgba(255, 240, 200, ${0.12 + 0.1 * pulse})`;
      ctx.fill(shape.path);
    }
    if (h.target !== undefined && this.shapes[h.target]) {
      const shape = this.shapes[h.target];
      ctx.strokeStyle = `rgba(255, 90, 90, ${0.6 + 0.4 * pulse})`;
      ctx.lineWidth = lw * (3 + pulse * 3);
      ctx.stroke(shape.path);
      ctx.fillStyle = `rgba(255, 70, 70, ${0.12 + 0.12 * pulse})`;
      ctx.fill(shape.path);
    }
    for (const a of h.arrows ?? []) this.drawArrow(ctx, a.from, a.to, a.color, 1, pulse);
  }

  private center(t: number): { x: number; y: number } {
    const [x, y] = cellXY(this.map!, this.info!.territories[t].anchor);
    return { x: x + 0.5, y: y + 0.5 };
  }

  private drawArrow(ctx: CanvasRenderingContext2D, from: number, to: number, color: string, progress: number, pulse = 1) {
    const a = this.center(from);
    const b = this.center(to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const end = { x: a.x + dx * progress - ux * 0.5, y: a.y + dy * progress - uy * 0.5 };
    // Gentle arc.
    const mx = (a.x + end.x) / 2 - uy * len * 0.15;
    const my = (a.y + end.y) / 2 + ux * len * 0.15;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.42;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx, my, end.x, end.y);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.75 + 0.25 * pulse;
    ctx.lineWidth = 0.26;
    ctx.stroke();
    // Head, aligned with the curve's end tangent.
    const tx = end.x - mx;
    const ty = end.y - my;
    const tl = Math.hypot(tx, ty) || 1;
    const hx = tx / tl;
    const hy = ty / tl;
    ctx.beginPath();
    ctx.moveTo(end.x + hx * 0.55, end.y + hy * 0.55);
    ctx.lineTo(end.x - hy * 0.45 - hx * 0.2, end.y + hx * 0.45 - hy * 0.2);
    ctx.lineTo(end.x + hy * 0.45 - hx * 0.2, end.y - hx * 0.45 - hy * 0.2);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 0.06;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private attackSource(attacker: number, target: number, force: { kind: string; from: number } | null): number {
    if (force) return force.from;
    const s = this.state!;
    const ns = this.info!.territories[target].neighbors.filter((n) => s.territories[n].owner === attacker);
    return ns[0] ?? -1;
  }

  // -------------------------------------------------------------------------
  // Effects

  private ripple(t: number, color: string, delay: number) {
    const c = this.center(t);
    this.addAnim(
      700,
      (ctx, p) => {
        ctx.strokeStyle = color;
        ctx.globalAlpha = 1 - p;
        ctx.lineWidth = 0.18;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 0.4 + p * 2.2, 0, Math.PI * 2);
        ctx.stroke();
      },
      false,
      delay,
    );
  }

  private floatLabel(t: number, text: string, color: string, icon: IconName, delay: number) {
    const c = this.center(t);
    this.addAnim(
      1300,
      (ctx, p) => {
        const e = 1 - Math.pow(1 - p, 2);
        this.upright(ctx, c.x, c.y);
        const y = -0.4 - e * 1.6;
        ctx.globalAlpha = p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25;
        ctx.fillStyle = 'rgba(8, 24, 32, 0.82)';
        roundRect(ctx, -1.05, y - 0.48, 2.1, 0.96, 0.48);
        ctx.fill();
        ctx.save();
        ctx.translate(-0.92, y - 0.36);
        ctx.scale(0.72 / 24, 0.72 / 24);
        ctx.fillStyle = color;
        ctx.fill(iconPath(icon));
        ctx.restore();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 0.62px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 0.35, y + 0.03);
      },
      false,
      delay,
    );
  }

  private arrow(from: number, to: number, color: string, delay: number, duration: number) {
    this.addAnim(
      duration,
      (ctx, p) => {
        const e = 1 - Math.pow(1 - Math.min(1, p * 1.4), 3);
        ctx.globalAlpha = p > 0.85 ? (1 - p) / 0.15 : 1;
        this.drawArrow(ctx, from, to, color, Math.max(0.05, e));
      },
      false,
      delay,
    );
  }

  private burst(t: number, color: string, label: string, delay: number) {
    const c = this.center(t);
    const shape = this.shapes[t];
    this.addAnim(
      1600,
      (ctx, p) => {
        if (p < 0.35) {
          ctx.fillStyle = '#ffffff';
          ctx.globalAlpha = 0.65 * (1 - p / 0.35);
          ctx.fill(shape.path);
        }
        ctx.globalAlpha = Math.max(0, 1 - p * 1.3);
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.3 * (1 - p);
        for (const k of [0, 0.15]) {
          const q = Math.max(0, p - k);
          ctx.beginPath();
          ctx.arc(c.x, c.y, 0.5 + q * 4, 0, Math.PI * 2);
          ctx.stroke();
        }
        this.upright(ctx, c.x, c.y);
        const y = -1.2 - Math.min(1, p * 3) * 0.6;
        ctx.globalAlpha = p < 0.8 ? 1 : (1 - p) / 0.2;
        ctx.font = 'bold 0.9px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 0.22;
        ctx.strokeStyle = 'rgba(6, 18, 26, 0.9)';
        ctx.strokeText(label, 0, y);
        ctx.fillStyle = label === 'Repelled!' ? '#ffd7d7' : '#fff6d8';
        ctx.fillText(label, 0, y);
      },
      false,
      delay,
    );
  }

  // -------------------------------------------------------------------------
  // Cached board

  private ensureCache() {
    const s = this.state!;
    const map = this.map!;
    // Resolution: match the current zoom, but stay inside iOS canvas limits.
    const want = this.cam.scale * this.dpr;
    const maxScale = Math.min(4096 / map.width, 4096 / map.height, Math.sqrt(12e6 / (map.width * map.height)));
    const scale = Math.min(want, maxScale);
    const settled = !this.pinch && this.pointers.size < 2;
    const needScale = !this.cacheScale || (settled && Math.abs(scale - this.cacheScale) / scale > 0.15);
    const key = s.version + ':' + this.rotated + ':' + s.players.map((p) => p.stockpile).join(',') + ':' + JSON.stringify(s.territories);
    if (!needScale && key === this.cacheKey) return;
    if (needScale) this.cacheScale = scale;
    this.cacheKey = key;
    this.paintBoard();
  }

  private paintBoard() {
    const s = this.state!;
    const map = this.map!;
    const info = this.info!;
    const k = this.cacheScale;
    const canvas = this.cache;
    canvas.width = Math.ceil(map.width * k);
    canvas.height = Math.ceil(map.height * k);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(k, 0, 0, k, 0, 0);

    // Sea.
    const sea = ctx.createLinearGradient(0, 0, 0, map.height);
    sea.addColorStop(0, SEA_TOP);
    sea.addColorStop(1, SEA_BOTTOM);
    ctx.fillStyle = sea;
    roundRect(ctx, 0, 0, map.width, map.height, 0.9);
    ctx.fill();
    ctx.save();
    roundRect(ctx, 0, 0, map.width, map.height, 0.9);
    ctx.clip();
    // Little wave marks, seeded by position so they never jump around.
    ctx.strokeStyle = 'rgba(160, 220, 235, 0.10)';
    ctx.lineWidth = 0.06;
    ctx.lineCap = 'round';
    for (let c = 0; c < map.cells.length; c++) {
      if (map.cells[c] !== -1) continue;
      const hash = (Math.imul(c, 2654435761) >>> 0) / 4294967296;
      if (hash > 0.22) continue;
      const [x, y] = cellXY(map, c);
      const ox = x + 0.2 + hash * 2.4;
      const oy = y + 0.5 + ((hash * 7) % 1) * 0.3;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.quadraticCurveTo(ox + 0.15, oy - 0.15, ox + 0.3, oy);
      ctx.quadraticCurveTo(ox + 0.45, oy + 0.15, ox + 0.6, oy);
      ctx.stroke();
    }
    // Shallow water glow along the coast.
    ctx.fillStyle = 'rgba(95, 200, 215, 0.10)';
    ctx.fill(this.coast!);
    ctx.fillStyle = 'rgba(120, 215, 225, 0.12)';
    ctx.fill(this.land!);
    ctx.restore();

    // Land shadow, then territories.
    ctx.save();
    ctx.shadowColor = 'rgba(0, 10, 16, 0.55)';
    ctx.shadowBlur = 0.35 * k;
    ctx.shadowOffsetY = 0.12 * k;
    ctx.fillStyle = '#1a2e36';
    for (const shape of this.shapes) ctx.fill(shape.path);
    ctx.restore();

    this.shapes.forEach((shape, id) => this.paintTerritory(ctx, id, shape));

    // Boats sit in coastal water cells next to their territory.
    this.boatCells.clear();
    s.territories.forEach((t, id) => {
      const used = new Map<number, number>();
      for (const sea of t.boats) {
        const i = used.get(sea) ?? 0;
        used.set(sea, i + 1);
        const cell = info.territories[id].coast[sea]?.[i];
        if (cell === undefined) continue;
        this.boatCells.set(cell, id);
        const [x, y] = cellXY(map, cell);
        this.paintToken(ctx, x + 0.5, y + 0.5, 'boat', ownerColors(t.owner, s), 0.44, true);
      }
    });
  }

  private paintTerritory(ctx: CanvasRenderingContext2D, id: number, shape: Shape) {
    const s = this.state!;
    const t = s.territories[id];
    const colors = ownerColors(t.owner, s);
    const grad = ctx.createLinearGradient(0, shape.minY, 0, shape.maxY);
    grad.addColorStop(0, shade(colors.fill, 0.18));
    grad.addColorStop(1, shade(colors.fill, -0.08));
    ctx.fillStyle = grad;
    ctx.fill(shape.path);

    ctx.save();
    ctx.clip(shape.path);
    // Soft inner rim: light at the top, darker at the bottom.
    ctx.lineWidth = 0.32;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.translate(0, 0.08);
    ctx.stroke(shape.path);
    ctx.translate(0, -0.16);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.stroke(shape.path);
    ctx.translate(0, 0.08);
    if (t.city) {
      // Cities are striped, as in the original.
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 0.16;
      ctx.beginPath();
      for (let d = shape.minX + shape.minY - 1; d < shape.maxX + shape.maxY + 1; d += 0.55) {
        ctx.moveTo(d - shape.minY + 1, shape.minY - 1);
        ctx.lineTo(d - shape.maxY - 1, shape.maxY + 1);
      }
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = colors.dark;
    ctx.lineWidth = 0.1;
    ctx.stroke(shape.path);

    // Icons: stockpile, city, weapon, horse, then the resource site.
    const items: { kind: IconName; token: boolean }[] = [];
    if (t.owner >= 0 && s.players[t.owner].stockpile === id) items.push({ kind: 'stockpile', token: true });
    if (t.city) items.push({ kind: 'city', token: true });
    if (t.weapon) items.push({ kind: 'weapon', token: true });
    if (t.horse) items.push({ kind: 'horse', token: true });
    if (t.site) items.push({ kind: t.site as IconName, token: false });
    const slots = this.slotsFor(id, items.length);
    items.forEach((item, i) => {
      const cell = slots[i];
      if (cell === undefined) return;
      const [x, y] = cellXY(this.map!, cell);
      if (item.token) this.paintToken(ctx, x + 0.5, y + 0.5, item.kind, colors, item.kind === 'city' ? 0.5 : 0.43, false);
      else this.paintSite(ctx, x + 0.5, y + 0.5, t.site!, colors);
    });
  }

  /** Spread icons over a territory's interior cells. */
  private slotsFor(id: number, n: number): number[] {
    const key = id + ':' + n;
    const hit = this.slotsCache.get(key);
    if (hit) return hit;
    const map = this.map!;
    const ranked = this.info!.territories[id].slots;
    const chosen: number[] = [];
    for (const minGap of [2, 1]) {
      for (const c of ranked) {
        if (chosen.length >= n) break;
        if (chosen.includes(c)) continue;
        const [x, y] = cellXY(map, c);
        const ok = chosen.every((o) => {
          const [ox, oy] = cellXY(map, o);
          return Math.max(Math.abs(ox - x), Math.abs(oy - y)) >= minGap;
        });
        if (ok) chosen.push(c);
      }
    }
    for (const c of ranked) if (chosen.length < n && !chosen.includes(c)) chosen.push(c);
    this.slotsCache.set(key, chosen);
    return chosen;
  }

  private paintSite(ctx: CanvasRenderingContext2D, x: number, y: number, site: Site, colors: { fill: string; dark: string }) {
    const size = 0.78;
    ctx.save();
    // Icons stay upright when the map is shown turned for portrait screens.
    ctx.translate(x, y);
    if (this.rotated) ctx.rotate(-Math.PI / 2);
    ctx.translate(-size / 2, -size / 2);
    ctx.scale(size / 24, size / 24);
    const path = iconPath(site as IconName);
    // Engraved look: a light edge below, ink on top.
    ctx.translate(0, 1.2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fill(path);
    ctx.translate(0, -1.2);
    ctx.fillStyle = shade(colors.dark, -0.25);
    ctx.globalAlpha = 0.78;
    ctx.fill(path);
    if (site === 'horses') {
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = shade(colors.dark, -0.25);
      ctx.stroke(path);
    }
    ctx.restore();
  }

  private paintToken(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    kind: IconName,
    colors: { fill: string; dark: string },
    r: number,
    floating: boolean,
  ) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 0.15 * this.cacheScale;
    ctx.shadowOffsetY = 0.05 * this.cacheScale;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    const special = kind === 'stockpile';
    ctx.fillStyle = floating ? shade(colors.fill, 0.55) : special ? '#fff3cf' : '#fbf6ea';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = special ? 0.09 : 0.065;
    ctx.strokeStyle = special ? '#c28d14' : colors.dark;
    ctx.stroke();
    const size = r * 1.42;
    ctx.save();
    ctx.translate(x, y);
    if (this.rotated) ctx.rotate(-Math.PI / 2);
    ctx.translate(-size / 2, -size / 2);
    ctx.scale(size / 24, size / 24);
    ctx.fillStyle = special ? '#9a6a07' : colors.dark;
    ctx.fill(iconPath(kind));
    ctx.restore();
  }
}

function isCameraAnim(a: Anim) {
  return cameraAnims.has(a.draw);
}
const cameraAnims = new WeakSet<Anim['draw']>();

/** Rounded rectangle path without CanvasRenderingContext2D.roundRect (iOS 15). */
export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
