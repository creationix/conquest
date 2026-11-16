// Generative background music for Conquest.
//
// Calm by design: a warm pad, a soft harp, an occasional low flute melody and a
// gentle bass, all in a reverb "hall". Nothing loops verbatim: every few bars
// the music moves to a new section (pad alone, harp, melody, a breath of
// silence), progressions and keys change, and melodies are made of short
// call-and-response phrases with plenty of rests. During conquest the same
// ensemble turns darker and slightly faster over a soft low drum.
// No recordings: everything is scheduled ahead on the Web Audio clock.

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
    { root: 50, scale: DORIAN }, // D dorian
    { root: 53, scale: LYDIAN }, // F lydian
    { root: 55, scale: MIXOLYDIAN }, // G mixolydian
    { root: 48, scale: IONIAN }, // C major
    { root: 57, scale: AEOLIAN }, // A minor
  ],
  war: [
    { root: 50, scale: AEOLIAN }, // D minor
    { root: 52, scale: PHRYGIAN }, // E phrygian
    { root: 45, scale: DORIAN }, // A dorian
  ],
};

// Chord progressions as scale degrees (0 = tonic); each chord lasts two bars.
const PROGRESSIONS: Record<Mood, number[][]> = {
  peace: [
    [0, 3, 4, 0],
    [0, 5, 3, 4],
    [0, 2, 3, 0],
    [5, 3, 0, 4],
    [0, 4, 5, 3],
    [3, 0, 4, 0],
  ],
  war: [
    [0, 5, 6, 0],
    [0, 3, 6, 4],
    [0, 6, 5, 4],
  ],
};

type Section = 'pad' | 'harp' | 'melody' | 'song' | 'breath';

// Each section is 8 bars. Peace drifts between textures; war keeps moving.
const PLANS: Record<Mood, Section[]> = {
  peace: ['pad', 'harp', 'melody', 'song', 'harp', 'breath', 'melody', 'song'],
  war: ['harp', 'melody', 'song', 'melody', 'harp', 'song'],
};

const TEMPO: Record<Mood, number> = { peace: 76, war: 92 };

// Harp patterns: eighth-note steps (8 per bar) and which chord tone (0-5) to play.
const HARP_PATTERNS: (number | null)[][] = [
  [0, null, 1, null, 2, null, 1, null],
  [0, 2, null, 3, null, 2, null, null],
  [0, null, null, 2, null, null, 4, null],
  [2, null, 1, null, 0, null, null, 3],
];

// Melody rhythms over two bars (16 steps): note lengths in steps, 0 = rest of that length.
const RHYTHMS: number[][] = [
  [3, 1, 4, 0, 2, 2, 4, 0], // dotted start, long close
  [2, 2, 2, 2, 6, 0, 2], // walking, long hold
  [0, 2, 2, 1, 1, 4, 4, 0], // pickup after a breath
  [4, 0, 2, 2, 2, 6], // slow call
  [1, 1, 2, 4, 0, 4, 4],
];

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
  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)];
  }
}

interface Phrase {
  /** Start step within two bars, length in steps, scale-degree offset. */
  notes: { at: number; len: number; deg: number }[];
}

export class MusicPlayer {
  private ctx: AudioContext;
  private dry: GainNode;
  private wet: GainNode;
  private enabled = false;
  private mood: Mood = 'peace';
  private pendingMood: Mood | null = null;
  private rng = new Random(Date.now());
  private key: Key = KEYS.peace[0];
  private progression = PROGRESSIONS.peace[0];
  private section: Section = 'pad';
  private sectionIndex = 0;
  private harp = HARP_PATTERNS[0];
  private bar = 0;
  private step = 0;
  private next = 0;
  private phrase: Phrase | null = null;
  private answer = false;
  private noise: AudioBuffer;

  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx;
    // A soft hall: generated impulse response, mixed under the dry signal.
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(out);
    this.dry = ctx.createGain();
    this.dry.gain.value = 0.75;
    this.dry.connect(master);
    const verb = ctx.createConvolver();
    verb.buffer = this.impulse(2.8);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.5;
    this.wet.connect(verb).connect(master);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.newSection(true);
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
      this.next = this.ctx.currentTime + 0.2;
      this.bar = 0;
      this.step = 0;
      this.newSection(true);
    }
    this.enabled = on;
  }

  /** Switch mood; it takes effect at the next section boundary (or soon after). */
  setMood(mood: Mood) {
    if (!this.enabled) {
      // Not playing yet: start straight in the right mood.
      if (mood !== this.mood) {
        this.mood = mood;
        this.newSection(true);
      }
      this.pendingMood = null;
      return;
    }
    if (mood === this.mood && !this.pendingMood) return;
    this.pendingMood = mood === this.mood ? null : mood;
  }

  tick() {
    if (!this.enabled || this.ctx.state !== 'running') return;
    const ahead = this.ctx.currentTime + 0.35;
    if (this.next < this.ctx.currentTime - 0.5) this.next = this.ctx.currentTime + 0.05;
    while (this.next < ahead) {
      this.playStep(this.next);
      // A gentle lilt: long-short eighths.
      const beat = 60 / TEMPO[this.mood] / 2;
      this.next += beat * (this.step % 2 === 0 ? 1.08 : 0.92);
      this.step++;
      if (this.step === 8) {
        this.step = 0;
        this.bar++;
        // Moods change at a phrase boundary (every 4 bars), sections every 8.
        if (this.pendingMood && this.bar % 4 === 0) {
          this.mood = this.pendingMood;
          this.pendingMood = null;
          this.newSection(true);
        } else if (this.bar >= this.sectionBars()) {
          this.newSection(false);
        }
      }
    }
  }

  /** Quiet passages are short breaths; the rest last eight bars. */
  private sectionBars() {
    return this.section === 'pad' || this.section === 'breath' ? 4 : 8;
  }

  private newSection(fresh: boolean) {
    const plan = PLANS[this.mood];
    this.sectionIndex = fresh ? this.rng.int(plan.length) : (this.sectionIndex + 1) % plan.length;
    this.section = plan[this.sectionIndex];
    this.bar = 0;
    // New key now and then; new progression every section.
    if (fresh || this.rng.next() < 0.35) this.key = this.rng.pick(KEYS[this.mood]);
    this.progression = this.rng.pick(PROGRESSIONS[this.mood]);
    this.harp = this.rng.pick(HARP_PATTERNS);
    this.phrase = null;
    this.answer = false;
  }

  /** MIDI note for a scale degree (any integer; wraps across octaves). */
  private degree(d: number, octave = 0): number {
    const n = this.key.scale.length;
    const o = Math.floor(d / n);
    return this.key.root + this.key.scale[((d % n) + n) % n] + 12 * (o + octave);
  }

  private chordDegrees(): number[] {
    const c = this.progression[Math.floor(this.bar / 2) % this.progression.length];
    return [c, c + 2, c + 4];
  }

  private playStep(t: number) {
    const section = this.section;
    const beat = 60 / TEMPO[this.mood] / 2;
    const chord = this.chordDegrees();
    const war = this.mood === 'war';
    const chordStart = this.step === 0 && this.bar % 2 === 0;

    // Pad: always, except it thins out during a breath.
    if (chordStart) {
      const gain = section === 'breath' ? 0.014 : 0.024;
      for (const d of chord) this.pad(this.degree(d), t, beat * 16, gain);
    }
    // Bass on the downbeat (and the half bar in war).
    if (section !== 'breath' && (this.step === 0 || (war && this.step === 4))) {
      this.bass(this.degree(chord[0], -1), t, beat * (war ? 3 : 6));
    }
    // Harp arpeggios.
    if (section === 'harp' || section === 'song' || (war && section === 'melody')) {
      const slot = this.harp[this.step];
      if (slot !== null && this.rng.next() > 0.15) {
        const tones = [...chord, chord[0] + 7, chord[1] + 7, chord[2] + 7];
        this.pluck(this.degree(tones[slot], 1), t, war ? 0.034 : 0.04);
      }
    }
    // Melody in two-bar phrases: a call, then an answer that echoes it.
    if ((section === 'melody' || section === 'song') && this.step === 0 && this.bar % 2 === 0) {
      this.playPhrase(t, beat, chord);
    }
    // War: a soft, low drum heartbeat.
    if (war && section !== 'breath') {
      if (this.step === 0) this.drum(t, 0.16);
      else if (this.step === 3 && this.bar % 2 === 1) this.drum(t, 0.08);
      else if (this.step === 6) this.drum(t, 0.1);
    }
  }

  private playPhrase(t: number, beat: number, chord: number[]) {
    // Every other phrase rests, so the melody never talks non-stop.
    if (this.bar % 4 === 2 && this.rng.next() < 0.4) return;
    if (!this.phrase || !this.answer) {
      this.phrase = this.makePhrase(chord);
      this.answer = true;
    } else {
      // The answer: same rhythm, contour shifted, landing on the chord root.
      const shift = this.rng.pick([-2, -1, 1, 2]);
      const notes = this.phrase.notes.map((n) => ({ ...n, deg: n.deg + shift }));
      notes[notes.length - 1].deg = chord[0] + 7;
      this.phrase = { notes };
      this.answer = false;
    }
    for (const n of this.phrase.notes) {
      this.flute(this.degree(n.deg), t + n.at * beat, n.len * beat);
    }
  }

  private makePhrase(chord: number[]): Phrase {
    const rhythm = this.rng.pick(RHYTHMS);
    const notes: Phrase['notes'] = [];
    let at = 0;
    // Start on a chord tone in the flute's warm middle register.
    let deg = this.rng.pick(chord) + 7;
    rhythm.forEach((len, i) => {
      const length = len || 2;
      if (len > 0 && at < 16) {
        notes.push({ at, len: Math.min(len, 16 - at), deg });
        // Mostly steps, sometimes a small leap; stay within about an octave.
        const move = this.rng.pick([-1, -1, 1, 1, 2, -2, 0, 3]);
        deg = Math.max(5, Math.min(13, deg + move));
        // Strong beats and the final note prefer chord tones.
        if (i === rhythm.length - 2) deg = chord[this.rng.int(3)] + 7;
      }
      at += length;
    });
    return { notes };
  }

  // ---------------------------------------------------------------------------
  // Voices

  private out(t: number, gain: number, attack: number, hold: number, release: number, send = 0.6) {
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

  /** Warm, slow pad: two detuned triangles through a low filter. */
  private pad(note: number, t: number, dur: number, gain: number) {
    const g = this.out(t, gain, 1.4, Math.max(0, dur - 1.4), 2.4, 0.8);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = this.mood === 'war' ? 700 : 900;
    f.connect(g);
    const end = t + dur + 2.6;
    this.osc('triangle', hz(note), t, end, f, -5);
    this.osc('triangle', hz(note), t, end, f, 5);
  }

  /** Soft harp: a sine with a quick, rounded decay and a hint of overtone. */
  private pluck(note: number, t: number, gain: number) {
    const g = this.out(t, gain, 0.006, 0, 1.6, 0.7);
    this.osc('sine', hz(note), t, t + 1.8, g);
    const g2 = this.out(t, gain * 0.25, 0.004, 0, 0.5, 0.5);
    this.osc('sine', hz(note) * 2, t, t + 0.6, g2);
  }

  /** Breathy low flute: sine plus a touch of filtered air, gentle vibrato. */
  private flute(note: number, t: number, dur: number) {
    const gain = this.mood === 'war' ? 0.045 : 0.05;
    const g = this.out(t, gain, 0.09, Math.max(0.05, dur - 0.15), 0.35, 0.65);
    const o = this.osc('sine', hz(note), t, t + dur + 0.5, g);
    const o2 = this.osc('triangle', hz(note), t, t + dur + 0.5, this.out(t, gain * 0.18, 0.09, Math.max(0.05, dur - 0.15), 0.3, 0.6));
    if (dur > 0.5) {
      const lfo = this.ctx.createOscillator();
      const depth = this.ctx.createGain();
      lfo.frequency.value = 4.6;
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(hz(note) * 0.004, t + 0.4);
      lfo.connect(depth);
      depth.connect(o.frequency);
      depth.connect(o2.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.5);
    }
    // A little breath at the start of each note.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = hz(note) * 2;
    bp.Q.value = 2;
    const ng = this.out(t, gain * 0.25, 0.03, 0.02, 0.12, 0.4);
    src.connect(bp).connect(ng);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.25);
  }

  private bass(note: number, t: number, dur: number) {
    const g = this.out(t, 0.07, 0.03, dur * 0.5, dur * 0.6, 0.25);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 400;
    f.connect(g);
    this.osc('triangle', hz(note), t, t + dur * 1.3, f);
    this.osc('sine', hz(note), t, t + dur * 1.3, f);
  }

  /** Soft low frame drum: a pitched thump, no rattle. */
  private drum(t: number, gain: number) {
    const g = this.out(t, gain, 0.005, 0, 0.45, 0.3);
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.3);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.5);
  }
}
