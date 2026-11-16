import type { MapData } from './map.ts';

export type Level = 1 | 2 | 3 | 4;
export type Chance = 'low' | 'medium' | 'high';
export type Abundance = 'low' | 'medium' | 'high';
export type Good = 'gold' | 'iron' | 'coal' | 'timber';
export type Site = Good | 'horses';
export type Item = 'weapon' | 'city' | 'boat';
export type Pay = 'gold' | 'goods';

export const GOODS: readonly Good[] = ['gold', 'iron', 'coal', 'timber'];

export type Stock = Record<Good, number>;

export interface MapChoice {
  kind: 'random' | 'classic';
  size: 'small' | 'medium' | 'large';
  water: 'low' | 'medium' | 'high';
}

export interface Settings {
  level: Level;
  chance: Chance;
  citiesToWin: number;
  abundance: Abundance;
  /** 'pick': players take turns choosing territories; 'deal': random deal. */
  selection: 'pick' | 'deal';
  map: MapChoice;
  seed: string;
}

export interface PlayerSetup {
  name: string;
  color: number;
  ai: boolean;
}

export interface Player extends PlayerSetup {
  id: number;
  alive: boolean;
  stock: Stock;
  /** Territory holding this player's stockpile, or -1 when it must be placed. */
  stockpile: number;
}

export interface TerritoryState {
  owner: number; // -1 = nobody
  site: Site | null;
  horse: boolean;
  weapon: boolean;
  city: boolean;
  /** One entry per boat, holding the id of the sea it floats on. */
  boats: number[];
}

/** Units brought into an attack (one force per attack, as in the original). */
export type Force =
  | { kind: 'horse'; from: number; via?: number; weaponFrom?: number }
  | { kind: 'weapon'; from: number }
  | { kind: 'boat'; from: number; sea: number; horse: boolean; weapon: boolean };

export type Side = 'attacker' | 'defender' | 'neutral';

export interface AttackPlan {
  target: number;
  defender: number;
  force: Force | null;
  /** Third parties with force bearing on the target, and their choices. */
  allies: { player: number; strength: number; side: Side | null }[];
}

export type Move =
  | { kind: 'stockpile'; to: number }
  | { kind: 'weapon'; from: number; to: number }
  | { kind: 'horse'; from: number; via?: number; to: number; weaponFrom?: number }
  | { kind: 'boat'; from: number; sea: number; to: number; horse: boolean; weapon: boolean };

export interface TradeOffer {
  id: number;
  from: number;
  to: number;
  give: Stock;
  get: Stock;
}

export type Phase =
  | 'select'
  | 'development'
  | 'production'
  | 'trade'
  | 'shipment'
  | 'conquest'
  | 'over';

export type GameEvent =
  | { kind: 'phase'; phase: Phase; skipped?: boolean }
  | { kind: 'year'; year: number }
  | { kind: 'pick'; player: number; territory: number }
  | { kind: 'deal' }
  | { kind: 'stockpile'; player: number; territory: number }
  | { kind: 'produce'; player: number; territory: number; good: Good; amount: number }
  | { kind: 'horse'; player: number; territory: number }
  | { kind: 'build'; player: number; item: Item; territory: number; sea?: number }
  | { kind: 'trade'; from: number; to: number; give: Stock; get: Stock }
  | { kind: 'offer'; from: number; to: number; give: Stock; get: Stock }
  | { kind: 'declined'; from: number; to: number }
  | { kind: 'ship'; player: number; move: Move }
  | {
      kind: 'battle';
      attacker: number;
      defender: number;
      target: number;
      force: Force | null;
      attack: number;
      defense: number;
      won: boolean;
      odds: number;
      looted?: Stock;
    }
  | { kind: 'eliminated'; player: number }
  | { kind: 'pass'; player: number; reason: string }
  | { kind: 'win'; player: number; reason: string };

export interface LoggedEvent {
  n: number;
  year: number;
  event: GameEvent;
}

export interface GameState {
  v: 1;
  settings: Settings;
  map: MapData;
  seed: number;
  players: Player[];
  territories: TerritoryState[];
  year: number;
  /** Turn order for this year; rotates by one every year. */
  order: number[];
  phase: Phase;
  /** Index into `order` for turn-based phases. */
  turn: number;
  /** Production: players that still need to place a stockpile. */
  placing: number[];
  conquest: { attacksLeft: number; usedStockpileMove: boolean; plan: AttackPlan | null };
  trade: { offers: TradeOffer[]; ready: number[]; nextId: number };
  winner: number;
  /** Recent events, oldest first; `n` increases forever. */
  log: LoggedEvent[];
  eventCount: number;
  /** Bumped on every successful action. */
  version: number;
}

export type Action =
  | { type: 'pick'; player: number; territory: number }
  | { type: 'placeStockpile'; player: number; territory: number }
  | { type: 'build'; player: number; item: Item; territory: number; pay: Pay; sea?: number }
  | { type: 'done'; player: number }
  | { type: 'offer'; player: number; to: number; give: Stock; get: Stock }
  | { type: 'respond'; player: number; offer: number; accept: boolean }
  | { type: 'withdraw'; player: number; offer: number }
  | { type: 'ready'; player: number; ready: boolean }
  | { type: 'ship'; player: number; move: Move }
  | { type: 'plan'; player: number; target: number; force: Force | null }
  | { type: 'ally'; player: number; side: Side }
  | { type: 'attack'; player: number }
  | { type: 'cancel'; player: number }
  | { type: 'moveStockpile'; player: number; to: number }
  | { type: 'resign'; player: number };

export const COLORS = [
  { name: 'Red', fill: '#ef5b5b', dark: '#8f2530' },
  { name: 'Blue', fill: '#4fa8ec', dark: '#1d4f86' },
  { name: 'Green', fill: '#63c96a', dark: '#24683a' },
  { name: 'Yellow', fill: '#f4cd4c', dark: '#8a6a12' },
  { name: 'Purple', fill: '#a786f2', dark: '#4e3496' },
  { name: 'Orange', fill: '#f59a4a', dark: '#8e4614' },
  { name: 'Teal', fill: '#35cfb0', dark: '#11695d' },
] as const;

export const MAX_PLAYERS = COLORS.length;
