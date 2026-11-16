// Owns one authoritative game: applies actions, notifies listeners and lets
// computer players take their turns at a watchable pace. Used in the browser
// for single-device games and on the LAN server for multi-device games.

import { chooseAction } from './ai.ts';
import { actors, tryApply } from './rules.ts';
import type { Action, GameState } from './types.ts';

export interface HostOptions {
  /** Multiplier for computer-player pauses (0 = instant, for tests). */
  pace?: number;
}

export class GameHost {
  state: GameState;
  private listeners = new Set<(state: GameState) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pace: number;
  private stopped = false;

  constructor(state: GameState, options: HostOptions = {}) {
    this.state = state;
    this.pace = options.pace ?? 1;
    this.scheduleAi();
  }

  subscribe(fn: (state: GameState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispatch(action: Action): string | undefined {
    if (this.stopped) return 'Game closed';
    const result = tryApply(this.state, action);
    if (result.error) return result.error;
    this.state = result.state;
    for (const fn of this.listeners) fn(this.state);
    this.scheduleAi();
    return undefined;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  /** Computer players act one at a time, with a pause so people can follow. */
  private scheduleAi() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const s = this.state;
    if (s.phase === 'over') return;
    const ai = actors(s).filter((p) => p >= 0 && s.players[p].ai && s.players[p].alive);
    if (!ai.length) return;
    const delay = this.delayFor(s) * this.pace;
    const run = () => {
      this.timer = null;
      for (const p of ai) {
        const action = chooseAction(this.state, p);
        if (!action) continue;
        let error = this.dispatch(action);
        if (error) {
          // Fall back to passing so a confused computer never stalls the game.
          const fallback: Action =
            this.state.phase === 'trade' ? { type: 'ready', player: p, ready: true } : { type: 'done', player: p };
          error = this.dispatch(fallback);
          if (error && this.state.phase === 'conquest') error = this.dispatch({ type: 'cancel', player: p });
        }
        return;
      }
    };
    if (delay <= 0) {
      // Avoid deep recursion in instant mode.
      this.timer = setTimeout(run, 0);
    } else {
      this.timer = setTimeout(run, delay);
    }
  }

  private delayFor(s: GameState): number {
    switch (s.phase) {
      case 'select':
        return 450;
      case 'production':
        return 600;
      case 'trade':
        return 900;
      case 'conquest':
        return s.conquest.plan ? 1500 : 1100;
      default:
        return 900;
    }
  }
}
