// The shared world of a network game, as one JSON value, and the only place
// its rules live. Pure: no networking, no timers. See docs/network.md.

import type { Lobby } from '../engine/protocol.ts';
import { actors, createGame, tryApply } from '../engine/rules.ts';
import { MAX_PLAYERS, type Action, type GameState } from '../engine/types.ts';

export interface Device {
  id: string;
  name: string;
  online: boolean;
}

export type Controller = { kind: 'device'; id: string } | { kind: 'computer' } | { kind: 'open' };

export interface Room {
  v: 2;
  code: string;
  /** Device currently hosting. */
  host: string;
  /** Number of host changes so far. */
  epoch: number;
  /** Increases with every change. */
  rev: number;
  /** Everyone who has joined, in join order (also the succession order). */
  devices: Device[];
  /** One controller per lord (lobby player index). */
  seats: Controller[];
  lobby: Lobby;
  game: GameState | null;
}

export type Intent =
  | { t: 'setup'; lobby: Lobby }
  | { t: 'start' }
  | { t: 'seat'; seat: number; to: 'me' | 'computer' | 'open' }
  | { t: 'action'; action: Action }
  | { t: 'kick'; device: string }
  | { t: 'handoff'; to: string }
  | { t: 'leave' };

export class RoomError extends Error {}
const fail = (m: string): never => {
  throw new RoomError(m);
};

/** Is `b` newer than `a`? */
export function newer(a: Room | null, b: Room): boolean {
  return !a || b.epoch > a.epoch || (b.epoch === a.epoch && b.rev > a.rev);
}

export function seatsFor(lobby: Lobby): Controller[] {
  return lobby.players.map((p) => (p.ai ? { kind: 'computer' } : { kind: 'open' }));
}

export function createRoom(code: string, host: Device, lobby: Lobby): Room {
  return { v: 2, code, host: host.id, epoch: 0, rev: 1, devices: [{ ...host, online: true }], seats: seatsFor(lobby), lobby, game: null };
}

export function device(room: Room, id: string): Device | undefined {
  return room.devices.find((d) => d.id === id);
}

export function isOnline(room: Room, id: string): boolean {
  return !!device(room, id)?.online;
}

/** The device that plays a lord, if it is a device. */
export function controllerOf(room: Room, seat: number): string | null {
  const c = room.seats[seat];
  return c?.kind === 'device' ? c.id : null;
}

/** A lord nobody at the table is playing right now (open, or its device is offline). */
export function unattended(room: Room, seat: number): boolean {
  const c = room.seats[seat];
  return !c || c.kind === 'open' || (c.kind === 'device' && !isOnline(room, c.id));
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** Make the engine's per-player computer flag match the seat. */
function syncAi(room: Room, seat: number) {
  const g = room.game;
  if (!g) return;
  const p = g.players[seat];
  const ai = room.seats[seat].kind === 'computer';
  if (!p || !p.alive || p.ai === ai) return;
  const r = tryApply(g, { type: 'setAi', player: seat, ai });
  if (!r.error) room.game = r.state;
}

function setSeat(room: Room, seat: number, c: Controller) {
  room.seats[seat] = c;
  syncAi(room, seat);
}

/** Device presence changes (joining, heartbeats): not an intent, done by the host. */
export function presence(room: Room, id: string, name: string | null, online: boolean): Room {
  const r = clone(room);
  const d = device(r, id);
  if (d) {
    if (d.online === online && (name === null || d.name === name)) return room;
    d.online = online;
    if (name) d.name = name;
  } else {
    if (!online) return room;
    r.devices.push({ id, name: name || 'Device', online: true });
  }
  r.rev++;
  return r;
}

/** Validate and apply an intent from a device. Throws RoomError on refusal. */
export function reduce(room: Room, from: string, intent: Intent): Room {
  const r = clone(room);
  const isHost = from === r.host;
  const game = r.game;
  switch (intent.t) {
    case 'setup': {
      if (!isHost) fail('Only the host can change the setup');
      if (game) fail('The game has started');
      const l = intent.lobby;
      if (!l || !Array.isArray(l.players) || l.players.length < 2 || l.players.length > MAX_PLAYERS) fail(`Choose 2 to ${MAX_PLAYERS} players`);
      // Keep claims on seats that are still people.
      r.seats = l.players.map((p, i) => (p.ai ? { kind: 'computer' } : r.seats[i]?.kind === 'device' ? r.seats[i] : { kind: 'open' }));
      r.lobby = l;
      break;
    }
    case 'start': {
      if (!isHost) fail('Only the host can start');
      if (game) fail('Already started');
      // Lords nobody claimed are played on the host's device (pass and play).
      r.seats = r.seats.map((c) => (c.kind === 'open' ? { kind: 'device', id: r.host } : c));
      r.game = createGame(r.lobby.settings, r.lobby.players);
      break;
    }
    case 'seat': {
      const seat = intent.seat;
      if (!r.seats[seat]) fail('No such lord');
      if (game && !game.players[seat]?.alive) fail('That lord is out of the game');
      const current = r.seats[seat];
      const mine = current.kind === 'device' && current.id === from;
      if (intent.to === 'me') {
        if (!game && r.lobby.players[seat]?.ai) fail('That lord is a computer player');
        // Take a lord that is free, computer-played, or whose device is gone; the host may take any.
        if (!mine && !isHost && current.kind === 'device' && isOnline(r, current.id)) fail('Someone else is playing that lord');
        setSeat(r, seat, { kind: 'device', id: from });
      } else {
        if (!mine && !isHost) fail('Only that lord’s player or the host can do that');
        if (!game && intent.to === 'computer' && !r.lobby.players[seat]?.ai) {
          // Before the start, giving up a seat just frees it.
          setSeat(r, seat, { kind: 'open' });
        } else setSeat(r, seat, intent.to === 'computer' ? { kind: 'computer' } : { kind: 'open' });
      }
      break;
    }
    case 'action': {
      if (!game) fail('The game has not started');
      const seat = intent.action?.player;
      const c = r.seats[seat];
      if (!c || c.kind !== 'device' || c.id !== from) fail('You are not playing that lord');
      const res = tryApply(game!, intent.action);
      if (res.error) fail(res.error);
      r.game = res.state;
      // A lord handed to the computer from inside the game.
      if (intent.action.type === 'setAi') r.seats[seat] = intent.action.ai ? { kind: 'computer' } : { kind: 'device', id: from };
      break;
    }
    case 'kick': {
      if (!isHost) fail('Only the host can remove devices');
      if (intent.device === r.host) fail('The host cannot remove itself');
      r.devices = r.devices.filter((d) => d.id !== intent.device);
      r.seats.forEach((c, i) => {
        if (c.kind === 'device' && c.id === intent.device) setSeat(r, i, game ? { kind: 'computer' } : { kind: 'open' });
      });
      break;
    }
    case 'leave': {
      r.seats.forEach((c, i) => {
        if (c.kind === 'device' && c.id === from) setSeat(r, i, game ? { kind: 'computer' } : { kind: 'open' });
      });
      const d = device(r, from);
      if (d) d.online = false;
      break;
    }
    case 'handoff': {
      if (!isHost) fail('Only the host can hand over hosting');
      if (!isOnline(r, intent.to) || intent.to === r.host) fail('That device is not here');
      r.host = intent.to;
      r.epoch++;
      break;
    }
    default:
      fail('Unknown request');
  }
  r.rev++;
  return r;
}

/** A device that took over hosting (failover): mark the old host offline. */
export function takeOver(room: Room, newHost: string): Room {
  const r = clone(room);
  const old = device(r, r.host);
  if (old && old.id !== newHost) old.online = false;
  const me = device(r, newHost);
  if (me) me.online = true;
  r.host = newHost;
  r.epoch++;
  r.rev++;
  return r;
}

/** Devices that would take over if the host vanished, best first. */
export function succession(room: Room): string[] {
  return room.devices.filter((d) => d.id !== room.host && d.online).map((d) => d.id);
}

/**
 * Automatic moves the host should make now: computer lords, and lords whose
 * device is offline or that nobody plays once they have waited long enough.
 */
export function automaticSeats(room: Room, waitingSince: Map<number, number>, now: number, grace: number): number[] {
  const g = room.game;
  if (!g || g.phase === 'over') return [];
  const out: number[] = [];
  for (const seat of pendingSeats(g)) {
    const c = room.seats[seat];
    if (!c) continue;
    if (c.kind === 'computer') out.push(seat);
    else if (unattended(room, seat) && now - (waitingSince.get(seat) ?? now) >= grace) out.push(seat);
  }
  return out;
}

/** Lords the game is waiting on. */
export function pendingSeats(g: GameState): number[] {
  return actors(g);
}
