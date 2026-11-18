// A Session is what the game screen talks to. Local sessions run the engine
// in the browser (pass and play on one device). Network sessions talk to the
// LAN server, which runs the engine for every device at the table.

import { GameHost } from '../engine/host.ts';
import type { Link } from './peer.ts';
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

export class NetSession implements Session {
  kind = 'net' as const;
  onError?: (message: string) => void;
  private listeners = new Set<(state: GameState) => void>();
  private off: () => void;

  net: Link;
  constructor(net: Link) {
    this.net = net;
    this.off = net.on((msg) => {
      if ((msg.t === 'state' || msg.t === 'room') && net.room?.state) {
        for (const fn of this.listeners) fn(net.room.state);
      } else if (msg.t === 'error') {
        this.onError?.(msg.message);
      }
    });
  }

  get state(): GameState {
    return this.net.room!.state!;
  }

  get code(): string | undefined {
    return this.net.room?.id;
  }

  controls(seat: number) {
    const room = this.net.room;
    if (!room) return false;
    const p = room.lobby.players[seat];
    // A lord handed to the computer during the game is no longer this device's.
    if (room.state?.players[seat]?.ai) return false;
    return !!p && !p.ai && room.seats[seat] === this.net.id;
  }

  whereIs(seat: number) {
    const room = this.net.room;
    if (!room) return '';
    if (room.lobby.players[seat]?.ai || room.state?.players[seat]?.ai) return 'computer';
    const holder = room.seats[seat];
    if (!holder) return 'no device yet';
    if (holder === this.net.id) return 'this device';
    const c = room.clients.find((x) => x.id === holder);
    return c ? c.name + (c.online ? '' : ' (offline)') : 'another device';
  }

  dispatch(action: Action) {
    if (!this.net.connected) return 'Not connected';
    this.net.send({ t: 'action', action });
    return undefined;
  }

  subscribe(fn: (state: GameState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    this.off();
    this.listeners.clear();
  }
}
