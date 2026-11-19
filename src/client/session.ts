// A Session is what the game screen talks to. Local sessions run the engine
// in the browser (pass and play on one device). Network sessions follow the
// shared room of a game played across devices.

import { GameHost } from '../engine/host.ts';
import type { NetGame } from '../net/net.ts';
import type { Room } from '../net/room.ts';
import type { Action, GameState } from '../engine/types.ts';

export interface Session {
  kind: 'local' | 'net';
  state: GameState;
  /** Can this device act for that seat? */
  controls(seat: number): boolean;
  /** Where a seat is being played, for "waiting for…" messages. */
  whereIs(seat: number): string;
  dispatch(action: Action): string | undefined;
  subscribe(fn: (state: GameState) => void): () => void;
  /** Network games: the code other devices use to join. */
  readonly code?: string;
  /** Called for errors that come back asynchronously (network). */
  onError?: (message: string) => void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Persistence

const SAVE_KEY = 'conquest-save-v2';

export function loadSave(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    const state = raw ? (JSON.parse(raw) as GameState) : null;
    return state && state.v === 1 && state.phase !== 'over' ? state : null;
  } catch {
    return null;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* storage may be unavailable */
  }
}

function save(state: GameState) {
  try {
    if (state.phase === 'over') localStorage.removeItem(SAVE_KEY);
    else localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch {
    /* storage may be unavailable */
  }
}

export class LocalSession implements Session {
  kind = 'local' as const;
  host: GameHost;
  constructor(state: GameState) {
    this.host = new GameHost(state);
    this.host.subscribe(save);
    save(state);
  }
  get state() {
    return this.host.state;
  }
  controls(seat: number) {
    const p = this.state.players[seat];
    return !!p && !p.ai;
  }
  whereIs(seat: number) {
    return this.state.players[seat]?.ai ? 'computer' : 'this device';
  }
  dispatch(action: Action) {
    return this.host.dispatch(action);
  }
  subscribe(fn: (state: GameState) => void) {
    return this.host.subscribe(fn);
  }
  close() {
    this.host.stop();
  }
}

// ---------------------------------------------------------------------------
// Network

export function clientId(): string {
  try {
    let id = localStorage.getItem('conquest-client');
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('conquest-client', id);
    }
    return id;
  } catch {
    return 'tmp-' + Math.random().toString(36).slice(2);
  }
}

export function deviceName(): string {
  try {
    const saved = localStorage.getItem('conquest-device');
    if (saved) return saved;
  } catch {
    /* ignore */
  }
  const ua = navigator.userAgent;
  if (/iPad|Macintosh.*Mobile/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'PC';
  return 'Computer';
}

export function setDeviceName(name: string) {
  try {
    localStorage.setItem('conquest-device', name);
  } catch {
    /* ignore */
  }
}

export interface SeatInfo {
  holder: string | null;
  name: string;
  online: boolean;
  mine: boolean;
  ai: boolean;
}

/** The game screen's view of a network game (see src/net/net.ts). */
export class NetSession implements Session {
  kind = 'net' as const;
  onError?: (message: string) => void;
  /** Seats, devices or hosting changed without a new game state. */
  onRoom?: () => void;
  private listeners = new Set<(state: GameState) => void>();
  private offs: (() => void)[];
  private lastGame = '';

  net: NetGame;
  constructor(net: NetGame) {
    this.net = net;
    this.lastGame = JSON.stringify(net.room?.game);
    this.offs = [
      net.onChange(() => {
        const g = net.room?.game;
        if (!g) return;
        const key = JSON.stringify(g);
        if (key !== this.lastGame) {
          this.lastGame = key;
          for (const fn of this.listeners) fn(g);
        } else this.onRoom?.();
      }),
      net.onError((m) => this.onError?.(m)),
    ];
  }

  private get room(): Room {
    return this.net.room!;
  }

  get state(): GameState {
    return this.room.game!;
  }

  get code(): string {
    return this.net.code;
  }

  get me(): string {
    return this.net.me;
  }

  controls(seat: number) {
    const c = this.room.seats[seat];
    return c?.kind === 'device' && c.id === this.net.me && !this.state.players[seat]?.ai;
  }

  /** Is this device the host? */
  get isHost(): boolean {
    return this.room.host === this.net.me;
  }

  /** Who plays each lord and whether their device is online. */
  seatInfo(seat: number): SeatInfo {
    const room = this.room;
    const c = room.seats[seat];
    if (!c || c.kind === 'computer') return { holder: null, name: 'Computer', online: true, mine: false, ai: true };
    if (c.kind === 'open') return { holder: null, name: 'Nobody', online: false, mine: false, ai: false };
    const d = room.devices.find((x) => x.id === c.id);
    return { holder: c.id, name: d?.name ?? 'a device', online: !!d?.online, mine: c.id === this.net.me, ai: false };
  }

  /** Every device in the game, with which one hosts. */
  devices(): { id: string; name: string; online: boolean; host: boolean; me: boolean }[] {
    const room = this.room;
    return room.devices.map((d) => ({ ...d, host: d.id === room.host, me: d.id === this.net.me }));
  }

  /** Play a lord on this device. */
  claimSeat(seat: number) {
    this.net.request({ t: 'seat', seat, to: 'me' });
  }

  /** Give a lord to the computer. */
  toComputer(seat: number) {
    this.net.request({ t: 'seat', seat, to: 'computer' });
  }

  kick(device: string) {
    this.net.request({ t: 'kick', device });
  }

  handoff(device: string) {
    this.net.request({ t: 'handoff', to: device });
  }

  whereIs(seat: number) {
    const i = this.seatInfo(seat);
    if (i.ai) return 'computer';
    if (!i.holder) return 'no device yet';
    if (i.mine) return 'this device';
    return i.name + (i.online ? '' : ', offline');
  }

  dispatch(action: Action) {
    if (!this.net.connected) return 'Not connected';
    this.net.request({ t: 'action', action });
    return undefined;
  }

  subscribe(fn: (state: GameState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    for (const off of this.offs) off();
    this.listeners.clear();
  }
}
