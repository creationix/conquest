// A straightforward computer lord: greedy, a little cautious, never cheats.
// It reads the same state everyone sees and returns one action at a time.

import {
  actors,
  adjacent,
  affordable,
  bearing,
  canPay,
  canPlace,
  cityCount,
  currentPlayer,
  defense,
  freeBerths,
  info,
  needsStockpile,
  neighbors,
  previewAttack,
  recipes,
  territoriesOf,
  tryApply,
  winOdds,
} from './rules.ts';
import { GOODS, type Action, type Force, type GameState, type Item, type Side, type Stock } from './types.ts';

const SITE_VALUE: Record<string, number> = { gold: 3.2, iron: 2, coal: 2, timber: 1.6, horses: 2.2 };

function siteValue(s: GameState, t: number): number {
  const site = s.territories[t].site;
  if (!site) return 0;
  if (s.settings.level === 1 && site !== 'gold' && site !== 'horses') return 0;
  return SITE_VALUE[site] ?? 0;
}

/** How threatened a territory of `p` is: strongest enemy bearing minus its defense. */
function threat(s: GameState, p: number, t: number): number {
  let worst = 0;
  for (const q of s.players) {
    if (!q.alive || q.id === p) continue;
    worst = Math.max(worst, bearing(s, q.id, t));
  }
  return worst - defense(s, t);
}

function leader(s: GameState): number {
  let best = -1;
  let score = -1;
  for (const q of s.players) {
    if (!q.alive) continue;
    const v = cityCount(s, q.id) * 10 + territoriesOf(s, q.id).length;
    if (v > score) {
      score = v;
      best = q.id;
    }
  }
  return best;
}

export function chooseAction(s: GameState, p: number): Action | null {
  if (!actors(s).includes(p)) return null;
  const tryIt = (a: Action | null) => (a && !tryApply(s, a).error ? a : null);
  if (s.placing.includes(p) || needsStockpile(s, p)) return { type: 'placeStockpile', player: p, territory: safest(s, p) };
  switch (s.phase) {
    case 'select':
      return pick(s, p);
    case 'production':
      return { type: 'placeStockpile', player: p, territory: safest(s, p) };
    case 'development':
      return tryIt(develop(s, p)) ?? { type: 'done', player: p };
    case 'trade': {
      const offer = s.trade.offers.find((o) => o.to === p);
      if (offer) return { type: 'respond', player: p, offer: offer.id, accept: judgeTrade(s, p, offer.give, offer.get) };
      const proposal = proposeTrade(s, p);
      if (proposal) return proposal;
      return { type: 'ready', player: p, ready: true };
    }
    case 'shipment':
      return tryIt(ship(s, p)) ?? { type: 'done', player: p };
    case 'conquest': {
      const plan = s.conquest.plan;
      if (plan && currentPlayer(s) !== p) return { type: 'ally', player: p, side: allySide(s, p, plan.target, plan.defender) };
      if (plan) {
        if (plan.allies.some((a) => a.side === null)) return null; // wait for allies
        // Re-check now that neighbors have chosen: back off if it went bad.
        const pv = previewAttack(s, p, plan.target, plan.force);
        let att = pv.attack;
        let def = pv.defense;
        for (const a of plan.allies) {
          if (a.side === 'attacker') att += a.strength;
          if (a.side === 'defender') def += a.strength;
        }
        const threshold = s.settings.chance === 'high' ? 0.55 : 0.5;
        return winOdds(s, att, def) >= threshold ? { type: 'attack', player: p } : { type: 'cancel', player: p };
      }
      if (s.conquest.attacksLeft <= 0) return { type: 'done', player: p };
      return tryIt(conquer(s, p)) ?? { type: 'done', player: p };
    }
  }
  return null;
}

function pick(s: GameState, p: number): Action {
  const map = info(s);
  let best = -1;
  let score = -Infinity;
  s.territories.forEach((t, id) => {
    if (t.owner !== -1) return;
    const ns = map.territories[id].neighbors;
    const mine = ns.filter((n) => s.territories[n].owner === p).length;
    const enemy = ns.filter((n) => s.territories[n].owner >= 0 && s.territories[n].owner !== p).length;
    const v = siteValue(s, id) * 2 + mine * 1.4 - enemy * 0.3 + ns.length * 0.15 + ((id * 7919 + s.version) % 13) / 40;
    if (v > score) {
      score = v;
      best = id;
    }
  });
  return { type: 'pick', player: p, territory: best };
}

function safest(s: GameState, p: number): number {
  const mine = territoriesOf(s, p);
  let best = mine[0];
  let score = -Infinity;
  for (const t of mine) {
    const v = -threat(s, p, t) * 2 + defense(s, t) - (s.territories[t].site ? 0.5 : 0);
    if (v > score) {
      score = v;
      best = t;
    }
  }
  return best;
}

function cheapest(s: GameState, stock: Stock, item: Item) {
  // Spend ordinary goods before gold, which is the flexible currency.
  const options = recipes(s.settings.level, item).filter((r) => canPay(stock, r.cost));
  options.sort((a, b) => a.cost.gold - b.cost.gold);
  return options[0];
}

function develop(s: GameState, p: number): Action | null {
  const items = affordable(s, p);
  const stock = s.players[p].stock;
  const mine = territoriesOf(s, p);
  if (items.includes('city')) {
    const r = cheapest(s, stock, 'city');
    let best = -1;
    let score = -Infinity;
    for (const t of mine) {
      if (!canPlace(s, p, 'city', t)) continue;
      // Cities double nearby production and are prizes: keep them safe.
      let v = siteValue(s, t);
      for (const n of neighbors(s, t)) if (s.territories[n].owner === p) v += siteValue(s, n) * 0.8;
      v -= Math.max(0, threat(s, p, t) + 2) * 0.6;
      if (v > score) {
        score = v;
        best = t;
      }
    }
    if (best >= 0 && r) return { type: 'build', player: p, item: 'city', territory: best, pay: r.pay };
  }
  // Save gold for a city if we are close to affording one.
  const cityGold = stock.gold >= 2 && stock.gold < 4 && cityCount(s, p) < s.settings.citiesToWin;
  if (items.includes('weapon')) {
    const r = cheapest(s, stock, 'weapon');
    if (r && !(r.pay === 'gold' && cityGold && territoriesOf(s, p).length > 3)) {
      let best = -1;
      let score = -Infinity;
      for (const t of mine) {
        if (!canPlace(s, p, 'weapon', t)) continue;
        let v = threat(s, p, t) + (s.territories[t].city ? 3 : 0) + (s.players[p].stockpile === t ? 4 : 0);
        // Also value weapons that border juicy enemy land.
        for (const n of neighbors(s, t)) {
          const o = s.territories[n].owner;
          if (o !== p) v += (siteValue(s, n) + (s.territories[n].city ? 3 : 0)) * 0.3;
        }
        if (v > score) {
          score = v;
          best = t;
        }
      }
      if (best >= 0) return { type: 'build', player: p, item: 'weapon', territory: best, pay: r.pay };
    }
  }
  if (items.includes('boat') && stock.timber >= 3) {
    const t = mine.find((x) => canPlace(s, p, 'boat', x));
    if (t !== undefined) return { type: 'build', player: p, item: 'boat', territory: t, pay: 'goods' };
  }
  return null;
}

function ship(s: GameState, p: number): Action | null {
  const now = s.players[p].stockpile;
  const best = safest(s, p);
  if (now < 0) return { type: 'ship', player: p, move: { kind: 'stockpile', to: best } };
  if (best !== now && threat(s, p, now) > threat(s, p, best) + 1) {
    return { type: 'ship', player: p, move: { kind: 'stockpile', to: best } };
  }
  return null;
}

interface Candidate {
  target: number;
  force: Force | null;
  odds: number;
  value: number;
}

function forcesFor(s: GameState, p: number, target: number): (Force | null)[] {
  const out: (Force | null)[] = [null];
  const T = s.territories;
  const own = (t: number) => T[t].owner === p;
  for (const via of neighbors(s, target)) {
    if (!own(via)) continue;
    for (const from of neighbors(s, via)) {
      if (from === target || !own(from) || !T[from].horse || adjacent(s, from, target)) continue;
      out.push({ kind: 'horse', from, via, weaponFrom: T[from].weapon ? from : T[via].weapon ? via : undefined });
    }
  }
  if (s.settings.level >= 3) {
    const seas = info(s).territories[target].seas;
    s.territories.forEach((t, from) => {
      if (!own(from)) return;
      for (const sea of new Set(t.boats)) {
        if (!seas.includes(sea) || freeBerths(s, target, sea) <= 0) continue;
        // Cargo from a land bordering the target already counts; carry it only from farther away.
        const far = !adjacent(s, from, target);
        out.push({ kind: 'boat', from, sea, horse: far && t.horse, weapon: far && t.weapon });
      }
    });
  }
  return out;
}

/** Lands this lord already attacked or gave up on during this conquest phase. */
function triedThisPhase(s: GameState, p: number): Set<number> {
  const tried = new Set<number>();
  for (let i = s.log.length - 1; i >= 0; i--) {
    const e = s.log[i].event;
    if (e.kind === 'phase') break;
    if (e.kind === 'battle' && e.attacker === p) tried.add(e.target);
    if (e.kind === 'pass' && e.player === p && e.target !== undefined) tried.add(e.target);
  }
  return tried;
}

function conquer(s: GameState, p: number): Action | null {
  const T = s.territories;
  const candidates: Candidate[] = [];
  const lead = leader(s);
  // Never ask the same neighbors about the same land twice in one turn.
  const tried = triedThisPhase(s, p);
  T.forEach((t, target) => {
    if (t.owner === p || tried.has(target)) return;
    for (const force of forcesFor(s, p, target)) {
      const touching = neighbors(s, target).some((n) => T[n].owner === p);
      if (!touching && force?.kind !== 'boat') continue;
      const pv = previewAttack(s, p, target, force);
      if (!pv.possible) continue;
      // Assume undecided third parties split evenly.
      const odds = pv.allies.length ? (pv.best + pv.worst) / 2 : winOdds(s, pv.attack, pv.defense);
      let value = 1 + siteValue(s, target) * 1.5 + (t.city ? 6 : 0) + (t.weapon ? 2 : 0) + (t.horse ? 1 : 0) + t.boats.length;
      if (t.owner >= 0 && s.players[t.owner].stockpile === target) {
        const st = s.players[t.owner].stock;
        value += GOODS.reduce((n, g) => n + st[g], 0) * 1.2 + 2;
      }
      if (t.owner === lead) value += 1.5;
      if (t.owner < 0) value -= 0.5;
      // Risking units costs something if we lose.
      const risk = force ? (force.kind === 'boat' ? 2 : 1) + ('weaponFrom' in force && force.weaponFrom !== undefined ? 2 : 0) : 0;
      candidates.push({ target, force, odds, value: value * odds - (1 - odds) * (risk + 1.5) });
    }
  });
  const threshold = s.settings.chance === 'high' ? 0.55 : 0.5;
  candidates.sort((a, b) => b.value - a.value);
  const best = candidates.find((c) => c.odds >= threshold && c.value > 0.4);
  if (best) return { type: 'plan', player: p, target: best.target, force: best.force };
  // Nothing worth attacking: maybe tuck the stockpile somewhere safer.
  const now = s.players[p].stockpile;
  if (!s.conquest.usedStockpileMove && now >= 0) {
    const safe = safest(s, p);
    if (safe !== now && threat(s, p, now) > 0 && threat(s, p, safe) < threat(s, p, now) - 1) {
      return { type: 'moveStockpile', player: p, to: safe };
    }
  }
  return null;
}

/** How far a lord is ahead of everyone else (cities count most). */
function standing(s: GameState, q: number): number {
  return cityCount(s, q) * 10 + territoriesOf(s, q).length;
}

/** Is this lord clearly ahead of every other lord (not just by a land or two)? */
function runaway(s: GameState, q: number): boolean {
  if (q < 0) return false;
  const mine = standing(s, q);
  const best = Math.max(...s.players.filter((x) => x.alive && x.id !== q).map((x) => standing(s, x.id)));
  return cityCount(s, q) > 0 && mine >= best + 10 ? true : mine >= best * 1.3 + 3;
}

function allySide(s: GameState, p: number, target: number, defender: number): Side {
  const attacker = currentPlayer(s);
  // Gang up only on a lord who is clearly running away with the game.
  if (runaway(s, attacker) && defender >= 0) return 'defender';
  if (runaway(s, defender)) return 'attacker';
  if (defender < 0) return 'neutral';
  // Otherwise mostly stay out; join in only against a neighbor that
  // threatens us far more than the other side does.
  const fromAttacker = territoriesOf(s, p).reduce((n, t) => n + bearing(s, attacker, t), 0);
  const fromDefender = territoriesOf(s, p).reduce((n, t) => n + bearing(s, defender, t), 0);
  void target;
  if (fromAttacker >= fromDefender + 5) return 'defender';
  if (fromDefender >= fromAttacker + 5) return 'attacker';
  return 'neutral';
}

function stockValue(st: Stock, need: Stock): number {
  return GOODS.reduce((n, g) => n + st[g] * (g === 'gold' ? 1.4 : 1) * (need[g] > 0 ? 1.3 : 1), 0);
}

/**
 * At most once per trading phase, offer a trade that helps toward a city:
 * two of something we have plenty of for one of something we lack, to the
 * lord who has the most of it to spare.
 */
function proposeTrade(s: GameState, p: number): Action | null {
  if (s.settings.level < 2) return null;
  // One offer per trading phase: look back to the start of this phase.
  for (let i = s.log.length - 1; i >= 0; i--) {
    const e = s.log[i].event;
    if (e.kind === 'phase') break;
    if (e.kind === 'offer' && e.from === p) return null;
  }
  const me = s.players[p].stock;
  const lacking = GOODS.filter((g) => me[g] === 0);
  const spare = GOODS.filter((g) => me[g] >= (g === 'gold' ? 5 : 3)).sort((a, b) => me[b] - me[a]);
  if (!lacking.length || !spare.length) return null;
  for (const want of lacking) {
    const partners = s.players
      .filter((q) => q.alive && q.id !== p && q.stock[want] >= 2)
      .sort((a, b) => b.stock[want] - a.stock[want]);
    const partner = partners[0];
    const give = spare.find((g) => g !== want);
    if (!partner || !give) continue;
    const g: Stock = { gold: 0, iron: 0, coal: 0, timber: 0 };
    const w: Stock = { gold: 0, iron: 0, coal: 0, timber: 0 };
    g[give] = 2;
    w[want] = 1;
    return { type: 'offer', player: p, to: partner.id, give: g, get: w };
  }
  return null;
}

function judgeTrade(s: GameState, p: number, give: Stock, get: Stock): boolean {
  const me = s.players[p].stock;
  if (!canPay(me, get)) return false;
  // Value what we lack (towards a city: one of each) a bit higher.
  const need: Stock = { gold: me.gold < 1 ? 1 : 0, iron: me.iron < 1 ? 1 : 0, coal: me.coal < 1 ? 1 : 0, timber: me.timber < 1 ? 1 : 0 };
  return stockValue(give, need) >= stockValue(get, need) * 1.1;
}
