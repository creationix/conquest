// Deterministic fantasy names for territories, so players can say
// "I'm attacking Thornwick!" instead of pointing at the screen.

import { Rng } from './rng.ts';

const START = ['Ash', 'Bel', 'Cor', 'Dun', 'El', 'Fen', 'Gal', 'Har', 'Ister', 'Kel', 'Lor', 'Mar', 'Nor', 'Oak', 'Pel', 'Quar', 'Ros', 'Sil', 'Thorn', 'Ul', 'Val', 'Wy', 'Yar', 'Zen', 'Bram', 'Cal', 'Dra', 'Eber', 'Glen', 'Hollow', 'Iron', 'Raven', 'Stone', 'Storm', 'Wolf', 'Amber', 'Black', 'Red', 'Gold', 'Frost'];
const END = ['mere', 'wick', 'ford', 'moor', 'vale', 'gard', 'holm', 'stead', 'ridge', 'haven', 'march', 'fell', 'wood', 'crag', 'shire', 'mark', 'dale', 'reach', 'burg', 'more', 'lund', 'heim', 'by', 'ton', 'wyn', 'garth'];

export function territoryNames(seed: number, count: number): string[] {
  const rng = new Rng(seed ^ 0x5eed);
  const used = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let name = '';
    for (let tries = 0; tries < 50; tries++) {
      const a = rng.pick(START);
      let b = rng.pick(END);
      if (a.toLowerCase().endsWith(b[0])) b = b.slice(1);
      name = a + b;
      if (!used.has(name)) break;
    }
    used.add(name);
    out.push(name);
  }
  return out;
}
