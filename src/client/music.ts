// Generative background music for Conquest.
//
// The music is a series of short pieces with real silence between them, so it
// never drones. Each piece is a different kind of thing: a harp arpeggio that
// slows to a close, a flute tune answered by itself, a quick plucked dance, a
// few soft chords that swell and fade, a sparse bell motif. During conquest it
// plays a soft march, a tense heartbeat, or harp and flute in minor keys, with
// shorter pauses. Keys, tempos and melodies are chosen fresh every time.
// No recordings: notes are generated and scheduled ahead on the Web Audio clock.

const hz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

export type Mood = 'peace' | 'war';

interface Key {
  root: number;
  scale: number[];
}

const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const MIXOLYDIAN = [0, 2, 4, 5, 7, 9, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
const IONIAN = [0, 2, 4, 5, 7, 9, 11];
const AEOLIAN = [0, 2, 3, 5, 7, 8, 10];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];

const KEYS: Record<Mood, Key[]> = {
  peace: [
    { root: 50, scale: DORIAN },
    { root: 53, scale: LYDIAN },
    { root: 55, scale: MIXOLYDIAN },
    { root: 48, scale: IONIAN },
    { root: 57, scale: AEOLIAN },
    { root: 52, scale: DORIAN },
  ],
  war: [
    { root: 50, scale: AEOLIAN },
    { root: 52, scale: PHRYGIAN },
    { root: 45, scale: DORIAN },
    { root: 47, scale: AEOLIAN },
  ],
};

// Chord progressions as scale degrees (0 = tonic), one chord per bar.
const PROGRESSIONS: Record<Mood, number[][]> = {
  peace: [
    [0, 3, 4, 0],
    [0, 5, 3, 4],
    [0, 2, 3, 0],
    [5, 3, 0, 4],
    [0, 4, 5, 3],
    [3, 0, 4, 0],
    [0, 3, 0, 4],
  ],
  war: [
    [0, 5, 6, 0],
    [0, 3, 6, 4],
    [0, 6, 5, 4],
    [0, 0, 5, 6],
  ],
};

type PieceKind = 'harp' | 'melody' | 'dance' | 'chorale' | 'bells' | 'march' | 'tension';

const PIECES: Record<Mood, [PieceKind, number][]> = {
  peace: [
    ['harp', 3],
    ['melody', 3],
    ['dance', 2],
    ['chorale', 2],
    ['bells', 2],
  ],
  war: [
    ['march', 3],
    ['tension', 2],
    ['harp', 1],
    ['melody', 2],
  ],
};

/** Seconds of silence between pieces. */
const REST: Record<Mood, [number, number]> = { peace: [7, 15], war: [3, 7] };

type Voice = 'harp' | 'flute' | 'bass' | 'pluckBass' | 'choir' | 'bell' | 'lute' | 'horn' | 'drum' | 'tap';

interface Note {
  /** Absolute audio-clock time. */
  at: number;
  voice: Voice;
  note: number;
  dur: number;
  gain: number;
}

class Random {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number) {
    return Math.floor(this.next() * n);
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)];
  }
  chance(p: number) {
    return this.next() < p;
  }
}

/** Helper for writing one piece: key, tempo and a list of notes. */
class Score {
  list: (Omit<Note, 'at'> & { t: number })[] = [];
  key: Key;
  beat: number;
  constructor(key: Key, tempo: number) {
    this.key = key;
    this.beat = 60 / tempo;
  }
  degree(d: number, octave = 0): number {
    const n = this.key.scale.length;
    const o = Math.floor(d / n);
    return this.key.root + this.key.scale[((d % n) + n) % n] + 12 * (o + octave);
  }
  add(t: number, voice: Voice, note: number, dur: number, gain: number) {
    this.list.push({ t, voice, note, dur, gain });
  }
  get length() {
    return this.list.reduce((m, n) => Math.max(m, n.t + n.dur), 0);
  }
}

export class MusicPlayer {
  private ctx: AudioContext;
  private dry: GainNode;
  private wet: GainNode;
  private enabled = false;
  private mood: Mood = 'peace';
  private rng = new Random(Date.now());
  private queue: Note[] = [];
  private restUntil = 0;
  private last: PieceKind | null = null;
  private noise: AudioBuffer;

  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(out);
    this.dry = ctx.createGain();
    this.dry.gain.value = 0.75;
    this.dry.connect(master);
    const verb = ctx.createConvolver();
    verb.buffer = this.impulse(2.6);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.5;
    this.wet.connect(verb).connect(master);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  private impulse(seconds: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3) * (i < rate * 0.01 ? i / (rate * 0.01) : 1);
      }
    }
    return buf;
  }

  setEnabled(on: boolean) {
    if (on && !this.enabled) {
      this.queue = [];
      this.restUntil = this.ctx.currentTime + 1.2;
    }
    if (!on) this.queue = [];
    this.enabled = on;
  }

  /** New mood: the current piece finishes; if resting, the next one comes soon. */
  setMood(mood: Mood) {
    if (mood === this.mood) return;
    this.mood = mood;
    if (this.enabled && !this.queue.length) this.restUntil = Math.min(this.restUntil, this.ctx.currentTime + 1.5);
  }

  tick() {
    if (!this.enabled || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (!this.queue.length && now >= this.restUntil) this.compose(Math.max(now + 0.1, this.restUntil));
    while (this.queue.length && this.queue[0].at < now + 0.4) {
      const n = this.queue.shift()!;
      if (n.at >= now - 0.2) this.voice(n);
    }
  }

  // ---------------------------------------------------------------------------
  // Composition

  private compose(start: number) {
    const choices = PIECES[this.mood].filter(([k]) => k !== this.last);
    const total = choices.reduce((n, [, w]) => n + w, 0);
    let r = this.rng.next() * total;
    let kind = choices[0][0];
    for (const [k, w] of choices) {
      r -= w;
      if (r <= 0) {
        kind = k;
        break;
      }
    }
    this.last = kind;
    const key = this.rng.pick(KEYS[this.mood]);
    const prog = this.rng.pick(PROGRESSIONS[this.mood]);
    const score =
      kind === 'harp'
        ? this.harpPiece(key, prog)
        : kind === 'melody'
          ? this.melodyPiece(key, prog)
          : kind === 'dance'
            ? this.dancePiece(key, prog)
            : kind === 'chorale'
              ? this.choralePiece(key, prog)
              : kind === 'bells'
                ? this.bellPiece(key)
                : kind === 'march'
                  ? this.marchPiece(key, prog)
                  : this.tensionPiece(key);
    this.queue = score.list.map((n) => ({ ...n, at: start + n.t })).sort((a, b) => a.at - b.at);
    const [lo, hi] = REST[this.mood];
    this.restUntil = start + score.length + this.rng.range(lo, hi);
  }

  /** Broken chords on the harp, slowing down into a final rolled chord. */
  private harpPiece(key: Key, prog: number[]): Score {
    const s = new Score(key, this.rng.range(66, 84));
    const patterns = [
      [0, null, 1, null, 2, null, 1, null],
      [0, 2, null, 3, null, 2, null, null],
      [0, null, null, 2, null, null, 4, null],
      [2, null, 1, null, 0, null, null, null],
    ];
    const bars = this.rng.pick([4, 4, 6]);
    let t = 0;
    for (let bar = 0; bar < bars; bar++) {
      const c = prog[bar % prog.length];
      const tones = [c, c + 2, c + 4, c + 7, c + 9];
      const pattern = this.rng.pick(patterns);
      const stretch = 1 + Math.max(0, bar - (bars - 2)) * 0.18;
      const step = (s.beat / 2) * stretch;
      if (bar === bars - 1) {
        // Final bar: a slow rolled chord on the tonic.
        [0, 4, 7, 9].forEach((d, i) => s.add(t + i * 0.14, 'harp', s.degree(d, d > 4 ? 0 : 1), 3, 0.04));
        s.add(t, 'bass', s.degree(0, -1), 3, 0.05);
        break;
      }
      pattern.forEach((slot, i) => {
        if (slot !== null && this.rng.chance(0.85)) s.add(t + i * step, 'harp', s.degree(tones[slot], 1), 1.6, 0.04);
      });
      if (bar % 2 === 0) s.add(t, 'bass', s.degree(c, -1), s.beat * 3, 0.045);
      t += step * 8;
    }
    return s;
  }

  /** A flute tune in call-and-response phrases over light harp. */
  private melodyPiece(key: Key, prog: number[]): Score {
    const s = new Score(key, this.rng.range(70, 88));
    const bars = this.rng.pick([4, 6]);
    const bar = s.beat * 4;
    const rhythms = [
      [1.5, 0.5, 2, -2, 1, 1, 2],
      [1, 1, 1, 1, 3, -1],
      [-1, 1, 0.5, 0.5, 2, 3],
      [2, -1, 1, 1, 3],
      [0.5, 0.5, 1, 2, -2, 2],
    ];
    let motif: { at: number; len: number; deg: number }[] = [];
    for (let b = 0; b < bars; b += 2) {
      const chord = prog[(b / 2) % prog.length];
      const t0 = b * bar;
      const last = b + 2 >= bars;
      if (b % 4 === 0 || !motif.length) {
        // A new call: walk the scale, landing on chord tones.
        motif = [];
        let at = 0;
        let deg = chord + 7 + this.rng.pick([0, 2, 4]);
        for (const len of this.rng.pick(rhythms)) {
          if (len > 0) {
            motif.push({ at, len, deg });
            deg = Math.max(5, Math.min(13, deg + this.rng.pick([-1, -1, 1, 1, 2, -2, 3])));
          }
          at += Math.abs(len);
        }
      } else {
        // The answer: same rhythm, shifted, settling down.
        const shift = this.rng.pick([-2, -1, 1]);
        motif = motif.map((n) => ({ ...n, deg: n.deg + shift }));
      }
      const phrase = motif.map((n, i) => (last && i === motif.length - 1 ? { ...n, deg: 7, len: Math.max(n.len, 3) } : n));
      for (const n of phrase) s.add(t0 + n.at * s.beat, 'flute', s.degree(n.deg), n.len * s.beat, 0.05);
      // Light harp dyads on the downbeats, and a bass note now and then.
      for (const k of [0, 1]) {
        const c = prog[(b + k) % prog.length];
        if (this.rng.chance(0.75)) {
          s.add(t0 + k * bar, 'harp', s.degree(c, 1), 1.8, 0.028);
          s.add(t0 + k * bar + 0.06, 'harp', s.degree(c + 2, 1), 1.8, 0.024);
        }
      }
      if (this.rng.chance(0.6)) s.add(t0, 'bass', s.degree(chord, -1), s.beat * 3, 0.045);
    }
    return s;
  }

  /** A short, quick, plucked dance tune with a bouncing bass. */
  private dancePiece(key: Key, prog: number[]): Score {
    const s = new Score(key, this.rng.range(104, 122));
    const bars = this.rng.pick([4, 6, 8]);
    const e = s.beat / 2;
    // A one-bar motif: degrees relative to the chord root (null = rest).
    const motif: (number | null)[] = [];
    for (let i = 0; i < 8; i++) motif.push(this.rng.chance(0.35) ? null : this.rng.pick([0, 2, 4, 5, 7, 4, 2]));
    motif[0] = this.rng.pick([0, 2, 4]);
    for (let b = 0; b < bars; b++) {
      const c = prog[b % prog.length];
      const t0 = b * 8 * e;
      const lastBar = b === bars - 1;
      motif.forEach((d, i) => {
        if (d === null) return;
        if (lastBar && i > 3) return;
        // Vary the second half of every other bar.
        const deg = b % 2 === 1 && i >= 4 && this.rng.chance(0.5) ? d + this.rng.pick([-1, 1, 2]) : d;
        s.add(t0 + i * e, 'lute', s.degree(c + deg, 1), e * 0.9, 0.042);
      });
      if (lastBar) {
        s.add(t0 + 4 * e, 'lute', s.degree(7, 1), s.beat * 2, 0.045);
        s.add(t0 + 4 * e, 'pluckBass', s.degree(0, -1), s.beat * 2, 0.07);
      } else {
        s.add(t0, 'pluckBass', s.degree(c, -1), e * 1.5, 0.07);
        s.add(t0 + 4 * e, 'pluckBass', s.degree(c + 4, -1), e * 1.5, 0.06);
      }
      if (!lastBar) for (const i of [2, 6]) s.add(t0 + i * e, 'tap', 0, 0.05, 0.03);
    }
    return s;
  }

  /** A few soft chords that swell and fade, with air between them. */
  private choralePiece(key: Key, prog: number[]): Score {
    const s = new Score(key, 60);
    let t = 0;
    const chords = prog.slice(0, this.rng.pick([3, 4]));
    chords.forEach((c, i) => {
      const hold = this.rng.range(1.4, 2.2);
      for (const d of [c, c + 2, c + 4]) s.add(t, 'choir', s.degree(d), hold, 0.022);
      s.add(t, 'choir', s.degree(c, -1), hold, 0.018);
      if (this.rng.chance(0.6)) s.add(t + 0.4, 'bell', s.degree(c + 4, 1), 2.5, 0.025);
      if (i === chords.length - 1) return;
      t += hold + this.rng.range(1.6, 2.6);
    });
    return s;
  }

  /** A sparse bell motif from a five-note scale, repeated with variations. */
  private bellPiece(key: Key): Score {
    const s = new Score(key, 72);
    const penta = [0, 1, 2, 4, 5];
    const motif = Array.from({ length: this.rng.pick([3, 4, 5]) }, () => this.rng.pick(penta));
    const gaps = motif.map(() => this.rng.range(0.35, 0.8));
    let t = 0;
    const repeats = this.rng.pick([2, 3]);
    for (let r = 0; r < repeats; r++) {
      motif.forEach((d, i) => {
        const deg = r === repeats - 1 && i === motif.length - 1 ? 0 : d + (r === 1 ? this.rng.pick([0, 1, -1]) : 0);
        s.add(t, 'bell', s.degree(deg, 1), 2.6, 0.035);
        t += gaps[i];
      });
      t += this.rng.range(1.2, 2.4);
    }
    s.add(t - 1, 'bass', s.degree(0, -1), 2.5, 0.035);
    return s;
  }

  /** War: a soft march: low drums and a horn phrase. */
  private marchPiece(key: Key, prog: number[]): Score {
    const s = new Score(key, this.rng.range(84, 96));
    const bars = this.rng.pick([4, 6]);
    const bar = s.beat * 4;
    let deg = 7;
    for (let b = 0; b < bars; b++) {
      const c = prog[b % prog.length];
      const t0 = b * bar;
      s.add(t0, 'drum', 0, 0.4, 0.14);
      s.add(t0 + s.beat * 2, 'drum', 0, 0.4, 0.1);
      if (b % 2 === 1) s.add(t0 + s.beat * 3.5, 'drum', 0, 0.3, 0.07);
      s.add(t0, 'bass', s.degree(c, -1), s.beat * 2, 0.05);
      // Horn: two or three notes per bar, resting on the last bar.
      if (b < bars - 1) {
        const rhythm = this.rng.pick([[1.5, 0.5, 2], [1, 1, 2], [2, 2], [-1, 1, 2]]);
        let at = 0;
        for (const len of rhythm) {
          if (len > 0) s.add(t0 + at * s.beat, 'horn', s.degree(deg), len * s.beat * 0.95, 0.04);
          at += Math.abs(len);
          deg = Math.max(4, Math.min(11, deg + this.rng.pick([-1, 1, -2, 2, 0])));
        }
      } else {
        s.add(t0, 'horn', s.degree(7), s.beat * 3, 0.04);
      }
    }
    return s;
  }

  /** War: a quiet heartbeat with a few low, uneasy harp notes. */
  private tensionPiece(key: Key): Score {
    const s = new Score(key, this.rng.range(76, 88));
    const beats = this.rng.pick([12, 16]);
    for (let i = 0; i < beats; i += 2) {
      s.add(i * s.beat, 'drum', 0, 0.4, 0.12);
      s.add((i + 0.5) * s.beat, 'drum', 0, 0.3, 0.06);
    }
    const uneasy = [0, 5, 4, 1, 0, 6];
    for (let i = 0; i < beats; i += this.rng.pick([2, 3, 4])) {
      s.add(i * s.beat + 0.2, 'harp', s.degree(this.rng.pick(uneasy)), 2, 0.035);
    }
    s.add(beats * s.beat, 'bell', s.degree(0, -1), 3, 0.03);
    return s;
  }

  // ---------------------------------------------------------------------------
  // Voices

  private env(t: number, gain: number, attack: number, hold: number, release: number, send = 0.6) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setValueAtTime(gain, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    g.connect(this.dry);
    const s = this.ctx.createGain();
    s.gain.value = send;
    g.connect(s).connect(this.wet);
    return g;
  }

  private osc(type: OscillatorType, freq: number, t: number, stop: number, dest: AudioNode, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.detune.value = detune;
    o.connect(dest);
    o.start(t);
    o.stop(stop);
    return o;
  }

  private voice(n: Note) {
    const t = n.at;
    const f = hz(n.note);
    switch (n.voice) {
      case 'harp': {
        this.osc('sine', f, t, t + n.dur + 0.2, this.env(t, n.gain, 0.006, 0, n.dur, 0.7));
        this.osc('sine', f * 2, t, t + 0.6, this.env(t, n.gain * 0.25, 0.004, 0, 0.45, 0.5));
        return;
      }
      case 'bell': {
        this.osc('sine', f, t, t + n.dur + 0.2, this.env(t, n.gain, 0.004, 0, n.dur, 0.8));
        this.osc('sine', f * 2.76, t, t + 1, this.env(t, n.gain * 0.35, 0.003, 0, 0.8, 0.8));
        this.osc('sine', f * 5.4, t, t + 0.4, this.env(t, n.gain * 0.12, 0.002, 0, 0.3, 0.8));
        return;
      }
      case 'lute': {
        const g = this.env(t, n.gain, 0.004, 0.02, Math.max(0.15, n.dur), 0.45);
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(2200, t);
        lp.frequency.exponentialRampToValueAtTime(500, t + 0.3);
        lp.connect(g);
        this.osc('triangle', f, t, t + n.dur + 0.4, lp);
        this.osc('sawtooth', f, t, t + n.dur + 0.4, lp, 4);
        return;
      }
      case 'flute': {
        const hold = Math.max(0.05, n.dur - 0.15);
        const g = this.env(t, n.gain, 0.09, hold, 0.35, 0.65);
        const o = this.osc('sine', f, t, t + n.dur + 0.5, g);
        if (n.dur > 0.5) {
          const lfo = this.ctx.createOscillator();
          const depth = this.ctx.createGain();
          lfo.frequency.value = 4.6;
          depth.gain.setValueAtTime(0, t);
          depth.gain.linearRampToValueAtTime(f * 0.004, t + 0.4);
          lfo.connect(depth).connect(o.frequency);
          lfo.start(t);
          lfo.stop(t + n.dur + 0.5);
        }
        this.osc('triangle', f, t, t + n.dur + 0.5, this.env(t, n.gain * 0.15, 0.09, hold, 0.3, 0.6));
        const src = this.ctx.createBufferSource();
        src.buffer = this.noise;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = f * 2;
        bp.Q.value = 2;
        src.connect(bp).connect(this.env(t, n.gain * 0.25, 0.03, 0.02, 0.12, 0.4));
        src.start(t, Math.random() * 0.5);
        src.stop(t + 0.25);
        return;
      }
      case 'horn': {
        const g = this.env(t, n.gain, 0.08, Math.max(0.05, n.dur - 0.2), 0.3, 0.6);
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 800;
        lp.connect(g);
        this.osc('triangle', f, t, t + n.dur + 0.4, lp);
        this.osc('sawtooth', f, t, t + n.dur + 0.4, lp, -3);
        return;
      }
      case 'choir': {
        const g = this.env(t, n.gain, 0.8, n.dur, 1.8, 0.85);
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1000;
        lp.connect(g);
        this.osc('triangle', f, t, t + n.dur + 2.8, lp, -6);
        this.osc('triangle', f, t, t + n.dur + 2.8, lp, 6);
        return;
      }
      case 'bass': {
        const g = this.env(t, n.gain, 0.03, n.dur * 0.4, n.dur * 0.7, 0.25);
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 400;
        lp.connect(g);
        this.osc('triangle', f, t, t + n.dur * 1.3, lp);
        this.osc('sine', f, t, t + n.dur * 1.3, lp);
        return;
      }
      case 'pluckBass': {
        const g = this.env(t, n.gain, 0.005, 0.02, Math.max(0.2, n.dur), 0.2);
        this.osc('triangle', f, t, t + n.dur + 0.3, g);
        return;
      }
      case 'drum': {
        const g = this.env(t, n.gain, 0.005, 0, 0.45, 0.3);
        const o = this.ctx.createOscillator();
        o.frequency.setValueAtTime(95, t);
        o.frequency.exponentialRampToValueAtTime(48, t + 0.3);
        o.connect(g);
        o.start(t);
        o.stop(t + 0.5);
        return;
      }
      case 'tap': {
        const src = this.ctx.createBufferSource();
        src.buffer = this.noise;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1500;
        bp.Q.value = 1.5;
        src.connect(bp).connect(this.env(t, n.gain, 0.002, 0, 0.06, 0.3));
        src.start(t, Math.random() * 0.5);
        src.stop(t + 0.1);
        return;
      }
    }
  }
}
