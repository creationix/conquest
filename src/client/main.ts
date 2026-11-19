import './style.css';
import type { Lobby, RoomView } from '../engine/protocol.ts';
import { actors, createGame, info } from '../engine/rules.ts';
import { chooseAction } from '../engine/ai.ts';
import { setMood, setupAudio } from './audio.ts';
import { setupInstall } from './pwa.ts';
import { GameScreen } from './game-ui.ts';
import { showRules } from './rules-ui.ts';
import { loadSave, LocalSession, NetSession, clearSave, clientId, deviceName, setDeviceName } from './session.ts';
import { hostBanner, loadLobby, renderJoin, renderSetup, saveLobby, showConnecting, showHome } from './setup-ui.ts';
import { loadNet, NetGame, normalizeCode } from '../net/net.ts';
import type { Room } from '../net/room.ts';

const root = document.getElementById('app')!;
let cleanup: (() => void) | null = null;

function swap(next: () => (() => void) | void) {
  cleanup?.();
  cleanup = null;
  const c = next();
  if (c) cleanup = c;
}

function home() {
  closeNet();
  setMood('peace');
  swap(() => {
    const save = loadSave();
    const net = loadNet();
    return showHome(root, {
      resume: save ? () => playLocal(save) : null,
      resumeHosted: net ? resumeNet : null,
      newGame: setupLocal,
      host: hostGame,
      join: () => joinGame(),
      rules: showRules,
    });
  });
}

function setupLocal() {
  swap(() => {
    let lobby = loadLobby();
    const form = renderSetup(root, {
      title: 'New game',
      lobby,
      editable: true,
      onChange: (l) => {
        lobby = l;
        saveLobby(l);
        form.update({ lobby: l });
      },
      onStart: () => {
        saveLobby(lobby);
        clearSave();
        playLocal(createGame(lobby.settings, lobby.players));
      },
      onBack: home,
    });
    return form.destroy;
  });
}

function playLocal(state: ReturnType<typeof createGame>) {
  swap(() => {
    const session = new LocalSession(state);
    // Play again: same lords and rules, fresh map.
    const rematch = () => {
      const settings = { ...state.settings, seed: Math.random().toString(36).slice(2, 8).toUpperCase() };
      const players = state.players.map((p) => ({ name: p.name, color: p.color, ai: p.ai }));
      clearSave();
      playLocal(createGame(settings, players));
    };
    const screen = new GameScreen(root, session, home, rematch);
    // Hook for automated browser tests.
    (window as unknown as { __conquest: unknown }).__conquest = { session, screen, chooseAction, actors, info };
    return () => {
      screen.destroy();
      session.close();
    };
  });
}

// ---------------------------------------------------------------------------
// Several devices: host a game (shows a code) or join one by its code.
// See docs/network.md; the room and its rules live in src/net/.

let current: NetGame | null = null;
let netOff: (() => void)[] = [];
const ACTIVE_KEY = 'conquest-net-active';

function remember(code: string | null) {
  try {
    if (code) sessionStorage.setItem(ACTIVE_KEY, code);
    else sessionStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

function closeNet() {
  for (const off of netOff) off();
  netOff = [];
  statusPill.remove();
  current = null;
}

function hostGame() {
  closeNet();
  runNet(NetGame.host(clientId(), deviceName(), loadLobby()));
}

function resumeNet() {
  const saved = loadNet();
  if (!saved) return home();
  closeNet();
  runNet(NetGame.resume(clientId(), deviceName(), saved));
}

function joinGame(prefill = '') {
  closeNet();
  remember(null);
  swap(() =>
    renderJoin(root, {
      code: prefill,
      deviceName: deviceName(),
      onBack: home,
      onJoin: (code, name) => {
        setDeviceName(name);
        connectTo(code);
      },
    }),
  );
}

function connectTo(code: string) {
  closeNet();
  const saved = loadNet();
  runNet(saved && saved.code === code ? NetGame.resume(clientId(), deviceName(), saved) : NetGame.join(clientId(), deviceName(), code));
}

/** A small notice over the game while the connection is not right. */
const statusPill = document.createElement('div');
statusPill.className = 'net-pill';

function toView(room: Room): RoomView {
  const seats: Record<number, string> = {};
  room.seats.forEach((c, i) => {
    if (c.kind === 'device') seats[i] = c.id;
  });
  const host = room.devices.find((d) => d.id === room.host);
  return { id: room.code, name: `${host?.name ?? 'Host'}’s game`, host: room.host, lobby: room.lobby, seats, clients: room.devices, state: room.game };
}

/** Drive the connecting, lobby and game screens from a network game. */
function runNet(g: NetGame) {
  current = g;
  let view: 'connecting' | 'lobby' | 'game' | null = null;
  let lobbyForm: ReturnType<typeof renderSetup> | null = null;
  let screen: GameScreen | null = null;
  let banner: ReturnType<typeof hostBanner> | null = null;
  const leave = () => {
    remember(null);
    closeNet();
    home();
  };
  const leaveLobby = () => {
    if (g.isHost) {
      if (!confirm('Close this game for everyone?')) return;
      g.closeForEveryone();
    } else g.leave();
    leave();
  };
  const leaveGame = () => {
    const others = g.room?.devices.some((d) => d.id !== g.me && d.online);
    const msg = g.isHost
      ? others
        ? 'Leave the game? Another device takes over hosting and the computer plays your lords.'
        : 'Leave for now? You can continue this game from the home screen.'
      : 'Leave the game? The computer plays your lords until someone takes them over.';
    if (!confirm(msg)) return;
    g.leave();
    leave();
  };
  const show = () => {
    if (current !== g) return;
    const room = g.room;
    // Ended by the host.
    if (g.status === 'closed' || g.status === 'removed') {
      const removed = g.status === 'removed';
      leave();
      setTimeout(() => alert(removed ? 'The host removed this device from the game.' : 'The host closed the game.'), 50);
      return;
    }
    if (g.status === 'not-found') {
      closeNet();
      alert(`No game found with the code ${g.code}. Check the code with the host.`);
      joinGame(g.code);
      return;
    }
    remember(g.code);
    // Connection notice over the lobby or game.
    const trouble = room && g.status !== 'online' && view !== 'connecting';
    statusPill.textContent = g.status === 'offline' ? 'No internet connection…' : g.isHost ? 'Getting the code ready…' : 'Reconnecting…';
    if (trouble && !statusPill.isConnected) document.body.appendChild(statusPill);
    if (!trouble) statusPill.remove();
    if (!room || (!room.game && !g.isHost && g.status !== 'online')) {
      if (view !== 'connecting') {
        view = 'connecting';
        swap(() => showConnecting(root, g.code, g.status, leaveLobby));
      }
      return;
    }
    if (!room.game) {
      if (g.isHost) {
        banner ??= hostBanner(g.code, g.status);
        banner.update(g.code, g.status);
      } else banner = null;
      const props = {
        title: g.isHost ? 'Your game' : toView(room).name,
        lobby: room.lobby,
        editable: g.isHost,
        room: toView(room),
        myId: g.me,
        extra: banner?.el ?? null,
        onChange: (lobby: Lobby) => {
          saveLobby(lobby);
          g.request({ t: 'setup', lobby });
          lobbyForm?.update({ lobby });
        },
        onClaim: (seat: number, claim: boolean) => g.request({ t: 'seat', seat, to: claim ? 'me' : 'open' }),
        onStart: g.isHost ? () => g.request({ t: 'start' }) : null,
        onBack: leaveLobby,
        backLabel: g.isHost ? 'Close game' : 'Leave',
      };
      if (view === 'lobby' && lobbyForm) lobbyForm.update(props);
      else {
        view = 'lobby';
        swap(() => {
          lobbyForm = renderSetup(root, props);
          return () => lobbyForm?.destroy();
        });
      }
      return;
    }
    if (view !== 'game') {
      view = 'game';
      lobbyForm = null;
      swap(() => {
        const session = new NetSession(g);
        const s = new GameScreen(root, session, leaveGame);
        screen = s;
        session.onRoom = () => s.render();
        (window as unknown as { __conquest: unknown }).__conquest = { session, screen: s, chooseAction, actors, info, net: g };
        return () => {
          screen = null;
          s.destroy();
          session.close();
        };
      });
    }
    void screen;
  };
  netOff.push(g.onChange(show));
  netOff.push(
    g.onError((m) => {
      if (view === 'lobby' && m !== 'Reconnecting…' && m !== 'Not connected yet') alert(m);
    }),
  );
  netOff.push(() => g.end(false));
  show();
}

// ---------------------------------------------------------------------------
// Boot

setupAudio();
setupInstall();
{
  // After a reload, rejoin the game this device was in.
  let active: string | null = null;
  try {
    active = sessionStorage.getItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
  const code = new URLSearchParams(location.search).get('join');
  if (code) joinGame(normalizeCode(code));
  else if (active) connectTo(active);
  else home();
}

if ('serviceWorker' in navigator && window.isSecureContext && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
