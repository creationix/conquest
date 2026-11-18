import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, generateMap, type MapData } from '../src/engine/map.ts';
import { Rng } from '../src/engine/rng.ts';
import {
  actors,
  apply,
  attackStrength,
  createGame,
  currentPlayer,
  defaultSettings,
  defense,
  emptyStock,
  freeBerths,
  tryApply,
} from '../src/engine/rules.ts';
import { chooseAction } from '../src/engine/ai.ts';
import type { GameState, PlayerSetup, Settings } from '../src/engine/types.ts';

const humans = (n: number, ai = false): PlayerSetup[] =>
  Array.from({ length: n }, (_, i) => ({ name: 'P' + i, color: i, ai }));

function settings(over: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), seed: 'TEST', ...over };
}

/**
 * A hand-made map, one character per cell: letters are territories (A = 0),
 * dots are water.
 *
 *   AABBCC..
 *   AABBCC.E
 *   DDDDCC.E
 */
function textMap(rows: string[]): MapData {
  const height = rows.length;
  const width = rows[0].length;
  const cells: number[] = [];
  for (const row of rows) for (const ch of row) cells.push(ch === '.' ? -1 : ch.charCodeAt(0) - 65);
  return { name: 'test', width, height, cells };
}

function custom(map: MapData, owners: number[], players = 3, over: Partial<Settings> = {}): GameState {
  const s = createGame(settings({ selection: 'deal', ...over }), humans(players));
  s.map = map;
  const n = analyze(map).territories.length;
  s.territories = Array.from({ length: n }, (_, i) => ({
    owner: owners[i] ?? -1,
    site: null,
    horse: false,
    weapon: false,
    city: false,
    boats: [],
  }));
  s.players.forEach((p) => {
    // Everyone starts with a stockpile in their first territory.
    p.stockpile = s.territories.findIndex((t) => t.owner === p.id);
    p.stock = emptyStock();
  });
  s.phase = 'conquest';
  s.order = [0, 1, 2].slice(0, players);
  s.turn = 0;
  s.year = 2;
  s.conquest = { attacksLeft: 2, usedStockpileMove: false, plan: null };
  s.placing = [];
  return s;
}

test('same seed gives the same game', () => {
  const a = createGame(settings(), humans(3));
  const b = createGame(settings(), humans(3));
  assert.deepEqual(a, b);
  const c = createGame(settings({ seed: 'OTHER' }), humans(3));
  assert.notDeepEqual(a.map.cells, c.map.cells);
});

test('maps without boats are one continent', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const map = generateMap(new Rng(seed), { width: 36, height: 24, territories: 34, land: 0.52, connected: true });
    const info = analyze(map);
    const seen = new Set([0]);
    const stack = [0];
    while (stack.length) for (const n of info.territories[stack.pop()!].neighbors) if (!seen.has(n)) (seen.add(n), stack.push(n));
    assert.equal(seen.size, info.territories.length, `seed ${seed} is connected`);
  }
});

test('force counts follow the manual', () => {
  // A B C in a row, D below all of them.
  const map = textMap(['AABBCC', 'AABBCC', 'DDDDDD']);
  const s = custom(map, [0, 1, 0, 0]);
  // Defender B (player 1) alone: 1 for itself.
  assert.equal(defense(s, 1), 1);
  s.territories[1].weapon = true;
  s.territories[1].city = true;
  assert.equal(defense(s, 1), 1 + 3 + 2);
  // Attacker bears from A, C, D: 3 territories, plus a horse in A and a weapon in D.
  s.territories[0].horse = true;
  s.territories[3].weapon = true;
  assert.equal(attackStrength(s, 0, 1, null), 3 + 1 + 3);
});

test('low chance: ties go to the attacker, hopeless attacks are refused', () => {
  const map = textMap(['AABB', 'AABB']);
  const s = custom(map, [0, 1], 2, { chance: 'low' });
  // 1 vs 1: tie, attacker wins.
  let next = apply(s, { type: 'plan', player: 0, target: 1, force: null });
  next = apply(next, { type: 'attack', player: 0 });
  assert.equal(next.territories[1].owner, 0);
  assert.equal(next.winner, 0, 'player 1 lost everything');

  s.territories[1].weapon = true;
  const r = tryApply(s, { type: 'plan', player: 0, target: 1, force: null });
  assert.equal(r.error, 'Attack will fail!');
});

test('capturing a stockpile takes the treasure', () => {
  const map = textMap(['AABBCC']);
  const s = custom(map, [0, 1, 1], 2, { chance: 'low' });
  s.players[1].stockpile = 1;
  s.players[1].stock = { gold: 3, iron: 1, coal: 0, timber: 2 };
  s.players[0].stockpile = 0;
  s.territories[0].weapon = true;
  let next = apply(s, { type: 'plan', player: 0, target: 1, force: null });
  next = apply(next, { type: 'attack', player: 0 });
  assert.equal(next.territories[1].owner, 0);
  assert.deepEqual(next.players[0].stock, { gold: 3, iron: 1, coal: 0, timber: 2 });
  assert.deepEqual(next.players[1].stock, emptyStock());
  assert.equal(next.players[1].stockpile, -1);
});

test('a looted lord places a new stockpile at the start of their next turn, for free', () => {
  const map = textMap(['AABBCC']);
  const s = custom(map, [0, 1, 1], 2, { chance: 'low' });
  s.players[0].stockpile = 0;
  s.players[1].stockpile = 1;
  s.players[1].stock.gold = 5;
  s.territories[0].weapon = true;
  let next = apply(apply(s, { type: 'plan', player: 0, target: 1, force: null }), { type: 'attack', player: 0 });
  assert.equal(next.players[0].stock.gold, 5);
  assert.equal(next.players[1].stockpile, -1);
  // The attacker carries on undisturbed, then ends the turn.
  assert.deepEqual(actors(next), [0]);
  next = apply(next, { type: 'done', player: 0 });
  assert.equal(currentPlayer(next), 1);
  assert.equal(tryApply(next, { type: 'done', player: 1 }).error, 'First choose where to keep your new stockpile');
  next = apply(next, { type: 'placeStockpile', player: 1, territory: 2 });
  assert.equal(next.players[1].stockpile, 2);
  assert.equal(currentPlayer(next), 1, 'still their turn');
  assert.equal(next.conquest.attacksLeft, 2, 'no attack used');
});

test('placing a new stockpile during shipment does not use the move', () => {
  const map = textMap(['AABBCC']);
  const s = custom(map, [0, 0, 1], 2, { chance: 'low' });
  s.phase = 'shipment';
  s.players[0].stockpile = -1;
  let next = apply(s, { type: 'placeStockpile', player: 0, territory: 0 });
  assert.equal(currentPlayer(next), 0);
  next = apply(next, { type: 'ship', player: 0, move: { kind: 'stockpile', to: 1 } });
  assert.equal(next.players[0].stockpile, 1);
  assert.equal(currentPlayer(next), 1);
});

test('a horse rides in from two territories away', () => {
  // A - B - C(target, player 1); horse in A rides through B.
  const map = textMap(['AABBCC']);
  const s = custom(map, [0, 0, 1], 2, { chance: 'low' });
  s.territories[2].weapon = true; // defense 4
  s.territories[0].horse = true;
  s.territories[0].weapon = true;
  // Without the horse: only B bears (1).
  assert.equal(attackStrength(s, 0, 2, null), 1);
  const force = { kind: 'horse' as const, from: 0, via: 1, weaponFrom: 0 };
  assert.equal(attackStrength(s, 0, 2, force), 1 + 1 + 3);
  let next = apply(s, { type: 'plan', player: 0, target: 2, force });
  next = apply(next, { type: 'attack', player: 0 });
  assert.equal(next.territories[2].owner, 0);
  assert.equal(next.territories[2].horse, true);
  assert.equal(next.territories[2].weapon, true, 'one weapon per territory');
  assert.equal(next.territories[0].horse, false);
  assert.equal(next.territories[0].weapon, false);
});

test('boats cross water and land on free coastline', () => {
  const map = textMap(['AA..BB', 'AA..BB']);
  const s = custom(map, [0, 1], 2, { chance: 'low', level: 3 });
  const sea = analyze(map).territories[0].seas[0];
  s.territories[0].boats.push(sea);
  s.territories[0].weapon = true;
  assert.equal(tryApply(s, { type: 'plan', player: 0, target: 1, force: null }).error, 'You need a bordering territory or a boat');
  const force = { kind: 'boat' as const, from: 0, sea, horse: false, weapon: true };
  assert.equal(attackStrength(s, 0, 1, force), 2 + 3);
  let next = apply(s, { type: 'plan', player: 0, target: 1, force });
  next = apply(next, { type: 'attack', player: 0 });
  assert.equal(next.territories[1].owner, 0);
  assert.deepEqual(next.territories[1].boats, [sea]);
  assert.ok(freeBerths(next, 1, sea) >= 1);
});

test('third parties are asked to take sides when it matters', () => {
  // B is attacked by A; C also borders B and could tip the balance.
  const map = textMap(['AABBCC']);
  const s = custom(map, [0, 1, 2], 3, { chance: 'low' });
  s.territories[0].horse = true; // attack 2 vs defense 1
  s.territories[2].weapon = true; // C bears 4 on B
  let next = apply(s, { type: 'plan', player: 0, target: 1, force: null });
  assert.deepEqual(actors(next), [0, 2]);
  assert.ok(tryApply(next, { type: 'attack', player: 0 }).error);
  const neutral = apply(apply(next, { type: 'ally', player: 2, side: 'neutral' }), { type: 'attack', player: 0 });
  assert.equal(neutral.territories[1].owner, 0);
  // Siding with the defender (2 vs 5) calls the attack off and uses it up.
  next = apply(apply(next, { type: 'ally', player: 2, side: 'defender' }), { type: 'attack', player: 0 });
  assert.equal(next.territories[1].owner, 1);
  assert.equal(next.conquest.attacksLeft, 1);
});

test('production: cities double, horses breed', () => {
  const map = textMap(['AABBCC']);
  const s = custom(map, [0, 0, 1], 2);
  s.territories[0].site = 'gold';
  s.territories[1].city = true;
  s.territories[2].site = 'horses';
  s.players[0].stockpile = 0;
  s.players[1].stockpile = 2;
  // Finish year 1's conquest; year 2 opens with development (nothing to
  // afford), then production runs at once since everyone has a stockpile.
  s.settings.chance = 'low';
  const before = s.players[0].stock.gold;
  s.year = 1;
  // End the year with both players finishing their conquests.
  let next = apply(s, { type: 'done', player: 0 });
  next = apply(next, { type: 'done', player: 1 });
  // Year 2 opens with development: both lords look at their stockpiles and pass.
  assert.equal(next.phase, 'development');
  next = apply(next, { type: 'done', player: next.order[next.turn] });
  next = apply(next, { type: 'done', player: next.order[next.turn] });
  assert.equal(next.year, 2);
  assert.equal(next.players[0].stock.gold, before + 2);
  assert.equal(next.territories[2].horse, true);
});

test('building costs follow the level', () => {
  const map = textMap(['AABB']);
  const s = custom(map, [0, 1], 2, { level: 1 });
  s.phase = 'development';
  s.players[0].stock = { gold: 6, iron: 1, coal: 1, timber: 0 };
  assert.ok(tryApply(s, { type: 'build', player: 0, item: 'weapon', territory: 0, pay: 'goods' }).error);
  let next = apply(s, { type: 'build', player: 0, item: 'weapon', territory: 0, pay: 'gold' });
  assert.equal(next.players[0].stock.gold, 4);
  next = apply(next, { type: 'build', player: 0, item: 'city', territory: 0, pay: 'gold' });
  assert.equal(next.territories[0].city, true);
  assert.equal(next.players[0].stock.gold, 0);
  // The turn lasts until the lord says they are done.
  assert.equal(currentPlayer(next), 0);
  next = apply(next, { type: 'done', player: 0 });
  assert.equal(currentPlayer(next), 1, 'the next lord gets a turn even with nothing to spend');
});

test('trades swap goods when accepted', () => {
  const s = createGame(settings({ selection: 'deal' }), humans(3));
  s.phase = 'trade';
  s.players[0].stock.gold = 2;
  s.players[1].stock.iron = 3;
  let next = apply(s, { type: 'offer', player: 0, to: 1, give: { ...emptyStock(), gold: 1 }, get: { ...emptyStock(), iron: 2 } });
  const id = next.trade.offers[0].id;
  next = apply(next, { type: 'respond', player: 1, offer: id, accept: true });
  assert.equal(next.players[0].stock.gold, 1);
  assert.equal(next.players[0].stock.iron, 2);
  assert.equal(next.players[1].stock.gold, 1);
  assert.equal(next.players[1].stock.iron, 1);
});

/** Let computer players run a whole game to the end. */
function selfPlay(over: Partial<Settings>, players: number, maxSteps = 20000): GameState {
  let s = createGame(settings(over), humans(players, true));
  for (let step = 0; step < maxSteps && s.phase !== 'over'; step++) {
    const who = actors(s);
    let acted = false;
    for (const p of who) {
      const action = chooseAction(s, p);
      if (!action) continue;
      const r = tryApply(s, action);
      assert.equal(r.error, undefined, `${s.phase}: ${JSON.stringify(action)} -> ${r.error}`);
      s = r.state;
      acted = true;
      break;
    }
    assert.ok(acted, `stuck in ${s.phase} waiting for ${who}`);
    if (s.year > 80) break;
  }
  return s;
}

for (const [label, over, n] of [
  ['beginner, low chance', { level: 1, chance: 'low' }, 2],
  ['intermediate, medium chance', { level: 2, chance: 'medium' }, 3],
  ['advanced, high chance', { level: 3, chance: 'high' }, 4],
  ['expert, deal, large map', { level: 4, chance: 'medium', selection: 'deal', map: { kind: 'random', size: 'large', water: 'high' } }, 5],
  ['classic map', { level: 3, chance: 'medium', map: { kind: 'classic', size: 'medium', water: 'medium' } }, 4],
] as const) {
  test(`computer players finish a game: ${label}`, () => {
    for (const seed of ['A', 'B', 'C']) {
      const s = selfPlay({ ...(over as Partial<Settings>), seed }, n as number);
      assert.ok(s.phase === 'over' || s.year > 80, `game ${seed} ended (year ${s.year})`);
    }
  });
}

test('dealt lands are fair and grow as connected realms', () => {
  const kinds = ['gold', 'iron', 'coal', 'timber', 'horses', null];
  let lonely = 0;
  let lands = 0;
  for (const players of [2, 3, 4, 6]) {
    for (const seed of ['D1', 'D2', 'D3']) {
      const s = createGame(settings({ selection: 'deal', level: 3, seed: seed + players }), humans(players));
      const info = analyze(s.map);
      for (const k of kinds) {
        const counts = s.players.map((p) => s.territories.filter((t) => t.owner === p.id && t.site === k).length);
        assert.ok(Math.max(...counts) - Math.min(...counts) <= 2, `${k ?? 'barren'} split evenly (${counts})`);
      }
      const owned = s.players.map((p) => s.territories.filter((t) => t.owner === p.id).length);
      assert.equal(Math.max(...owned), Math.min(...owned), 'everyone gets the same number of lands');
      s.territories.forEach((t, id) => {
        if (t.owner < 0) return;
        lands++;
        if (!info.territories[id].neighbors.some((n) => s.territories[n].owner === t.owner)) lonely++;
      });
    }
  }
  assert.ok(lonely / lands < 0.08, `few stray lands (${lonely}/${lands})`);
});

test('computer lords answer offers and propose their own', () => {
  const s = createGame(settings({ selection: 'deal', level: 2 }), [
    { name: 'Human', color: 0, ai: false },
    { name: 'Bot', color: 1, ai: true },
    { name: 'Bot2', color: 2, ai: true },
  ]);
  s.phase = 'trade';
  s.placing = [];
  s.trade = { offers: [], ready: [], nextId: 1 };
  s.log.push({ n: s.eventCount++, year: s.year, event: { kind: 'phase', phase: 'trade' } });
  s.players[0].stock = { gold: 0, iron: 4, coal: 0, timber: 0 };
  s.players[1].stock = { gold: 0, iron: 0, coal: 5, timber: 1 };
  s.players[2].stock = { gold: 1, iron: 1, coal: 1, timber: 1 };
  // A generous offer is accepted; a stingy one is declined (and logged).
  let next = apply(s, { type: 'offer', player: 0, to: 1, give: { ...emptyStock(), iron: 2 }, get: { ...emptyStock(), coal: 1 } });
  const answer = chooseAction(next, 1)!;
  assert.deepEqual(answer, { type: 'respond', player: 1, offer: next.trade.offers[0].id, accept: true });
  const stingy = apply(s, { type: 'offer', player: 0, to: 1, give: { ...emptyStock(), iron: 1 }, get: { ...emptyStock(), coal: 4 } });
  const no = chooseAction(stingy, 1)!;
  assert.equal(no.type === 'respond' && no.accept, false);
  const declined = apply(stingy, no);
  assert.equal(declined.log[declined.log.length - 1].event.kind, 'declined');
  // Bot lacks iron and has plenty of coal: it proposes 2 coal for 1 iron to the human.
  const proposal = chooseAction(s, 1)!;
  assert.deepEqual(proposal, { type: 'offer', player: 1, to: 0, give: { ...emptyStock(), coal: 2 }, get: { ...emptyStock(), iron: 1 } });
  next = apply(s, proposal);
  // Only one offer per trading phase.
  assert.equal(chooseAction(next, 1)!.type, 'ready');
});

test('a computer attacker backs off when allies turn against it, and does not ask twice', () => {
  // A (computer) attacks B; C (a person) also borders B and could tip the balance.
  const map = textMap(['AABBCC']);
  const s = custom(map, [0, 1, 2], 3, { chance: 'low' });
  s.players[0].ai = true;
  s.territories[0].horse = true; // attack 2 vs defense 1
  s.territories[2].weapon = true; // C bears 4 on B
  const plan = chooseAction(s, 0)!;
  assert.deepEqual(plan, { type: 'plan', player: 0, target: 1, force: null });
  let next = apply(s, plan);
  assert.deepEqual(actors(next), [0, 2], 'the person is asked to take a side');
  next = apply(next, { type: 'ally', player: 2, side: 'defender' });
  // 2 vs 5 now: the computer calls it off instead of attacking...
  const after = chooseAction(next, 0)!;
  assert.deepEqual(after, { type: 'cancel', player: 0 });
  next = apply(next, after);
  // ...and does not plan the same attack again this turn.
  const again = chooseAction(next, 0)!;
  assert.ok(!(again.type === 'plan' && again.target === 1), `asked again: ${JSON.stringify(again)}`);
});

test('a turn does not end by itself after the last attack', () => {
  const map = textMap(['AABBCCDD']);
  const s = custom(map, [0, 1, 1, 1], 2, { chance: 'low' });
  s.territories[0].weapon = true;
  s.conquest.attacksLeft = 1;
  let next = apply(apply(s, { type: 'plan', player: 0, target: 1, force: null }), { type: 'attack', player: 0 });
  assert.equal(next.conquest.attacksLeft, 0);
  assert.equal(currentPlayer(next), 0, 'still the attacker’s turn');
  assert.equal(tryApply(next, { type: 'plan', player: 0, target: 2, force: null }).error, 'No attacks left this turn');
  next = apply(next, { type: 'done', player: 0 });
  assert.equal(currentPlayer(next), 1);
});

test('computer neighbors do not gang up on a lord who is only slightly ahead', () => {
  // A (person) attacks B (computer); C (computer) borders B. A has one more land than the others.
  const map = textMap(['AABBCC', 'DD....']);
  const s = custom(map, [0, 1, 2, 0], 3, { chance: 'high' });
  s.players[1].ai = true;
  s.players[2].ai = true;
  s.territories[0].horse = true;
  let next = apply(s, { type: 'plan', player: 0, target: 1, force: null });
  assert.deepEqual(next.conquest.plan!.allies.map((a) => a.player), [2]);
  assert.deepEqual(chooseAction(next, 2), { type: 'ally', player: 2, side: 'neutral' });
  // Far ahead (two cities more than anyone): now the neighbors push back.
  s.territories[0].city = true;
  s.territories[3].city = true;
  next = apply(s, { type: 'plan', player: 0, target: 1, force: null });
  assert.deepEqual(chooseAction(next, 2), { type: 'ally', player: 2, side: 'defender' });
});

test('an offer to several lords goes to the first who accepts', () => {
  const s = createGame(settings({ selection: 'deal' }), humans(4));
  s.phase = 'trade';
  s.placing = [];
  s.players[0].stock = { gold: 2, iron: 0, coal: 0, timber: 0 };
  s.players[1].stock = { gold: 0, iron: 3, coal: 0, timber: 0 };
  s.players[2].stock = { gold: 0, iron: 3, coal: 0, timber: 0 };
  let next = apply(s, { type: 'offer', player: 0, to: [1, 2], give: { ...emptyStock(), gold: 2 }, get: { ...emptyStock(), iron: 2 } });
  assert.deepEqual(next.trade.offers.map((o) => o.to), [1, 2]);
  const second = next.trade.offers[1].id;
  next = apply(next, { type: 'respond', player: 2, offer: second, accept: true });
  assert.equal(next.players[0].stock.iron, 2);
  assert.equal(next.players[2].stock.gold, 2);
  assert.deepEqual(next.trade.offers, [], 'the copy sent to player 1 was withdrawn');
});

test('a boat can carry a weapon into a land that already has one', () => {
  // A and C are across the water from each other; B (the target, armed) is C's neighbor.
  const map = textMap(['AA..BBCC']);
  const s = custom(map, [0, 1, 1], 2, { chance: 'low', level: 3 });
  const sea = analyze(map).territories[0].seas[0];
  s.territories[0].boats.push(sea);
  s.territories[0].weapon = true;
  s.territories[0].horse = true;
  s.territories[1].weapon = true; // defense 1 + 3 + 1 (C) = 5
  const force = { kind: 'boat' as const, from: 0, sea, horse: true, weapon: true };
  assert.equal(attackStrength(s, 0, 1, force), 2 + 1 + 3);
  let next = apply(s, { type: 'plan', player: 0, target: 1, force });
  next = apply(next, { type: 'attack', player: 0 });
  assert.equal(next.territories[1].owner, 0);
  assert.equal(next.territories[1].weapon, true, 'one weapon in the conquered land');
  assert.equal(next.territories[0].weapon, false, 'the carried weapon left home');
  assert.equal(next.territories[1].horse, true);
});

test('a horse can pick up a weapon in the land it rides through', () => {
  // A (horse) -> B (weapon) -> C (target).
  const map = textMap(['AABBCC']);
  const s = custom(map, [0, 0, 1], 2, { chance: 'low' });
  s.territories[0].horse = true;
  s.territories[1].weapon = true;
  s.territories[2].weapon = true; // defense 1 + 3
  const force = { kind: 'horse' as const, from: 0, via: 1, weaponFrom: 1 };
  // B already borders C, so its weapon already counts: the horse adds 1.
  assert.equal(attackStrength(s, 0, 2, force), 1 + 3 + 1);
  const next = apply(apply(s, { type: 'plan', player: 0, target: 2, force }), { type: 'attack', player: 0 });
  assert.equal(next.territories[2].owner, 0);
  assert.equal(next.territories[2].weapon, true);
  assert.equal(next.territories[1].weapon, false);
});

test('a lord can be handed to the computer mid-turn and taken back', () => {
  const s = createGame(settings({ selection: 'deal', level: 2 }), humans(3));
  // Whoever must act now hands their lord over; the computer can then act for them.
  const who = actors(s)[0];
  let next = apply(s, { type: 'setAi', player: who, ai: true });
  assert.equal(next.players[who].ai, true);
  assert.ok(chooseAction(next, who), 'the computer has a move for that lord');
  assert.equal(tryApply(next, { type: 'setAi', player: who, ai: true }).error, 'Already played by the computer');
  next = apply(next, { type: 'setAi', player: who, ai: false });
  assert.equal(next.players[who].ai, false);
  // Lands and stockpile are kept throughout.
  assert.deepEqual(next.territories.map((t) => t.owner), s.territories.map((t) => t.owner));
});
