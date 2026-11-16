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
import { cycle, level, levelLabel, play, setMood } from './audio.ts';
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
  tradeTo: number | null;
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
    tradeTo: null,
    give: emptyStock(),
    get: emptyStock(),
    info: null,
  };
}

interface ForceOption {
  force: Force | null;
  label: string;
  bonus: number;
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

  constructor(root: HTMLElement, session: Session, onExit: () => void) {
    this.root = root;
    this.session = session;
    this.onExit = onExit;
    const canvas = h('canvas.map') as HTMLCanvasElement;
    this.el.brand = h('div.float.brand');
    this.el.roster = h('div.float.roster', { onclick: () => this.toggleRoster() });
    this.el.panel = h('div.float.panel');
    this.el.info = h('div.float.infocard', { hidden: true, onclick: () => this.setInfo(null) });
    this.el.toasts = h('div.toasts');
    this.el.overlay = h('div', { hidden: true });
    this.el.tools = h(
      'div.float.tools',
      h('button', { title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => this.renderer.zoomBy(1.4) }, icon('plus')),
      h('button', { title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => this.renderer.zoomBy(1 / 1.4) }, icon('minus')),
      h('button', { title: 'Fit the whole map', 'aria-label': 'Fit the whole map', onclick: () => this.renderer.fit() }, icon('fit')),
    );
    if (canFullscreen()) {
      const fs = h('button', { title: 'Full screen', 'aria-label': 'Full screen', onclick: toggleFullscreen }, icon('fullscreen'));
      this.el.tools.appendChild(fs);
      this.offFullscreen = onFullscreenChange(() => fs.replaceChildren(icon(isFullscreen() ? 'exitFullscreen' : 'fullscreen')));
    }
    this.el.menu = h('div.float.menu-btn', h('button', { title: 'Menu', 'aria-label': 'Menu', onclick: () => this.openMenu() }, icon('menu')));
    this.el.game = h('div.screen.game', canvas, this.el.brand, this.el.roster, this.el.info, this.el.panel, this.el.tools, this.el.menu, this.el.toasts, this.el.overlay);
    mount(root, this.el.game);
    this.rosterCompact = window.innerWidth < 700 || window.innerHeight <= 520;
    this.renderer = new MapRenderer(canvas);
    this.renderer.onTap = (t) => this.tap(t);
    this.session.onError = (msg) => this.toast(msg, true);
    const state = session.state;
    this.names = territoryNames(hashSeed(state.settings.seed), state.territories.length);
    this.lastEvent = state.eventCount - 1;
    this.renderer.setState(state);
    this.unsub = session.subscribe((s) => this.onState(s));
    window.addEventListener('resize', this.layout);
    this.render();
  }

  private offFullscreen: () => void = () => {};

  destroy() {
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
    let produced = false;
    for (const { event: e } of events) {
      switch (e.kind) {
        case 'year':
          this.toast(`Year ${e.year} begins`);
          break;
        case 'phase':
          if (e.skipped) {
            const why: Partial<Record<Phase, string>> = {
              production: 'A hard winter: no production this year.',
              trade: 'Roads are closed: no trading this year.',
              shipment: 'Storms at sea: no shipments this year.',
            };
            this.toast(why[e.phase] ?? `${PHASE_NAMES[e.phase]} skipped`);
          }
          break;
        case 'deal':
          this.toast('The lands have been dealt out.');
          break;
        case 'produce':
        case 'horse':
          produced = true;
          break;
        case 'build':
          play('build');
          this.toast(`${this.player(e.player).name} built a ${ITEM_LABEL[e.item].toLowerCase()} in ${this.tname(e.territory)}`, false, e.player);
          break;
        case 'trade':
          play('trade');
          this.toast(`${this.player(e.from).name} and ${this.player(e.to).name} made a trade`, false, e.from);
          break;
        case 'ship':
          if (e.move.kind === 'stockpile') this.toast(`${this.player(e.player).name} moved their stockpile`, false, e.player);
          else this.toast(`${this.player(e.player).name} moved a ${e.move.kind} to ${this.tname(e.move.to)}`, false, e.player);
          break;
        case 'battle': {
          play('battle');
          const a = this.player(e.attacker).name;
          const d = e.defender < 0 ? 'the locals' : this.player(e.defender).name;
          const odds = `${e.attack} vs ${e.defense}`;
          if (!e.looted) setTimeout(() => play(e.won ? 'win' : 'lose'), 600);
          if (e.won) this.toast(`${a} conquered ${this.tname(e.target)} from ${d} (${odds})`, false, e.attacker);
          else this.toast(`${d} held ${this.tname(e.target)} against ${a} (${odds})`, false, e.defender);
          if (e.looted) {
            setTimeout(() => play('plunder'), 700);
            const loot = GOODS.filter((g) => e.looted![g] > 0).map((g) => `${e.looted![g]} ${g}`).join(', ');
            this.toast(`${a} captured ${d}'s stockpile${loot ? ': ' + loot : ''}!`, false, e.attacker);
          }
          break;
        }
        case 'eliminated':
          this.toast(`${this.player(e.player).name} has been driven from the map!`, false, e.player);
          break;
        case 'pass':
          if (e.reason && e.reason !== 'no shipment') this.toast(e.reason, false, e.player);
          break;
        case 'win':
          setTimeout(() => play('victory'), 400);
          break;
      }
    }
    if (produced) play('coin');
  }

  toast(text: string, error = false, player = -1) {
    const el = h('div.toast', player >= 0 ? h('span.dot', { style: { background: this.color(player).fill } }) : null, text);
    if (error) el.style.background = '#ffd9d9';
    this.el.toasts.appendChild(el);
    while (this.el.toasts.children.length > (window.innerHeight <= 520 ? 2 : 3)) this.el.toasts.removeChild(this.el.toasts.firstChild!);
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
      const ally = s.conquest.plan.allies.find((a) => a.side === null && local(a.player));
      if (ally) return { seat: ally.player, role: 'ally' };
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

  /**
   * Place the HUD and frame the map. The frame depends only on the screen and
   * the roster, never on the current prompt, so the map stays put while
   * prompts come and go. Where there is room beside the map (tablets,
   * landscape phones) prompts sit in a column on the right and never cover
   * it; on portrait phones they sit along the bottom.
   */
  private layout = () => {
    const game = this.el.game;
    const panel = this.el.panel;
    const roster = this.el.roster;
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const short = hgt <= 520;
    const narrowPortrait = w <= 600 && hgt > w;
    const css = getComputedStyle(document.documentElement);
    const safeTop = parseFloat(css.getPropertyValue('--safe-top')) || 0;
    const safeRight = parseFloat(css.getPropertyValue('--safe-right')) || 0;
    const brandBottom = safeTop + (w <= 700 || short ? 76 : 92);
    const sideW = Math.round(short ? Math.min(360, w * 0.42) : Math.min(300, Math.max(240, w * 0.3)));
    const side = short
      ? { top: 8, right: sideW + 20 + safeRight, bottom: 8, left: 64 }
      : { top: brandBottom + 6, right: sideW + 20 + safeRight, bottom: 62, left: 8 };
    const rosterBottom = safeTop + 12 + roster.getBoundingClientRect().height;
    const bottomH = (narrowPortrait ? 68 : 12) + Math.min(150, hgt * 0.2);
    const bottomOptions = [
      { top: Math.max(brandBottom, rosterBottom) + 6, right: 8, bottom: bottomH, left: 8 },
      { top: brandBottom + 6, right: Math.min(270, w * 0.46) + 20, bottom: bottomH, left: 8 },
    ];
    const bestBottom = Math.max(...bottomOptions.map((o) => this.renderer.scaleFor(o)));
    const useSide = !narrowPortrait && (short || this.renderer.scaleFor(side) >= bestBottom * 0.95);
    game.classList.toggle('side', useSide);
    game.classList.toggle('short', short);
    game.style.setProperty('--side-w', sideW + 'px');
    if (useSide) {
      const top = roster.getBoundingClientRect().bottom + 8;
      panel.style.top = top + 'px';
      panel.style.maxHeight = `${hgt - top - 12}px`;
      this.el.toasts.style.left = `${(side.left + w - side.right) / 2}px`;
      this.el.toasts.style.bottom = `${side.bottom + 8}px`;
      this.renderer.setInsets(side);
    } else {
      panel.style.top = '';
      panel.style.maxHeight = '';
      const rect = panel.getBoundingClientRect();
      const shown = !panel.hidden && rect.height > 0;
      // Toasts float just above the panel so they never hide the map's middle.
      this.el.toasts.style.left = '';
      this.el.toasts.style.bottom = `${(shown ? hgt - rect.top : 70) + 10}px`;
      this.renderer.setInsets(bottomOptions);
    }
  };

  render() {
    const s = this.state;
    const act = this.acting();
    const key = [s.phase, s.year, s.turn, act?.seat ?? -1, act?.role ?? '', s.conquest.plan ? 'p' : ''].join(':');
    if (key !== this.ui.key) {
      const keep = { tradeAs: this.ui.tradeAs, info: this.ui.info };
      this.ui = { ...freshUi(key), ...keep };
    }
    // Music turns martial during conquest.
    setMood(s.phase === 'conquest' ? 'war' : 'peace');
    this.renderBrand();
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
    if (act && multi && act.role !== 'trade' && act.seat !== this.lastSeat && this.handoffDone !== handKey) {
      this.showHandoff(act.seat, act.role, handKey);
      return;
    }
    this.el.overlay.hidden = true;
    if (act) this.lastSeat = act.seat;
    const hl = this.renderPanel(act);
    this.renderer.setHighlight(hl);
    this.layout();
  }

  private renderBrand() {
    const s = this.state;
    const list: Phase[] = s.year === 1 ? ['production', 'trade', 'shipment', 'conquest'] : ['development', 'production', 'trade', 'shipment', 'conquest'];
    const idx = list.indexOf(s.phase);
    const skipped = new Set(s.log.filter((e) => e.year === s.year && e.event.kind === 'phase' && e.event.skipped).map((e) => (e.event as { phase: Phase }).phase));
    mount(
      this.el.brand,
      h('div.name', 'LORDS OF CONQUEST'),
      h('div.phase', PHASE_NAMES[s.phase]),
      h('div.year', s.phase === 'select' ? 'Claim your lands' : `Year ${s.year} · first to ${s.settings.citiesToWin} cities`),
      s.phase === 'select' || s.phase === 'over'
        ? null
        : h('div.track', list.map((p, i) => h('span', { class: p === s.phase ? 'on' : skipped.has(p) ? 'skip' : i < idx ? 'done' : '', title: PHASE_NAMES[p] }))),
    );
  }

  private toggleRoster() {
    this.rosterCompact = !this.rosterCompact;
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
    mount(this.el.roster, rows);
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
          ? 'Your stockpile was captured! Choose where to keep a new one. This is free: it does not use up your turn.'
          : 'Your stockpile holds all your gold, iron, coal and timber. If an enemy conquers that land, they take everything. Keep it safe!',
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
      if (item === 'boat' && ui.sel !== null) {
        const seas = info(s).territories[ui.sel].seas.filter((x) => freeBerths(s, ui.sel!, x) > 0);
        if (ui.sea === null || !seas.includes(ui.sea)) ui.sea = seas[0] ?? null;
        if (seas.length > 1) {
          seaRow = h(
            'div.row',
            { style: { marginTop: '10px' } },
            h('span.muted', 'Launch on'),
            h('div.seg', seas.map((x, i) => h('button', { 'aria-pressed': String(ui.sea === x), onclick: () => ((ui.sea = x), this.render()) }, `Water ${i + 1}`))),
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
      h('div.choice', choices),
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
    if (ui.tradeTo === null || !others.some((o) => o.id === ui.tradeTo)) ui.tradeTo = others[0]?.id ?? null;
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

    const offerLine = (o: (typeof s.trade.offers)[number], mineSide: 'in' | 'out') =>
      h(
        'div.offer',
        h('span.dot', { style: { background: this.color(mineSide === 'in' ? o.from : o.to).fill } }),
        mineSide === 'in'
          ? h('span', h('b', this.player(o.from).name), ' gives ', stockView(o.give, true), ' for ', stockView(o.get, true))
          : h('span', 'To ', h('b', this.player(o.to).name), ': ', stockView(o.give, true), ' for ', stockView(o.get, true)),
        h('span.spacer'),
        mineSide === 'in'
          ? [
              h('button.small.primary', { disabled: !canPay(me.stock, o.get), onclick: () => this.act({ type: 'respond', player: seat, offer: o.id, accept: true }) }, 'Accept'),
              h('button.small', { onclick: () => this.act({ type: 'respond', player: seat, offer: o.id, accept: false }) }, 'Decline'),
            ]
          : h('button.small', { onclick: () => this.act({ type: 'withdraw', player: seat, offer: o.id }) }, 'Withdraw'),
      );

    const partner = ui.tradeTo;
    const partnerLocal = partner !== null && this.session.controls(partner);
    const stepper = (stock: Stock, g: (typeof GOODS)[number], max: number) =>
      h(
        'span.stepper',
        h('button', { disabled: stock[g] <= 0, onclick: () => ((stock[g] -= 1), this.render()), 'aria-label': 'less' }, '−'),
        h('output', String(stock[g])),
        h('button', { disabled: stock[g] >= max, onclick: () => ((stock[g] += 1), this.render()), 'aria-label': 'more' }, '+'),
      );
    const theirs = partner !== null ? this.player(partner).stock : emptyStock();
    const empty = GOODS.every((g) => ui.give[g] === 0 && ui.get[g] === 0);
    const composer =
      partner === null
        ? null
        : h(
            'div',
            h('div.row', { style: { marginTop: '10px' } }, h('span.muted', 'Trade with'), h('div.seg', others.map((o) => h('button', { 'aria-pressed': String(o.id === partner), onclick: () => ((ui.tradeTo = o.id), this.render()) }, o.name)))),
            h(
              'div.trade-grid',
              h('span'),
              h('span.hdr', `${me.name} gives`),
              h('span.hdr', `${this.player(partner).name} gives`),
              GOODS.map((g) => [h('span.row', goodIcon(g), GOOD_LABELS[g]), stepper(ui.give, g, me.stock[g]), stepper(ui.get, g, partnerLocal ? theirs[g] : 99)]),
            ),
            h(
              'div.actions',
              h('span.spacer'),
              h(
                'button',
                {
                  class: partnerLocal ? 'primary' : '',
                  disabled: empty,
                  onclick: () => this.makeOffer(seat, partner, partnerLocal),
                },
                icon('trade'),
                partnerLocal ? 'Make this trade' : `Offer to ${this.player(partner).name}`,
              ),
            ),
          );
    mount(
      panel,
      this.who(seat, ready ? `${me.name} is done trading` : `${me.name}: trading`, h('p', 'Make deals out loud, then record them here. Your stockpile: ', stockView(me.stock))),
      asRow,
      incoming.map((o) => offerLine(o, 'in')),
      outgoing.map((o) => offerLine(o, 'out')),
      ready ? null : composer,
      h(
        'div.actions',
        h('span.muted', { style: { fontSize: '13px' } }, stillTrading.length ? `Still trading: ${stillTrading.join(', ')}` : ''),
        h('span.spacer'),
        ready
          ? h('button', { onclick: () => this.act({ type: 'ready', player: seat, ready: false }) }, 'Keep trading')
          : h('button.primary', { onclick: () => this.act({ type: 'ready', player: seat, ready: true }) }, 'Done trading'),
      ),
    );
    return {};
  }

  private makeOffer(seat: number, to: number, local: boolean) {
    const s = this.state;
    const id = s.trade.nextId;
    const give = { ...this.ui.give };
    const get = { ...this.ui.get };
    const err = this.session.dispatch({ type: 'offer', player: seat, to, give, get });
    if (err) return this.toast(err, true);
    this.ui.give = emptyStock();
    this.ui.get = emptyStock();
    if (local) {
      // Both people are holding this device and agreed out loud.
      const e2 = this.session.dispatch({ type: 'respond', player: to, offer: id, accept: true });
      if (e2) this.toast(e2, true);
    } else {
      this.toast(`Offer sent to ${this.player(to).name}`);
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
      h('div.choice', choices),
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

  private forceOptions(seat: number, target: number): ForceOption[] {
    const s = this.state;
    const T = s.territories;
    const touching = neighbors(s, target).some((n) => T[n].owner === seat);
    const out: ForceOption[] = touching ? [{ force: null, label: 'Just my borders', bonus: 0 }] : [];
    const seenHorse = new Set<number>();
    for (const via of neighbors(s, target)) {
      if (T[via].owner !== seat) continue;
      for (const from of neighbors(s, via)) {
        if (from === target || seenHorse.has(from) || T[from].owner !== seat || !T[from].horse || adjacent(s, from, target)) continue;
        seenHorse.add(from);
        out.push({ force: { kind: 'horse', from, via }, label: `Horse from ${this.tname(from)}`, bonus: 1 });
        if (T[from].weapon) out.push({ force: { kind: 'horse', from, via, weaponFrom: from }, label: `Horse + weapon from ${this.tname(from)}`, bonus: 4 });
      }
    }
    if (s.settings.level >= 3) {
      const seas = info(s).territories[target].seas;
      T.forEach((t, from) => {
        if (t.owner !== seat) return;
        for (const sea of new Set(t.boats)) {
          if (!seas.includes(sea) || freeBerths(s, target, sea) <= 0) continue;
          out.push({ force: { kind: 'boat', from, sea, horse: false, weapon: false }, label: `Boat from ${this.tname(from)}`, bonus: 2 });
          const far = !adjacent(s, from, target);
          const horse = t.horse && !T[target].horse;
          const weapon = t.weapon && !T[target].weapon;
          if (far && (horse || weapon)) {
            const what = [horse ? 'horse' : '', weapon ? 'weapon' : ''].filter(Boolean).join(' + ');
            out.push({ force: { kind: 'boat', from, sea, horse, weapon }, label: `Boat + ${what} from ${this.tname(from)}`, bonus: 2 + (horse ? 1 : 0) + (weapon ? 3 : 0) });
          }
        }
      });
    }
    return out;
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
        return h('div.offer', h('span.dot', { style: { background: this.color(a.player).fill } }), h('b', this.player(a.player).name), ' ', what);
      });
      const pending = plan.allies.some((a) => a.side === null);
      mount(
        panel,
        this.who(seat, `${p.name} attacks ${this.tname(plan.target)}`, pending ? 'Neighbors with forces nearby are choosing sides…' : 'Everyone has chosen.'),
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
    const footer = h(
      'div.actions',
      h('button', { onclick: () => this.act({ type: 'done', player: seat }) }, 'End turn'),
      !s.conquest.usedStockpileMove && territoriesOf(s, seat).length > 1
        ? h('button', { onclick: () => ((ui.stockpileMode = true), (ui.target = null), this.render()) }, icon('stockpile'), 'Move stockpile')
        : null,
      h('span.spacer'),
      target !== null ? h('button.primary', { id: 'attack-btn' }, icon('swords'), 'Attack!') : null,
    );
    const title = `${p.name}: ${left === 1 ? 'one attack left' : `${left} attacks`}`;
    if (target === null) {
      mount(panel, this.who(seat, title, 'Tap an enemy or unclaimed territory next to yours to plan an attack.'), footer);
      return { selectable: targets };
    }
    const options = this.forceOptions(seat, target);
    if (ui.force >= options.length) ui.force = 0;
    const opt = options[ui.force];
    const pv = previewAttack(s, seat, target, opt?.force ?? null);
    const btn = footer.querySelector('#attack-btn') as HTMLButtonElement;
    btn.disabled = !pv.possible;
    btn.onclick = () => this.launch(seat, target, opt?.force ?? null);
    const allyNote = pv.allies.length
      ? h('p', 'Also nearby: ', pv.allies.map((a, i) => [i ? ', ' : '', h('b', this.player(a.player).name), ` (${a.strength})`]), ' may take sides.')
      : null;
    mount(
      panel,
      this.who(seat, `${title} · ${this.tname(target)}`, null),
      this.vsView(pv.attack, pv.defense, s.territories[target].owner, pv.possible ? null : 'Attack will fail!'),
      this.stakeView(target),
      options.length > 1
        ? h(
            'div.choice',
            options.map((o, i) =>
              h('button', { 'aria-pressed': String(i === ui.force), onclick: () => ((ui.force = i), play('tap'), this.render()) }, h('b', o.label), h('small', o.bonus ? `+${o.bonus}` : 'no extra')),
            ),
          )
        : null,
      allyNote,
      footer,
    );
    const arrows = opt?.force ? [{ from: opt.force.from, to: target, color }] : [];
    return { selectable: targets, target, arrows };
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
        '. It is outlined in red on the map.',
      ),
      this.stakeView(plan.target),
      h('p', `Your lands next to it add `, h('b', { style: { color: 'var(--text)' } }, `+${entry.strength}`), ' to whichever side you join.'),
      this.vsView(att, def, plan.defender, null, attName),
      h(
        'div.choice',
        choice('attacker', `Help ${attName}`, att + entry.strength, def),
        choice('defender', `Help ${defName === 'the locals' ? 'the locals' : defName}`, att, def + entry.strength),
        choice('neutral', 'Stay out', att, def, 'quiet'),
      ),
      undecided.length ? h('p', `Also deciding: ${undecided.join(', ')}.`) : null,
    );
    return { target: plan.target, arrows: plan.force ? [{ from: plan.force.from, to: plan.target, color: this.color(attacker).fill }] : [] };
  }

  /** What changes hands if a territory falls. */
  private stakeView(t: number) {
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
      h('span.muted', 'At stake:'),
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
    if (action.type === 'pick' || action.type === 'placeStockpile') play('select');
    this.ui.info = null;
    this.render();
  }

  private tap(t: number) {
    const s = this.state;
    const act = this.acting();
    const ui = this.ui;
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
            this.forceOptions(act.seat, t).forEach((o, i) => {
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

  private showHandoff(seat: number, role: string, key: string) {
    const p = this.player(seat);
    const c = this.color(seat);
    const s = this.state;
    const plan = s.conquest.plan;
    const what =
      role === 'ally' && plan
        ? `${this.player(currentPlayer(s)).name} is attacking ${this.tname(plan.target)} and needs your answer.`
        : role === 'place'
          ? s.phase === 'production'
            ? 'Time to place your stockpile.'
            : 'Your stockpile was captured. Choose a new home for it, then take your turn.'
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
        h(
          'div.stack',
          h(
            'button.primary',
            {
              onclick: () => {
                this.handoffDone = key;
                this.lastSeat = seat;
                play('turn');
                this.render();
              },
            },
            `I'm ${p.name}, let's go`,
          ),
        ),
      ),
    );
    this.renderer.setHighlight({});
  }

  private showGameOver() {
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
          h('button.primary', { onclick: () => this.onExit() }, 'Back to the menu'),
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
          h('button', { onclick: () => (close(), this.onExit()) }, this.session.kind === 'local' ? 'Save and leave' : 'Leave (the game keeps going)'),
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

function costText(cost: Stock) {
  return GOODS.filter((g) => cost[g] > 0)
    .map((g) => `${cost[g]} ${g}`)
    .join(' + ');
}
