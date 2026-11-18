// The game screen: map, HUD and the context panel for whoever may act on
// this device. When none of this device's seats can act, the screen is a
// read-only view of the other players' turns.

import { hashSeed } from '../engine/rng.ts';
import { territoryNames } from '../engine/names.ts';
import {
  actors,
  adjacent,
  affordable,
  canPay,
  canPlace,
  cityCount,
  currentPlayer,
  defense,
  emptyStock,
  freeBerths,
  info,
  neighbors,
  isDoubled,
  needsStockpile,
  forceBonus,
  previewAttack,
  recipes,
  territoriesOf,
} from '../engine/rules.ts';
import {
  COLORS,
  GOODS,
  type Action,
  type Force,
  type GameState,
  type Item,
  type LoggedEvent,
  type Move,
  type Pay,
  type Phase,
  type Stock,
} from '../engine/types.ts';
import { cycle, level, levelLabel, play, setMood, setMusicActive } from './audio.ts';
import { closeDialog, h, mount, openDialog, svgIcon } from './dom.ts';
import { GOOD_LABELS, ICONS, STROKED, type IconName } from './icons.ts';
import { MapRenderer, type Highlight } from './renderer.ts';
import { showRules } from './rules-ui.ts';
import type { Session } from './session.ts';
import { canFullscreen, isFullscreen, onFullscreenChange, toggleFullscreen } from './pwa.ts';

type ShipKind = Move['kind'];

interface UiState {
  key: string;
  sel: number | null;
  item: Item | null;
  pay: Pay | null;
  sea: number | null;
  ship: { kind: ShipKind | null; from: number | null; to: number | null; horse: boolean; weapon: boolean };
  target: number | null;
  force: number;
  stockpileMode: boolean;
  tradeAs: number;
  /** Set when the player deliberately deselected everyone. */
  tradeCleared?: boolean;
  /** Lords the next offer goes to (several at once is allowed). */
  tradeTo: number[];
  give: Stock;
  get: Stock;
  info: number | null;
}

const PHASE_NAMES: Record<Phase, string> = {
  select: 'Choosing Lands',
  development: 'Development',
  production: 'Production',
  trade: 'Trading',
  shipment: 'Shipment',
  conquest: 'Conquest',
  over: 'Game Over',
};

const ITEM_LABEL: Record<Item, string> = { city: 'City', weapon: 'Weapon', boat: 'Boat' };

function icon(name: IconName, cls = '') {
  return svgIcon(ICONS[name], 'ico' + (STROKED.has(name) ? ' stroke' : '') + (cls ? ' ' + cls : ''));
}

function freshUi(key = ''): UiState {
  return {
    key,
    sel: null,
    item: null,
    pay: null,
    sea: null,
    ship: { kind: null, from: null, to: null, horse: false, weapon: false },
    target: null,
    force: 0,
    stockpileMode: false,
    tradeAs: -1,
    tradeTo: [],
    give: emptyStock(),
    get: emptyStock(),
    info: null,
  };
}

interface ForceOption {
  force: Force | null;
  label: string;
  /** Where the force comes from. */
  place?: string;
  /** Options with the same group are one row; they differ only in cargo. */
  group: string;
  /** Cargo carried in this variant (toggle labels, e.g. '+ weapon'). */
  cargo: string[];
  bonus: number;
  /** A caveat, e.g. that a unit is lost because only one fits. */
  note?: string;
}

export class GameScreen {
  root: HTMLElement;
  session: Session;
  renderer: MapRenderer;
  ui: UiState = freshUi();
  names: string[] = [];
  private el: Record<string, HTMLElement> = {};
  private lastEvent = -1;
  private handoffDone = '';
  private lastSeat = -1;
  private unsub: () => void;
  private onExit: () => void;
  private rosterCompact = false;

  /** Start a new game with the same lords and settings (single-device games). */
  private onRematch: (() => void) | null;

  constructor(root: HTMLElement, session: Session, onExit: () => void, onRematch: (() => void) | null = null) {
    this.root = root;
    this.session = session;
    this.onExit = onExit;
    this.onRematch = onRematch;
    const canvas = h('canvas.map') as HTMLCanvasElement;
    this.el.brand = h('div.float.brand');
    this.el.roster = h('div.float.roster', { onclick: () => this.toggleRoster() });
    this.el.panel = h('div.float.panel');
    this.el.info = h('div.float.infocard', { hidden: true, onclick: () => this.setInfo(null) });
    this.el.toasts = h('div.toasts');
    this.el.banner = h('div.banner', { hidden: true, role: 'status', 'aria-live': 'polite' });
    this.el.notes = h('div.float.yearnotes', { hidden: true });
    this.el.overlay = h('div', { hidden: true });
    this.el.tools = h(
      'div.float.tools',
      h('button.zoom', { title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => this.renderer.zoomBy(1.4) }, icon('plus')),
      h('button.zoom', { title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => this.renderer.zoomBy(1 / 1.4) }, icon('minus')),
      h('button', { title: 'Fit the whole map', 'aria-label': 'Fit the whole map', onclick: () => this.renderer.fit() }, icon('fit')),
    );
    if (canFullscreen()) {
      const fs = h('button', { title: 'Full screen', 'aria-label': 'Full screen', onclick: toggleFullscreen }, icon('fullscreen'));
      this.el.tools.appendChild(fs);
      this.offFullscreen = onFullscreenChange(() => fs.replaceChildren(icon(isFullscreen() ? 'exitFullscreen' : 'fullscreen')));
    }
    this.el.menu = h('div.float.menu-btn', h('button', { title: 'Menu', 'aria-label': 'Menu', onclick: () => this.openMenu() }, icon('menu')));
    this.el.game = h('div.screen.game', canvas, this.el.brand, this.el.roster, this.el.info, this.el.panel, this.el.tools, this.el.menu, this.el.notes, this.el.toasts, this.el.banner, this.el.overlay);
    mount(root, this.el.game);
    // Players start compact on small screens, unless this device chose otherwise.
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('conquest-roster');
    } catch {
      /* ignore */
    }
    this.rosterCompact = saved ? saved === 'compact' : window.innerWidth < 700 || window.innerHeight <= 520;
    this.renderer = new MapRenderer(canvas);
    this.renderer.onTap = (t, cell) => this.tap(t, cell);
    this.session.onError = (msg) => this.toast(msg, true);
    const state = session.state;
    this.names = territoryNames(hashSeed(state.settings.seed), state.territories.length);
    this.lastEvent = state.eventCount - 1;
    this.handoffSeen = state.eventCount - 1;
    this.renderer.setState(state);
    this.unsub = session.subscribe((s) => this.onState(s));
    setMusicActive(true);
    window.addEventListener('resize', this.layout);
    this.render();
  }

  private offFullscreen: () => void = () => {};

  destroy() {
    if (this.handoffTimer) clearTimeout(this.handoffTimer);
    setMusicActive(false);
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.offFullscreen();
    this.unsub();
    this.renderer.destroy();
    window.removeEventListener('resize', this.layout);
  }

  get state(): GameState {
    return this.session.state;
  }

  private player(p: number) {
    return this.state.players[p];
  }

  private color(p: number) {
    if (p < 0) return { fill: '#d9ccab', dark: '#7d6c4b', name: 'Unclaimed' };
    return COLORS[this.player(p).color] ?? COLORS[0];
  }

  private tname(t: number) {
    return this.names[t] ?? `Land ${t + 1}`;
  }


  // -------------------------------------------------------------------------
  // State updates

  private onState(s: GameState) {
    // Network games: launch a planned attack once the server confirms that no
    // third parties need to be asked.
    const auto = this.pendingAutoAttack;
    if (auto) {
      const plan = s.conquest.plan;
      this.pendingAutoAttack = null;
      if (plan && plan.target === auto.target && currentPlayer(s) === auto.seat && !plan.allies.length) {
        this.session.dispatch({ type: 'attack', player: auto.seat });
      }
    }
    const fresh = s.log.filter((e) => e.n > this.lastEvent);
    if (fresh.length) this.lastEvent = fresh[fresh.length - 1].n;
    this.renderer.setState(s);
    this.renderer.animateEvents(fresh);
    this.announce(fresh);
    this.render();
  }

  private announce(events: LoggedEvent[]) {
    // Each kind of event has its own sound. Sounds in one batch are spaced
    // out (cue after the year bell, production one site at a time).
    let cueDelay = 0;
    let produced = 0;
    const colorOf = (p: number) => (p >= 0 ? this.player(p).color : 3);
    const local = (p: number) => p >= 0 && this.session.controls(p);
    for (const { event: e } of events) {
      switch (e.kind) {
        case 'year':
          this.banner({ icon: 'bell', title: `Year ${e.year}`, sub: 'The seasons turn.', sound: 'newYear' });
          cueDelay = 2.4;
          break;
        case 'phase':
          if (e.skipped) {
            const why: Partial<Record<Phase, { title: string; sub: string; sound: 'winter' | 'roadsClosed' | 'storm'; icon: IconName }>> = {
              production: { title: 'A hard winter', sub: 'No production this year.', sound: 'winter', icon: 'timber' },
              trade: { title: 'The roads are closed', sub: 'No trading this year.', sound: 'roadsClosed', icon: 'trade' },
              shipment: { title: 'Storms at sea', sub: 'No shipments this year.', sound: 'storm', icon: 'boat' },
            };
            const w = why[e.phase];
            if (w) this.banner(w);
            else this.toast(`${PHASE_NAMES[e.phase]} skipped`);
          } else {
            const cue: Partial<Record<Phase, Parameters<typeof play>[0]>> = {
              development: 'cueBuild',
              production: 'cueHarvest',
              trade: 'cueMarket',
              shipment: 'cueSail',
              conquest: 'cueWar',
            };
            const c = cue[e.phase];
            if (c) play(c, { delay: cueDelay });
          }
          cueDelay += 0.9;
          break;
        case 'deal':
          play('bell');
          this.toast('The lands have been dealt out.');
          break;
        case 'pick':
          play('flag', { variant: colorOf(e.player) });
          break;
        case 'stockpile':
          play('chest', { variant: colorOf(e.player) });
          break;
        case 'produce':
          // One sound per site, in step with the floating labels (at most a dozen).
          if (produced < 12) play(e.good, { delay: cueDelay + 0.3 + produced * 0.11 });
          produced++;
          break;
        case 'horse':
          if (produced < 12) play('hooves', { delay: cueDelay + 0.3 + produced * 0.11 });
          produced++;
          break;
        case 'build':
          play(e.item, { variant: colorOf(e.player) });
          this.toast(`${this.player(e.player).name} built a ${ITEM_LABEL[e.item].toLowerCase()} in ${this.tname(e.territory)}`, false, e.player);
          break;
        case 'trade':
          // An accepted offer is done: clear the amounts for the next deal.
          if (local(e.from)) {
            this.ui.give = emptyStock();
            this.ui.get = emptyStock();
          }
          play('trade');
          this.toast(`${this.player(e.from).name} and ${this.player(e.to).name} made a trade`, false, e.from);
          break;
        case 'offer':
          // Let people know when someone elsewhere (or a computer) offers them a deal.
          if (local(e.to) && !local(e.from)) {
            play('offer');
            this.toast(`${this.player(e.from).name} offers ${this.player(e.to).name} ${stockText(e.give)} for ${stockText(e.get)}`, false, e.from);
          }
          break;
        case 'declined':
          if (local(e.from)) this.lastDeclined = e.to;
          if (local(e.from) || local(e.to)) {
            play('decline');
            this.toast(`${this.player(e.to).name} turned down ${this.player(e.from).name}'s offer`, false, e.to);
          }
          break;
        case 'ship': {
          const sound = { stockpile: 'chest', weapon: 'weapon', horse: 'hooves', boat: 'splash' } as const;
          play(sound[e.move.kind], { variant: colorOf(e.player) });
          if (e.move.kind === 'stockpile') this.toast(`${this.player(e.player).name} moved their stockpile`, false, e.player);
          else this.toast(`${this.player(e.player).name} moved a ${e.move.kind} to ${this.tname(e.move.to)}`, false, e.player);
          break;
        }
        case 'battle': {
          this.lastBattleAt = performance.now();
          // Bigger battles get bigger drums; the result depends on whose side you're on.
          play('battle', { strength: (e.attack + e.defense) / 16 });
          const a = this.player(e.attacker).name;
          const d = e.defender < 0 ? 'the locals' : this.player(e.defender).name;
          // The totals and odds actually rolled, after any allies joined in.
          const odds = `${e.attack} vs ${e.defense}` + (e.odds > 0 && e.odds < 1 ? `, ${Math.round(e.odds * 100)}% odds` : '');
          const outcome = !e.won ? 'repel' : local(e.attacker) ? 'triumph' : local(e.defender) ? 'loss' : 'win';
          if (!e.looted) play(outcome, { delay: 0.75 });
          if (e.won) this.toast(`${a} conquered ${this.tname(e.target)} from ${d} (${odds})`, false, e.attacker);
          else this.toast(`${d} held ${this.tname(e.target)} against ${a} (${odds})`, false, e.defender);
          if (e.looted) {
            const loot = GOODS.filter((g) => e.looted![g] > 0).map((g) => `${e.looted![g]} ${g}`).join(', ');
            this.banner({ icon: 'stockpile', title: 'Stockpile captured!', sub: `${a} seized ${d}'s treasure${loot ? ': ' + loot : ''}.`, sound: 'plunder', player: e.attacker, delay: 0.75 });
          }
          break;
        }
        case 'eliminated':
          this.banner({ icon: 'shield', title: `${this.player(e.player).name} is defeated`, sub: 'Driven from the map.', sound: 'gong', player: e.player, delay: 1.2 });
          break;
        case 'pass':
          if (e.reason && e.reason !== 'no shipment') this.toast(e.reason, false, e.player);
          else if (!e.reason && e.target !== undefined && !local(e.player)) {
            this.toast(`${this.player(e.player).name} called off the attack on ${this.tname(e.target)}`, false, e.player);
          }
          break;
        case 'win':
          // Background music steps aside for the victory song.
          setMusicActive(false);
          play('victory', { delay: 0.4 });
          this.renderer.celebrate(e.player);
          this.gameOverAt = performance.now() + 5500;
          break;
      }
    }
  }

  // Big announcements: shown one after another, each for a few seconds with its own tune.
  private banners: { icon: IconName; title: string; sub: string; sound: Parameters<typeof play>[0]; player?: number; delay?: number }[] = [];
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;

  private banner(b: GameScreen['banners'][number]) {
    this.banners.push(b);
    if (!this.bannerTimer) this.nextBanner();
  }

  private nextBanner() {
    const b = this.banners.shift();
    const el = this.el.banner;
    if (!b) {
      this.bannerTimer = null;
      el.classList.remove('show');
      setTimeout(() => {
        if (!this.bannerTimer) el.hidden = true;
      }, 400);
      return;
    }
    const start = () => {
      play(b.sound);
      const color = b.player !== undefined ? this.color(b.player).fill : 'var(--accent)';
      mount(el, h('div.badge', { style: { background: color } }, icon(b.icon)), h('div', h('div.title', b.title), h('div.sub', b.sub)));
      el.hidden = false;
      el.classList.remove('show');
      void el.offsetWidth;
      el.classList.add('show');
      this.bannerTimer = setTimeout(() => {
        el.classList.remove('show');
        this.bannerTimer = setTimeout(() => this.nextBanner(), 350);
      }, 2800);
    };
    if (b.delay) this.bannerTimer = setTimeout(start, b.delay * 1000);
    else start();
  }

  toast(text: string, error = false, player = -1) {
    const el = h('div.toast', player >= 0 ? h('span.dot', { style: { background: this.color(player).fill } }) : null, text);
    if (error) el.style.background = '#ffd9d9';
    this.el.toasts.appendChild(el);
    while (this.el.toasts.children.length > (window.innerHeight <= 520 || window.innerWidth <= 600 ? 2 : 3)) this.el.toasts.removeChild(this.el.toasts.firstChild!);
    setTimeout(() => el.classList.add('out'), 3400);
    setTimeout(() => el.remove(), 3900);
  }

  // -------------------------------------------------------------------------
  // Who is acting on this device?

  private localSeats(): number[] {
    return this.state.players.filter((p) => p.alive && this.session.controls(p.id)).map((p) => p.id);
  }

  /** The seat this device should prompt now, and in what role. */
  private acting(): { seat: number; role: 'main' | 'ally' | 'trade' | 'place' } | null {
    const s = this.state;
    if (s.phase === 'over') return null;
    const local = (p: number) => p >= 0 && this.session.controls(p) && s.players[p].alive;
    if (s.phase === 'production' && s.placing.length) {
      const seat = s.placing.find(local);
      return seat === undefined ? null : { seat, role: 'place' };
    }
    // A lord whose stockpile was captured places a new one first thing in their next turn.
    const now = currentPlayer(s);
    if (local(now) && needsStockpile(s, now)) return { seat: now, role: 'place' };
    if (s.phase === 'conquest' && s.conquest.plan) {
      // When the attacker is at this device, neighbors here answer right in
      // the attacker's prompt (no passing the device mid-attack).
      const attackerHere = local(currentPlayer(s));
      const ally = s.conquest.plan.allies.find((a) => a.side === null && local(a.player));
      if (ally && !attackerHere) return { seat: ally.player, role: 'ally' };
    }
    if (s.phase === 'trade') {
      const mine = this.localSeats();
      if (!mine.length) return null;
      const seat = mine.includes(this.ui.tradeAs) ? this.ui.tradeAs : mine[0];
      return { seat, role: 'trade' };
    }
    if (s.phase === 'production') {
      const seat = s.placing.find(local);
      return seat === undefined ? null : { seat, role: 'place' };
    }
    const cur = currentPlayer(s);
    return local(cur) ? { seat: cur, role: 'main' } : null;
  }

  // -------------------------------------------------------------------------
  // Rendering

  /** On phones the prompt can be folded down to its title and buttons to see the map. */
  private panelCollapsed = false;

  private addPanelToggle() {
    const collapsed = this.panelCollapsed;
    this.el.panel.classList.toggle('collapsed', collapsed);
    this.el.panel.appendChild(
      h(
        'button.panel-toggle',
        {
          title: collapsed ? 'Show the whole prompt' : 'Fold the prompt to see the map',
          'aria-label': collapsed ? 'Show the whole prompt' : 'Fold the prompt to see the map',
          'aria-expanded': String(!collapsed),
          onclick: () => {
            this.panelCollapsed = !this.panelCollapsed;
            this.render();
          },
        },
        icon(collapsed ? 'chevronUp' : 'chevronDown'),
      ),
    );
  }

  private layoutKey = '';
  private layoutMode: 'column' | 'bar' | 'topbar' | 'short' = 'topbar';

  /**
   * Place the HUD and frame the map. Three layouts are tried and the one that
   * leaves the biggest map wins: a right-hand column (wide screens), a top bar
   * of player chips with the prompt below (tall screens) and a compact side
   * layout for landscape phones. The choice and the map frame depend only on
   * the screen and the roster, never on the current prompt, so the map stays
   * put while prompts come and go.
   */
  private layout = () => {
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const short = hgt <= 520;
    const narrowPortrait = w <= 600 && hgt > w;
    const key = [w, hgt, this.state.players.length, this.rosterCompact].join(':');
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      if (short) this.layoutMode = 'short';
      else if (narrowPortrait) this.layoutMode = 'topbar';
      else {
        // Prompts like trading need room: the full column only counts when
        // the player list leaves enough space under it.
        const column = this.renderer.scaleFor(this.applyLayout('column'));
        const columnRoom = this.panelRoom;
        const bar = this.renderer.scaleFor(this.applyLayout('bar'));
        const topbar = this.renderer.scaleFor(this.applyLayout('topbar'));
        const roomy = columnRoom >= 480;
        const best = Math.max(roomy ? column : 0, bar, topbar);
        // Prefer the bottom bar (prompts get the whole column), then the
        // stacked column, when they leave (nearly) as much map as the best.
        if (bar >= best * 0.97) this.layoutMode = 'bar';
        else if (roomy && column >= best * 0.97) this.layoutMode = 'column';
        else this.layoutMode = 'topbar';
      }
      // The map frame is fixed until the screen or roster changes; later
      // renders only re-place the HUD around it.
      this.layoutInsets = this.applyLayout(this.layoutMode);
    } else {
      this.applyLayout(this.layoutMode);
    }
    this.renderer.setInsets(this.layoutInsets);
    // Year notes go under the title card (and under the players if they sit below it).
    const b = this.el.brand.getBoundingClientRect();
    const r = this.el.roster.getBoundingClientRect();
    const under = r.left < b.right && r.top >= b.top ? Math.max(b.bottom, r.bottom) : b.bottom;
    this.el.game.style.setProperty('--notes-top', under + 8 + 'px');
  };

  private layoutInsets = { top: 8, right: 8, bottom: 8, left: 8 };
  /** Height available for prompts in the column layouts. */
  private panelRoom = 0;

  /** Arrange the HUD for one layout and return the map insets it leaves. */
  private applyLayout(mode: 'column' | 'bar' | 'topbar' | 'short') {
    const { game, panel, roster, brand, toasts } = this.el;
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const narrowPortrait = w <= 600 && hgt > w;
    const css = getComputedStyle(document.documentElement);
    const safeRight = parseFloat(css.getPropertyValue('--safe-right')) || 0;
    game.classList.remove('column', 'bar', 'topbar', 'short', 'slim', 'tiny', 'phone');
    // The bar layout is the column layout with players moved to the bottom.
    if (mode === 'bar') game.classList.add('column', 'bar');
    else game.classList.add(mode);
    toasts.style.left = '';
    if (mode === 'bar') {
      const sideW = Math.round(Math.min(280, Math.max(240, w * 0.2)));
      const safeLeft = parseFloat(css.getPropertyValue('--safe-left')) || 0;
      game.style.setProperty('--side-w', sideW + 'px');
      const barWidth = w - 24 - safeLeft - (sideW + 24 + safeRight);
      // Narrow chips drop the resource counts, then the names (tap for more).
      const perChip = barWidth / this.state.players.length;
      if (!this.rosterCompact && perChip < 340) game.classList.add('slim');
      if (!this.rosterCompact && perChip < 125) game.classList.add('slim', 'tiny');
      const top = brand.getBoundingClientRect().bottom + 8;
      game.style.setProperty('--panel-top', top + 'px');
      game.style.setProperty('--panel-max', `${hgt - top - 72 - this.notesHeight()}px`);
      this.panelRoom = hgt - top - 72;
      const barTop = roster.getBoundingClientRect().top;
      const insets = { top: 8, right: sideW + 24 + safeRight, bottom: hgt - barTop + 8, left: 8 };
      toasts.style.left = `${(w - insets.right) / 2}px`;
      toasts.style.bottom = `${hgt - barTop + 10}px`;
      return insets;
    }
    if (mode === 'column') {
      const sideW = Math.round(Math.min(260, Math.max(232, w * 0.2)));
      game.style.setProperty('--side-w', sideW + 'px');
      game.style.setProperty('--roster-top', brand.getBoundingClientRect().bottom + 8 + 'px');
      const top = roster.getBoundingClientRect().bottom + 8;
      game.style.setProperty('--panel-top', top + 'px');
      game.style.setProperty('--panel-max', `${hgt - top - 72 - this.notesHeight()}px`);
      this.panelRoom = hgt - top - 72;
      const insets = { top: 8, right: sideW + 24 + safeRight, bottom: 8, left: 8 };
      toasts.style.left = `${(w - insets.right) / 2}px`;
      toasts.style.bottom = '18px';
      return insets;
    }
    if (mode === 'short') {
      const sideW = Math.round(Math.min(360, w * 0.42));
      game.style.setProperty('--side-w', sideW + 'px');
      const top = roster.getBoundingClientRect().bottom + 8;
      game.style.setProperty('--panel-top', top + 'px');
      game.style.setProperty('--panel-max', `${hgt - top - 12}px`);
      const insets = { top: 8, right: sideW + 20 + safeRight, bottom: 8, left: 64 };
      toasts.style.left = `${(insets.left + w - insets.right) / 2}px`;
      toasts.style.bottom = '14px';
      return insets;
    }
    // Top bar (phones in portrait get a slimmer version of it).
    game.classList.toggle('phone', narrowPortrait);
    const b = brand.getBoundingClientRect();
    game.style.setProperty('--roster-left', b.right + 8 + 'px');
    game.style.removeProperty('--roster-top');
    let r = roster.getBoundingClientRect();
    if (narrowPortrait && r.height > b.height + 12) {
      // Too many players to fit beside the title: give them a full-width row below it.
      const safeLeft = parseFloat(css.getPropertyValue('--safe-left')) || 0;
      game.style.setProperty('--roster-left', 10 + safeLeft + 'px');
      game.style.setProperty('--roster-top', b.bottom + 6 + 'px');
      r = roster.getBoundingClientRect();
    }
    // Phones reserve room for a typical (or folded) prompt; a taller prompt
    // may cover the map's edge, but it folds and the map drags.
    const bottom = narrowPortrait ? 10 + Math.min(140, hgt * 0.2) : 12 + Math.min(150, hgt * 0.2);
    const rect = panel.getBoundingClientRect();
    const shown = !panel.hidden && rect.height > 0;
    // Toasts (and the phone map buttons) float just above the prompt.
    toasts.style.bottom = `${(shown ? hgt - rect.top : 70) + 10}px`;
    game.style.setProperty('--tools-bottom', `${(shown ? hgt - rect.top : 10) + 8}px`);
    const top = Math.max(b.bottom, r.bottom, this.el.menu.getBoundingClientRect().bottom) + 6;
    return { top, right: 8, bottom, left: 8 };
  }

  render() {
    const s = this.state;
    const act = this.acting();
    const key = [s.phase, s.year, s.turn, act?.seat ?? -1, act?.role ?? '', s.conquest.plan ? 'p' : ''].join(':');
    if (key !== this.ui.key) {
      const keep = { tradeAs: this.ui.tradeAs, info: this.ui.info };
      this.ui = { ...freshUi(key), ...keep };
    }
    this.boatGhosts = [];
    // Music turns martial during conquest.
    setMood(s.phase === 'conquest' ? 'war' : 'peace');
    this.renderBrand();
    this.renderNotes();
    this.renderRoster(act?.seat ?? -1);
    this.renderInfo();
    if (s.phase === 'over') {
      mount(this.el.panel);
      this.el.panel.hidden = true;
      this.renderer.setHighlight({});
      this.showGameOver();
      return;
    }
    this.el.panel.hidden = false;
    // Hand the device over when a different person needs to act.
    const multi = this.localSeats().length > 1;
    const handKey = act ? `${act.seat}:${act.role}:${s.phase}:${s.year}` : '';
    if (act && multi && act.role !== 'trade' && act.role !== 'ally' && act.seat !== this.lastSeat && this.handoffDone !== handKey) {
      // Let a battle (animation, messages, announcements) play out before
      // the device is handed over and the screen is covered.
      const wait = Math.max(this.lastBattleAt + 2600 - performance.now(), this.bannerTimer ? 400 : 0);
      if (wait > 0) {
        this.el.overlay.hidden = true;
        this.renderer.setHighlight(this.renderWaiting(this.el.panel));
        if (!this.handoffTimer) this.handoffTimer = setTimeout(() => ((this.handoffTimer = null), this.render()), wait);
        return;
      }
      this.showHandoff(act.seat, act.role, handKey);
      return;
    }
    this.el.overlay.hidden = true;
    if (act && act.role !== 'ally') this.lastSeat = act.seat;
    const hl = this.renderPanel(act);
    this.addPanelToggle();
    this.renderer.setHighlight(hl);
    this.layout();
  }

  /** Persistent notes on what this year skipped (the banners fade, these stay). */
  private renderNotes() {
    const s = this.state;
    const skipped = s.log.filter((e) => e.year === s.year && e.event.kind === 'phase' && e.event.skipped).map((e) => (e.event as { phase: Phase }).phase);
    const lines: Partial<Record<Phase, [IconName, string]>> = {
      production: ['timber', 'Hard winter: no production'],
      trade: ['trade', 'Roads closed: no trading'],
      shipment: ['boat', 'Storms at sea: no shipments'],
    };
    const shown = skipped.filter((p) => lines[p]);
    this.el.notes.hidden = !shown.length || s.phase === 'over';
    mount(
      this.el.notes,
      h('div.eyebrow', `Year ${s.year}`),
      shown.map((p) => h('div.note', icon(lines[p]![0]), lines[p]![1])),
    );
  }

  private notesHeight() {
    return this.el.notes.hidden ? 0 : this.el.notes.getBoundingClientRect().height + 8;
  }

  private renderBrand() {
    const s = this.state;
    const list: Phase[] = s.year === 1 ? ['production', 'trade', 'shipment', 'conquest'] : ['development', 'production', 'trade', 'shipment', 'conquest'];
    const idx = list.indexOf(s.phase);
    const skipped = new Set(s.log.filter((e) => e.year === s.year && e.event.kind === 'phase' && e.event.skipped).map((e) => (e.event as { phase: Phase }).phase));
    mount(
      this.el.brand,
      h('div.name', 'CONQUEST'),
      h('div.phase', PHASE_NAMES[s.phase], s.phase === 'select' || s.phase === 'over' ? null : h('span.yr', ` · Year ${s.year}`)),
      h('div.year', s.phase === 'select' ? 'Claim your lands' : `Year ${s.year} · first to ${s.settings.citiesToWin} cities`),
      s.phase === 'select' || s.phase === 'over'
        ? null
        : h('div.track', list.map((p, i) => h('span', { class: p === s.phase ? 'on' : skipped.has(p) ? 'skip' : i < idx ? 'done' : '', title: PHASE_NAMES[p] }))),
    );
  }

  private toggleRoster() {
    this.rosterCompact = !this.rosterCompact;
    try {
      localStorage.setItem('conquest-roster', this.rosterCompact ? 'compact' : 'full');
    } catch {
      /* ignore */
    }
    this.render();
  }

  private renderRoster(acting: number) {
    const s = this.state;
    const turn = actors(s);
    this.el.roster.classList.toggle('compact', this.rosterCompact);
    const rows = s.order.map((pid) => {
      const p = s.players[pid];
      const c = this.color(pid);
      const where = this.session.whereIs(pid);
      const isTurn = turn.includes(pid) && s.phase !== 'trade';
      const ready = s.phase === 'trade' && s.trade.ready.includes(pid);
      return h(
        'div.prow',
        { class: [isTurn ? 'turn' : '', p.alive ? '' : 'out'].join(' ') },
        h('span.swatch-sm', { style: { background: c.fill } }, p.ai ? icon('computer') : pid === acting ? icon('star') : null),
        h(
          'span.pname',
          p.name,
          this.rosterCompact ? null : h('small', p.ai ? 'AI' : where === 'this device' ? '' : where),
          ready ? h('span.ready-mark', ' ✓') : null,
        ),
        h('span.cities', { title: 'Cities' }, icon('city'), String(cityCount(s, pid))),
        h(
          'div.goods',
          GOODS.map((g) => h('span', { title: GOOD_LABELS[g] }, goodIcon(g), String(p.stock[g]))),
          h('span', { title: 'Territories' }, icon('shield'), String(territoriesOf(s, pid).length)),
        ),
      );
    });
    // A visible handle for the collapse (the whole list also toggles on tap).
    const toggle = h(
      'button.roster-toggle',
      {
        title: this.rosterCompact ? 'Show names and resources' : 'Show only colors and cities',
        'aria-label': this.rosterCompact ? 'Show names and resources' : 'Show only colors and cities',
        'aria-expanded': String(!this.rosterCompact),
      },
      icon(this.rosterCompact ? 'chevronDown' : 'chevronUp'),
    );
    mount(this.el.roster, rows, toggle);
  }

  private setInfo(t: number | null) {
    this.ui.info = t;
    this.renderInfo();
  }

  private renderInfo() {
    const t = this.ui.info;
    const el = this.el.info;
    if (t === null || t < 0 || !this.state.territories[t]) {
      el.hidden = true;
      return;
    }
    const s = this.state;
    const ts = s.territories[t];
    const c = this.color(ts.owner);
    const facts: (HTMLElement | null)[] = [];
    if (ts.site) facts.push(h('span', siteIcon(ts.site), GOOD_LABELS[ts.site] + (isDoubled(s, t) ? ' ×2 (city)' : '')));
    if (ts.city) facts.push(h('span', icon('city'), 'City'));
    if (ts.weapon) facts.push(h('span', icon('weapon'), 'Weapon'));
    if (ts.horse) facts.push(h('span', icon('horse'), 'Horse'));
    if (ts.boats.length) facts.push(h('span', icon('boat'), ts.boats.length > 1 ? `${ts.boats.length} boats` : 'Boat'));
    if (ts.owner >= 0 && s.players[ts.owner].stockpile === t) facts.push(h('span', icon('stockpile'), 'Stockpile'));
    facts.push(h('span', icon('shield'), `Defense ${defense(s, t)}`));
    el.hidden = false;
    mount(
      el,
      h('span.swatch-sm', { style: { background: c.fill, width: '30px', height: '30px', borderRadius: '9px', flexShrink: '0' } }),
      h('div', h('b', this.tname(t)), h('span.muted', ' · ' + (ts.owner < 0 ? 'Unclaimed' : this.player(ts.owner).name)), h('div.facts', facts)),
    );
  }

  // -------------------------------------------------------------------------
  // Panels

  private who(seat: number, title: string, sub?: string | HTMLElement | null) {
    const c = this.color(seat);
    return h(
      'div',
      h('div.who', h('span.swatch-sm', { style: { background: c.fill } }), h('h3', title)),
      sub ? (typeof sub === 'string' ? h('p', sub) : sub) : null,
    );
  }

  private renderPanel(act: ReturnType<GameScreen['acting']>): Highlight {
    const panel = this.el.panel;
    if (!act) return this.renderWaiting(panel);
    switch (act.role) {
      case 'ally':
        return this.renderAlly(panel, act.seat);
      case 'trade':
        return this.renderTrade(panel, act.seat);
      case 'place':
        return this.renderPlace(panel, act.seat);
    }
    switch (this.state.phase) {
      case 'select':
        return this.renderSelect(panel, act.seat);
      case 'development':
        return this.renderDevelop(panel, act.seat);
      case 'shipment':
        return this.renderShip(panel, act.seat);
      case 'conquest':
        return this.renderConquest(panel, act.seat);
    }
    return {};
  }

  private renderWaiting(panel: HTMLElement): Highlight {
    const s = this.state;
    const who = actors(s);
    const names = who.map((p) => `${this.player(p).name}${this.session.whereIs(p) === 'computer' ? '' : ` (${this.session.whereIs(p)})`}`);
    let doing = '';
    switch (s.phase) {
      case 'select':
        doing = 'is choosing a territory';
        break;
      case 'production':
        doing = 'must place a stockpile';
        break;
      case 'development':
        doing = 'is building';
        break;
      case 'trade':
        doing = 'still trading';
        break;
      case 'shipment':
        doing = 'is shipping';
        break;
      case 'conquest':
        doing = needsStockpile(s, currentPlayer(s)) ? 'is choosing where to keep a new stockpile' : s.conquest.plan ? 'is planning an attack' : 'is on the attack';
        break;
    }
    const hl: Highlight = {};
    const plan = s.conquest.plan;
    if (s.phase === 'conquest' && plan) {
      hl.target = plan.target;
      if (plan.force) hl.arrows = [{ from: plan.force.from, to: plan.target, color: this.color(currentPlayer(s)).fill }];
      const waitingAllies = plan.allies.filter((a) => a.side === null).map((a) => this.player(a.player).name);
      if (waitingAllies.length) doing = `is attacking ${this.tname(plan.target)}; waiting for ${waitingAllies.join(' and ')} to choose a side`;
    }
    const lead = who.length ? who[0] : -1;
    const title = who.length === 1 ? `${names[0]} ${doing}` : `Waiting for ${names.join(', ')}`;
    mount(
      panel,
      h('div.waiting', h('span.spinner'), h('div', h('h3', title), h('p', 'Tap any territory to inspect it.'))),
      lead >= 0 ? null : null,
    );
    return hl;
  }

  private renderSelect(panel: HTMLElement, seat: number): Highlight {
    const s = this.state;
    const free = new Set(s.territories.map((t, i) => (t.owner === -1 ? i : -1)).filter((i) => i >= 0));
    const sel = this.ui.sel;
    const p = this.player(seat);
    mount(
      panel,
      this.who(seat, `${p.name}, claim a territory`, sel === null ? 'Tap any unclaimed land. Resource sites and lands next to your own are good picks.' : null),
      sel !== null ? this.territoryLine(sel) : null,
      h(
        'div.actions',
        h('span.spacer'),
        h('button.primary', { disabled: sel === null, onclick: () => this.act({ type: 'pick', player: seat, territory: sel! }) }, sel === null ? 'Claim' : `Claim ${this.tname(sel)}`),
      ),
    );
    return { selectable: free, selected: sel !== null ? [sel] : [] };
  }

  private renderPlace(panel: HTMLElement, seat: number): Highlight {
    const mine = new Set(territoriesOf(this.state, seat));
    const sel = this.ui.sel;
    const p = this.player(seat);
    const lost = this.state.phase !== 'production' || this.state.year > 1;
    mount(
      panel,
      this.who(
        seat,
        `${p.name}, place your stockpile`,
        lost
          ? this.state.phase === 'production'
            ? 'You have new goods but no stockpile (yours was captured). Choose where to keep them.'
            : 'You have goods but no stockpile. Choose where to keep them; this does not use up your turn.'
          : 'Your first harvest is in! Choose where to keep your stockpile: it holds all your gold, iron, coal and timber. If an enemy conquers that land, they take everything.',
      ),
      sel !== null ? this.territoryLine(sel) : null,
      h(
        'div.actions',
        h('span.spacer'),
        h('button.primary', { disabled: sel === null, onclick: () => this.act({ type: 'placeStockpile', player: seat, territory: sel! }) }, sel === null ? 'Place stockpile' : `Keep it in ${this.tname(sel)}`),
      ),
    );
    return { selectable: mine, selected: sel !== null ? [sel] : [] };
  }

  private territoryLine(t: number) {
    const s = this.state;
    const ts = s.territories[t];
    const bits = [ts.site ? GOOD_LABELS[ts.site] + (isDoubled(s, t) ? ' ×2' : '') : 'No resources', ts.city ? 'City' : '', ts.weapon ? 'Weapon' : '', ts.horse ? 'Horse' : '', `Defense ${defense(s, t)}`].filter(Boolean);
    return h('p', h('b', { style: { color: 'var(--text)' } }, this.tname(t)), ' · ', bits.join(' · '));
  }

  // Development ---------------------------------------------------------------

  private boatGhosts: { sea: number; cell: number }[] = [];

  /** Name bodies of water by where they lie on screen: "North water", "East water". */
  private waterNames(t: number, seas: number[]): string[] {
    const s = this.state;
    const map = s.map;
    const anchor = info(s).territories[t].anchor;
    const ax = anchor % map.width;
    const ay = Math.floor(anchor / map.width);
    const dirs = ['East', 'North-east', 'North', 'North-west', 'West', 'South-west', 'South', 'South-east'];
    const names = seas.map((sea) => {
      const berths = info(s).territories[t].coast[sea];
      let dx = 0;
      let dy = 0;
      for (const c of berths) {
        dx += (c % map.width) - ax;
        dy += Math.floor(c / map.width) - ay;
      }
      // Name directions as seen on screen, even when the map is turned.
      if (this.renderer.rotated) [dx, dy] = [-dy, dx];
      const sector = Math.round(Math.atan2(-dy, dx) / (Math.PI / 4));
      return dirs[(sector + 8) % 8];
    });
    return names.map((n, i) => (names.indexOf(n) !== names.lastIndexOf(n) ? `${n} water ${names.slice(0, i + 1).filter((x) => x === n).length}` : `${n} water`));
  }

  private renderDevelop(panel: HTMLElement, seat: number): Highlight {
    const s = this.state;
    const p = this.player(seat);
    const level = s.settings.level;
    const items: Item[] = level >= 3 ? ['city', 'weapon', 'boat'] : ['city', 'weapon'];
    const can = affordable(s, seat);
    const ui = this.ui;
    if (ui.item && !can.includes(ui.item)) ui.item = null;
    const choices = items.map((item) => {
      const rs = recipes(level, item);
      return h(
        'button',
        {
          'aria-pressed': String(ui.item === item),
          disabled: !can.includes(item),
          onclick: () => {
            ui.item = item;
            ui.sel = null;
            ui.pay = null;
            play('tap');
            this.render();
          },
        },
        icon(item),
        h('b', ITEM_LABEL[item]),
        h('small', rs.map((r) => costText(r.cost)).join(' or ')),
      );
    });
    let hl: Highlight = {};
    let detail: HTMLElement | null = null;
    if (ui.item) {
      const item = ui.item;
      const places = new Set(territoriesOf(s, seat).filter((t) => canPlace(s, seat, item, t)));
      hl = { selectable: places, selected: ui.sel !== null ? [ui.sel] : [] };
      const payable = recipes(level, item).filter((r) => canPay(p.stock, r.cost));
      if (!ui.pay || !payable.some((r) => r.pay === ui.pay)) ui.pay = (payable.find((r) => r.pay === 'goods') ?? payable[0])?.pay ?? null;
      const payRow =
        payable.length > 1
          ? h(
              'div.row',
              { style: { marginTop: '10px' } },
              h('span.muted', 'Pay with'),
              h(
                'div.seg',
                payable.map((r) =>
                  h('button', { 'aria-pressed': String(ui.pay === r.pay), onclick: () => ((ui.pay = r.pay), this.render()) }, costText(r.cost)),
                ),
              ),
            )
          : null;
      let seaRow: HTMLElement | null = null;
      this.boatGhosts = [];
      if (item === 'boat' && ui.sel !== null) {
        const t = ui.sel;
        const seas = info(s).territories[t].seas.filter((x) => freeBerths(s, t, x) > 0);
        if (ui.sea === null || !seas.includes(ui.sea)) ui.sea = seas[0] ?? null;
        // Where the new boat would float on each body of water.
        const names = this.waterNames(t, seas);
        this.boatGhosts = seas.map((sea) => ({ sea, cell: info(s).territories[t].coast[sea][s.territories[t].boats.filter((b) => b === sea).length] }));
        const c = this.color(seat);
        hl.ghosts = this.boatGhosts.map((g) => ({ cell: g.cell, fill: c.fill, dark: c.dark, selected: g.sea === ui.sea }));
        if (seas.length > 1) {
          seaRow = h(
            'div',
            h(
              'div.row',
              { style: { marginTop: '10px' } },
              h('span.muted', 'Launch on'),
              h('div.seg', seas.map((x, i) => h('button', { 'aria-pressed': String(ui.sea === x), onclick: () => ((ui.sea = x), this.render()) }, names[i]))),
            ),
            h('p', 'The glowing boat on the map shows where it will float. Tap another faded boat to switch.'),
          );
        }
      }
      const hint: Record<Item, string> = {
        city: 'Cities double the gold, iron, coal and timber of their land and their neighbors, and add 2 to defense. Build enough to win!',
        weapon: 'A weapon adds 3 to attacks and defense of nearby land.',
        boat: 'Boats carry forces across water and add 2 to an attack.',
      };
      detail = h(
        'div',
        h('p', ui.sel === null ? `Tap where to build. ${hint[item]}` : null),
        ui.sel !== null ? this.territoryLine(ui.sel) : null,
        payRow,
        seaRow,
      );
    }
    mount(
      panel,
      this.who(seat, `${p.name}, build`, h('p', 'Your stockpile: ', stockView(p.stock))),
      h('div.choice.one-row', choices),
      can.length
        ? null
        : h(
            'p',
            p.stockpile < 0
              ? 'Your stockpile was captured, so there is nothing to spend. Production comes next.'
              : "You can't afford anything yet. Production comes next, so save up! A city is the way to win.",
          ),
      detail,
      h(
        'div.actions',
        h('button', { onclick: () => this.act({ type: 'done', player: seat }) }, 'Done building'),
        h('span.spacer'),
        ui.item
          ? h(
              'button.primary',
              {
                disabled: ui.sel === null || !ui.pay,
                onclick: () =>
                  this.act({ type: 'build', player: seat, item: ui.item!, territory: ui.sel!, pay: ui.pay!, sea: ui.item === 'boat' ? ui.sea ?? undefined : undefined }),
              },
              ui.sel === null ? `Build ${ITEM_LABEL[ui.item].toLowerCase()}` : `Build in ${this.tname(ui.sel)}`,
            )
          : null,
      ),
    );
    return hl;
  }

  // Trading -------------------------------------------------------------------

  private renderTrade(panel: HTMLElement, seat: number): Highlight {
    const s = this.state;
    const ui = this.ui;
    ui.tradeAs = seat;
    const me = this.player(seat);
    const mine = this.localSeats();
    const others = s.players.filter((p) => p.alive && p.id !== seat);
    ui.tradeTo = ui.tradeTo.filter((id) => others.some((o) => o.id === id));
    if (!ui.tradeTo.length && others.length && !ui.tradeCleared) ui.tradeTo = [others[0].id];
    const ready = s.trade.ready.includes(seat);
    const incoming = s.trade.offers.filter((o) => o.to === seat);
    const outgoing = s.trade.offers.filter((o) => o.from === seat);
    const stillTrading = s.players.filter((p) => p.alive && !s.trade.ready.includes(p.id)).map((p) => p.name);

    const asRow =
      mine.length > 1
        ? h(
            'div.row',
            { style: { marginTop: '8px' } },
            h('span.muted', 'Trading as'),
            h('div.seg', mine.map((id) => h('button', { 'aria-pressed': String(id === seat), onclick: () => ((ui.tradeAs = id), (ui.give = emptyStock()), (ui.get = emptyStock()), this.render()) }, this.player(id).name))),
          )
        : null;

    const incomingLine = (o: (typeof s.trade.offers)[number]) =>
      h(
        'div.offer',
        h('span.dot', { style: { background: this.color(o.from).fill } }),
        h('span', h('b', this.player(o.from).name), ' gives ', stockView(o.give, true), ' for ', stockView(o.get, true)),
        h('span.spacer'),
        h('button.small.primary', { disabled: !canPay(me.stock, o.get), onclick: () => this.act({ type: 'respond', player: seat, offer: o.id, accept: true }) }, 'Accept'),
        h('button.small', { onclick: () => this.act({ type: 'respond', player: seat, offer: o.id, accept: false }) }, 'Decline'),
      );
    // Outgoing offers: copies sent to several lords show as one line.
    const groups = new Map<number, (typeof s.trade.offers)[number][]>();
    for (const o of outgoing) {
      const k = o.group ?? -o.id;
      groups.set(k, [...(groups.get(k) ?? []), o]);
    }
    const outgoingLine = (list: (typeof s.trade.offers)[number][]) =>
      h(
        'div.offer',
        list.map((o) => h('span.dot', { style: { background: this.color(o.to).fill } })),
        h(
          'span',
          'To ',
          h('b', list.map((o) => this.player(o.to).name).join(', ')),
          ': ',
          stockView(list[0].give, true),
          ' for ',
          stockView(list[0].get, true),
          list.length > 1 ? h('small.muted', ' (first to accept)') : null,
        ),
        h('span.spacer'),
        h('button.small', { onclick: () => list.forEach((o) => this.session.dispatch({ type: 'withdraw', player: seat, offer: o.id })) }, 'Withdraw'),
      );

    const partners = ui.tradeTo;
    const partnerLocal = partners.length === 1 && this.session.controls(partners[0]);
    // The most any chosen partner could give of each good.
    const theirs = emptyStock();
    for (const id of partners) for (const g of GOODS) theirs[g] = Math.max(theirs[g], this.player(id).stock[g]);
    const cell = (stock: Stock, g: (typeof GOODS)[number], max: number, note: string) =>
      h(
        'span.trade-cell',
        h(
          'span.stepper',
          h('button', { disabled: stock[g] <= 0, onclick: () => ((stock[g] -= 1), this.render()), 'aria-label': 'less' }, '−'),
          h('output', String(stock[g])),
          h('button', { disabled: stock[g] >= max, onclick: () => ((stock[g] += 1), this.render()), 'aria-label': 'more' }, '+'),
        ),
        h('small.have', { class: max === 0 ? 'none' : '' }, note),
      );
    const empty = GOODS.every((g) => ui.give[g] === 0 && ui.get[g] === 0);
    const togglePartner = (id: number) => {
      // One partner at a time; the amounts stay, so the same deal can be tried with someone else.
      ui.tradeTo = [id];
      ui.tradeCleared = false;
      // Asking for more than the new partners have makes no sense.
      for (const g of GOODS) ui.get[g] = Math.min(ui.get[g], Math.max(0, ...ui.tradeTo.map((x) => this.player(x).stock[g])));
      this.render();
    };
    const theyLabel = partners.length === 1 ? `${this.player(partners[0]).name} gives` : partners.length ? 'They give' : 'They give';
    // After a decline the same amounts are still set: offer again in one tap, or tweak first.
    const declinedBy = partners.length === 1 && this.lastDeclined === partners[0];
    const offerLabel = partnerLocal
      ? 'Make this trade'
      : partners.length
        ? `${declinedBy ? 'Offer again to' : 'Offer to'} ${this.player(partners[0]).name}`
        : 'Offer';
    const composer = h(
      'div',
      h(
        'div.row',
        { style: { marginTop: '10px' } },
        h('span.muted', 'Trade with'),
        h(
          'div.seg',
          others.map((o) =>
            h('button', { 'aria-pressed': String(partners.includes(o.id)), onclick: () => togglePartner(o.id) }, h('span.dot', { style: { background: this.color(o.id).fill } }), o.name),
          ),

        ),
      ),
      h(
        'div.trade-grid',
        h('span'),
        h('span.hdr', `${me.name} gives`),
        h('span.hdr', theyLabel),
        GOODS.map((g) => [
          h('span.row', goodIcon(g), GOOD_LABELS[g]),
          cell(ui.give, g, me.stock[g], `of ${me.stock[g]}`),
          cell(ui.get, g, theirs[g], partners.length > 1 ? `up to ${theirs[g]}` : `of ${theirs[g]}`),
        ]),
      ),
    );
    // The offer button lives in the always-visible footer; it is the main
    // action once a deal is set up.
    const offerButton = h(
      'button',
      { class: empty || !partners.length ? '' : 'primary', disabled: empty || !partners.length, onclick: () => this.makeOffer(seat, partners, partnerLocal) },
      icon('trade'),
      offerLabel,
    );
    const anyAi = partners.some((x) => this.player(x).ai);
    mount(
      panel,
      this.who(
        seat,
        ready ? `${me.name} is done trading` : `${me.name}: trading`,
        h(
          'p',
          anyAi
            ? 'Computer lords accept a deal if it helps them. '
            : 'Make deals out loud, then record them here. ',
          'Your stockpile: ',
          stockView(me.stock),
        ),
      ),
      asRow,
      incoming.map(incomingLine),
      [...groups.values()].map(outgoingLine),
      ready ? null : composer,
      h(
        'div.actions',
        h('span.muted', { style: { fontSize: '13px' } }, stillTrading.length ? `Still trading: ${stillTrading.join(', ')}` : ''),
        h('span.spacer'),
        ready
          ? h('button', { onclick: () => this.act({ type: 'ready', player: seat, ready: false }) }, 'Keep trading')
          : [
              h('button', { class: empty ? 'primary' : '', onclick: () => this.act({ type: 'ready', player: seat, ready: true }) }, 'Done trading'),
              offerButton,
            ],
      ),
    );
    return {};
  }

  private makeOffer(seat: number, to: number[], local: boolean) {
    const s = this.state;
    const id = s.trade.nextId;
    const give = { ...this.ui.give };
    const get = { ...this.ui.get };
    const err = this.session.dispatch({ type: 'offer', player: seat, to: to.length === 1 ? to[0] : to, give, get });
    if (err) return this.toast(err, true);
    this.lastDeclined = -1;
    if (local) {
      this.ui.give = emptyStock();
      this.ui.get = emptyStock();
      // Both people are holding this device and agreed out loud.
      const e2 = this.session.dispatch({ type: 'respond', player: to[0], offer: id, accept: true });
      if (e2) this.toast(e2, true);
    } else {
      this.toast(`Offer sent to ${to.map((x) => this.player(x).name).join(' and ')}`);
    }
    this.render();
  }


  // Shipment ------------------------------------------------------------------

  private shipSources(seat: number, kind: ShipKind): number[] {
    const s = this.state;
    const T = s.territories;
    const mine = territoriesOf(s, seat);
    if (kind === 'stockpile') return [];
    if (kind === 'weapon') return mine.filter((t) => T[t].weapon && neighbors(s, t).some((n) => T[n].owner === seat && !T[n].weapon));
    if (kind === 'horse') return mine.filter((t) => T[t].horse && this.horseDests(seat, t).length);
    return mine.filter((t) => T[t].boats.length && this.boatDests(seat, t).length);
  }

  private horseDests(seat: number, from: number): { to: number; via?: number }[] {
    const s = this.state;
    const T = s.territories;
    const out: { to: number; via?: number }[] = [];
    const seen = new Set<number>();
    for (const n of neighbors(s, from)) {
      if (T[n].owner !== seat) continue;
      if (!T[n].horse && !seen.has(n)) {
        out.push({ to: n });
        seen.add(n);
      }
    }
    for (const via of neighbors(s, from)) {
      if (T[via].owner !== seat) continue;
      for (const n of neighbors(s, via)) {
        if (n === from || seen.has(n) || T[n].owner !== seat || T[n].horse) continue;
        out.push({ to: n, via });
        seen.add(n);
      }
    }
    return out;
  }

  private boatDests(seat: number, from: number): { to: number; sea: number }[] {
    const s = this.state;
    const out: { to: number; sea: number }[] = [];
    for (const sea of new Set(s.territories[from].boats)) {
      for (const t of info(s).seas[sea].coast) {
        if (t !== from && s.territories[t].owner === seat && freeBerths(s, t, sea) > 0) out.push({ to: t, sea });
      }
    }
    return out;
  }

  private renderShip(panel: HTMLElement, seat: number): Highlight {
    const s = this.state;
    const T = s.territories;
    const p = this.player(seat);
    const ui = this.ui;
    const ship = ui.ship;
    const kinds: ShipKind[] = s.settings.level >= 4 ? ['stockpile', 'weapon', 'horse', 'boat'] : ['stockpile'];
    const avail = (k: ShipKind) => (k === 'stockpile' ? territoriesOf(s, seat).length > 1 : this.shipSources(seat, k).length > 0);
    const kindLabel: Record<ShipKind, string> = { stockpile: 'Stockpile', weapon: 'Weapon', horse: 'Horse', boat: 'Boat' };
    const kindIcon: Record<ShipKind, IconName> = { stockpile: 'stockpile', weapon: 'weapon', horse: 'horse', boat: 'boat' };
    const choices = kinds.map((k) =>
      h(
        'button',
        { 'aria-pressed': String(ship.kind === k), disabled: !avail(k), onclick: () => ((ui.ship = { kind: k, from: null, to: null, horse: false, weapon: false }), play('tap'), this.render()) },
        icon(kindIcon[k]),
        h('b', kindLabel[k]),
      ),
    );
    let hl: Highlight = {};
    let hint = s.settings.level >= 4 ? 'Make one move: your stockpile, or a weapon, horse or boat.' : 'You may move your stockpile to another of your lands.';
    let move: Move | null = null;
    if (ship.kind === 'stockpile') {
      const opts = new Set(territoriesOf(s, seat).filter((t) => t !== p.stockpile));
      hl = { selectable: opts, selected: ship.to !== null ? [ship.to] : [] };
      hint = ship.to === null ? 'Tap the land to move your stockpile to.' : '';
      if (ship.to !== null) move = { kind: 'stockpile', to: ship.to };
    } else if (ship.kind) {
      if (ship.from === null) {
        hl = { selectable: new Set(this.shipSources(seat, ship.kind)) };
        hint = `Tap the ${ship.kind} you want to move.`;
      } else {
        const from = ship.from;
        let dests: number[] = [];
        if (ship.kind === 'weapon') dests = neighbors(s, from).filter((n) => T[n].owner === seat && !T[n].weapon);
        if (ship.kind === 'horse') dests = this.horseDests(seat, from).map((d) => d.to);
        if (ship.kind === 'boat') dests = this.boatDests(seat, from).map((d) => d.to);
        hl = { selectable: new Set([...dests, from]), selected: [from] };
        hint = ship.to === null ? 'Now tap where it should go.' : '';
        if (ship.to !== null && dests.includes(ship.to)) {
          const to = ship.to;
          hl.arrows = [{ from, to, color: '#ffe7a8' }];
          if (ship.kind === 'weapon') move = { kind: 'weapon', from, to };
          if (ship.kind === 'horse') {
            const d = this.horseDests(seat, from).find((x) => x.to === to)!;
            const weaponAt = T[from].weapon ? from : d.via !== undefined && T[d.via].weapon ? d.via : undefined;
            const carry = ship.weapon && weaponAt !== undefined && !T[to].weapon;
            move = { kind: 'horse', from, to, via: d.via, weaponFrom: carry ? weaponAt : undefined };
          }
          if (ship.kind === 'boat') {
            const d = this.boatDests(seat, from).find((x) => x.to === to)!;
            move = { kind: 'boat', from, to, sea: d.sea, horse: ship.horse && T[from].horse && !T[to].horse, weapon: ship.weapon && T[from].weapon && !T[to].weapon };
          }
        }
      }
    }
    // Carry toggles.
    const toggles: HTMLElement[] = [];
    if (move && move.kind === 'horse') {
      const d = this.horseDests(seat, move.from).find((x) => x.to === move!.to);
      const weaponAt = T[move.from].weapon ? move.from : d?.via !== undefined && T[d.via].weapon ? d.via : undefined;
      if (weaponAt !== undefined && !T[move.to].weapon) toggles.push(h('button.small', { 'aria-pressed': String(ship.weapon), onclick: () => ((ship.weapon = !ship.weapon), this.render()) }, icon('weapon'), 'Pick up the weapon'));
    }
    if (move && move.kind === 'boat') {
      if (T[move.from].horse && !T[move.to].horse) toggles.push(h('button.small', { 'aria-pressed': String(ship.horse), onclick: () => ((ship.horse = !ship.horse), this.render()) }, icon('horse'), 'Carry horse'));
      if (T[move.from].weapon && !T[move.to].weapon) toggles.push(h('button.small', { 'aria-pressed': String(ship.weapon), onclick: () => ((ship.weapon = !ship.weapon), this.render()) }, icon('weapon'), 'Carry weapon'));
    }
    mount(
      panel,
      this.who(seat, `${p.name}: shipment`, hint),
      h('div.choice.one-row', choices),
      toggles.length ? h('div.row', { style: { marginTop: '10px' } }, toggles) : null,
      h(
        'div.actions',
        h('button', { onclick: () => this.act({ type: 'done', player: seat }) }, 'Skip'),
        h('span.spacer'),
        ship.kind
          ? h('button.primary', { disabled: !move, onclick: () => move && this.act({ type: 'ship', player: seat, move }) }, move ? `Move to ${this.tname(move.to)}` : 'Move')
          : null,
      ),
    );
    return hl;
  }

  // Conquest ------------------------------------------------------------------

  private attackTargets(seat: number): Set<number> {
    const s = this.state;
    const out = new Set<number>();
    s.territories.forEach((t, id) => {
      if (t.owner === seat) return;
      if (neighbors(s, id).some((n) => s.territories[n].owner === seat)) out.add(id);
    });
    if (s.settings.level >= 3) {
      s.territories.forEach((t) => {
        if (t.owner !== seat) return;
        for (const sea of new Set(t.boats)) {
          for (const id of info(s).seas[sea].coast) if (s.territories[id].owner !== seat && freeBerths(s, id, sea) > 0) out.add(id);
        }
      });
    }
    return out;
  }

  /**
   * Every reinforcement the rules allow, strongest first within each kind.
   * Units in lands bordering the target already count, so bringing them adds
   * no strength, but they move in if you win (and are lost if you lose).
   */
  private forceOptions(seat: number, target: number): ForceOption[] {
    const s = this.state;
    const T = s.territories;
    const mine = (t: number) => T[t].owner === seat;
    const touching = neighbors(s, target).some(mine);
    const out: ForceOption[] = touching ? [{ force: null, label: 'Just my borders', bonus: 0, group: 'none', cargo: [] }] : [];
    const add = (force: Force, label: string, place: number, group: string, cargo: string[]) =>
      out.push({ force, label, place: this.tname(place), group, cargo, bonus: forceBonus(s, target, force) });
    // Horses from two lands away (optionally picking up a weapon on the way).
    const seenHorse = new Set<number>();
    for (const via of neighbors(s, target)) {
      if (!mine(via)) continue;
      for (const from of neighbors(s, via)) {
        if (from === target || seenHorse.has(from) || !mine(from) || !T[from].horse || adjacent(s, from, target)) continue;
        seenHorse.add(from);
        const g = `h${from}`;
        add({ kind: 'horse', from, via }, 'Horse', from, g, []);
        if (T[from].weapon) add({ kind: 'horse', from, via, weaponFrom: from }, 'Horse', from, g, ['+ weapon']);
        if (T[via].weapon) add({ kind: 'horse', from, via, weaponFrom: via }, 'Horse', from, g, [`+ weapon from ${this.tname(via)}`]);
      }
    }
    // Units next door, moving in.
    for (const from of neighbors(s, target)) {
      if (!mine(from)) continue;
      if (T[from].horse) {
        add({ kind: 'horse', from }, 'Horse', from, `h${from}`, []);
        if (T[from].weapon) add({ kind: 'horse', from, weaponFrom: from }, 'Horse', from, `h${from}`, ['+ weapon']);
      }
      if (T[from].weapon) add({ kind: 'weapon', from }, 'Weapon', from, `w${from}`, []);
    }
    // Boats, with any cargo from their home land.
    if (s.settings.level >= 3) {
      const seas = info(s).territories[target].seas;
      T.forEach((t, from) => {
        if (t.owner !== seat) return;
        for (const sea of new Set(t.boats)) {
          if (!seas.includes(sea) || freeBerths(s, target, sea) <= 0) continue;
          const g = `b${from}:${sea}`;
          add({ kind: 'boat', from, sea, horse: false, weapon: false }, 'Boat', from, g, []);
          if (t.horse) add({ kind: 'boat', from, sea, horse: true, weapon: false }, 'Boat', from, g, ['+ horse']);
          if (t.weapon) add({ kind: 'boat', from, sea, horse: false, weapon: true }, 'Boat', from, g, ['+ weapon']);
          if (t.horse && t.weapon) add({ kind: 'boat', from, sea, horse: true, weapon: true }, 'Boat', from, g, ['+ horse', '+ weapon']);
        }
      });
    }
    return out;
  }

  /** Pick the variant of a row with this cargo (or the closest one). */
  private variantWith(options: ForceOption[], group: string, cargo: string[]): number {
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
    const exact = options.findIndex((o) => o.group === group && same(o.cargo, cargo));
    if (exact >= 0) return exact;
    // E.g. a horse can take the weapon from one land or the other, not both.
    const last = cargo[cargo.length - 1];
    const close = options.findIndex((o) => o.group === group && o.cargo.includes(last));
    return close >= 0 ? close : options.findIndex((o) => o.group === group);
  }

  /** Best variant of a row: strongest, and among equals the one risking least. */
  private bestVariant(options: ForceOption[], group: string): number {
    let best = -1;
    options.forEach((o, i) => {
      if (o.group !== group) return;
      if (best < 0 || o.bonus > options[best].bonus || (o.bonus === options[best].bonus && o.cargo.length < options[best].cargo.length)) best = i;
    });
    return best;
  }

  /** What a brought force consists of. */
  private units(force: Force | null): ('horse' | 'weapon' | 'boat')[] {
    if (!force) return [];
    if (force.kind === 'weapon') return ['weapon'];
    if (force.kind === 'horse') return force.weaponFrom !== undefined ? ['horse', 'weapon'] : ['horse'];
    return ['boat', ...(force.horse ? ['horse' as const] : []), ...(force.weapon ? ['weapon' as const] : [])];
  }

  /** Plain-language results of this attack, for a win and for a loss. */
  private outcomeView(target: number, force: Force | null, odds: number) {
    const s = this.state;
    const t = s.territories[target];
    const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
    const yours = this.units(force);
    // Win: everything in the land becomes yours, and what you brought moves in.
    const moving = yours.filter((u) => u === 'boat' || !t[u]);
    const clash = yours.filter((u) => u !== 'boat' && t[u]) as ('horse' | 'weapon')[];
    const after: string[] = [];
    if (moving.length) after.push(`Your ${list(moving)} ${moving.length > 1 ? 'move' : 'moves'} in.`);
    if (clash.length) after.push(`Only one ${list(clash.map((u) => u))} ${clash.length > 1 ? 'fit' : 'fits'} per land: you keep theirs and lose yours.`.replace('Only one horse and weapon', 'Only one horse and one weapon'));
    const lose: string[] = [];
    if (yours.length) lose.push(`you lose your ${list(yours)}`);
    else lose.push('you lose nothing');
    if (s.conquest.attacksLeft > 1 && s.settings.chance !== 'low') lose.push('your attacks end this turn');
    const name = (p: number) => (p < 0 ? 'the locals' : this.player(p).name);
    const hasStuff = t.site || t.city || t.weapon || t.horse || t.boats.length || (t.owner >= 0 && s.players[t.owner].stockpile === target);
    return h(
      'div.outcome',
      h('div', h('b.win', 'If you win: '), `you take the land from ${name(t.owner)}${hasStuff ? ', with:' : '.'}`),
      hasStuff ? this.stakeView(target, '') : null,
      after.length ? h('div.after', after.join(' ')) : null,
      odds < 1 ? h('div', h('b.lose', 'If you lose: '), list(lose), '.') : null,
    );
  }

  private renderConquest(panel: HTMLElement, seat: number): Highlight {
    const s = this.state;
    const p = this.player(seat);
    const ui = this.ui;
    const plan = s.conquest.plan;
    const left = s.conquest.attacksLeft;
    const color = this.color(seat).fill;

    if (plan) {
      // Attack planned; maybe waiting on allies.
      const pv = previewAttack(s, seat, plan.target, plan.force);
      let att = pv.attack;
      let def = pv.defense;
      const lines = plan.allies.map((a) => {
        if (a.side === 'attacker') att += a.strength;
        if (a.side === 'defender') def += a.strength;
        const what = a.side === null ? 'deciding…' : a.side === 'neutral' ? 'stays out' : a.side === 'attacker' ? `joins you (+${a.strength})` : `defends (+${a.strength})`;
        const dot = h('span.dot', { style: { background: this.color(a.player).fill } });
        // A neighbor at this table answers here: ask them out loud, tap their answer.
        if (a.side === null && this.session.controls(a.player) && !this.player(a.player).ai) {
          const defName = plan.defender < 0 ? 'locals' : this.player(plan.defender).name;
          const choose = (side: 'attacker' | 'defender' | 'neutral') => this.act({ type: 'ally', player: a.player, side });
          return h(
            'div.offer.ask',
            h('div', dot, h('b', this.player(a.player).name), ` (+${a.strength}), which side?`),
            h(
              'div.row',
              h('button.small', { onclick: () => choose('attacker') }, `Help ${p.name}`),
              h('button.small', { onclick: () => choose('defender') }, `Help ${defName}`),
              h('button.small.quiet', { onclick: () => choose('neutral') }, 'Stay out'),
            ),
          );
        }
        return h('div.offer', dot, h('b', this.player(a.player).name), ' ', what);
      });
      const pending = plan.allies.some((a) => a.side === null);
      mount(
        panel,
        this.who(
          seat,
          `${p.name} attacks ${this.tname(plan.target)}`,
          pending
            ? plan.allies.some((a) => a.side === null && this.session.controls(a.player) && !this.player(a.player).ai)
              ? 'Ask your neighbors which side they take, then tap their answers.'
              : 'Neighbors with forces nearby are choosing sides…'
            : 'Everyone has chosen.',
        ),
        this.vsView(att, def, plan.defender),
        lines,
        h(
          'div.actions',
          h('button', { onclick: () => this.act({ type: 'cancel', player: seat }) }, 'Call it off'),
          h('span.spacer'),
          h('button.primary', { disabled: pending, onclick: () => this.act({ type: 'attack', player: seat }) }, icon('swords'), 'Attack!'),
        ),
      );
      return { target: plan.target, arrows: plan.force ? [{ from: plan.force.from, to: plan.target, color }] : [] };
    }

    if (ui.stockpileMode) {
      const opts = new Set(territoriesOf(s, seat).filter((t) => t !== p.stockpile));
      mount(
        panel,
        this.who(seat, `${p.name}: move your stockpile`, ui.sel === null ? 'Tap the land to move it to. This uses one of your attacks.' : null),
        ui.sel !== null ? this.territoryLine(ui.sel) : null,
        h(
          'div.actions',
          h('button', { onclick: () => ((ui.stockpileMode = false), (ui.sel = null), this.render()) }, 'Back'),
          h('span.spacer'),
          h('button.primary', { disabled: ui.sel === null, onclick: () => this.act({ type: 'moveStockpile', player: seat, to: ui.sel! }) }, ui.sel === null ? 'Move stockpile' : `Move to ${this.tname(ui.sel)}`),
        ),
      );
      return { selectable: opts, selected: ui.sel !== null ? [ui.sel] : [] };
    }

    const targets = this.attackTargets(seat);
    const target = ui.target !== null && targets.has(ui.target) ? ui.target : null;
    const spent = left <= 0;
    const footer = h(
      'div.actions',
      // With no attacks left the turn waits: ending it is the main action.
      h('button', { class: spent ? 'primary' : '', onclick: () => this.act({ type: 'done', player: seat }) }, 'End turn'),
      !spent && !s.conquest.usedStockpileMove && territoriesOf(s, seat).length > 1
        ? h('button', { onclick: () => ((ui.stockpileMode = true), (ui.target = null), this.render()) }, icon('stockpile'), 'Move stockpile')
        : null,
      h('span.spacer'),
      target !== null && !spent ? h('button.primary', { id: 'attack-btn' }, icon('swords'), 'Attack!') : null,
    );
    const title = `${p.name}: ${spent ? 'no attacks left' : left === 1 ? 'one attack left' : `${left} attacks`}`;
    if (target === null) {
      mount(
        panel,
        this.who(seat, title, spent ? 'Tap any land to see its odds, then end your turn when you are ready.' : 'Tap an enemy or unclaimed territory next to yours to plan an attack.'),
        footer,
      );
      return { selectable: targets };
    }
    const options = this.forceOptions(seat, target);
    if (ui.force >= options.length) ui.force = 0;
    const opt = options[ui.force];
    const pv = previewAttack(s, seat, target, opt?.force ?? null);
    const btn = footer.querySelector('#attack-btn') as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = !pv.possible;
      btn.onclick = () => this.launch(seat, target, opt?.force ?? null);
    }
    // Neighbors may still join either side: show what that would do to the odds.
    let allyNote: HTMLElement | null = null;
    if (pv.allies.length) {
      const names = pv.allies.map((a) => this.player(a.player).name).join(pv.allies.length > 2 ? ', ' : ' and ');
      const sum = pv.allies.reduce((n, a) => n + a.strength, 0);
      const pct = (a: number, d: number) => `${Math.round(this.odds(a, d) * 100)}%`;
      const defName = s.territories[target].owner < 0 ? 'the locals' : this.player(s.territories[target].owner).name;
      allyNote = h(
        'p',
        h('b', { style: { color: 'var(--text)' } }, names),
        ` ${pv.allies.length > 1 ? 'border' : 'borders'} it too (+${sum}) and will choose a side: `,
        h('b', { style: { color: 'var(--ok)' } }, `${pct(pv.attack + sum, pv.defense)} if ${pv.allies.length > 1 ? 'they help' : 'it helps'} you`),
        ', ',
        h('b', { style: { color: 'var(--danger)' } }, `${pct(pv.attack, pv.defense + sum)} if ${pv.allies.length > 1 ? 'they help' : 'it helps'} ${defName}`),
        '.',
      );
    }
    mount(
      panel,
      this.who(seat, `${title} · ${this.tname(target)}`, null),
      this.vsView(pv.attack, pv.defense, s.territories[target].owner, pv.possible ? null : 'Attack will fail!'),
      options.length > 1 ? this.forceRows(options, ui.force) : null,
      this.outcomeView(target, opt?.force ?? null, pv.possible ? this.odds(pv.attack, pv.defense) : 0),
      allyNote,
      footer,
    );
    const arrows = opt?.force ? [{ from: opt.force.from, to: target, color }] : [];
    return { selectable: targets, target, arrows };
  }

  /** One row per thing to bring; the chosen row offers its cargo as toggles. */
  private forceRows(options: ForceOption[], chosen: number) {
    const ui = this.ui;
    const groups: string[] = [];
    for (const o of options) if (!groups.includes(o.group)) groups.push(o.group);
    const current = options[chosen];
    const bonusText = (b: number, o: ForceOption) => (b ? `+${b}` : o.force ? 'moves in' : 'no extra');
    return h(
      'div.choice.forces',
      groups.map((g) => {
        const isChosen = current?.group === g;
        const variants = options.filter((o) => o.group === g);
        const shown = isChosen ? current : options[this.bestVariant(options, g)];
        const max = Math.max(...variants.map((v) => v.bonus));
        const row = h(
          'button',
          { 'aria-pressed': String(isChosen), onclick: () => ((ui.force = this.bestVariant(options, g)), play('tap'), this.render()) },
          h('b', shown.label),
          h('small', (shown.place ? `${shown.place} · ` : '') + (isChosen || max === shown.bonus ? bonusText(shown.bonus, shown) : `up to +${max}`)),
        );
        // Cargo toggles for the chosen row.
        const tokens: string[] = [];
        for (const v of variants) for (const c of v.cargo) if (!tokens.includes(c)) tokens.push(c);
        if (!isChosen || !tokens.length) return row;
        return h(
          'div.force-group',
          row,
          h(
            'div.cargo',
            tokens.map((c) =>
              h(
                'button.small',
                {
                  'aria-pressed': String(current.cargo.includes(c)),
                  onclick: () => {
                    const want = current.cargo.includes(c) ? current.cargo.filter((x) => x !== c) : [...current.cargo, c];
                    ui.force = this.variantWith(options, g, want);
                    play('tap');
                    this.render();
                  },
                },
                c,
              ),
            ),
          ),
        );
      }),
    );
  }

  private vsView(att: number, def: number, defender: number, failure: string | null = null, attackLabel = 'Attack') {
    const odds = failure ? 0 : this.odds(att, def);
    const holder = defender < 0 ? 'The locals hold' : `${this.player(defender).name} holds`;
    // Third parties see the standing of the battle, not attacker advice.
    const label =
      failure ??
      (attackLabel !== 'Attack'
        ? `As it stands: ${odds >= 1 ? `${attackLabel} wins` : odds <= 0 ? holder : `${Math.round(odds * 100)}% for ${attackLabel}`}`
        : odds >= 1
          ? 'Victory is certain'
          : odds <= 0
            ? 'Attack will fail!'
            : `${Math.round(odds * 100)}% chance to win`);
    const cls = odds >= 0.75 ? 'good' : odds <= 0.35 ? 'bad' : 'meh';
    return h(
      'div',
      h(
        'div.vs',
        h('div.side', h('div.num', String(att)), h('div.lbl', attackLabel)),
        h('div.mid', 'vs'),
        h('div.side', h('div.num', String(def)), h('div.lbl', defender < 0 ? 'Locals' : this.player(defender).name)),
      ),
      h('div.odds', { class: cls }, label),
    );
  }

  private launch(seat: number, target: number, force: Force | null) {
    const err = this.session.dispatch({ type: 'plan', player: seat, target, force });
    if (err) return this.toast(err, true);
    const s = this.state;
    // Locally, the plan is applied synchronously; attack at once if nobody else must decide.
    if (this.session.kind === 'local' && s.conquest.plan && !s.conquest.plan.allies.length) {
      this.act({ type: 'attack', player: seat });
    } else if (this.session.kind === 'net') {
      this.pendingAutoAttack = { seat, target };
    }
  }

  private pendingAutoAttack: { seat: number; target: number } | null = null;

  private renderAlly(panel: HTMLElement, seat: number): Highlight {
    const s = this.state;
    const plan = s.conquest.plan!;
    const attacker = currentPlayer(s);
    const entry = plan.allies.find((a) => a.player === seat)!;
    const p = this.player(seat);
    const attName = this.player(attacker).name;
    const defName = plan.defender < 0 ? 'the locals' : this.player(plan.defender).name;
    const pv = previewAttack(s, attacker, plan.target, plan.force);
    // Totals so far, counting neighbors who already chose.
    let att = pv.attack;
    let def = pv.defense;
    for (const a of plan.allies) {
      if (a.side === 'attacker') att += a.strength;
      if (a.side === 'defender') def += a.strength;
    }
    const outcome = (a: number, d: number) => {
      const odds = this.odds(a, d);
      const verdict = odds >= 1 ? `${attName} wins` : odds <= 0 ? `${defName === 'the locals' ? 'The locals hold' : defName + ' holds'}` : `${Math.round(odds * 100)}% for ${attName}`;
      return `${a} vs ${d} · ${verdict}`;
    };
    const choice = (side: 'attacker' | 'defender' | 'neutral', label: string, a: number, d: number, cls = '') =>
      h('button', { class: cls, onclick: () => this.act({ type: 'ally', player: seat, side }) }, h('b', label), h('small', outcome(a, d)));
    const undecided = plan.allies.filter((a) => a.side === null && a.player !== seat).map((a) => this.player(a.player).name);
    mount(
      panel,
      this.who(seat, `${p.name}, choose a side`),
      h(
        'p',
        h('b', { style: { color: this.color(attacker).fill } }, attName),
        ' is attacking ',
        h('b', { style: { color: 'var(--text)' } }, this.tname(plan.target)),
        plan.defender < 0 ? ', unclaimed land' : [', held by ', h('b', { style: { color: this.color(plan.defender).fill } }, defName)],
        '.',
        h('span.long', ' It is outlined in red on the map.'),
      ),
      this.stakeView(plan.target),
      h('p', `Your lands next to it add `, h('b', { style: { color: 'var(--text)' } }, `+${entry.strength}`), ' to whichever side you join.'),
      this.vsView(att, def, plan.defender, null, attName),
      h(
        'div.choice.one-row',
        choice('attacker', `Help ${attName}`, att + entry.strength, def),
        choice('defender', `Help ${defName === 'the locals' ? 'the locals' : defName}`, att, def + entry.strength),
        choice('neutral', 'Stay out', att, def, 'quiet'),
      ),
      undecided.length ? h('p', `Also deciding: ${undecided.join(', ')}.`) : null,
    );
    return { target: plan.target, arrows: plan.force ? [{ from: plan.force.from, to: plan.target, color: this.color(attacker).fill }] : [] };
  }

  /** What changes hands if a territory falls. */
  private stakeView(t: number, label = 'At stake:') {
    const s = this.state;
    const ts = s.territories[t];
    const items: (HTMLElement | string)[] = [];
    const chip = (ico: HTMLElement | SVGElement, text: string) => h('span', ico, text);
    const siteNames: Record<string, string> = { gold: 'Gold mine', iron: 'Iron mine', coal: 'Coal mine', timber: 'Timber', horses: 'Pasture' };
    if (ts.site) items.push(chip(siteIcon(ts.site), siteNames[ts.site] + (isDoubled(s, t) ? ' ×2' : '')));
    if (ts.city) items.push(chip(icon('city'), 'City'));
    if (ts.weapon) items.push(chip(icon('weapon'), 'Weapon'));
    if (ts.horse) items.push(chip(icon('horse'), 'Horse'));
    if (ts.boats.length) items.push(chip(icon('boat'), ts.boats.length > 1 ? `${ts.boats.length} boats` : 'Boat'));
    if (ts.owner >= 0 && s.players[ts.owner].stockpile === t) {
      const st = s.players[ts.owner].stock;
      const total = GOODS.reduce((n, g) => n + st[g], 0);
      items.push(h('span', icon('stockpile'), h('b', { style: { color: 'var(--accent)' } }, 'Stockpile'), total ? [' (', stockView(st, true), ')'] : ' (empty)'));
    }
    return h(
      'div.stake',
      label ? h("span.muted", label) : null,
      items.length ? items : h('span', 'just the land itself'),
    );
  }

  private odds(att: number, def: number) {
    const c = this.state.settings.chance;
    return c === 'low' ? (att >= def ? 1 : 0) : c === 'medium' ? (att > def ? 1 : att === def ? 0.5 : 0) : att / (att + def);
  }

  // -------------------------------------------------------------------------
  // Input

  private act(action: Action) {
    const err = this.session.dispatch(action);
    if (err) {
      this.toast(err, true);
      play('error');
      return;
    }
    this.ui.info = null;
    this.render();
  }

  private tap(t: number, cell = -1) {
    const s = this.state;
    const act = this.acting();
    const ui = this.ui;
    // Tapping a ghost boat picks which water a new boat is launched on.
    const ghost = this.boatGhosts.find((g) => g.cell === cell);
    if (ghost) {
      ui.sea = ghost.sea;
      play('tap');
      this.render();
      return;
    }
    if (t < 0) {
      this.setInfo(null);
      return;
    }
    play('tap');
    if (!act) {
      this.setInfo(ui.info === t ? null : t);
      return;
    }
    const mine = s.territories[t].owner === act.seat;
    const phase = s.phase;
    let used = false;
    if (act.role === 'place' && mine) {
      ui.sel = ui.sel === t ? null : t;
      used = true;
    } else if (act.role === 'main') {
      if (phase === 'select' && s.territories[t].owner === -1) {
        if (ui.sel === t) return this.act({ type: 'pick', player: act.seat, territory: t });
        ui.sel = t;
        used = true;
      } else if (phase === 'development' && ui.item && canPlace(s, act.seat, ui.item, t)) {
        ui.sel = t;
        used = true;
      } else if (phase === 'shipment' && ui.ship.kind) {
        const ship = ui.ship;
        if (ship.kind === 'stockpile') {
          if (mine && t !== this.player(act.seat).stockpile) {
            ship.to = t;
            used = true;
          }
        } else if (ship.from === null || t === ship.from) {
          if (this.shipSources(act.seat, ship.kind!).includes(t)) {
            ship.from = ship.from === t ? null : t;
            ship.to = null;
            used = true;
          }
        } else if (mine) {
          ship.to = t;
          ship.horse = true;
          ship.weapon = true;
          used = true;
        }
      } else if (phase === 'conquest' && !s.conquest.plan) {
        if (ui.stockpileMode) {
          if (mine && t !== this.player(act.seat).stockpile) {
            ui.sel = t;
            used = true;
          }
        } else if (this.attackTargets(act.seat).has(t)) {
          ui.target = ui.target === t ? null : t;
          ui.force = 0;
          // Default to the option with the best odds; ties keep the safest
          // (earliest) one, so forces are not risked for nothing.
          if (ui.target !== null) {
            let bestOdds = -1;
            const opts = this.forceOptions(act.seat, t);
            opts.forEach((o, i) => {
              if (i !== this.bestVariant(opts, o.group)) return;
              const pv = previewAttack(s, act.seat, t, o.force);
              const odds = (pv.best + pv.worst) / 2;
              if (odds > bestOdds + 1e-9) {
                bestOdds = odds;
                ui.force = i;
              }
            });
          }
          used = true;
        }
      }
    }
    this.ui.info = used ? null : ui.info === t ? null : t;
    this.render();
  }

  // -------------------------------------------------------------------------
  // Overlays

  private lastBattleAt = -1e9;
  private handoffTimer: ReturnType<typeof setTimeout> | null = null;
  /** Log position at the last handoff, for the "since you last played" recap. */
  private handoffSeen = -1;

  /** Battles since the device was last passed, as short lines from this lord's view. */
  private recap(seat: number): HTMLElement | null {
    const s = this.state;
    const lines: HTMLElement[] = [];
    for (const { n, event: e } of s.log) {
      if (n <= this.handoffSeen || e.kind !== 'battle') continue;
      const a = this.player(e.attacker).name;
      const place = this.tname(e.target);
      const mine = e.defender === seat ? ' (yours)' : '';
      const result =
        e.defender === seat ? (e.won ? 'you lost it' : 'you held it') : e.attacker === seat ? (e.won ? 'you took it' : 'you were repelled') : e.won ? `${a} took it` : 'it held';
      lines.push(h('div.recap-line', h('span.dot', { style: { background: this.color(e.won ? e.attacker : Math.max(e.defender, 0)).fill } }), `${a} attacked ${place}${mine}: ${result}, ${e.attack} vs ${e.defense}`));
    }
    if (!lines.length) return null;
    return h('div.recap', h('div.eyebrow', 'Since the last turn'), lines.slice(-5));
  }

  private showHandoff(seat: number, role: string, key: string) {
    const p = this.player(seat);
    const c = this.color(seat);
    const s = this.state;
    const plan = s.conquest.plan;
    const what =
      role === 'ally' && plan
        ? `${this.player(currentPlayer(s)).name} is attacking ${this.tname(plan.target)} and needs your answer.`
        : role === 'place'
          ? s.year === 1
            ? 'Your first harvest is in: choose where to keep your stockpile.'
            : 'You have goods but no stockpile: choose where to keep it.'
          : `It's your turn: ${PHASE_NAMES[s.phase].toLowerCase()}.`;
    this.el.overlay.className = 'overlay';
    this.el.overlay.hidden = false;
    mount(
      this.el.overlay,
      h(
        'div.card',
        h('div.badge', { style: { background: c.fill } }, icon('shield')),
        h('div.eyebrow', 'Pass the device'),
        h('h2', `${p.name}'s turn`),
        h('p', what),
        this.recap(seat),
        h(
          'div.stack',
          h(
            'button.primary',
            {
              onclick: () => {
                this.handoffDone = key;
                this.handoffSeen = this.state.eventCount - 1;
                this.lastSeat = seat;
                play('turn', { variant: p.color });
                this.render();
              },
            },
            `I'm ${p.name}, let's go`,
          ),
          // Someone left the table: the computer takes over just that lord.
          h(
            'button.quiet',
            {
              onclick: () => {
                if (!confirm(`The computer will play ${p.name}'s lands from now on. Sure?`)) return;
                this.handoffDone = key;
                this.act({ type: 'setAi', player: seat, ai: true });
              },
            },
            icon('computer'),
            `${p.name} has left: let the computer play`,
          ),
        ),
      ),
    );
    this.renderer.setHighlight({});
  }

  private gameOverAt = 0;
  /** Who last turned down this device's offer (for "Offer again"). */
  private lastDeclined = -1;

  private showGameOver() {
    // Let the lands change color first (when the win just happened).
    const wait = this.gameOverAt - performance.now();
    if (wait > 0) {
      this.el.overlay.hidden = true;
      setTimeout(() => this.state.phase === 'over' && this.showGameOver(), wait + 50);
      return;
    }
    const s = this.state;
    const w = s.winner;
    const c = this.color(w);
    const win = [...s.log].reverse().find((e) => e.event.kind === 'win')?.event as { reason: string } | undefined;
    this.el.overlay.className = 'overlay';
    this.el.overlay.hidden = false;
    mount(
      this.el.overlay,
      h(
        'div.card',
        h('div.badge', { style: { background: c.fill } }, icon('city')),
        h('div.eyebrow', 'Victory'),
        h('h2', w >= 0 ? `${this.player(w).name} rules the land!` : 'Game over'),
        h('p', win ? `Won with ${win.reason}.` : ''),
        h(
          'div.stack',
          h('button', { onclick: () => (this.el.overlay.hidden = true) }, 'Look at the map'),
          this.onRematch ? h('button.primary', { onclick: () => this.onRematch!() }, 'Play again (new map)') : null,
          h(this.onRematch ? 'button' : 'button.primary', { onclick: () => this.onExit() }, 'Back to the menu'),
        ),
      ),
    );
  }

  private openMenu() {
    const s = this.state;
    const dlg = h('dialog') as HTMLDialogElement;
    const close = () => closeDialog(dlg);
    const resignable = this.localSeats();
    dlg.appendChild(
      h(
        'div',
        h('div.row', h('h2', { style: { margin: '0' } }, 'Menu'), h('span.spacer'), h('button.quiet', { onclick: close, 'aria-label': 'Close' }, icon('close'))),
        // Network games: the code, so a device that dropped out can rejoin.
        this.session.code ? h('p.muted', { style: { margin: '8px 0 0' } }, 'Game code: ', h('b.code-inline', this.session.code)) : null,
        h(
          'div',
          { style: { display: 'grid', gap: '10px', marginTop: '16px' } },
          h('button', { onclick: () => (close(), showRules()) }, icon('scroll'), 'How to play'),
          h(
            'div.row',
            { style: { gap: '10px' } },
            audioButton('sound'),
            audioButton('music'),
          ),
          canFullscreen()
            ? h('button', { onclick: () => (close(), toggleFullscreen()) }, icon(isFullscreen() ? 'exitFullscreen' : 'fullscreen'), isFullscreen() ? 'Leave full screen' : 'Full screen')
            : null,
          s.phase !== 'over'
            ? resignable.map((seat) =>
                h(
                  'button',
                  {
                    onclick: () => {
                      if (confirm(`The computer will play ${this.player(seat).name}'s lands from now on. Sure?`)) {
                        close();
                        this.act({ type: 'setAi', player: seat, ai: true });
                      }
                    },
                  },
                  icon('computer'),
                  `Let the computer play for ${this.player(seat).name}`,
                ),
              )
            : null,
          // Single device: anyone can take a computer-played lord back.
          s.phase !== 'over' && this.session.kind === 'local'
            ? s.players
                .filter((p) => p.alive && p.ai)
                .map((p) => h('button', { onclick: () => (close(), this.act({ type: 'setAi', player: p.id, ai: false })) }, icon('device'), `Play ${p.name} myself`))
            : null,
          s.phase !== 'over'
            ? resignable.map((seat) =>
                h(
                  'button.danger',
                  {
                    onclick: () => {
                      if (confirm(`${this.player(seat).name} will surrender and leave the game. Sure?`)) {
                        close();
                        this.act({ type: 'resign', player: seat });
                      }
                    },
                  },
                  `Surrender (${this.player(seat).name})`,
                ),
              )
            : null,
          s.phase === 'over' && this.onRematch ? h('button', { onclick: () => (close(), this.onRematch!()) }, 'Play again (new map)') : null,
          h(
            'button',
            { onclick: () => (close(), this.onExit()) },
            // A finished game has nothing left to save.
            s.phase === 'over' ? 'Back to the menu' : this.session.kind === 'local' ? 'Save and leave' : 'Leave (the game keeps going)',
          ),
        ),
      ),
    );
    openDialog(dlg);
  }
}

/** A button that cycles Sound or Music through Off / Soft / Full. */
export function audioButton(kind: 'sound' | 'music') {
  const ico = () => icon(kind === 'music' ? 'music' : level(kind) === 'off' ? 'mute' : 'sound');
  const btn = h('button', { style: { flex: '1' } }, ico(), levelLabel(kind));
  btn.addEventListener('click', () => {
    cycle(kind);
    btn.replaceChildren(ico(), levelLabel(kind));
  });
  return btn;
}

function goodIcon(g: string) {
  const el = icon(g as IconName);
  el.style.fill = ({ gold: '#f5c542', iron: '#b8c8d6', coal: '#9aa0ad', timber: '#8fd16d' } as Record<string, string>)[g] ?? 'currentColor';
  return el;
}

function siteIcon(site: string) {
  if (site === 'horses') {
    const el = icon('horse');
    el.style.fill = '#e0b27a';
    return el;
  }
  return goodIcon(site);
}

function stockView(stock: Stock, compact = false) {
  const parts = GOODS.filter((g) => !compact || stock[g] > 0).map((g) => h('span', goodIcon(g), String(stock[g])));
  return h('span.goods', { style: { display: 'inline-flex', gap: '8px', verticalAlign: 'middle' } }, parts.length ? parts : 'nothing');
}

/** Plain-text amounts for messages: "2 coal", "1 gold and 3 timber". */
function stockText(stock: Stock) {
  const parts = GOODS.filter((g) => stock[g] > 0).map((g) => `${stock[g]} ${g}`);
  if (!parts.length) return 'nothing';
  return parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

/** Short cost labels: "4 gold", "iron + coal", "1 of each". */
function costText(cost: Stock) {
  const used = GOODS.filter((g) => cost[g] > 0);
  if (used.length === GOODS.length && used.every((g) => cost[g] === 1)) return '1 of each';
  return used.map((g) => (cost[g] === 1 && used.length > 1 ? g : `${cost[g]} ${g}`)).join(' + ');
}
