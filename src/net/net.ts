// Network runtime: one NetGame per device, in the host role or the client
// role, switching on handoff and failover. See docs/network.md.

import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import { chooseAction } from '../engine/ai.ts';
import { paceFor } from '../engine/host.ts';
import type { Lobby } from '../engine/protocol.ts';
import { tryApply } from '../engine/rules.ts';
import type { Action } from '../engine/types.ts';
import {
  automaticSeats,
  createRoom,
  newer,
  pendingSeats,
  presence,
  reduce,
  RoomError,
  succession,
  takeOver,
  unattended,
  type Intent,
  type Room,
} from './room.ts';

// ---------------------------------------------------------------------------
// Settings

const PREFIX = 'conquest-v2-';
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels: no accidental words
// `?fastnet` shortens the waits, for automated tests.
const FAST = typeof location !== 'undefined' && /[?&]fastnet\b/.test(location.search);
const HEARTBEAT = 2000;
const SILENCE = 7000; // after this long without a word, a device (or the host) is gone
const CONNECT_TIMEOUT = 8000; // a host that does not answer at all
const AUTOPILOT_GRACE = FAST ? 4000 : 25000; // how long the game waits for an absent lord
const FAILOVER_STEP = FAST ? 4000 : 15000; // extra wait per place in the succession order
const SAVE_KEY = 'conquest-net-v2';

function peerOptions(): PeerOptions {
  const opts: PeerOptions = { debug: 0 };
  try {
    const signal = new URLSearchParams(location.search).get('signal');
    if (signal) {
      const [hostPort, ...path] = signal.split('/');
      const [host, port] = hostPort.split(':');
      Object.assign(opts, { host, port: Number(port || 443), path: '/' + path.join('/'), secure: location.protocol === 'https:' && !/^(localhost|127\.)/.test(host) });
    }
  } catch {
    /* the public service */
  }
  return opts;
}

export function newCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
  return code;
}

export function normalizeCode(text: string): string {
  return text.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

// ---------------------------------------------------------------------------
// Wire format: JSON, split into small chunks (older Safari limits message size).

type ToHost = { t: 'hello'; device: string; name: string } | { t: 'intent'; intent: Intent } | { t: 'ping' };
type ToClient = { t: 'room'; room: Room } | { t: 'error'; message: string } | { t: 'ping' } | { t: 'bye'; reason: 'closed' | 'removed' } | { t: 'handoff'; room: Room };

const CHUNK = 15000;

function send(conn: DataConnection, msg: ToHost | ToClient) {
  if (!conn.open) return;
  const text = JSON.stringify(msg);
  try {
    if (text.length <= CHUNK) return void conn.send(text);
    const id = Math.random().toString(36).slice(2, 8);
    const n = Math.ceil(text.length / CHUNK);
    for (let i = 0; i < n; i++) conn.send(`#${id}:${i}:${n}:` + text.slice(i * CHUNK, (i + 1) * CHUNK));
  } catch {
    /* the channel is closing */
  }
}

function receiver<T>(onMessage: (msg: T) => void) {
  const parts = new Map<string, string[]>();
  return (data: unknown) => {
    if (typeof data !== 'string') return;
    let text = data;
    if (data[0] === '#') {
      const m = /^#(\w+):(\d+):(\d+):/.exec(data);
      if (!m) return;
      const [head, id, i, n] = m;
      const list = parts.get(id) ?? new Array<string>(Number(n));
      list[Number(i)] = data.slice(head.length);
      parts.set(id, list);
      if (list.filter((x) => x !== undefined).length < Number(n)) return;
      parts.delete(id);
      text = list.join('');
    }
    try {
      onMessage(JSON.parse(text) as T);
    } catch {
      /* ignore malformed */
    }
  };
}

// ---------------------------------------------------------------------------
// Saved games: every device keeps the latest snapshot, so any device can bring
// the game back.

export interface SavedNet {
  code: string;
  room: Room;
}

export function loadNet(): SavedNet | null {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null') as SavedNet | null;
    return s && s.room?.v === 2 && s.room.game && s.room.game.phase !== 'over' ? s : null;
  } catch {
    return null;
  }
}

function saveNet(room: Room | null) {
  try {
    if (!room || (room.game && room.game.phase === 'over')) localStorage.removeItem(SAVE_KEY);
    else if (room.game) localStorage.setItem(SAVE_KEY, JSON.stringify({ code: room.code, room } satisfies SavedNet));
  } catch {
    /* storage may be unavailable */
  }
}

// ---------------------------------------------------------------------------

export type NetStatus = 'connecting' | 'online' | 'reconnecting' | 'offline' | 'not-found' | 'closed' | 'removed';

interface Remote {
  conn: DataConnection;
  device: string;
  seen: number;
}

export class NetGame {
  readonly me: string;
  name: string;
  code: string;
  room: Room | null = null;
  role: 'host' | 'client' = 'client';
  status: NetStatus = 'connecting';
  private listeners = new Set<() => void>();
  private errorListeners = new Set<(message: string) => void>();
  private peer: Peer | null = null;
  private ended = false;
  private leaving = false;
  // Host role
  private remotes = new Set<Remote>();
  private waitingSince = new Map<number, number>();
  /** Absent lords the computer has started playing: no more waiting for them until their device is back. */
  private autopilot = new Set<number>();
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private freshCode = false;
  // Client role
  private conn: DataConnection | null = null;
  private lastHeard = 0;
  private connectStarted = 0;
  private hostLostAt = 0;
  private retries = 0;
  private everJoined = false;

  private constructor(me: string, name: string, code: string) {
    this.me = me;
    this.name = name;
    this.code = code;
  }

  /** Host a new game. */
  static host(me: string, name: string, lobby: Lobby): NetGame {
    const g = new NetGame(me, name, newCode());
    g.room = createRoom(g.code, { id: me, name, online: true }, lobby);
    g.freshCode = true;
    g.becomeHost(g.room);
    return g;
  }

  /** Join someone's game by its code. */
  static join(me: string, name: string, code: string): NetGame {
    const g = new NetGame(me, name, code);
    g.becomeClient();
    return g;
  }

  /** Bring back a saved game: rejoin its host, or host it if nobody does. */
  static resume(me: string, name: string, saved: SavedNet): NetGame {
    const g = new NetGame(me, name, saved.code);
    g.room = saved.room;
    g.everJoined = true;
    g.becomeClient();
    return g;
  }

  get isHost() {
    return this.role === 'host';
  }

  get connected() {
    return this.role === 'host' || (!!this.conn?.open && this.status === 'online');
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onError(fn: (message: string) => void): () => void {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  private error(message: string) {
    for (const fn of this.errorListeners) fn(message);
  }

  private setStatus(s: NetStatus) {
    if (this.status === s) return;
    this.status = s;
    this.changed();
  }

  /** Ask for a change. Asynchronous: the result arrives as a new room (or an error). */
  request(intent: Intent) {
    if (this.role === 'host') {
      setTimeout(() => this.apply(this.me, intent, (m) => this.error(m)), 0);
    } else if (this.conn?.open) {
      send(this.conn, { t: 'intent', intent });
    } else {
      this.error('Not connected yet');
    }
  }

  /** Leave the game; your lords go to the computer. A host hands hosting on first if anyone is here. */
  leave() {
    if (this.ended) return;
    if (this.role === 'host' && this.room) {
      const next = this.room.game ? succession(this.room)[0] : undefined;
      // Nobody else here: keep the save so the game can be continued later.
      if (!next) return this.end(false);
      this.leaving = true;
      this.apply(this.me, { t: 'leave' }, () => {});
      this.apply(this.me, { t: 'handoff', to: next }, () => {});
    } else if (this.conn?.open) {
      send(this.conn, { t: 'intent', intent: { t: 'leave' } });
    }
    this.end(true);
  }

  /** Host only: end the game for everyone. */
  closeForEveryone() {
    for (const r of this.remotes) send(r.conn, { t: 'bye', reason: 'closed' });
    this.end();
  }

  /** Stop all networking. */
  end(clear = true) {
    if (this.ended) return;
    this.ended = true;
    if (clear) saveNet(null);
    this.teardown();
  }

  private teardown() {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    if (this.beat) clearInterval(this.beat);
    this.autoTimer = null;
    this.beat = null;
    this.remotes.clear();
    this.conn = null;
    const p = this.peer;
    this.peer = null;
    // A moment for the last messages to go out.
    if (p) setTimeout(() => p.destroy(), 300);
  }

  // =========================================================================
  // Host role

  private becomeHost(room: Room, attempt = 0) {
    if (this.ended) return;
    this.teardown();
    this.role = 'host';
    this.room = room;
    this.setStatus('connecting');
    const peer = new Peer(PREFIX + this.code, peerOptions());
    this.peer = peer;
    peer.on('open', () => {
      if (this.peer !== peer) return;
      this.freshCode = false;
      this.setStatus('online');
      this.commit(this.room!);
    });
    peer.on('connection', (conn) => this.accept(conn));
    peer.on('disconnected', () => {
      // Lost the signaling service only: connected devices keep playing.
      if (this.peer === peer && !peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 2000);
    });
    peer.on('error', (err: Error & { type?: string }) => {
      if (this.peer !== peer || this.ended) return;
      if (err.type === 'unavailable-id') {
        peer.destroy();
        if (this.freshCode) {
          // A brand new game whose code is taken: pick another.
          this.code = newCode();
          this.room = { ...this.room!, code: this.code };
          this.becomeHost(this.room, attempt + 1);
        } else if (attempt < 3) {
          // Our own old registration may still be fading (handoff, reload): try again.
          setTimeout(() => this.becomeHost(this.room!, attempt + 1), 1500);
        } else {
          // Someone else hosts this game now: join them.
          this.becomeClient();
        }
        return;
      }
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type ?? '')) {
        this.setStatus('offline');
        peer.destroy();
        setTimeout(() => this.becomeHost(this.room!, attempt), 4000);
      }
    });
    // Heartbeat: ping everyone; mark silent devices offline.
    this.beat = setInterval(() => this.hostBeat(), HEARTBEAT);
    this.changed();
  }

  private accept(conn: DataConnection) {
    const remote: Remote = { conn, device: '', seen: Date.now() };
    conn.on(
      'data',
      receiver<ToHost>((msg) => {
        remote.seen = Date.now();
        if (msg.t === 'hello') {
          remote.device = String(msg.device).slice(0, 64);
          // One live connection per device.
          for (const r of [...this.remotes]) if (r.device === remote.device && r !== remote) this.remotes.delete(r);
          this.remotes.add(remote);
          this.commit(presence(this.room!, remote.device, String(msg.name || 'Device').slice(0, 32), true), true);
          return;
        }
        if (!remote.device) return;
        if (msg.t === 'intent') this.apply(remote.device, msg.intent, (m) => send(conn, { t: 'error', message: m }));
      }),
    );
    const drop = () => {
      if (!this.remotes.has(remote)) return;
      this.remotes.delete(remote);
      if (![...this.remotes].some((r) => r.device === remote.device)) this.commit(presence(this.room!, remote.device, null, false));
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  private hostBeat() {
    const now = Date.now();
    let room = this.room!;
    for (const r of [...this.remotes]) {
      send(r.conn, { t: 'ping' });
      if (now - r.seen > SILENCE || !r.conn.open) {
        this.remotes.delete(r);
        try {
          r.conn.close();
        } catch {
          /* already gone */
        }
      }
    }
    // Devices with no live connection are offline.
    const live = new Set([this.me, ...[...this.remotes].map((r) => r.device)]);
    for (const d of room.devices) if (d.online && !live.has(d.id)) room = presence(room, d.id, null, false);
    if (room !== this.room) this.commit(room);
  }

  private apply(from: string, intent: Intent, reply: (message: string) => void) {
    if (this.role !== 'host' || !this.room) return;
    let next: Room;
    try {
      next = reduce(this.room, from, intent);
    } catch (e) {
      if (e instanceof RoomError) return reply(e.message);
      throw e;
    }
    if (intent.t === 'kick') {
      for (const r of [...this.remotes]) {
        if (r.device !== intent.device) continue;
        send(r.conn, { t: 'bye', reason: 'removed' });
        this.remotes.delete(r);
        setTimeout(() => r.conn.close(), 300);
      }
    }
    if (intent.t === 'handoff') {
      // Tell everyone (the new host takes the code), then become a client.
      this.room = next;
      for (const r of this.remotes) send(r.conn, { t: 'handoff', room: next });
      saveNet(next);
      this.changed();
      if (!this.leaving) setTimeout(() => this.becomeClient(), 600);
      return;
    }
    this.commit(next);
  }

  /** Publish a new room to everyone (host role). */
  private commit(room: Room, force = false) {
    if (!force && room === this.room && this.status !== 'online') return;
    this.room = room;
    for (const r of this.remotes) send(r.conn, { t: 'room', room });
    saveNet(room);
    this.changed();
    this.scheduleAutomatic();
  }

  /** Computer lords move after a short pause; absent lords after the grace period. */
  private scheduleAutomatic() {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
    const room = this.room;
    const g = room?.game;
    if (!room || !g || g.phase === 'over' || this.role !== 'host') return;
    const now = Date.now();
    for (const seat of [...this.autopilot]) if (!unattended(room, seat)) this.autopilot.delete(seat);
    const pending = new Set(pendingSeats(g));
    for (const seat of [...this.waitingSince.keys()]) if (!pending.has(seat)) this.waitingSince.delete(seat);
    for (const seat of pending) if (!this.waitingSince.has(seat)) this.waitingSince.set(seat, this.autopilot.has(seat) ? now - AUTOPILOT_GRACE + paceFor(g) : now);
    const computerNow = [...pending].some((seat) => room.seats[seat]?.kind === 'computer');
    let wait = computerNow ? paceFor(g) : Infinity;
    for (const seat of pending) {
      const c = room.seats[seat];
      if (c && c.kind !== 'computer' && (c.kind === 'open' || !room.devices.find((d) => d.id === c.id)?.online)) {
        wait = Math.min(wait, Math.max(300, this.waitingSince.get(seat)! + AUTOPILOT_GRACE - now));
      }
    }
    if (wait === Infinity) return;
    this.autoTimer = setTimeout(() => this.runAutomatic(), wait);
  }

  private runAutomatic() {
    this.autoTimer = null;
    const room = this.room;
    const g = room?.game;
    if (!room || !g || this.role !== 'host') return;
    const seats = automaticSeats(room, this.waitingSince, Date.now(), AUTOPILOT_GRACE);
    for (const seat of seats) {
      if (unattended(room, seat)) this.autopilot.add(seat);
      const action = chooseAction(g, seat);
      if (!action) continue;
      let res = tryApply(g, action);
      if (res.error) {
        const fallback: Action = g.phase === 'trade' ? { type: 'ready', player: seat, ready: true } : g.phase === 'conquest' && g.conquest.plan ? { type: 'cancel', player: seat } : { type: 'done', player: seat };
        res = tryApply(g, fallback);
        if (res.error) continue;
      }
      this.commit({ ...room, game: res.state, rev: room.rev + 1 });
      return;
    }
    this.scheduleAutomatic();
  }

  // =========================================================================
  // Client role

  private becomeClient() {
    if (this.ended) return;
    this.teardown();
    this.role = 'client';
    this.setStatus(this.everJoined ? 'reconnecting' : 'connecting');
    const peer = new Peer(peerOptions());
    this.peer = peer;
    peer.on('open', () => this.peer === peer && this.connect());
    peer.on('error', (err: Error & { type?: string }) => {
      if (this.peer !== peer || this.ended) return;
      if (err.type === 'peer-unavailable') return this.hostMissing();
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type ?? '')) {
        this.setStatus('offline');
        setTimeout(() => this.peer === peer && this.becomeClient(), 4000);
      }
    });
    this.beat = setInterval(() => this.clientBeat(), HEARTBEAT);
    this.changed();
  }

  private connect() {
    if (this.ended || !this.peer || this.role !== 'client') return;
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true, serialization: 'raw' });
    this.conn = conn;
    this.connectStarted = Date.now();
    conn.on('open', () => {
      if (this.conn !== conn) return;
      this.lastHeard = Date.now();
      this.hostLostAt = 0;
      this.retries = 0;
      send(conn, { t: 'hello', device: this.me, name: this.name });
    });
    conn.on(
      'data',
      receiver<ToClient>((msg) => {
        if (this.conn !== conn) return;
        this.lastHeard = Date.now();
        switch (msg.t) {
          case 'room':
            this.everJoined = true;
            if (newer(this.room, msg.room) || this.status !== 'online') {
              this.room = msg.room;
              this.code = msg.room.code;
              saveNet(msg.room);
            }
            this.setStatus('online');
            this.changed();
            break;
          case 'handoff':
            this.room = msg.room;
            saveNet(msg.room);
            this.changed();
            if (msg.room.host === this.me) setTimeout(() => this.becomeHost(this.room!), 300);
            else this.lost();
            break;
          case 'error':
            this.error(msg.message);
            break;
          case 'bye':
            this.ended = true;
            saveNet(null);
            this.teardown();
            this.setStatus(msg.reason === 'removed' ? 'removed' : 'closed');
            break;
        }
      }),
    );
    const gone = () => this.conn === conn && this.lost();
    conn.on('close', gone);
    conn.on('error', gone);
  }

  private clientBeat() {
    if (this.role !== 'client') return;
    if (this.conn?.open) {
      send(this.conn, { t: 'ping' });
      if (Date.now() - this.lastHeard > SILENCE) this.lost();
    } else if (this.conn && Date.now() - this.connectStarted > CONNECT_TIMEOUT) {
      // The code is registered but nobody answers (a host that just vanished).
      this.lost();
    }
  }

  /** The host went quiet or the connection broke: reconnect (and maybe take over). */
  private lost() {
    if (this.ended || this.role !== 'client') return;
    const conn = this.conn;
    this.conn = null;
    try {
      conn?.close();
    } catch {
      /* gone */
    }
    if (!this.hostLostAt) this.hostLostAt = Date.now();
    if (this.everJoined) {
      if (this.status === 'online') this.error('Reconnecting…');
      this.setStatus('reconnecting');
    }
    this.retries++;
    setTimeout(() => this.role === 'client' && !this.ended && (this.peer && !this.peer.destroyed && !this.peer.disconnected ? this.connect() : this.becomeClient()), Math.min(3000, 600 * this.retries));
  }

  /** Nobody holds the code right now. */
  private hostMissing() {
    if (!this.hostLostAt) this.hostLostAt = Date.now();
    if (!this.room) {
      // Never joined: probably a wrong code.
      if (++this.retries >= 3) {
        this.ended = true;
        this.teardown();
        this.setStatus('not-found');
        return;
      }
      setTimeout(() => this.connect(), 1200);
      return;
    }
    // We have the game: if it is our turn in the succession order, host it.
    const order = succession(this.room).filter((id) => id !== this.room!.host);
    const rank = Math.max(0, order.indexOf(this.me));
    const solo = !order.length || this.room.devices.every((d) => d.id === this.me || !d.online);
    const waited = Date.now() - this.hostLostAt;
    if (solo || this.room.host === this.me || waited >= 2000 + rank * FAILOVER_STEP) {
      this.becomeHost(takeOver(this.room, this.me));
      return;
    }
    this.lost();
  }
}
