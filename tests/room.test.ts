import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automaticSeats, createRoom, newer, presence, reduce, RoomError, succession, takeOver, unattended, type Room } from '../src/net/room.ts';
import { defaultSettings, actors } from '../src/engine/rules.ts';
import { chooseAction } from '../src/engine/ai.ts';
import type { Lobby } from '../src/engine/protocol.ts';

const lobby = (): Lobby => ({
  settings: { ...defaultSettings(), seed: 'ROOM', selection: 'deal', level: 2 },
  players: [
    { name: 'Dad', color: 1, ai: false },
    { name: 'Kid', color: 0, ai: false },
    { name: 'Bot', color: 2, ai: true },
  ],
});

function started(): Room {
  let r = createRoom('ABCD', { id: 'host', name: 'iPad', online: true }, lobby());
  r = presence(r, 'kid', "Kid's phone", true);
  r = reduce(r, 'host', { t: 'seat', seat: 0, to: 'me' });
  r = reduce(r, 'kid', { t: 'seat', seat: 1, to: 'me' });
  return reduce(r, 'host', { t: 'start' });
}

const refuses = (fn: () => unknown, msg?: RegExp) => assert.throws(fn, (e) => e instanceof RoomError && (!msg || msg.test(e.message)));

test('only the host changes the setup and starts', () => {
  const r = presence(createRoom('ABCD', { id: 'host', name: 'iPad', online: true }, lobby()), 'kid', 'phone', true);
  refuses(() => reduce(r, 'kid', { t: 'setup', lobby: lobby() }), /host/);
  refuses(() => reduce(r, 'kid', { t: 'start' }), /host/);
  const s = reduce(r, 'host', { t: 'start' });
  assert.ok(s.game);
  // Unclaimed people seats go to the host's device; the computer keeps its seat.
  assert.deepEqual(s.seats, [{ kind: 'device', id: 'host' }, { kind: 'device', id: 'host' }, { kind: 'computer' }]);
});

test('devices only move their own lords', () => {
  const r = started();
  const kidMove = actors(r.game!).includes(1) ? chooseAction(r.game!, 1) : null;
  refuses(() => reduce(r, 'host', { t: 'action', action: { type: 'done', player: 1 } }), /not playing/);
  if (kidMove) assert.ok(reduce(r, 'kid', { t: 'action', action: kidMove }).game);
});

test('a newcomer can take a computer lord or an offline lord, not an active one', () => {
  let r = presence(started(), 'gma', "Grandma's laptop", true);
  refuses(() => reduce(r, 'gma', { t: 'seat', seat: 1, to: 'me' }), /Someone else/);
  const took = reduce(r, 'gma', { t: 'seat', seat: 2, to: 'me' });
  assert.deepEqual(took.seats[2], { kind: 'device', id: 'gma' });
  assert.equal(took.game!.players[2].ai, false, 'engine flag follows the seat');
  r = presence(r, 'kid', null, false);
  assert.ok(unattended(r, 1));
  assert.deepEqual(reduce(r, 'gma', { t: 'seat', seat: 1, to: 'me' }).seats[1], { kind: 'device', id: 'gma' });
});

test('the host can hand lords to the computer and remove devices', () => {
  let r = reduce(started(), 'host', { t: 'seat', seat: 1, to: 'computer' });
  assert.equal(r.game!.players[1].ai, true);
  r = reduce(r, 'kid', { t: 'seat', seat: 1, to: 'me' }); // kid takes it back (it is computer now)
  r = reduce(r, 'host', { t: 'kick', device: 'kid' });
  assert.equal(r.devices.some((d) => d.id === 'kid'), false);
  assert.deepEqual(r.seats[1], { kind: 'computer' });
  refuses(() => reduce(r, 'kid', { t: 'seat', seat: 0, to: 'computer' }), /host/);
});

test('leaving hands your lords to the computer', () => {
  const r = reduce(started(), 'kid', { t: 'leave' });
  assert.deepEqual(r.seats[1], { kind: 'computer' });
  assert.equal(r.devices.find((d) => d.id === 'kid')!.online, false);
});

test('handoff and takeover change the host and bump the epoch', () => {
  const r = started();
  refuses(() => reduce(r, 'kid', { t: 'handoff', to: 'kid' }), /host/);
  const h = reduce(r, 'host', { t: 'handoff', to: 'kid' });
  assert.equal(h.host, 'kid');
  assert.ok(newer(r, h));
  assert.deepEqual(succession(r), ['kid']);
  const t = takeOver(r, 'kid');
  assert.equal(t.host, 'kid');
  assert.equal(t.devices.find((d) => d.id === 'host')!.online, false, 'old host marked offline');
  assert.ok(t.epoch > r.epoch);
});

test('autopilot plays computer lords at once and offline lords after the grace period', () => {
  let r = started();
  // Find whoever the game waits on and make their device go offline.
  const waiting = actors(r.game!);
  const seat = waiting[0];
  const holder = r.seats[seat];
  if (holder.kind === 'device') r = presence(r, holder.id, null, false);
  const since = new Map([[seat, 1000]]);
  const auto = automaticSeats(r, since, 2000, 25000);
  assert.equal(auto.includes(seat), holder.kind === 'computer');
  assert.ok(automaticSeats(r, since, 1000 + 25000, 25000).includes(seat));
});
