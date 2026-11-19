// Shapes shared by the setup screen and network games.

import type { GameState, PlayerSetup, Settings } from './types.ts';

export interface Lobby {
  settings: Settings;
  players: PlayerSetup[];
}

/** What the setup screen shows of a network game's lobby. */
export interface RoomView {
  id: string;
  name: string;
  host: string;
  lobby: Lobby;
  /** Seat index -> device id, for seats a device has claimed. */
  seats: Record<number, string>;
  clients: { id: string; name: string; online: boolean }[];
  state: GameState | null;
}
