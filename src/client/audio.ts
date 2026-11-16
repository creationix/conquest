// Small synthesized sound effects. No audio files, works offline, and the
// context is unlocked on the first tap (required by iOS Safari).

type Sfx = 'tap' | 'select' | 'build' | 'coin' | 'win' | 'lose' | 'battle' | 'turn' | 'victory';

let ctx: AudioContext | null = null;
let enabled = true;
try {
  enabled = localStorage.getItem('conquest-sound') !== 'off';
} catch {
  /* ignore */
}

export function soundOn() {
  return enabled;
}

export function setSound(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem('conquest-sound', on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
}

function audio(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function unlockAudio() {
  const unlock = () => {
    audio();
    window.removeEventListener('pointerdown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
}

function tone(freq: number, start: number, dur: number, type: OscillatorType, gain: number, slide = 0) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + start;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function noise(start: number, dur: number, gain: number) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + start;
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = a.createBufferSource();
  src.buffer = buf;
  const filter = a.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 700;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(a.destination);
  src.start(t);
}

export function play(sfx: Sfx) {
  if (!enabled) return;
  switch (sfx) {
    case 'tap':
      return tone(660, 0, 0.06, 'triangle', 0.06);
    case 'select':
      tone(523, 0, 0.08, 'triangle', 0.07);
      return tone(784, 0.05, 0.1, 'triangle', 0.06);
    case 'build':
      tone(392, 0, 0.12, 'square', 0.04);
      return tone(587, 0.08, 0.18, 'triangle', 0.08);
    case 'coin':
      tone(988, 0, 0.07, 'square', 0.03);
      return tone(1319, 0.06, 0.16, 'square', 0.03);
    case 'battle':
      noise(0, 0.35, 0.25);
      return tone(110, 0, 0.35, 'sawtooth', 0.05, 0.5);
    case 'win':
      [523, 659, 784].forEach((f, i) => tone(f, i * 0.09, 0.22, 'triangle', 0.08));
      return;
    case 'lose':
      return [392, 311].forEach((f, i) => tone(f, i * 0.14, 0.3, 'triangle', 0.07));
    case 'turn':
      tone(440, 0, 0.12, 'sine', 0.08);
      return tone(660, 0.1, 0.2, 'sine', 0.08);
    case 'victory':
      [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, i * 0.13, 0.3, 'triangle', 0.09));
      return;
  }
}
