// Home screen, game setup and the network lobby.

import { GameHost } from '../engine/host.ts';
import type { Lobby, RoomView } from '../engine/protocol.ts';
import { createGame, defaultSettings } from '../engine/rules.ts';
import { COLORS, MAX_PLAYERS, type Level, type PlayerSetup, type Settings } from '../engine/types.ts';
import { play } from './audio.ts';
import { h, mount, svgIcon } from './dom.ts';
import { ICONS, STROKED, type IconName } from './icons.ts';
import { MapRenderer } from './renderer.ts';
import { audioButton } from './game-ui.ts';
import { closeDialog, openDialog } from './dom.ts';
import { installMode, onInstallChange, promptInstall } from './pwa.ts';

/** Home-screen install offer: a real prompt on Chrome/Edge/Android, instructions on iOS. */
function installRow(): { el: HTMLElement; off: () => void } {
  const el = h('div', { style: { marginTop: '10px' } });
  const render = () => {
    const mode = installMode();
    el.hidden = !mode;
    mount(
      el,
      mode
        ? h(
            'button.quiet',
            { style: { width: '100%' }, onclick: () => (mode === 'prompt' ? promptInstall() : showIOSInstall()) },
            icon('download'),
            mode === 'prompt' ? 'Install the app' : `Add to your ${/iPhone/.test(navigator.userAgent) ? 'iPhone' : 'iPad'}`,
          )
        : null,
    );
  };
  render();
  return { el, off: onInstallChange(render) };
}

function showIOSInstall() {
  const dlg = h('dialog') as HTMLDialogElement;
  const safari = !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
  dlg.appendChild(
    h(
      'div',
      h('h2', { style: { marginTop: '0' } }, 'Install Conquest'),
      safari
        ? h(
            'ol',
            { style: { lineHeight: '1.7', paddingLeft: '20px' } },
            h('li', 'Tap the Share button (the square with an arrow) in Safari’s toolbar.'),
            h('li', 'Scroll down and tap “Add to Home Screen”.'),
            h('li', 'Tap “Add”. Conquest opens full screen from its icon and plays offline.'),
          )
        : h('p', 'Open this page in Safari, then use Share → “Add to Home Screen”. Other iOS browsers may not install it as an app.'),
      h('div.row', h('span.spacer'), h('button.primary', { onclick: () => closeDialog(dlg) }, 'Got it')),
    ),
  );
  openDialog(dlg);
}


function icon(name: IconName) {
  return svgIcon(ICONS[name], 'ico' + (STROKED.has(name) ? ' stroke' : ''));
}

// ---------------------------------------------------------------------------
// Home

export interface HomeActions {
  resume: (() => void) | null;
  resumeHosted: (() => void) | null;
  newGame: () => void;
  host: () => void;
  join: () => void;
  rules: () => void;
}

export function showHome(root: HTMLElement, actions: HomeActions): () => void {
  const canvas = h('canvas') as HTMLCanvasElement;
  const install = installRow();
  const card = h(
    'div.menu-card',
    h('div.eyebrow', 'A game of land, wealth and war'),
    h('div.title', 'CONQUEST'),
    h('p.subtitle', 'Claim land. Grow rich. Build cities. Betray your family.'),
    h(
      'div.stack',
      actions.resume ? h('button.primary', { onclick: actions.resume }, 'Continue game') : null,
      actions.resumeHosted ? h('button.primary', { onclick: actions.resumeHosted }, icon('device'), 'Continue network game') : null,
      h('button', { class: actions.resume || actions.resumeHosted ? '' : 'primary', onclick: actions.newGame }, 'New game on this device'),
      h('div.row', { style: { gap: '8px', flexWrap: 'nowrap' } }, h('button', { style: { flex: '1' }, onclick: actions.host }, icon('device'), 'Host a game'), h('button', { style: { flex: '1' }, onclick: actions.join }, 'Join a game')),
      h('button.quiet', { onclick: actions.rules }, icon('scroll'), 'How to play'),
    ),
    h('div.row', { style: { marginTop: '14px', gap: '8px' } }, audioButton('sound'), audioButton('music')),
    install.el,
    h('div.foot', 'Pass and play on one device, or host a game and share its code with other phones, tablets and laptops.'),
  );
  mount(root, h('div.screen.home', canvas, h('div.veil'), card));

  // Attract mode: computer lords battle quietly behind the menu.
  const renderer = new MapRenderer(canvas);
  let host: GameHost | null = null;
  let stopped = false;
  const start = () => {
    if (stopped) return;
    host?.stop();
    const settings: Settings = { ...defaultSettings(), level: 3, chance: 'high', selection: 'deal', seed: 'ATTRACT' + Math.floor(Math.random() * 1e6) };
    const players: PlayerSetup[] = [0, 1, 2, 3, 4].map((c) => ({ name: COLORS[c].name, color: c, ai: true }));
    host = new GameHost(createGame(settings, players), { pace: 0.7 });
    renderer.setState(host.state);
    let last = host.state.eventCount;
    host.subscribe((s) => {
      renderer.setState(s);
      renderer.animateEvents(s.log.filter((e) => e.n >= last));
      last = s.eventCount;
      if (s.phase === 'over') setTimeout(start, 4000);
    });
  };
  start();
  const onVis = () => {
    if (document.hidden) host?.stop();
    else start();
  };
  document.addEventListener('visibilitychange', onVis);
  return () => {
    install.off();
    stopped = true;
    host?.stop();
    renderer.destroy();
    document.removeEventListener('visibilitychange', onVis);
  };
}

// ---------------------------------------------------------------------------
// Setup form (shared by local games and network lobbies)

export function defaultLobby(): Lobby {
  const settings = defaultSettings();
  return {
    settings,
    players: [
      { name: 'Red', color: 0, ai: false },
      { name: 'Blue', color: 1, ai: false },
      { name: 'Green', color: 2, ai: true },
    ],
  };
}

export function loadLobby(): Lobby {
  try {
    const raw = localStorage.getItem('conquest-lobby');
    if (raw) {
      const l = JSON.parse(raw) as Lobby;
      if (l.players?.length >= 2 && l.settings) return { ...l, settings: { ...defaultSettings(), ...l.settings, seed: defaultSettings().seed } };
    }
  } catch {
    /* ignore */
  }
  return defaultLobby();
}

export function saveLobby(l: Lobby) {
  try {
    localStorage.setItem('conquest-lobby', JSON.stringify(l));
  } catch {
    /* ignore */
  }
}

interface SetupOptions {
  title: string;
  lobby: Lobby;
  editable: boolean;
  onChange: (lobby: Lobby) => void;
  onStart: (() => void) | null;
  onBack: () => void;
  /** Network lobbies: seat claims. */
  room?: RoomView;
  myId?: string;
  onClaim?: (seat: number, claim: boolean) => void;
  extra?: HTMLElement | null;
  backLabel?: string;
}

const LEVELS: { v: Level; label: string; help: string }[] = [
  { v: 1, label: 'Beginner', help: 'Only gold and horses. Great for a first game.' },
  { v: 2, label: 'Intermediate', help: 'All five resources: gold, iron, coal, timber and horses.' },
  { v: 3, label: 'Advanced', help: 'Adds boats, so lords can cross the water.' },
  { v: 4, label: 'Expert', help: 'Weapons, horses and boats can also be moved during shipment.' },
];

export function renderSetup(root: HTMLElement, o: SetupOptions): { update: (o2: Partial<SetupOptions>) => void; destroy: () => void } {
  let opts = o;
  const preview = h('canvas.preview') as HTMLCanvasElement;
  const renderer = new MapRenderer(preview);
  let previewKey = '';
  const scroll = h('div.scroll');
  mount(root, h('div.screen', scroll));

  const setSettings = (patch: Partial<Settings>) => {
    const lobby = { ...opts.lobby, settings: { ...opts.lobby.settings, ...patch } };
    // The classic map has islands, so it needs boats.
    if (lobby.settings.map.kind === 'classic' && lobby.settings.level < 3) lobby.settings.level = 3;
    opts.onChange(lobby);
  };
  const setPlayers = (players: PlayerSetup[]) => opts.onChange({ ...opts.lobby, players });

  function seg<T extends string | number>(value: T, options: { v: T; label: string }[], on: (v: T) => void) {
    return h(
      'div.seg',
      options.map((x) =>
        h('button', { 'aria-pressed': String(x.v === value), disabled: !opts.editable, onclick: () => (play('tap'), on(x.v)) }, x.label),
      ),
    );
  }

  function render() {
    const { lobby, editable, room, myId } = opts;
    const s = lobby.settings;
    const used = new Set(lobby.players.map((p) => p.color));
    const rows = lobby.players.map((p, i) => {
      const c = COLORS[p.color];
      const holder = room?.seats[i];
      const holderName = holder ? room?.clients.find((x) => x.id === holder)?.name ?? 'a device' : null;
      return h(
        'div.player-row',
        h('button.swatch', {
          style: { background: c.fill },
          title: 'Change color',
          'aria-label': `Color: ${c.name}`,
          disabled: !editable,
          onclick: () => {
            let next = (p.color + 1) % COLORS.length;
            while (used.has(next) && next !== p.color) next = (next + 1) % COLORS.length;
            const players = lobby.players.slice();
            const wasDefault = COLORS.some((x) => x.name === p.name);
            players[i] = { ...p, color: next, name: wasDefault ? COLORS[next].name : p.name };
            setPlayers(players);
          },
        }),
        h('input', {
          value: p.name,
          maxLength: 16,
          disabled: !editable,
          'aria-label': 'Player name',
          onchange: (e: Event) => {
            const players = lobby.players.slice();
            players[i] = { ...p, name: (e.target as HTMLInputElement).value.trim() || COLORS[p.color].name };
            setPlayers(players);
          },
        }),
        h(
          'div.seg',
          h('button', { 'aria-pressed': String(!p.ai), disabled: !editable, onclick: () => setPlayers(lobby.players.map((x, j) => (j === i ? { ...x, ai: false } : x))) }, 'Person'),
          h('button', { 'aria-pressed': String(p.ai), disabled: !editable, onclick: () => setPlayers(lobby.players.map((x, j) => (j === i ? { ...x, ai: true } : x))) }, icon('computer')),
        ),
        room && !p.ai
          ? holder === myId
            ? h('button.small', { 'aria-pressed': 'true', onclick: () => opts.onClaim?.(i, false) }, icon('check'), 'Me')
            : h('button.small', { onclick: () => opts.onClaim?.(i, true) }, holderName ? `${holderName} · take` : "That's me")
          : null,
        editable && lobby.players.length > 2
          ? h('button.quiet.small', { 'aria-label': 'Remove player', onclick: () => setPlayers(lobby.players.filter((_, j) => j !== i)) }, icon('close'))
          : null,
      );
    });
    const addPlayer = () => {
      const color = COLORS.findIndex((_, i) => !used.has(i));
      if (color < 0) return;
      setPlayers([...lobby.players, { name: COLORS[color].name, color, ai: lobby.players.filter((p) => !p.ai).length >= 2 }]);
    };
    const humans = lobby.players.filter((p) => !p.ai).length;
    const mapKind = s.map.kind === 'classic' ? 'classic' : s.map.size;
    mount(
      scroll,
      h(
        'div.sheet',
        h('div.topbar', h('button.quiet', { onclick: opts.onBack }, '‹ ' + (opts.backLabel ?? 'Back')), h('span.spacer')),
        h('h1', opts.title),
        opts.extra ?? null,
        h('h2', 'Lords'),
        h(
          'div.card',
          rows,
          editable && lobby.players.length < MAX_PLAYERS ? h('div.row', { style: { marginTop: '10px' } }, h('button', { onclick: addPlayer }, icon('plus'), 'Add a lord')) : null,
          room
            ? h('p.muted', { style: { fontSize: '13px', margin: '10px 0 0' } }, "Each person taps \"That's me\" on their own device. Seats nobody claims are played on the host's device, pass-and-play style.")
            : humans > 1
              ? h('p.muted', { style: { fontSize: '13px', margin: '10px 0 0' } }, 'Everyone shares this device and passes it around.')
              : null,
        ),
        h('h2', 'Map'),
        h(
          'div.card',
          preview,
          h(
            'div.option',
            h('label', 'World'),
            seg(mapKind, [
              { v: 'small', label: 'Small' },
              { v: 'medium', label: 'Medium' },
              { v: 'large', label: 'Large' },
              { v: 'classic', label: 'Classic' },
            ], (v) => setSettings({ map: v === 'classic' ? { ...s.map, kind: 'classic' } : { ...s.map, kind: 'random', size: v as 'small' } })),
            h('div.help', s.map.kind === 'classic' ? 'The hand-drawn map from the original 2010 version. Needs boats (Advanced+).' : `${({ small: 24, medium: 34, large: 46 } as Record<string, number>)[s.map.size]} territories.`),
          ),
          s.map.kind === 'random'
            ? h(
                'div.option',
                h('label', 'Water'),
                seg(s.map.water, [
                  { v: 'low', label: 'A little' },
                  { v: 'medium', label: 'Some' },
                  { v: 'high', label: 'Lots' },
                ], (v) => setSettings({ map: { ...s.map, water: v } })),
              )
            : null,
          h(
            'div.option',
            h('label', 'Shuffle'),
            h(
              'div.row',
              h('button', { disabled: !editable, onclick: () => setSettings({ seed: Math.random().toString(36).slice(2, 8).toUpperCase() }) }, '⚄ New map'),
              h('span.muted', { style: { fontSize: '13px' } }, `Seed ${s.seed}`),
            ),
          ),
          h(
            'div.option',
            h('label', 'Lands'),
            seg(s.selection, [
              { v: 'pick', label: 'Take turns choosing' },
              { v: 'deal', label: 'Deal randomly' },
            ], (v) => setSettings({ selection: v })),
          ),
        ),
        h('h2', 'Rules'),
        h(
          'div.card',
          h(
            'div.option',
            h('label', 'Level'),
            seg(s.level, LEVELS.map((l) => ({ v: l.v, label: l.label })), (v) => setSettings({ level: v })),
            h('div.help', LEVELS[s.level - 1].help),
          ),
          h(
            'div.option',
            h('label', 'Chance'),
            seg(s.chance, [
              { v: 'low', label: 'Low' },
              { v: 'medium', label: 'Medium' },
              { v: 'high', label: 'High' },
            ], (v) => setSettings({ chance: v })),
            h(
              'div.help',
              s.chance === 'low'
                ? 'No luck: the stronger side always wins, ties go to the attacker.'
                : s.chance === 'medium'
                  ? 'Ties are a coin toss, and some years have no production, trade or shipment.'
                  : 'Odds follow strength, so underdogs can win. Some years skip phases.',
            ),
          ),
          h(
            'div.option',
            h('label', 'Cities to win'),
            seg(s.citiesToWin, [3, 4, 5, 6].map((n) => ({ v: n, label: String(n) })), (v) => setSettings({ citiesToWin: v })),
          ),
          h(
            'div.option',
            h('label', 'Resources'),
            seg(s.abundance, [
              { v: 'low', label: 'Scarce' },
              { v: 'medium', label: 'Normal' },
              { v: 'high', label: 'Plenty' },
            ], (v) => setSettings({ abundance: v })),
          ),
        ),
        h(
          'div.row',
          { style: { marginTop: '22px' } },
          h('span.spacer'),
          opts.onStart
            ? h('button.primary', { style: { fontSize: '18px', padding: '14px 26px' }, onclick: opts.onStart }, 'Start the game')
            : h('span.muted', editable ? '' : 'Waiting for the host to start…'),
        ),
      ),
    );
    // Preview the map (and resource sites) for these settings.
    const key = JSON.stringify([s.seed, s.map, s.level, s.abundance, lobby.players.length]);
    if (key !== previewKey) {
      previewKey = key;
      try {
        const state = createGame({ ...s, selection: 'pick' }, lobby.players);
        renderer.setState(state);
      } catch {
        /* ignore invalid setups while editing */
      }
    }
  }
  render();
  return {
    update(o2) {
      opts = { ...opts, ...o2 };
      const top = scroll.scrollTop;
      render();
      scroll.scrollTop = top;
    },
    destroy() {
      renderer.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Several devices: the host's code banner, the join screen, connecting.

/** The game code, big, for the host to read out; with the connection status. */
export function hostBanner(code: string, status: string) {
  const el = h('div.card.code-card');
  const update = (c: string, st: string, detail?: string) => {
    mount(
      el,
      h('div.eyebrow', 'Game code'),
      h('div.game-code', c),
      h(
        'p.muted',
        st === 'online'
          ? 'Others tap "Join a game" on their phone, tablet or laptop and enter this code.'
          : detail || (st === 'offline' ? 'Cannot reach the game-code service. Check the internet connection.' : 'Getting the code ready…'),
      ),
      h('div.code-status', { class: st }, st === 'online' ? 'Ready for players' : st === 'offline' ? 'Offline' : 'Connecting…'),
    );
  };
  update(code, status);
  return { el, update };
}

export function renderJoin(
  root: HTMLElement,
  o: { code: string; deviceName: string; onJoin: (code: string, name: string) => void; onBack: () => void },
) {
  const codeInput = h('input.code-input', {
    value: o.code,
    maxLength: 4,
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: false,
    inputMode: 'text',
    placeholder: 'ABCD',
    'aria-label': 'Game code',
  }) as HTMLInputElement;
  const nameInput = h('input', { value: o.deviceName, maxLength: 24, 'aria-label': 'Device name' }) as HTMLInputElement;
  const go = h('button.primary', { style: { fontSize: '18px', padding: '14px 26px', width: '100%' } }, 'Join') as HTMLButtonElement;
  const sync = () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    go.disabled = codeInput.value.length !== 4;
  };
  const submit = () => {
    sync();
    if (!go.disabled) o.onJoin(codeInput.value, nameInput.value.trim() || 'Device');
  };
  codeInput.addEventListener('input', sync);
  codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  go.addEventListener('click', submit);
  sync();
  mount(
    root,
    h(
      'div.screen',
      h(
        'div.scroll',
        h(
          'div.sheet',
          { style: { maxWidth: '460px' } },
          h('div.topbar', h('button.quiet', { onclick: o.onBack }, '‹ Home')),
          h('h1', 'Join a game'),
          h('div.card', h('label', { class: 'muted' }, 'Game code from the host'), codeInput, h('p.muted', { style: { fontSize: '13px', margin: '10px 0 0' } }, 'The host sees it after tapping "Host a game".')),
          h('h2', 'This device'),
          h('div.card', nameInput, h('p.muted', { style: { fontSize: '13px', margin: '8px 0 0' } }, 'A name like "Mom\'s phone" helps everyone see who is playing where.')),
          h('div', { style: { marginTop: '20px' } }, go),
        ),
      ),
    ),
  );
  setTimeout(() => (o.code ? nameInput : codeInput).focus(), 50);
}

export function showConnecting(root: HTMLElement, code: string, status: string, onCancel: () => void) {
  mount(
    root,
    h(
      'div.screen',
      h(
        'div.overlay',
        h(
          'div.card',
          h('div.spinner', { style: { margin: '4px auto 14px', width: '34px', height: '34px' } }),
          h('h2', status === 'offline' ? 'Waiting for the internet…' : status === 'reconnecting' ? 'Reconnecting…' : `Joining ${code}…`),
          h('p', status === 'offline' ? 'Cannot reach the game-code service yet; still trying.' : 'Connecting to the host\'s device.'),
          h('div.stack', h('button', { onclick: onCancel }, 'Cancel')),
        ),
      ),
    ),
  );
}
