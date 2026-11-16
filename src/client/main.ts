import './style.css';
import type { Lobby } from '../engine/protocol.ts';
import { actors, createGame } from '../engine/rules.ts';
import { chooseAction } from '../engine/ai.ts';
import { setMood, setupAudio } from './audio.ts';
import { setupInstall } from './pwa.ts';
import { GameScreen } from './game-ui.ts';
import { showRules } from './rules-ui.ts';
import { detectServer, loadSave, LocalSession, NetClient, NetSession, clearSave } from './session.ts';
import { loadLobby, renderNetwork, renderNetworkHelp, renderSetup, saveLobby, showHome } from './setup-ui.ts';

const root = document.getElementById('app')!;
let cleanup: (() => void) | null = null;
let server: { serverName: string; addresses: string[] } | null = null;
let net: NetClient | null = null;
let netOff: (() => void) | null = null;

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
    return showHome(root, {
      resume: save ? () => playLocal(save) : null,
      newGame: setupLocal,
      network: server ? network : null,
      networkHelp: () => swap(() => renderNetworkHelp(root, home)),
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
    const screen = new GameScreen(root, session, home);
    // Hook for automated browser tests.
    (window as unknown as { __conquest: unknown }).__conquest = { session, screen, chooseAction, actors };
    return () => {
      screen.destroy();
      session.close();
    };
  });
}

// ---------------------------------------------------------------------------
// Network

function closeNet() {
  netOff?.();
  netOff = null;
  net?.close();
  net = null;
}

function network() {
  if (!net) net = new NetClient();
  const client = net;
  let view: 'list' | 'lobby' | 'game' | null = null;
  let lobbyForm: ReturnType<typeof renderSetup> | null = null;

  const show = () => {
    const room = client.room;
    const want = !room ? 'list' : room.state ? 'game' : 'lobby';
    if (want === 'list') {
      if (view !== 'list') swap(() => {});
      if (view === 'game') return home();
      view = 'list';
      lobbyForm = null;
      renderNetwork(root, {
        serverName: server?.serverName ?? location.host,
        addresses: server?.addresses ?? [],
        deviceName: client.name,
        rooms: client.rooms,
        connected: client.connected,
        onRename: (n) => client.rename(n),
        onHost: () => client.create(`${client.name}'s game`, loadLobby()),
        onJoin: (id) => client.join(id),
        onBack: home,
      });
      return;
    }
    if (want === 'lobby') {
      const isHost = room!.host === client.id;
      const props = {
        title: isHost ? 'Your game' : `${room!.name}`,
        lobby: room!.lobby,
        editable: isHost,
        room: room!,
        myId: client.id,
        onChange: (l: Lobby) => {
          saveLobby(l);
          client.send({ t: 'lobby', lobby: l });
          lobbyForm?.update({ lobby: l });
        },
        onClaim: (seat: number, claim: boolean) => client.send({ t: 'claim', seat, claim }),
        onStart: isHost ? () => client.send({ t: 'start' }) : null,
        onBack: () => {
          if (isHost && confirm('Close this game for everyone?')) client.send({ t: 'close' });
          else client.leave();
        },
        backLabel: isHost ? 'Close game' : 'Leave',
      };
      if (view === 'lobby' && lobbyForm) {
        lobbyForm.update(props);
      } else {
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
        const session = new NetSession(client);
        const screen = new GameScreen(root, session, () => {
          client.leave();
        });
        (window as unknown as { __conquest: unknown }).__conquest = { session, screen, chooseAction, actors };
        return () => {
          screen.destroy();
          session.close();
        };
      });
    }
  };
  netOff?.();
  netOff = client.on((msg) => {
    if (msg.t === 'error') {
      if (view !== 'game' && msg.message !== 'Reconnecting…') alert(msg.message);
      return;
    }
    show();
  });
  show();
}

// ---------------------------------------------------------------------------
// Boot

setupAudio();
setupInstall();
detectServer().then((info) => {
  server = info;
  // Rejoin a network game after a reload.
  let wasInRoom = false;
  try {
    wasInRoom = !!sessionStorage.getItem('conquest-room');
  } catch {
    /* ignore */
  }
  if (server && wasInRoom) network();
  else home();
});

if ('serviceWorker' in navigator && window.isSecureContext && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
