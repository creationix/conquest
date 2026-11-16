// Lords of Conquest rules, following the 1986 Electronic Arts manual.
//
// The game state is plain JSON. `apply` validates an action, mutates a copy
// and returns it, so the same code runs in the browser (pass and play) and on
// the LAN server (authoritative host for several devices).

import { analyze, generateMap, fromLegacy, type MapData, type MapInfo } from './map.ts';
import { Rng, hashSeed } from './rng.ts';
import { CLASSIC_MAP } from './classic.ts';
import {
  GOODS,
  type Action,
  type AttackPlan,
  type Force,
  type GameEvent,
  type GameState,
  type Good,
  type Item,
  type Move,
  type Pay,
  type Phase,
  type PlayerSetup,
  type Settings,
  type Site,
  type Stock,
  type TerritoryState,
} from './types.ts';

export class RuleError extends Error {}

const fail = (msg: string): never => {
  throw new RuleError(msg);
};

export const emptyStock = (): Stock => ({ gold: 0, iron: 0, coal: 0, timber: 0 });

export function info(state: GameState): MapInfo {
  return analyze(state.map);
}

// ---------------------------------------------------------------------------
// Costs

export interface Recipe {
  pay: Pay;
  cost: Stock;
}

export function recipes(level: number, item: Item): Recipe[] {
  const s = (p: Partial<Stock>): Stock => ({ ...emptyStock(), ...p });
  const out: Recipe[] = [];
  if (item === 'weapon') {
    out.push({ pay: 'gold', cost: s({ gold: 2 }) });
    if (level >= 2) out.push({ pay: 'goods', cost: s({ iron: 1, coal: 1 }) });
  } else if (item === 'city') {
    out.push({ pay: 'gold', cost: s({ gold: 4 }) });
    if (level >= 2) out.push({ pay: 'goods', cost: s({ gold: 1, iron: 1, coal: 1, timber: 1 }) });
  } else if (item === 'boat' && level >= 3) {
    out.push({ pay: 'gold', cost: s({ gold: 3 }) });
    out.push({ pay: 'goods', cost: s({ timber: 3 }) });
  }
  return out;
}

export const canPay = (stock: Stock, cost: Stock) => GOODS.every((g) => stock[g] >= cost[g]);

// ---------------------------------------------------------------------------
// Queries

export const owns = (s: GameState, p: number, t: number) => s.territories[t]?.owner === p;
export const neighbors = (s: GameState, t: number) => info(s).territories[t].neighbors;
export const adjacent = (s: GameState, a: number, b: number) => neighbors(s, a).includes(b);

/** How many boats can berth at territory `t` on sea `sea`. */
export function berths(s: GameState, t: number, sea: number): number {
  return info(s).territories[t].coast[sea]?.length ?? 0;
}

export function freeBerths(s: GameState, t: number, sea: number): number {
  return berths(s, t, sea) - s.territories[t].boats.filter((b) => b === sea).length;
}

export function unitPoints(t: TerritoryState): number {
  return (t.horse ? 1 : 0) + (t.city ? 2 : 0) + (t.weapon ? 3 : 0);
}

/** Force a player bears on `target` from their own bordering territories. */
export function bearing(s: GameState, player: number, target: number): number {
  let total = 0;
  for (const n of neighbors(s, target)) {
    const t = s.territories[n];
    if (t.owner === player) total += 1 + unitPoints(t);
  }
  return total;
}

export function defense(s: GameState, target: number): number {
  const t = s.territories[target];
  if (t.owner < 0) {
    // Unclaimed land defends with itself and its unclaimed neighbors.
    return 1 + neighbors(s, target).filter((n) => s.territories[n].owner < 0).length;
  }
  return 1 + unitPoints(t) + 2 * t.boats.length + bearing(s, t.owner, target);
}

/** Extra points a brought force adds (units next to the target already count). */
export function forceBonus(s: GameState, target: number, force: Force | null): number {
  if (!force) return 0;
  const near = (t: number) => adjacent(s, t, target);
  if (force.kind === 'weapon') return 0;
  if (force.kind === 'horse') {
    let bonus = near(force.from) ? 0 : 1;
    if (force.weaponFrom !== undefined && !near(force.weaponFrom)) bonus += 3;
    return bonus;
  }
  let bonus = 2;
  if (!near(force.from)) bonus += (force.horse ? 1 : 0) + (force.weapon ? 3 : 0);
  return bonus;
}

export function attackStrength(s: GameState, player: number, target: number, force: Force | null): number {
  return bearing(s, player, target) + forceBonus(s, target, force);
}

/** Chance the attacker wins with the given totals, under the game's chance level. */
export function winOdds(s: GameState, attack: number, defense_: number): number {
  switch (s.settings.chance) {
    case 'low':
      return attack >= defense_ ? 1 : 0;
    case 'medium':
      return attack > defense_ ? 1 : attack === defense_ ? 0.5 : 0;
    default:
      return attack / (attack + defense_);
  }
}

export function currentPlayer(s: GameState): number {
  if (s.phase === 'select' || s.phase === 'development' || s.phase === 'shipment' || s.phase === 'conquest') {
    return s.order[s.turn] ?? -1;
  }
  return -1;
}

/** Players who may act right now. */
export function actors(s: GameState): number[] {
  switch (s.phase) {
    case 'select':
    case 'development':
    case 'shipment':
      return [currentPlayer(s)];
    case 'production':
      return [...s.placing];
    case 'trade':
      return s.players.filter((p) => p.alive && !s.trade.ready.includes(p.id)).map((p) => p.id);
    case 'conquest': {
      const plan = s.conquest.plan;
      const waiting = plan ? plan.allies.filter((a) => a.side === null).map((a) => a.player) : [];
      return [currentPlayer(s), ...waiting];
    }
    default:
      return [];
  }
}

/**
 * A lord whose stockpile was captured places a new one at the start of their
 * next turn. It is free: it does not use up a move or an attack.
 */
export function needsStockpile(s: GameState, p: number): boolean {
  if (s.phase !== 'development' && s.phase !== 'shipment' && s.phase !== 'conquest') return false;
  const player = s.players[p];
  return !!player && player.alive && player.stockpile < 0 && currentPlayer(s) === p && territoriesOf(s, p).length > 0;
}

export function territoriesOf(s: GameState, p: number): number[] {
  const out: number[] = [];
  s.territories.forEach((t, i) => {
    if (t.owner === p) out.push(i);
  });
  return out;
}

export function cityCount(s: GameState, p: number): number {
  return s.territories.filter((t) => t.owner === p && t.city).length;
}

/** Can this territory hold a new item of this kind? */
export function canPlace(s: GameState, p: number, item: Item, t: number, sea?: number): boolean {
  const ts = s.territories[t];
  if (!ts || ts.owner !== p) return false;
  if (item === 'weapon') return !ts.weapon;
  if (item === 'city') return !ts.city;
  if (s.settings.level < 3) return false;
  if (sea === undefined) return info(s).territories[t].seas.some((x) => freeBerths(s, t, x) > 0);
  return freeBerths(s, t, sea) > 0;
}

export function affordable(s: GameState, p: number): Item[] {
  const stock = s.players[p].stock;
  const out: Item[] = [];
  for (const item of ['city', 'weapon', 'boat'] as Item[]) {
    if (!recipes(s.settings.level, item).some((r) => canPay(stock, r.cost))) continue;
    if (!territoriesOf(s, p).some((t) => canPlace(s, p, item, t))) continue;
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Setup

export const MAP_SIZES = {
  small: { width: 30, height: 20, territories: 24 },
  medium: { width: 36, height: 24, territories: 34 },
  large: { width: 44, height: 28, territories: 46 },
} as const;

const WATER = { low: 0.72, medium: 0.62, high: 0.52 } as const;
const ABUNDANCE = { low: 0.34, medium: 0.48, high: 0.62 } as const;

export function defaultSettings(): Settings {
  return {
    level: 2,
    chance: 'medium',
    citiesToWin: 3,
    abundance: 'medium',
    selection: 'pick',
    map: { kind: 'random', size: 'medium', water: 'medium' },
    seed: Math.random().toString(36).slice(2, 8).toUpperCase(),
  };
}

export function buildMap(settings: Settings, rng: Rng): MapData {
  if (settings.map.kind === 'classic') return fromLegacy('Classic', CLASSIC_MAP);
  const size = MAP_SIZES[settings.map.size];
  return generateMap(rng, {
    ...size,
    land: WATER[settings.map.water],
    connected: settings.level < 3,
    name: 'Random',
  });
}

export function distributeSites(settings: Settings, map: MapData, rng: Rng): (Site | null)[] {
  const n = analyze(map).territories.length;
  const count = Math.max(4, Math.round(n * ABUNDANCE[settings.abundance]));
  const kinds: Site[] = settings.level === 1 ? ['gold', 'horses'] : ['gold', 'horses', 'iron', 'coal', 'timber'];
  const sites: (Site | null)[] = new Array(n).fill(null);
  const pool: Site[] = [];
  for (let i = 0; i < count; i++) pool.push(kinds[i % kinds.length]);
  const slots = rng.shuffle([...Array(n).keys()]);
  pool.forEach((site, i) => (sites[slots[i]] = site));
  return sites;
}

export function createGame(settings: Settings, setups: PlayerSetup[]): GameState {
  if (setups.length < 2) fail('Need at least two players');
  const rng = new Rng(hashSeed(settings.seed));
  const map = buildMap(settings, rng);
  const sites = distributeSites(settings, map, rng);
  const order = rng.shuffle(setups.map((_, i) => i));
  const s: GameState = {
    v: 1,
    settings,
    map,
    seed: rng.state,
    players: setups.map((p, id) => ({ ...p, id, alive: true, stock: emptyStock(), stockpile: -1 })),
    territories: sites.map((site) => ({ owner: -1, site, horse: false, weapon: false, city: false, boats: [] })),
    year: 1,
    order,
    phase: 'select',
    turn: 0,
    placing: [],
    conquest: { attacksLeft: 0, usedStockpileMove: false, plan: null },
    trade: { offers: [], ready: [], nextId: 1 },
    winner: -1,
    log: [],
    eventCount: 0,
    version: 0,
  };
  if (settings.selection === 'deal') {
    random(s, (r) => {
      const ids = r.shuffle([...s.territories.keys()]);
      const each = Math.floor(ids.length / setups.length);
      for (let i = 0; i < each * setups.length; i++) s.territories[ids[i]].owner = order[i % setups.length];
    });
    emit(s, { kind: 'deal' });
    beginPhase(s, 'production');
  } else {
    emit(s, { kind: 'phase', phase: 'select' });
  }
  return s;
}

// ---------------------------------------------------------------------------
// Internals

function emit(s: GameState, event: GameEvent) {
  s.log.push({ n: s.eventCount++, year: s.year, event });
  if (s.log.length > 300) s.log.splice(0, s.log.length - 300);
}

function random<T>(s: GameState, fn: (rng: Rng) => T): T {
  const rng = new Rng(s.seed);
  const out = fn(rng);
  s.seed = rng.state;
  return out;
}

const alive = (s: GameState) => s.players.filter((p) => p.alive);

function phasesFor(year: number): Phase[] {
  return year === 1
    ? ['production', 'trade', 'shipment', 'conquest']
    : ['development', 'production', 'trade', 'shipment', 'conquest'];
}

/** Move `turn` to the first living player at or after index `from`. */
function seekTurn(s: GameState, from: number): boolean {
  for (let i = from; i < s.order.length; i++) {
    if (s.players[s.order[i]].alive) {
      s.turn = i;
      return true;
    }
  }
  return false;
}

function chanceSkip(s: GameState, phase: Phase): boolean {
  if (s.settings.chance === 'low') return false;
  if (phase === 'production' && s.year === 1) return false;
  return random(s, (r) => r.chance(0.25));
}

function beginPhase(s: GameState, phase: Phase): void {
  if (s.phase === 'over') return;
  s.phase = phase;
  s.turn = 0;
  switch (phase) {
    case 'development': {
      emit(s, { kind: 'phase', phase });
      startDevelopmentTurn(s, 0);
      return;
    }
    case 'production': {
      if (chanceSkip(s, phase)) {
        emit(s, { kind: 'phase', phase, skipped: true });
        return nextPhase(s);
      }
      emit(s, { kind: 'phase', phase });
      s.placing = s.order.filter((p) => s.players[p].alive && s.players[p].stockpile < 0 && territoriesOf(s, p).length > 0);
      if (!s.placing.length) {
        produce(s);
        return nextPhase(s);
      }
      return;
    }
    case 'trade': {
      if (alive(s).length < 3) return nextPhase(s);
      if (chanceSkip(s, phase)) {
        emit(s, { kind: 'phase', phase, skipped: true });
        return nextPhase(s);
      }
      emit(s, { kind: 'phase', phase });
      s.trade = { offers: [], ready: [], nextId: s.trade.nextId };
      return;
    }
    case 'shipment': {
      if (chanceSkip(s, phase)) {
        emit(s, { kind: 'phase', phase, skipped: true });
        return nextPhase(s);
      }
      emit(s, { kind: 'phase', phase });
      if (!seekTurn(s, 0)) nextPhase(s);
      return;
    }
    case 'conquest': {
      emit(s, { kind: 'phase', phase });
      if (!seekTurn(s, 0)) return nextPhase(s);
      s.conquest = { attacksLeft: 2, usedStockpileMove: false, plan: null };
      return;
    }
  }
}

/** Every living lord gets a development turn, even with nothing to spend. */
function startDevelopmentTurn(s: GameState, from: number): void {
  if (!seekTurn(s, from)) nextPhase(s);
}

function nextPhase(s: GameState): void {
  if (s.phase === 'over') return;
  const list = phasesFor(s.year);
  const i = list.indexOf(s.phase);
  if (s.phase === 'select' || i < 0) return beginPhase(s, list[0]);
  if (i + 1 < list.length) return beginPhase(s, list[i + 1]);
  endYear(s);
}

function endYear(s: GameState): void {
  const target = s.settings.citiesToWin;
  const counts = alive(s).map((p) => ({ p: p.id, c: cityCount(s, p.id) }));
  const best = Math.max(...counts.map((x) => x.c));
  const leaders = counts.filter((x) => x.c === best);
  if (best >= target && leaders.length === 1) {
    return finish(s, leaders[0].p, `${best} cities at the end of year ${s.year}`);
  }
  s.year++;
  // The first player moves to the end of the line each year.
  s.order.push(s.order.shift()!);
  emit(s, { kind: 'year', year: s.year });
  beginPhase(s, 'development');
}

function finish(s: GameState, winner: number, reason: string) {
  s.winner = winner;
  s.phase = 'over';
  s.conquest.plan = null;
  emit(s, { kind: 'win', player: winner, reason });
}

function advanceTurn(s: GameState): void {
  if (s.phase === 'development') return startDevelopmentTurn(s, s.turn + 1);
  if (s.phase === 'conquest') {
    s.conquest = { attacksLeft: 2, usedStockpileMove: false, plan: null };
  }
  if (!seekTurn(s, s.turn + 1)) nextPhase(s);
}

function produce(s: GameState) {
  const terr = s.territories;
  const map = info(s);
  terr.forEach((t, id) => {
    if (t.owner < 0 || !t.site || t.site === 'horses') return;
    const owner = s.players[t.owner];
    if (owner.stockpile < 0) return;
    const doubled = t.city || map.territories[id].neighbors.some((n) => terr[n].owner === t.owner && terr[n].city);
    const amount = doubled ? 2 : 1;
    owner.stock[t.site] += amount;
    emit(s, { kind: 'produce', player: t.owner, territory: id, good: t.site, amount });
  });
  // Horses: each pasture breeds one horse; it stays home if there is room,
  // otherwise it wanders to the nearest horse-free land of the same owner.
  terr.forEach((t, id) => {
    if (t.owner < 0 || t.site !== 'horses') return;
    let spot = -1;
    if (!t.horse) spot = id;
    else {
      const seen = new Set([id]);
      let frontier = [id];
      while (frontier.length && spot < 0) {
        const next: number[] = [];
        for (const f of frontier) {
          for (const n of map.territories[f].neighbors) {
            if (seen.has(n) || terr[n].owner !== t.owner) continue;
            seen.add(n);
            next.push(n);
          }
        }
        const open = next.filter((n) => !terr[n].horse);
        if (open.length) spot = random(s, (r) => r.pick(open));
        frontier = next;
      }
    }
    if (spot >= 0) {
      terr[spot].horse = true;
      emit(s, { kind: 'horse', player: t.owner, territory: spot });
    }
  });
}

function loot(s: GameState, from: number, to: number): Stock {
  const a = s.players[from];
  const b = s.players[to];
  const taken = { ...a.stock };
  for (const g of GOODS) {
    b.stock[g] += a.stock[g];
    a.stock[g] = 0;
  }
  a.stockpile = -1;
  return taken;
}

function checkElimination(s: GameState, p: number) {
  if (p < 0 || !s.players[p].alive) return;
  if (territoriesOf(s, p).length > 0) return;
  eliminate(s, p);
}

function eliminate(s: GameState, p: number) {
  const player = s.players[p];
  player.alive = false;
  player.stock = emptyStock();
  player.stockpile = -1;
  s.placing = s.placing.filter((x) => x !== p);
  s.trade.offers = s.trade.offers.filter((o) => o.from !== p && o.to !== p);
  s.trade.ready = s.trade.ready.filter((x) => x !== p);
  emit(s, { kind: 'eliminated', player: p });
  const left = alive(s);
  if (left.length === 1) finish(s, left[0].id, 'last lord standing');
}

// ---------------------------------------------------------------------------
// Validation of forces and moves

function validateForce(s: GameState, p: number, target: number, force: Force) {
  const T = s.territories;
  const own = (t: number) => owns(s, p, t);
  if (force.kind === 'weapon') {
    if (!own(force.from) || !T[force.from].weapon) fail('No weapon there');
    if (!adjacent(s, force.from, target)) fail('A weapon can only move into a bordering territory');
    return;
  }
  if (force.kind === 'horse') {
    if (!own(force.from) || !T[force.from].horse) fail('No horse there');
    if (force.via !== undefined) {
      if (!own(force.via)) fail('Horses can only ride through your own land');
      if (!adjacent(s, force.from, force.via) || !adjacent(s, force.via, target)) fail('That horse is too far away');
    } else if (!adjacent(s, force.from, target)) fail('That horse is too far away');
    if (force.weaponFrom !== undefined) {
      if (force.weaponFrom !== force.from && force.weaponFrom !== force.via) fail('The horse must pass the weapon');
      if (!T[force.weaponFrom].weapon) fail('No weapon there');
    }
    return;
  }
  if (s.settings.level < 3) fail('Boats are not used at this level');
  if (!own(force.from) || !T[force.from].boats.includes(force.sea)) fail('No boat there');
  if (!info(s).territories[target].seas.includes(force.sea)) fail('That boat cannot reach the target');
  if (freeBerths(s, target, force.sea) <= 0) fail('No free coastline to land on');
  if (force.horse && !T[force.from].horse) fail('No horse to carry');
  if (force.weapon && !T[force.from].weapon) fail('No weapon to carry');
}

export function validateMove(s: GameState, p: number, move: Move) {
  const T = s.territories;
  const own = (t: number) => owns(s, p, t);
  if (move.kind === 'stockpile') {
    if (!own(move.to)) fail('Choose one of your territories');
    if (s.players[p].stockpile === move.to) fail('Your stockpile is already there');
    return;
  }
  if (s.settings.level < 4) fail('Only the stockpile can be shipped below Expert level');
  if (move.kind === 'weapon') {
    if (!own(move.from) || !T[move.from].weapon) fail('No weapon there');
    if (!own(move.to) || !adjacent(s, move.from, move.to)) fail('Weapons move one territory');
    if (T[move.to].weapon) fail('Only one weapon per territory');
    return;
  }
  if (move.kind === 'horse') {
    if (!own(move.from) || !T[move.from].horse) fail('No horse there');
    if (!own(move.to) || move.to === move.from) fail('Choose one of your territories');
    if (move.via !== undefined) {
      if (!own(move.via) || !adjacent(s, move.from, move.via) || !adjacent(s, move.via, move.to)) fail('Horses move up to two territories');
    } else if (!adjacent(s, move.from, move.to)) fail('Horses move up to two territories');
    if (T[move.to].horse) fail('Only one horse per territory');
    if (move.weaponFrom !== undefined) {
      if (move.weaponFrom !== move.from && move.weaponFrom !== move.via) fail('The horse must pass the weapon');
      if (!T[move.weaponFrom].weapon) fail('No weapon there');
      if (T[move.to].weapon) fail('Only one weapon per territory');
    }
    return;
  }
  if (!own(move.from) || !T[move.from].boats.includes(move.sea)) fail('No boat there');
  if (!own(move.to) || move.to === move.from) fail('Choose one of your territories');
  if (!info(s).territories[move.to].seas.includes(move.sea)) fail('Boats stay on their own body of water');
  if (freeBerths(s, move.to, move.sea) <= 0) fail('No free coastline there');
  if (move.horse && (!T[move.from].horse || T[move.to].horse)) fail('Cannot carry that horse');
  if (move.weapon && (!T[move.from].weapon || T[move.to].weapon)) fail('Cannot carry that weapon');
}

function doMove(s: GameState, p: number, move: Move) {
  const T = s.territories;
  if (move.kind === 'stockpile') {
    s.players[p].stockpile = move.to;
  } else if (move.kind === 'weapon') {
    T[move.from].weapon = false;
    T[move.to].weapon = true;
  } else if (move.kind === 'horse') {
    T[move.from].horse = false;
    T[move.to].horse = true;
    if (move.weaponFrom !== undefined) {
      T[move.weaponFrom].weapon = false;
      T[move.to].weapon = true;
    }
  } else {
    const i = T[move.from].boats.indexOf(move.sea);
    T[move.from].boats.splice(i, 1);
    T[move.to].boats.push(move.sea);
    if (move.horse) {
      T[move.from].horse = false;
      T[move.to].horse = true;
    }
    if (move.weapon) {
      T[move.from].weapon = false;
      T[move.to].weapon = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Attacks

export interface AttackPreview {
  attack: number;
  defense: number;
  /** Strength of every third party that could join. */
  allies: { player: number; strength: number }[];
  /** Best and worst case with allies. */
  best: number;
  worst: number;
  possible: boolean;
}

export function previewAttack(s: GameState, p: number, target: number, force: Force | null): AttackPreview {
  const attack = attackStrength(s, p, target, force);
  const def = defense(s, target);
  const defender = s.territories[target].owner;
  const allies = s.players
    .filter((x) => x.alive && x.id !== p && x.id !== defender)
    .map((x) => ({ player: x.id, strength: bearing(s, x.id, target) }))
    .filter((x) => x.strength > 0);
  const sum = allies.reduce((n, a) => n + a.strength, 0);
  const best = winOdds(s, attack + sum, def);
  const worst = winOdds(s, attack, def + sum);
  return { attack, defense: def, allies, best, worst, possible: best > 0 };
}

function planAttack(s: GameState, p: number, target: number, force: Force | null) {
  const T = s.territories;
  if (!T[target]) fail('No such territory');
  if (T[target].owner === p) fail('You already own that territory');
  if (force) validateForce(s, p, target, force);
  const touching = neighbors(s, target).some((n) => T[n].owner === p);
  if (!touching && force?.kind !== 'boat') fail('You need a bordering territory or a boat');
  const pv = previewAttack(s, p, target, force);
  if (!pv.possible) fail('Attack will fail!');
  // Ask third parties only when their choice could change the outcome.
  const matters = pv.best !== pv.worst;
  const plan: AttackPlan = {
    target,
    defender: T[target].owner,
    force,
    allies: matters ? pv.allies.map((a) => ({ ...a, side: null })) : [],
  };
  s.conquest.plan = plan;
}

function resolveAttack(s: GameState, p: number) {
  const plan = s.conquest.plan;
  if (!plan) return fail('Plan an attack first');
  if (plan.allies.some((a) => a.side === null)) fail('Waiting for allies to decide');
  const T = s.territories;
  const target = plan.target;
  let attack = attackStrength(s, p, target, plan.force);
  let def = defense(s, target);
  for (const a of plan.allies) {
    if (a.side === 'attacker') attack += a.strength;
    if (a.side === 'defender') def += a.strength;
  }
  const odds = winOdds(s, attack, def);
  s.conquest.plan = null;
  if (odds <= 0) {
    // The allies tipped the balance: the attack is called off before any
    // fighting, nothing is lost, but the attack is used up.
    emit(s, { kind: 'pass', player: p, reason: 'The allies tipped the balance, so the attack was called off.' });
    s.conquest.attacksLeft--;
    if (s.conquest.attacksLeft <= 0) advanceTurn(s);
    return;
  }
  const won = odds >= 1 ? true : random(s, (r) => r.next() < odds);
  const defender = plan.defender;
  const force = plan.force;
  let looted: Stock | undefined;
  if (won) {
    const t = T[target];
    if (defender >= 0 && s.players[defender].stockpile === target) {
      looted = loot(s, defender, p);
      if (s.players[p].stockpile < 0) s.players[p].stockpile = target;
    }
    t.owner = p;
    if (force) {
      if (force.kind === 'weapon') {
        T[force.from].weapon = false;
        t.weapon = true;
      } else if (force.kind === 'horse') {
        T[force.from].horse = false;
        t.horse = true;
        if (force.weaponFrom !== undefined) {
          T[force.weaponFrom].weapon = false;
          t.weapon = true;
        }
      } else {
        T[force.from].boats.splice(T[force.from].boats.indexOf(force.sea), 1);
        t.boats.push(force.sea);
        if (force.horse) {
          T[force.from].horse = false;
          t.horse = true;
        }
        if (force.weapon) {
          T[force.from].weapon = false;
          t.weapon = true;
        }
      }
    }
  } else if (force) {
    // Repulsed: everything brought into the attack is lost.
    if (force.kind === 'weapon') T[force.from].weapon = false;
    else if (force.kind === 'horse') {
      T[force.from].horse = false;
      if (force.weaponFrom !== undefined) T[force.weaponFrom].weapon = false;
    } else {
      T[force.from].boats.splice(T[force.from].boats.indexOf(force.sea), 1);
      if (force.horse) T[force.from].horse = false;
      if (force.weapon) T[force.from].weapon = false;
    }
  }
  emit(s, { kind: 'battle', attacker: p, defender, target, force, attack, defense: def, won, odds, looted });
  if (won) checkElimination(s, defender);
  if (s.phase === 'over') return;
  s.conquest.attacksLeft = won ? s.conquest.attacksLeft - 1 : 0;
  if (s.conquest.attacksLeft <= 0) advanceTurn(s);
}

// ---------------------------------------------------------------------------
// Reducer

const isStock = (x: unknown): x is Stock =>
  !!x && typeof x === 'object' && GOODS.every((g) => Number.isInteger((x as Stock)[g]) && (x as Stock)[g] >= 0);

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

export function apply(state: GameState, action: Action): GameState {
  const s = clone(state);
  const p = action.player;
  const player = s.players[p];
  if (!player) fail('Unknown player');
  if (s.phase === 'over') fail('The game is over');
  if (action.type === 'resign') {
    if (!player.alive) fail('Already out');
    const wasCurrent = currentPlayer(s) === p;
    s.territories.forEach((t) => {
      if (t.owner === p) Object.assign(t, { owner: -1, horse: false, weapon: false, city: false, boats: [] });
    });
    if (s.conquest.plan?.defender === p) s.conquest.plan = null;
    eliminate(s, p);
    if (s.phase !== 'over') {
      if (s.conquest.plan) s.conquest.plan.allies = s.conquest.plan.allies.filter((a) => a.player !== p);
      if (wasCurrent) {
        if (s.phase === 'select') {
          if (!seekTurn(s, s.turn + 1) && !seekTurn(s, 0)) nextPhase(s);
        } else advanceTurn(s);
      } else if (s.phase === 'production' && !s.placing.length) {
        produce(s);
        nextPhase(s);
      } else if (s.phase === 'trade') {
        maybeEndTrade(s);
      }
    }
    s.version++;
    return s;
  }
  if (!player.alive) fail('You are out of the game');
  if (!actors(s).includes(p)) fail('Not your turn');
  if (needsStockpile(s, p) && action.type !== 'placeStockpile') fail('First choose where to keep your new stockpile');

  switch (action.type) {
    case 'pick': {
      if (s.phase !== 'select') fail('Not choosing territories now');
      const t = s.territories[action.territory];
      if (!t || t.owner !== -1) fail('That territory is taken');
      t.owner = p;
      emit(s, { kind: 'pick', player: p, territory: action.territory });
      // Next living player; at the start of each round, stop when there are
      // not enough territories left for everyone (leftovers stay unclaimed).
      if (!seekTurn(s, s.turn + 1)) {
        const free = s.territories.filter((x) => x.owner === -1).length;
        if (free < alive(s).length || free === 0) nextPhase(s);
        else seekTurn(s, 0);
      }
      break;
    }
    case 'placeStockpile': {
      const midTurn = needsStockpile(s, p);
      if (!midTurn && !(s.phase === 'production' && s.placing.includes(p))) fail('You already have a stockpile');
      if (!owns(s, p, action.territory)) fail('Choose one of your territories');
      player.stockpile = action.territory;
      s.placing = s.placing.filter((x) => x !== p);
      emit(s, { kind: 'stockpile', player: p, territory: action.territory });
      // Mid-turn placement is free: the turn simply carries on.
      if (s.phase === 'production' && !s.placing.length) {
        produce(s);
        nextPhase(s);
      }
      break;
    }
    case 'build': {
      if (s.phase !== 'development') fail('Building happens during development');
      const recipe = recipes(s.settings.level, action.item).find((r) => r.pay === action.pay);
      if (!recipe) fail('You cannot build that');
      if (!canPay(player.stock, recipe!.cost)) fail('Not enough resources');
      if (!canPlace(s, p, action.item, action.territory, action.sea)) fail('You cannot place that there');
      const t = s.territories[action.territory];
      let sea = action.sea;
      if (action.item === 'boat') {
        if (sea === undefined) sea = info(s).territories[action.territory].seas.find((x) => freeBerths(s, action.territory, x) > 0);
        t.boats.push(sea!);
      } else if (action.item === 'weapon') t.weapon = true;
      else t.city = true;
      for (const g of GOODS) player.stock[g] -= recipe!.cost[g];
      emit(s, { kind: 'build', player: p, item: action.item, territory: action.territory, sea });
      break;
    }
    case 'done': {
      if (s.phase !== 'development' && s.phase !== 'shipment' && s.phase !== 'conquest' && s.phase !== 'select') fail('Nothing to finish');
      if (s.phase === 'select') fail('Pick a territory');
      if (s.phase === 'conquest' && s.conquest.plan) fail('Cancel or launch your attack first');
      if (s.phase === 'shipment') emit(s, { kind: 'pass', player: p, reason: 'no shipment' });
      advanceTurn(s);
      break;
    }
    case 'offer': {
      if (s.phase !== 'trade') fail('Not trading now');
      const to = s.players[action.to];
      if (!to || !to.alive || action.to === p) fail('Choose another player');
      if (!isStock(action.give) || !isStock(action.get)) fail('Bad trade');
      if (!canPay(player.stock, action.give)) fail('You do not have that much');
      if (GOODS.every((g) => action.give[g] === 0 && action.get[g] === 0)) fail('Empty trade');
      s.trade.offers.push({ id: s.trade.nextId++, from: p, to: action.to, give: { ...action.give }, get: { ...action.get } });
      s.trade.ready = s.trade.ready.filter((x) => x !== p && x !== action.to);
      break;
    }
    case 'respond': {
      if (s.phase !== 'trade') fail('Not trading now');
      const i = s.trade.offers.findIndex((o) => o.id === action.offer);
      const offer = s.trade.offers[i];
      if (!offer || offer.to !== p) fail('No such offer');
      s.trade.offers.splice(i, 1);
      if (action.accept) {
        const a = s.players[offer.from];
        if (!canPay(a.stock, offer.give)) fail(`${a.name} no longer has those goods`);
        if (!canPay(player.stock, offer.get)) fail('You do not have that much');
        for (const g of GOODS) {
          a.stock[g] += offer.get[g] - offer.give[g];
          player.stock[g] += offer.give[g] - offer.get[g];
        }
        emit(s, { kind: 'trade', from: offer.from, to: p, give: offer.give, get: offer.get });
      }
      break;
    }
    case 'withdraw': {
      if (s.phase !== 'trade') fail('Not trading now');
      const i = s.trade.offers.findIndex((o) => o.id === action.offer && o.from === p);
      if (i < 0) fail('No such offer');
      s.trade.offers.splice(i, 1);
      break;
    }
    case 'ready': {
      if (s.phase !== 'trade') fail('Not trading now');
      s.trade.ready = s.trade.ready.filter((x) => x !== p);
      if (action.ready) s.trade.ready.push(p);
      maybeEndTrade(s);
      break;
    }
    case 'ship': {
      if (s.phase !== 'shipment') fail('Not shipping now');
      validateMove(s, p, action.move);
      doMove(s, p, action.move);
      emit(s, { kind: 'ship', player: p, move: action.move });
      advanceTurn(s);
      break;
    }
    case 'plan': {
      if (s.phase !== 'conquest' || currentPlayer(s) !== p) fail('Not your attack');
      if (s.conquest.plan?.allies.some((a) => a.side !== null)) fail('Allies have already chosen sides');
      planAttack(s, p, action.target, action.force);
      break;
    }
    case 'ally': {
      const plan = s.conquest.plan;
      const entry = plan?.allies.find((a) => a.player === p);
      if (!plan || !entry || entry.side !== null) fail('Nothing to decide');
      if (!['attacker', 'defender', 'neutral'].includes(action.side)) fail('Bad choice');
      entry!.side = action.side;
      break;
    }
    case 'attack': {
      if (s.phase !== 'conquest' || currentPlayer(s) !== p) fail('Not your attack');
      resolveAttack(s, p);
      break;
    }
    case 'cancel': {
      if (s.phase !== 'conquest' || currentPlayer(s) !== p) fail('Not your attack');
      s.conquest.plan = null;
      break;
    }
    case 'moveStockpile': {
      if (s.phase !== 'conquest' || currentPlayer(s) !== p) fail('Not your turn');
      if (s.conquest.plan) fail('Cancel your attack first');
      if (s.conquest.usedStockpileMove) fail('You already moved your stockpile');
      validateMove(s, p, { kind: 'stockpile', to: action.to });
      player.stockpile = action.to;
      s.conquest.usedStockpileMove = true;
      emit(s, { kind: 'ship', player: p, move: { kind: 'stockpile', to: action.to } });
      s.conquest.attacksLeft--;
      if (s.conquest.attacksLeft <= 0) advanceTurn(s);
      break;
    }
    default:
      fail('Unknown action');
  }
  s.version++;
  return s;
}

function maybeEndTrade(s: GameState) {
  if (s.phase !== 'trade') return;
  if (alive(s).every((x) => s.trade.ready.includes(x.id))) {
    s.trade.offers = [];
    nextPhase(s);
  }
}

/** Apply, returning an error message instead of throwing for rule errors. */
export function tryApply(state: GameState, action: Action): { state: GameState; error?: string } {
  try {
    return { state: apply(state, action) };
  } catch (e) {
    if (e instanceof RuleError) return { state, error: e.message };
    throw e;
  }
}

export type { Good };
