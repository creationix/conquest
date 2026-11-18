import './style.css';
import type { Lobby } from '../engine/protocol.ts';
import { actors, createGame, info } from '../engine/rules.ts';
import { chooseAction } from '../engine/ai.ts';
import { setMood, setupAudio } from './audio.ts';
import { setupInstall } from './pwa.ts';
import { GameScreen } from './game-ui.ts';
import { showRules } from './rules-ui.ts';
import { loadSave, LocalSession, NetSession, clearSave, deviceName, setDeviceName } from './session.ts';
import { hostBanner, loadLobby, renderJoin, renderSetup, saveLobby, showConnecting, showHome } from './setup-ui.ts';
import { loadHosted, normalizeCode, PeerClient, PeerHost, rememberedJoin, type JoinStatus, type Link } from './peer.ts';

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
    const hosted = loadHosted();
    return showHome(root, {
      resume: save ? () => playLocal(save) : null,
      resumeHosted: hosted?.state ? () => hostGame(true) : null,
      newGame: setupLocal,
      host: () => hostGame(false),
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

let linkOff: (() => void) | null = null;
let hosting: PeerHost | null = null;

function closeNet() {
  linkOff?.();
  linkOff = null;
  hosting = null;
}

/** Host a new game, or resume the one this device was hosting. */
function hostGame(resume = false) {
  closeNet();
  const host = new PeerHost(loadLobby(), resume ? loadHosted() : null);
  hosting = host;
  const banner = hostBanner(host.code, host.status);
  host.onStatus = (status, detail) => banner.update(host.code, status, detail);
  runRoom(host.link, {
    banner: banner.el,
    // The host leaving the lobby closes the game for everyone.
    onLeaveLobby: () => {
      if (!confirm('Close this game for everyone?')) return;
      host.close();
      home();
    },
    // Mid-game the host can step away: the game is saved and resumes with the same code.
    onLeaveGame: () => {
      if (!confirm('Others cannot play while you are away. Leave for now? You can continue it from the home screen.')) return;
      host.suspend();
      home();
    },
  });
}

function joinGame(prefill = '') {
  closeNet();
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
  const client = new PeerClient(code);
  const status = (s: JoinStatus) => {
    if (s === 'not-found') {
      client.close();
      alert(`No game found with the code ${code}. Check the code with the host.`);
      joinGame(code);
    } else if (s === 'closed') {
      alert('The host closed the game.');
      home();
    } else if (!client.room) showConnecting(root, code, s, () => (client.close(), home()));
  };
  client.onStatus = status;
  status(client.status);
  runRoom(client, {
    banner: null,
    onLeaveLobby: () => (client.close(), home()),
    onLeaveGame: () => (client.close(), home()),
  });
}

/** Drive the lobby and game screens from a link's room. */
function runRoom(l: Link, opts: { banner: HTMLElement | null; onLeaveLobby: () => void; onLeaveGame: () => void }) {
  let view: 'lobby' | 'game' | null = null;
  let lobbyForm: ReturnType<typeof renderSetup> | null = null;
  const show = () => {
    const room = l.room;
    if (!room) return;
    if (!room.state) {
      const isHost = room.host === l.id;
      const props = {
        title: isHost ? 'Your game' : room.name,
        lobby: room.lobby,
        editable: isHost,
        room,
        myId: l.id,
        extra: opts.banner,
        onChange: (lobby: Lobby) => {
          saveLobby(lobby);
          l.send({ t: 'lobby', lobby });
          lobbyForm?.update({ lobby });
        },
        onClaim: (seat: number, claim: boolean) => l.send({ t: 'claim', seat, claim }),
        onStart: isHost ? () => l.send({ t: 'start' }) : null,
        onBack: opts.onLeaveLobby,
        backLabel: isHost ? 'Close game' : 'Leave',
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
        const session = new NetSession(l);
        const screen = new GameScreen(root, session, opts.onLeaveGame);
        (window as unknown as { __conquest: unknown }).__conquest = { session, screen, chooseAction, actors, info, hosting };
        return () => {
          screen.destroy();
          session.close();
        };
      });
    }
  };
  linkOff?.();
  linkOff = l.on((msg) => {
    if (msg.t === 'error') {
      if (view === 'lobby' && msg.message !== 'Reconnecting…') alert(msg.message);
      return;
    }
    show();
  });
  if (l.room) show();
  else if (l === hosting?.link) l.send({ t: 'hello', clientId: l.id, name: l.name });
}

// ---------------------------------------------------------------------------
// Boot

setupAudio();
setupInstall();
{
  // After a reload, rejoin the game this device was in.
  const joined = rememberedJoin();
  const code = new URLSearchParams(location.search).get('join');
  if (code) joinGame(normalizeCode(code));
  else if (joined) connectTo(joined);
  else home();
}

if ('serviceWorker' in navigator && window.isSecureContext && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
