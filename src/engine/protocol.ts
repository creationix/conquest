// Messages between devices and the LAN server.

import type { Action, GameState, PlayerSetup, Settings } from './types.ts';

export interface Lobby {
  settings: Settings;
  players: PlayerSetup[];
}

export interface RoomClient {
  id: string;
  name: string;
  online: boolean;
}

export interface RoomView {
  id: string;
  name: string;
  host: string;
  lobby: Lobby;
  /** Seat index -> client id, for human seats that a device has claimed. */
  seats: Record<number, string>;
  clients: RoomClient[];
  state: GameState | null;
}

export interface RoomSummary {
  id: string;
  name: string;
  hostName: string;
  started: boolean;
  over: boolean;
  players: { name: string; color: number; ai: boolean; claimed: boolean }[];
  year: number;
}

export type ClientMessage =
  | { t: 'hello'; clientId: string; name: string }
  | { t: 'list' }
  | { t: 'create'; name: string; lobby: Lobby }
  | { t: 'join'; room: string }
  | { t: 'leave' }
  | { t: 'lobby'; lobby: Lobby }
  | { t: 'claim'; seat: number; claim: boolean }
  | { t: 'start' }
  | { t: 'action'; action: Action }
  | { t: 'close' };

export type ServerMessage =
  | { t: 'welcome'; serverName: string }
  | { t: 'rooms'; rooms: RoomSummary[] }
  | { t: 'room'; room: RoomView }
  | { t: 'state'; state: GameState }
  | { t: 'left' }
  | { t: 'error'; message: string };
