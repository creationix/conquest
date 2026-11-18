// Playing on several devices with a game code, no server to set up.
//
// The host's device runs the game (like pass and play) and also acts as the
// "server" for the other devices. Devices find each other through a public
// PeerJS signaling service using the game code, then talk directly over a
// WebRTC data channel (or through a relay when a network blocks that).
//
// Every device, the host included, talks to the game through a Link, using
// the same messages the old LAN server used (see engine/protocol.ts).

import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import { GameHost } from '../engine/host.ts';
import type { ClientMessage, Lobby, RoomView, ServerMessage } from '../engine/protocol.ts';
import { createGame } from '../engine/rules.ts';
import { MAX_PLAYERS, type Action, type GameState } from '../engine/types.ts';
import { clientId, deviceName } from './session.ts';

// ---------------------------------------------------------------------------
// Signaling configuration. Override with ?signal=host:port[/path] (testing,
// or your own PeerJS server).

const PREFIX = 'conquest-v1-';
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels: no accidental words

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
    /* use the default public service */
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
// Messages are JSON split into small chunks: older Safari limits the size of
// a single WebRTC message.

const CHUNK = 15000;

function sendChunked(conn: DataConnection, msg: unknown) {
  const text = JSON.stringify(msg);
  if (text.length <= CHUNK) {
    conn.send(text);
    return;
  }
  const id = Math.random().toString(36).slice(2, 8);
  const n = Math.ceil(text.length / CHUNK);
  for (let i = 0; i < n; i++) conn.send(`#${id}:${i}:${n}:` + text.slice(i * CHUNK, (i + 1) * CHUNK));
}

function receiver(onMessage: (msg: unknown) => void) {
  const parts = new Map<string, string[]>();
  return (data: unknown) => {
    if (typeof data !== 'string') return;
    if (data[0] !== '#') {
      try {
        onMessage(JSON.parse(data));
      } catch {
        /* ignore malformed */
      }
      return;
    }
    const m = /^#(\w+):(\d+):(\d+):/.exec(data);
    if (!m) return;
    const [head, id, i, n] = m;
    const list = parts.get(id) ?? new Array<string>(Number(n));
    list[Number(i)] = data.slice(head.length);
    parts.set(id, list);
    if (list.filter((x) => x !== undefined).length === Number(n)) {
      parts.delete(id);
      try {
        onMessage(JSON.parse(list.join('')));
      } catch {
        /* ignore malformed */
      }
    }
  };
}

// ---------------------------------------------------------------------------
// What the game screens talk to.

export interface Link {
  id: string;
  name: string;
  room: RoomView | null;
  connected: boolean;
  on(fn: (msg: ServerMessage) => void): () => void;
  send(msg: ClientMessage): void;
  close(): void;
}

class Emitter {
  private listeners = new Set<(msg: ServerMessage) => void>();
  on(fn: (msg: ServerMessage) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(msg: ServerMessage) {
    for (const fn of this.listeners) fn(msg);
  }
}

// ---------------------------------------------------------------------------
// Host

interface Saved {
  code: string;
  host: string;
  lobby: Lobby;
  seats: Record<number, string>;
  names: Record<string, string>;
  state: GameState | null;
}

const SAVE_KEY = 'conquest-hosted-v1';

export function loadHosted(): Saved | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null') as Saved | null;
    return saved && saved.code && (!saved.state || saved.state.phase !== 'over') ? saved : null;
  } catch {
    return null;
  }
}

function clearHosted() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

interface Remote {
  conn: DataConnection;
  clientId: string;
}

export type HostStatus = 'connecting' | 'online' | 'offline';

/** Runs the lobby and the game for everyone; the host's own screen uses `link`. */
export class PeerHost {
  code: string;
  status: HostStatus = 'connecting';
  onStatus: (status: HostStatus, detail?: string) => void = () => {};
  readonly link: Link;
  private hostId = clientId();
  private lobby: Lobby;
  private seats: Record<number, string>;
  private names: Record<string, string>;
  private game: GameHost | null = null;
  private peer: Peer | null = null;
  private remotes = new Set<Remote>();
  private local = new Emitter();
  private closed = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private resumed: boolean;

  constructor(lobby: Lobby, saved: Saved | null = null) {
    this.resumed = !!saved;
    this.code = saved?.code ?? newCode();
    this.lobby = saved?.lobby ?? lobby;
    this.seats = saved?.seats ?? {};
    this.names = saved?.names ?? {};
    this.names[this.hostId] = deviceName();
    if (saved?.state) this.attach(saved.state);
    const host = this;
    const local = this.local;
    this.link = {
      id: this.hostId,
      get name() {
        return deviceName();
      },
      get room() {
        return host.view();
      },
      get connected() {
        return true;
      },
      on: (fn) => local.on(fn),
      // Asynchronous, like a real network, so screens see replies after dispatching.
      send: (msg) => setTimeout(() => host.handle(host.hostId, msg, (m) => local.emit(m)), 0),
      close: () => host.close(),
    };
    this.listen();
  }

  private listen(attempt = 0) {
    if (this.closed) return;
    this.setStatus('connecting');
    const peer = new Peer(PREFIX + this.code, peerOptions());
    this.peer = peer;
    peer.on('open', () => {
      this.setStatus('online');
      this.save();
    });
    peer.on('connection', (conn) => this.accept(conn));
    peer.on('disconnected', () => {
      // Lost the signaling service: existing players stay connected; reconnect for new ones.
      if (!this.closed && !peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 2000);
    });
    peer.on('error', (err: Error & { type?: string }) => {
      if (this.closed) return;
      if (err.type === 'unavailable-id') {
        peer.destroy();
        if (this.resumed || this.game) {
          // Our old connection has not timed out yet: keep the code, try again soon.
          this.setStatus('connecting', 'Reclaiming the game code…');
          setTimeout(() => this.listen(attempt + 1), Math.min(10000, 2000 + attempt * 1000));
        } else {
          this.code = newCode();
          this.listen(attempt + 1);
        }
        return;
      }
      if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed') {
        this.setStatus('offline', 'Cannot reach the game-code service. Check the internet connection.');
        peer.destroy();
        setTimeout(() => this.listen(attempt + 1), Math.min(15000, 3000 + attempt * 2000));
      }
    });
  }

  private setStatus(status: HostStatus, detail?: string) {
    this.status = status;
    this.onStatus(status, detail);
  }

  private accept(conn: DataConnection) {
    const remote: Remote = { conn, clientId: '' };
    const reply = (m: ServerMessage) => {
      if (conn.open) sendChunked(conn, m);
    };
    conn.on(
      'data',
      receiver((msg) => {
        const m = msg as ClientMessage;
        if (m.t === 'hello') {
          remote.clientId = String(m.clientId).slice(0, 64);
          this.remotes.add(remote);
        }
        if (!remote.clientId) return;
        this.handle(remote.clientId, m, reply);
      }),
    );
    const drop = () => {
      this.remotes.delete(remote);
      this.broadcastRoom();
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  // Room logic -----------------------------------------------------------

  private view(): RoomView {
    const online = new Set([this.hostId, ...[...this.remotes].map((r) => r.clientId)]);
    const ids = new Set([...Object.values(this.seats), ...online]);
    return {
      id: this.code,
      name: `${this.names[this.hostId] || 'Host'}'s game`,
      host: this.hostId,
      lobby: this.lobby,
      seats: this.seats,
      clients: [...ids].map((id) => ({ id, name: this.names[id] || 'Device', online: online.has(id) })),
      state: this.game?.state ?? null,
    };
  }

  private everyone(msg: ServerMessage) {
    this.local.emit(msg);
    for (const r of this.remotes) if (r.conn.open) sendChunked(r.conn, msg);
  }

  private broadcastRoom() {
    this.everyone({ t: 'room', room: this.view() });
    this.save();
  }

  private attach(state: GameState) {
    this.game?.stop();
    const g = new GameHost(state);
    g.subscribe((s) => {
      this.everyone({ t: 'state', state: s });
      this.save();
    });
    this.game = g;
  }

  private handle(from: string, msg: ClientMessage, reply: (m: ServerMessage) => void) {
    const isHost = from === this.hostId;
    const error = (message: string) => reply({ t: 'error', message });
    switch (msg.t) {
      case 'hello':
        this.names[from] = String(msg.name || 'Device').slice(0, 32);
        reply({ t: 'welcome', serverName: this.code });
        this.broadcastRoom();
        return;
      case 'lobby': {
        if (!isHost || this.game) return error('Only the host can change the setup');
        const l = msg.lobby;
        if (!l || !Array.isArray(l.players) || l.players.length < 2 || l.players.length > MAX_PLAYERS) return error(`Choose 2 to ${MAX_PLAYERS} players`);
        this.lobby = l;
        for (const k of Object.keys(this.seats)) {
          const seat = Number(k);
          if (!l.players[seat] || l.players[seat].ai) delete this.seats[seat];
        }
        this.broadcastRoom();
        return;
      }
      case 'claim': {
        const p = this.lobby.players[msg.seat];
        if (!p || p.ai) return error('No such seat');
        if (msg.claim) this.seats[msg.seat] = from;
        else if (this.seats[msg.seat] === from || isHost) delete this.seats[msg.seat];
        this.broadcastRoom();
        return;
      }
      case 'start': {
        if (!isHost) return error('Only the host can start');
        if (this.game) return error('Already started');
        // Seats nobody claimed are played on the host's device.
        this.lobby.players.forEach((p, i) => {
          if (!p.ai && !this.seats[i]) this.seats[i] = this.hostId;
        });
        try {
          this.attach(createGame(this.lobby.settings, this.lobby.players));
        } catch (e) {
          return error((e as Error).message);
        }
        this.broadcastRoom();
        return;
      }
      case 'action': {
        if (!this.game) return error('The game has not started');
        const action = msg.action as Action;
        const seat = action?.player;
        const holder = this.seats[seat];
        if (holder && holder !== from) return error('That seat belongs to another device');
        if (this.game.state.players[seat]?.ai && action.type !== 'setAi') return error('That is a computer player');
        const err = this.game.dispatch(action);
        if (err) error(err);
        return;
      }
      case 'leave':
        if (isHost) this.close();
        return;
      case 'close':
        if (isHost) this.close();
        return;
    }
  }

  private save() {
    if (this.saveTimer || this.closed) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.closed) return;
      const state = this.game?.state ?? null;
      if (state?.phase === 'over') return clearHosted();
      const data: Saved = { code: this.code, host: this.hostId, lobby: this.lobby, seats: this.seats, names: this.names, state };
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      } catch {
        /* storage may be unavailable */
      }
    }, 300);
  }

  /** Close the game for everyone. */
  close() {
    if (this.closed) return;
    for (const r of this.remotes) if (r.conn.open) sendChunked(r.conn, { t: 'left' } satisfies ServerMessage);
    this.closed = true;
    clearHosted();
    this.game?.stop();
    setTimeout(() => this.peer?.destroy(), 300);
  }

  /** Leave without closing: the game is saved and can be resumed with the same code. */
  suspend() {
    this.closed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const state = this.game?.state ?? null;
    if (state && state.phase !== 'over') {
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify({ code: this.code, host: this.hostId, lobby: this.lobby, seats: this.seats, names: this.names, state } satisfies Saved));
      } catch {
        /* ignore */
      }
    } else if (!state) clearHosted();
    this.game?.stop();
    this.peer?.destroy();
  }
}

// ---------------------------------------------------------------------------
// Joining

export type JoinStatus = 'connecting' | 'connected' | 'reconnecting' | 'not-found' | 'offline' | 'closed';

const JOIN_KEY = 'conquest-joined';

export function rememberedJoin(): string | null {
  try {
    return sessionStorage.getItem(JOIN_KEY);
  } catch {
    return null;
  }
}

/** A device joining someone else's game by its code. */
export class PeerClient implements Link {
  id = clientId();
  name = deviceName();
  room: RoomView | null = null;
  connected = false;
  status: JoinStatus = 'connecting';
  onStatus: (status: JoinStatus) => void = () => {};
  private emitter = new Emitter();
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private closed = false;
  private everConnected = false;
  private retries = 0;

  code: string;
  constructor(code: string) {
    this.code = code;
    try {
      sessionStorage.setItem(JOIN_KEY, code);
    } catch {
      /* ignore */
    }
    this.start();
  }

  private setStatus(s: JoinStatus) {
    this.status = s;
    this.onStatus(s);
  }

  private start() {
    if (this.closed) return;
    const peer = new Peer(peerOptions());
    this.peer = peer;
    peer.on('open', () => this.connect());
    peer.on('error', (err: Error & { type?: string }) => {
      if (this.closed) return;
      if (err.type === 'peer-unavailable') {
        // The host is not there (wrong code, or the host is reloading).
        if (!this.everConnected && this.retries >= 2) {
          this.setStatus('not-found');
          return;
        }
        this.retry();
        return;
      }
      if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed') {
        this.setStatus('offline');
        peer.destroy();
        this.retry(true);
      }
    });
  }

  private connect() {
    if (this.closed || !this.peer) return;
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true, serialization: 'raw' });
    this.conn = conn;
    conn.on('open', () => {
      this.connected = true;
      this.everConnected = true;
      this.retries = 0;
      this.setStatus('connected');
      sendChunked(conn, { t: 'hello', clientId: this.id, name: this.name } satisfies ClientMessage);
    });
    conn.on(
      'data',
      receiver((msg) => {
        const m = msg as ServerMessage;
        if (m.t === 'room') this.room = m.room;
        else if (m.t === 'state' && this.room) this.room = { ...this.room, state: m.state };
        else if (m.t === 'left') {
          this.setStatus('closed');
          this.close();
        }
        this.emitter.emit(m);
      }),
    );
    const lost = () => {
      if (this.conn !== conn) return;
      this.connected = false;
      if (!this.closed) {
        this.emitter.emit({ t: 'error', message: 'Reconnecting…' });
        this.retry();
      }
    };
    conn.on('close', lost);
    conn.on('error', lost);
  }

  private retry(fresh = false) {
    if (this.closed) return;
    this.retries++;
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');
    setTimeout(
      () => {
        if (this.closed) return;
        if (fresh || !this.peer || this.peer.destroyed || this.peer.disconnected) {
          this.peer?.destroy();
          this.start();
        } else this.connect();
      },
      Math.min(8000, 1000 * this.retries),
    );
  }

  on(fn: (msg: ServerMessage) => void) {
    return this.emitter.on(fn);
  }

  send(msg: ClientMessage) {
    if (this.conn?.open) sendChunked(this.conn, msg);
  }

  close() {
    this.closed = true;
    try {
      sessionStorage.removeItem(JOIN_KEY);
    } catch {
      /* ignore */
    }
    this.connected = false;
    setTimeout(() => this.peer?.destroy(), 200);
  }
}
