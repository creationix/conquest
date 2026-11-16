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
  music?.setEnabled(levels.music !== 'off' && !document.hidden);
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
// Effects

type Sfx = 'click' | 'tap' | 'select' | 'build' | 'coin' | 'win' | 'lose' | 'battle' | 'turn' | 'victory' | 'trade' | 'error';

function tone(freq: number, start: number, dur: number, type: OscillatorType, gain: number, slide = 0) {
  if (!ctx || !buses.sound) return;
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(buses.sound);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function hiss(start: number, dur: number, gain: number, type: BiquadFilterType, freq: number) {
  if (!ctx || !buses.sound || !noise) return;
  const t = ctx.currentTime + start;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(buses.sound);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.05);
}

export function play(sfx: Sfx) {
  if (levels.sound === 'off' || !ctx || ctx.state !== 'running') return;
  switch (sfx) {
    case 'click':
      return tone(1200, 0, 0.035, 'triangle', 0.05);
    case 'tap':
      return tone(700, 0, 0.06, 'triangle', 0.08);
    case 'select':
      tone(523, 0, 0.09, 'triangle', 0.1);
      return tone(784, 0.06, 0.14, 'triangle', 0.09);
    case 'build':
      // Hammer on an anvil: two clanks with a metallic ring.
      for (const at of [0, 0.13]) {
        hiss(at, 0.05, 0.25, 'bandpass', 3000);
        tone(1870, at, 0.25, 'sine', 0.05);
        tone(2630, at, 0.18, 'sine', 0.03);
      }
      return;
    case 'coin':
      tone(988, 0, 0.08, 'square', 0.04);
      return tone(1319, 0.07, 0.2, 'square', 0.04);
    case 'trade':
      [659, 784, 988].forEach((f, i) => tone(f, i * 0.07, 0.16, 'triangle', 0.08));
      return;
    case 'battle':
      // War drums and a clash of steel.
      [0, 0.16, 0.32].forEach((at, i) => {
        tone(110 - i * 10, at, 0.3, 'sine', 0.35, 0.45);
        hiss(at, 0.08, 0.2, 'lowpass', 700);
      });
      hiss(0.5, 0.35, 0.18, 'highpass', 4500);
      tone(1480, 0.5, 0.4, 'sine', 0.04);
      return;
    case 'win':
      [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.1, 0.3, 'triangle', 0.1));
      return;
    case 'lose':
      [392, 370, 311].forEach((f, i) => tone(f, i * 0.16, 0.35, 'triangle', 0.09));
      return;
    case 'error':
      return tone(220, 0, 0.18, 'square', 0.04, 0.8);
    case 'turn':
      tone(587, 0, 0.14, 'sine', 0.1);
      return tone(880, 0.12, 0.28, 'sine', 0.1);
    case 'victory': {
      // A short fanfare.
      const notes = [523, 523, 523, 659, 784, 659, 784, 1047];
      const at = [0, 0.12, 0.24, 0.36, 0.6, 0.84, 0.96, 1.2];
      notes.forEach((f, i) => {
        tone(f, at[i], i === notes.length - 1 ? 1 : 0.22, 'sawtooth', 0.05);
        tone(f / 2, at[i], i === notes.length - 1 ? 1 : 0.22, 'triangle', 0.06);
      });
      return;
    }
  }
}
