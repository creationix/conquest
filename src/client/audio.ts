// Audio session: synthesized sound effects and optional background music.
// Sound and music each have Off / Soft / Full. New players start with soft
// effects and no music. Everything is generated with Web Audio (no files),
// unlocked on the first tap as iOS requires, and paused in the background.

import { MusicPlayer, type Mood } from './music.ts';

export type Level = 'off' | 'soft' | 'full';
const LEVELS: Level[] = ['off', 'soft', 'full'];
const GAINS = { sound: { off: 0, soft: 0.45, full: 1 }, music: { off: 0, soft: 0.45, full: 0.95 } };
const LABEL: Record<Level, string> = { off: 'Off', soft: 'Soft', full: 'Full' };

type Kind = 'sound' | 'music';

function read(kind: Kind, fallback: Level): Level {
  try {
    const v = localStorage.getItem('conquest-' + kind) as Level | null;
    if (v && LEVELS.includes(v)) return v;
  } catch {
    /* ignore */
  }
  return fallback;
}

const levels: Record<Kind, Level> = { sound: read('sound', 'soft'), music: read('music', 'off') };

let ctx: AudioContext | null = null;
let limiter: DynamicsCompressorNode | null = null;
const buses: Partial<Record<Kind, GainNode>> = {};
let music: MusicPlayer | null = null;
let mood: Mood = 'peace';
let noise: AudioBuffer | null = null;

export function level(kind: Kind): Level {
  return levels[kind];
}

export function levelLabel(kind: Kind): string {
  return `${kind === 'music' ? 'Music' : 'Sound'}: ${LABEL[levels[kind]]}`;
}

/** Cycle Off → Soft → Full and return the new level. */
export function cycle(kind: Kind): Level {
  const next = LEVELS[(LEVELS.indexOf(levels[kind]) + 1) % LEVELS.length];
  levels[kind] = next;
  try {
    localStorage.setItem('conquest-' + kind, next);
  } catch {
    /* ignore */
  }
  init();
  sync();
  if (kind === 'sound' && next !== 'off') play('select');
  return next;
}

/** Music plays only during a game; the menus stay quiet. */
let musicActive = false;
export function setMusicActive(on: boolean) {
  musicActive = on;
  sync();
}

export function setMood(m: Mood) {
  mood = m;
  music?.setMood(m);
}

function sync() {
  if (!ctx) return;
  for (const kind of ['sound', 'music'] as Kind[]) {
    const g = GAINS[kind][levels[kind]];
    buses[kind]?.gain.setTargetAtTime(g, ctx.currentTime, 0.03);
  }
  music?.setEnabled(levels.music !== 'off' && musicActive && !document.hidden);
}

function init() {
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    // On iPhone, let enabled game audio play even with the ring/silent switch on.
    try {
      const nav = navigator as unknown as { audioSession?: { type: string } };
      if (nav.audioSession) nav.audioSession.type = 'playback';
    } catch {
      /* optional */
    }
    ctx = new AC();
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 8;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    limiter.connect(ctx.destination);
    for (const kind of ['sound', 'music'] as Kind[]) {
      const g = ctx.createGain();
      g.gain.value = GAINS[kind][levels[kind]];
      g.connect(limiter);
      buses[kind] = g;
    }
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    music = new MusicPlayer(ctx, buses.music!);
    music.setMood(mood);
    setInterval(() => music?.tick(), 80);
    // Older iOS needs a sound started inside the first gesture.
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      /* ignore */
    }
  }
  if (!document.hidden && ctx.state !== 'running') ctx.resume().catch(() => {});
  sync();
}

/** Start listening for the first gesture, button clicks and visibility changes. */
export function setupAudio() {
  for (const ev of ['pointerdown', 'touchend', 'click', 'keydown']) window.addEventListener(ev, init, true);
  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest?.('button')) play('click');
  });
  document.addEventListener('visibilitychange', () => {
    sync();
    if (ctx) (document.hidden ? ctx.suspend() : ctx.resume()).catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Effects: a small kit of synthesized sounds. Every call varies slightly in
// pitch so repeated events never sound mechanical.

export type Sfx =
  | 'click' | 'tap' | 'select' | 'error'
  | 'flag' | 'chest' | 'turn' | 'bell'
  | 'cueBuild' | 'cueHarvest' | 'cueMarket' | 'cueSail' | 'cueWar' | 'cueSkip'
  | 'newYear' | 'winter' | 'roadsClosed' | 'storm'
  | 'gold' | 'iron' | 'coal' | 'timber' | 'hooves'
  | 'city' | 'weapon' | 'boat' | 'splash'
  | 'offer' | 'trade' | 'decline'
  | 'battle' | 'triumph' | 'win' | 'loss' | 'repel' | 'plunder' | 'gong' | 'victory';

export interface SfxOptions {
  /** Seconds from now. */
  delay?: number;
  /** Per-player variation (0-6): shifts pitch so each lord sounds a little different. */
  variant?: number;
  /** 0-1: bigger battles get bigger drums. */
  strength?: number;
}

let jitter = 1;
let base = 0;

function tone(freq: number, start: number, dur: number, type: OscillatorType, gain: number, slide = 0, attack = 0.01) {
  if (!ctx || !buses.sound) return;
  const t = ctx.currentTime + base + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  const f = freq * jitter;
  osc.frequency.setValueAtTime(f, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, f * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(buses.sound);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function hiss(start: number, dur: number, gain: number, type: BiquadFilterType, freq: number, sweepTo = 0, q = 1) {
  if (!ctx || !buses.sound || !noise) return;
  const t = ctx.currentTime + base + start;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t);
  if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(buses.sound);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.05);
}

/** A struck metal object: inharmonic partials that ring and fade. */
function metal(start: number, freq: number, gain: number, decay: number) {
  [1, 2.76, 5.4, 8.93].forEach((r, i) => tone(freq * r, start, decay / (1 + i * 0.6), 'sine', gain / (1 + i)));
}

/** A wooden knock: a quick pitched thump. */
function knock(start: number, freq: number, gain: number) {
  tone(freq, start, 0.09, 'sine', gain, 0.55, 0.003);
  hiss(start, 0.03, gain * 0.5, 'bandpass', freq * 3, 0, 2);
}

/** A soft brass note: sawtooth through a gentle filter (via a quieter triangle doubling). */
function horn(start: number, freq: number, dur: number, gain: number) {
  tone(freq, start, dur, 'sawtooth', gain * 0.35, 0, 0.06);
  tone(freq, start, dur, 'triangle', gain, 0, 0.05);
  tone(freq / 2, start, dur, 'sine', gain * 0.6, 0, 0.05);
}

function drum(start: number, gain: number, pitch = 110) {
  tone(pitch, start, 0.3, 'sine', gain, 0.45, 0.004);
  hiss(start, 0.07, gain * 0.5, 'lowpass', 700);
}

export function play(sfx: Sfx, options: SfxOptions = {}) {
  if (levels.sound === 'off' || !ctx || ctx.state !== 'running') return;
  base = options.delay ?? 0;
  const v = options.variant ?? -1;
  // Small random detune on every sound, plus a per-player pitch where given.
  jitter = (1 + (Math.random() - 0.5) * 0.05) * (v >= 0 ? Math.pow(2, (v - 3) / 12) : 1);
  const strength = Math.max(0, Math.min(1, options.strength ?? 0.5));
  switch (sfx) {
    // --- Interface ---
    case 'click':
      return tone(1300, 0, 0.03, 'triangle', 0.035);
    case 'tap':
      return tone(720, 0, 0.05, 'triangle', 0.06);
    case 'select':
      tone(523, 0, 0.08, 'triangle', 0.08);
      return tone(784, 0.05, 0.12, 'triangle', 0.07);
    case 'error':
      tone(233, 0, 0.12, 'triangle', 0.08);
      return tone(196, 0.1, 0.2, 'triangle', 0.08);
    case 'turn':
      // A rising two-note call, pitched to the player.
      tone(587, 0, 0.16, 'sine', 0.1);
      return tone(880, 0.12, 0.3, 'sine', 0.1);
    // --- Claiming land and stockpiles ---
    case 'flag':
      // Cloth whoosh, then the pole thumping into the ground.
      hiss(0, 0.18, 0.12, 'bandpass', 600, 2400, 1.5);
      knock(0.16, 140, 0.25);
      return tone(660, 0.18, 0.18, 'triangle', 0.05);
    case 'chest':
      // A heavy lid and a lock click.
      knock(0, 90, 0.3);
      knock(0.07, 70, 0.2);
      return metal(0.2, 2400, 0.03, 0.12);
    case 'bell':
      // The bell tolls in a new year.
      metal(0, 330, 0.09, 2.2);
      return metal(0, 165, 0.05, 2.6);
    // --- Phase cues ---
    case 'cueBuild':
      [0, 0.18].forEach((at) => metal(at, 1400, 0.04, 0.35));
      return tone(392, 0.3, 0.4, 'triangle', 0.06);
    case 'cueHarvest':
      [659, 784, 988].forEach((f, i) => tone(f, i * 0.09, 0.5, 'sine', 0.06));
      return;
    case 'cueMarket':
      [988, 1175, 1319, 1175].forEach((f, i) => metal(i * 0.11, f, 0.03, 0.4));
      return;
    case 'cueSail':
      // A ship's horn over the waves.
      hiss(0, 0.9, 0.06, 'lowpass', 400, 900);
      return horn(0.1, 147, 0.8, 0.07);
    case 'cueWar':
      drum(0, 0.3, 90);
      drum(0.22, 0.3, 90);
      horn(0.38, 147, 0.25, 0.08);
      return horn(0.62, 220, 0.5, 0.08);
    case 'cueSkip':
      // A muted, falling shrug: this phase is skipped.
      tone(330, 0, 0.18, 'triangle', 0.05);
      return tone(247, 0.14, 0.3, 'triangle', 0.05);
    // --- Announcement jingles (a few seconds each) ---
    case 'newYear':
      // The bell, then a rising, hopeful horn call.
      metal(0, 330, 0.08, 2);
      [392, 523, 659, 784].forEach((f, i) => horn(0.5 + i * 0.22, f, i === 3 ? 0.9 : 0.24, 0.07));
      return;
    case 'winter':
      // Cold wind and slow, falling bells.
      hiss(0, 2.6, 0.06, 'bandpass', 500, 1600, 0.8);
      [659, 523, 440, 330].forEach((f, i) => metal(0.2 + i * 0.42, f, 0.06, 1.4));
      return;
    case 'roadsClosed':
      // A gate slams, then a falling horn phrase.
      knock(0, 110, 0.32);
      knock(0.12, 90, 0.26);
      [294, 262, 220].forEach((f, i) => horn(0.4 + i * 0.32, f, i === 2 ? 0.8 : 0.3, 0.07));
      return;
    case 'storm':
      // Thunder rolling in over wind, and a low, uneasy horn.
      hiss(0, 2.4, 0.3, 'lowpass', 180, 60, 0.7);
      hiss(0.05, 0.25, 0.25, 'lowpass', 1200, 200);
      hiss(0, 2.6, 0.05, 'bandpass', 700, 1800, 0.8);
      horn(0.6, 147, 0.7, 0.06);
      return horn(1.25, 139, 1, 0.06);
    // --- Production ---
    case 'gold':
      tone(1976, 0, 0.12, 'square', 0.03);
      tone(2637, 0.06, 0.3, 'sine', 0.1);
      return metal(0.02, 3100, 0.04, 0.35);
    case 'iron':
      return metal(0, 620, 0.06, 0.45);
    case 'coal':
      // Tumbling lumps.
      [0, 0.05, 0.11].forEach((at, i) => knock(at, 120 - i * 15, 0.15));
      return hiss(0, 0.25, 0.08, 'lowpass', 500);
    case 'timber':
      // An axe biting wood, twice.
      knock(0, 330, 0.2);
      return knock(0.13, 300, 0.16);
    case 'hooves':
      // A short gallop.
      [0, 0.08, 0.26, 0.34].forEach((at, i) => knock(at, i % 2 ? 260 : 300, 0.14));
      return;
    // --- Building ---
    case 'city':
      // Stone blocks set in place, then a bright chime.
      [0, 0.14, 0.28].forEach((at) => knock(at, 95, 0.28));
      metal(0.42, 880, 0.06, 1.2);
      return metal(0.42, 1320, 0.04, 1);
    case 'weapon':
      // Steel drawn and ringing.
      hiss(0, 0.25, 0.1, 'highpass', 3000, 6000);
      return metal(0.18, 1870, 0.05, 0.8);
    case 'boat':
      hiss(0, 0.5, 0.2, 'lowpass', 1800, 300);
      knock(0.35, 180, 0.16);
      return knock(0.45, 150, 0.1);
    case 'splash':
      return hiss(0, 0.5, 0.22, 'lowpass', 2000, 300);
    // --- Trading ---
    case 'offer':
      [1319, 1568].forEach((f, i) => tone(f, i * 0.07, 0.22, 'sine', 0.09));
      return;
    case 'trade':
      // Coins changing hands both ways.
      [1760, 2093, 1568, 1976].forEach((f, i) => metal(i * 0.07, f, 0.05, 0.3));
      return;
    case 'decline':
      tone(392, 0, 0.18, 'triangle', 0.06);
      return tone(311, 0.15, 0.25, 'triangle', 0.06);
    // --- Battle ---
    case 'battle': {
      // Drums: more beats for bigger battles, then a clash of steel.
      const beats = 2 + Math.round(strength * 3);
      for (let i = 0; i < beats; i++) drum(i * 0.14, 0.22 + strength * 0.15, 105 - i * 6);
      hiss(beats * 0.14, 0.3, 0.14, 'highpass', 4000);
      return metal(beats * 0.14, 1480, 0.035, 0.5);
    }
    case 'triumph':
      // You won: a bright fanfare.
      [523, 659, 784].forEach((f, i) => horn(i * 0.11, f, 0.16, 0.1));
      return horn(0.36, 1047, 0.5, 0.11);
    case 'win':
      // Someone else won: a short, neutral flourish.
      [392, 523].forEach((f, i) => horn(i * 0.1, f, 0.22, 0.07));
      return;
    case 'loss':
      // You lost a land: a falling, minor phrase.
      [392, 349, 311].forEach((f, i) => horn(i * 0.16, f, 0.26, 0.05));
      return;
    case 'repel':
      // The attack breaks on shields.
      metal(0, 800, 0.06, 0.35);
      knock(0.05, 110, 0.25);
      return tone(196, 0.12, 0.4, 'triangle', 0.06, 0.8);
    case 'gong':
      metal(0, 98, 0.12, 3);
      return metal(0, 147, 0.06, 2.5);
    case 'plunder': {
      // A stockpile is looted: a dark brass stab, then spilling coins.
      for (const [f, g] of [[147, 0.07], [175, 0.06], [220, 0.05]] as const) {
        tone(f, 0, 0.9, 'sawtooth', g * 0.6);
        tone(f / 2, 0, 1.1, 'triangle', g);
      }
      hiss(0, 0.5, 0.14, 'lowpass', 500);
      let at = 0.25;
      for (let i = 0; i < 22; i++) {
        const f = 1900 + ((i * 7919) % 13) * 110;
        tone(f, at, 0.09, 'square', 0.022);
        tone(f * 1.5, at + 0.005, 0.12, 'sine', 0.03);
        hiss(at, 0.03, 0.05, 'highpass', 6000);
        at += 0.035 + i * 0.004;
      }
      return tone(2400, at, 0.5, 'sine', 0.035, 0.7);
    }
    case 'victory': {
      const notes = [523, 523, 523, 659, 784, 659, 784, 1047];
      const at = [0, 0.12, 0.24, 0.36, 0.6, 0.84, 0.96, 1.2];
      notes.forEach((f, i) => horn(at[i], f, i === notes.length - 1 ? 1 : 0.22, 0.1));
      return;
    }
  }
}
