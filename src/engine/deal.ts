// "Deal randomly" that is fair rather than purely random.
//
// Players draft territories in snake order (1-2-3, 3-2-1, ...). Starting
// lands are spread far apart. Each later pick prefers:
//   - resources that keep everyone's share even (each resource kind, and
//     barren land too, is split as evenly as the map allows);
//   - land touching the player's own, so realms grow as connected regions.
// A little randomness keeps every deal different.

import { seaNeighbors, type MapInfo } from './map.ts';
import type { Rng } from './rng.ts';
import type { Site } from './types.ts';

type Kind = Site | 'none';

/** Returns the owner (player id) of each territory, -1 for leftovers. */
export function smartDeal(info: MapInfo, sites: (Site | null)[], order: number[], rng: Rng): number[] {
  const n = info.territories.length;
  const players = order.length;
  const each = Math.floor(n / players);
  const owner = new Array<number>(n).fill(-1);
  const sea = info.territories.map((t) => seaNeighbors(info, t.id));

  // Hop distance between territories, across land or water.
  const dist: number[][] = [];
  for (let a = 0; a < n; a++) {
    const d = new Array<number>(n).fill(Infinity);
    d[a] = 0;
    const queue = [a];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi];
      for (const y of [...info.territories[x].neighbors, ...sea[x]]) {
        if (d[y] === Infinity) {
          d[y] = d[x] + 1;
          queue.push(y);
        }
      }
    }
    dist.push(d);
  }

  // Fair shares: how many of each kind every player should end up with.
  const kindOf = (t: number): Kind => sites[t] ?? 'none';
  const total = new Map<Kind, number>();
  for (let t = 0; t < n; t++) total.set(kindOf(t), (total.get(kindOf(t)) ?? 0) + 1);
  const totalSites = sites.filter(Boolean).length;
  const have = order.map(() => new Map<Kind, number>());
  const sitesHave = order.map(() => 0);
  const lands: number[][] = order.map(() => []);

  const take = (i: number, t: number) => {
    owner[t] = order[i];
    lands[i].push(t);
    const k = kindOf(t);
    have[i].set(k, (have[i].get(k) ?? 0) + 1);
    if (k !== 'none') sitesHave[i]++;
  };

  const score = (i: number, t: number): number => {
    let v = rng.next() * 1.2;
    // Keep each kind of land, and resource sites overall, evenly split.
    const k = kindOf(t);
    const share = (total.get(k) ?? 0) / players;
    const got = have[i].get(k) ?? 0;
    v += got + 1 <= Math.ceil(share) ? 4 * (share - got) : -6;
    if (k !== 'none') v += sitesHave[i] + 1 <= Math.ceil(totalSites / players) ? 1 : -5;
    // Grow connected realms: touch your own land, ideally on several sides.
    if (lands[i].length) {
      const touching = info.territories[t].neighbors.filter((x) => owner[x] === order[i]).length;
      const byWater = sea[t].some((x) => owner[x] === order[i]);
      const near = Math.min(...lands[i].map((x) => dist[x][t]));
      v += touching * 2.5 + (touching ? 3 : byWater ? 1 : -2 * near);
      // Stay away from other players' cores, so realms do not interleave.
      for (let j = 0; j < players; j++) {
        if (j !== i && info.territories[t].neighbors.some((x) => owner[x] === order[j])) v -= 0.6;
      }
    }
    return v;
  };

  // Starting lands: as far from each other as possible.
  const starts: number[] = [];
  for (let i = 0; i < players; i++) {
    let best = -1;
    let bestV = -Infinity;
    for (let t = 0; t < n; t++) {
      if (owner[t] >= 0) continue;
      const far = starts.length ? Math.min(...starts.map((x) => dist[x][t])) : 0;
      // Prefer well-connected land (not a lonely islet) and a fair first resource.
      const v = (far === Infinity ? 0 : far) * 3 + Math.min(info.territories[t].neighbors.length, 4) + score(i, t);
      if (v > bestV) {
        bestV = v;
        best = t;
      }
    }
    starts.push(best);
    take(i, best);
  }

  // Snake draft for the rest.
  for (let round = 1; round < each; round++) {
    const seq = round % 2 ? [...order.keys()].reverse() : [...order.keys()];
    for (const i of seq) {
      let best = -1;
      let bestV = -Infinity;
      for (let t = 0; t < n; t++) {
        if (owner[t] >= 0) continue;
        const v = score(i, t);
        if (v > bestV) {
          bestV = v;
          best = t;
        }
      }
      if (best >= 0) take(i, best);
    }
  }
  polish(info, owner, kindOf, total, totalSites, order, rng);
  return owner;
}

/**
 * Hill-climb with swaps between players: accept a swap only when it makes the
 * resource split fairer or the realms more connected, never worse overall.
 */
function polish(
  info: MapInfo,
  owner: number[],
  kindOf: (t: number) => Kind,
  total: Map<Kind, number>,
  totalSites: number,
  order: number[],
  rng: Rng,
) {
  const players = order.length;
  const kinds = [...total.keys()];
  const cost = (): number => {
    let c = 0;
    for (const p of order) {
      const mine: number[] = [];
      owner.forEach((o, t) => o === p && mine.push(t));
      // Fairness: distance from an even share of every kind and of sites overall.
      for (const k of kinds) {
        const got = mine.filter((t) => kindOf(t) === k).length;
        const share = total.get(k)! / players;
        c += 6 * Math.max(0, Math.abs(got - share) - 0.5) ** 2;
      }
      const sites = mine.filter((t) => kindOf(t) !== 'none').length;
      c += 6 * Math.max(0, Math.abs(sites - totalSites / players) - 0.5) ** 2;
      // Shape: few separate regions, no stray lands.
      const seen = new Set<number>();
      for (const t of mine) {
        if (!info.territories[t].neighbors.some((x) => owner[x] === p)) c += 2;
        if (seen.has(t)) continue;
        c += 3;
        const stack = [t];
        seen.add(t);
        while (stack.length) {
          const x = stack.pop()!;
          for (const y of info.territories[x].neighbors) {
            if (owner[y] === p && !seen.has(y)) {
              seen.add(y);
              stack.push(y);
            }
          }
        }
      }
    }
    return c;
  };
  const dealt = owner.map((o, t) => (o >= 0 ? t : -1)).filter((t) => t >= 0);
  let current = cost();
  for (let tries = 0; tries < 1500 && current > 0; tries++) {
    const a = dealt[rng.int(dealt.length)];
    // Swap with a land of another player, preferring a neighbor (keeps borders tidy).
    const near = info.territories[a].neighbors.filter((x) => owner[x] >= 0 && owner[x] !== owner[a]);
    const b = near.length && rng.chance(0.7) ? rng.pick(near) : dealt[rng.int(dealt.length)];
    if (owner[a] === owner[b] || kindOf(a) === kindOf(b) && rng.chance(0.5)) continue;
    [owner[a], owner[b]] = [owner[b], owner[a]];
    const next = cost();
    if (next <= current) current = next;
    else [owner[a], owner[b]] = [owner[b], owner[a]];
  }
}
