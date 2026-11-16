// Original, procedurally synthesized music for Conquest: modal "medieval"
// tunes for peaceful phases and a drum-driven march for conquest. No audio
// files; everything is scheduled ahead on the Web Audio clock.

const hz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);
const bar = (text: string) => text.trim().split(/\s+/).map((t) => (t === '-' ? null : Number(t)));
const bars = (text: string) => text.split('|').map(bar);
const chords = (text: string) => text.split('|').map((c) => c.trim().split(/\s+/).map(Number));
const rhythm = (text: string) => [...text.replace(/\s/g, '')].map((c) => (c === '-' ? 0 : Number(c)));

type Voice = 'recorder' | 'lute' | 'harp' | 'brass';

interface Song {
  title: string;
  bpm: number;
  voice: Voice;
  /** One chord per bar for the A and B sections (4 bars each). */
  chordsA: number[][];
  chordsB: number[][];
  a: (number | null)[][];
  b: (number | null)[][];
  /** Per eighth-note step (8 per bar): drum accents 0-9. */
  drum: number[];
  tabor: number[];
  jingle: number[];
  /** Bass pattern: digits pick chord tones (1 = root), 0 = rest. */
  bass: number[];
  drone: boolean;
}

// Notes are MIDI numbers; each bar is eight eighth notes. Form: A A B A.
const SONGS: Record<string, Song> = {
  road: {
    title: "The King's Road",
    bpm: 100,
    voice: 'recorder',
    chordsA: chords('50 57 62|48 55 60|46 53 58|45 52 57'),
    chordsB: chords('41 48 53|48 55 60|50 57 62|45 52 57'),
    a: bars('74 - 72 74 77 - 76 74|72 - 69 72 76 - 74 72|70 - 74 77 - 74 70 -|69 72 76 - 74 72 69 -'),
    b: bars('77 - 81 - 79 77 76 -|76 74 72 - 76 - 79 -|81 - 79 77 76 74 72 -|74 - 73 - 69 - - -'),
    drum: rhythm('7--- 5-3-'),
    tabor: rhythm('--4- --4-'),
    jingle: rhythm('---3 ---3'),
    bass: rhythm('1--- 3---'),
    drone: true,
  },
  fair: {
    title: 'Harvest Fair',
    bpm: 120,
    voice: 'lute',
    chordsA: chords('43 50 55 59|41 48 53 57|48 52 55 60|43 50 55 59'),
    chordsB: chords('43 50 55 59|41 48 53 57|48 52 55 60|50 54 57 62'),
    a: bars('79 - 81 83 - 81 79 77|77 - 76 74 72 - 74 -|72 76 79 - 76 72 74 76|79 - - 74 79 - - -'),
    b: bars('83 - 84 86 - 84 83 81|81 79 77 - 76 77 79 -|76 - 79 84 - 83 81 79|74 77 79 - 81 - 78 -'),
    drum: rhythm('8--5 6--5'),
    tabor: rhythm('-3-- -3-4'),
    jingle: rhythm('-2-2 -2-2'),
    bass: rhythm('1-3- 2-3-'),
    drone: false,
  },
  watch: {
    title: 'Night Watch',
    bpm: 84,
    voice: 'harp',
    chordsA: chords('45 52 57 60|41 48 53 57|43 50 55 59|40 47 52 56'),
    chordsB: chords('45 52 57 60|41 48 53 57|43 50 55 59|40 47 52 56'),
    a: bars('76 - - 72 69 - 72 -|77 - 76 - 72 - - -|74 - 71 - 67 71 74 -|71 - - 68 64 - - -'),
    b: bars('81 - 79 76 - 72 76 -|77 - 81 - 84 - 81 -|79 - 74 71 - 74 79 -|76 - 75 - 76 - - -'),
    drum: rhythm('6--- ----'),
    tabor: rhythm('---- 3---'),
    jingle: rhythm('---- ----'),
    bass: rhythm('1--- ----'),
    drone: true,
  },
  arms: {
    title: 'To Arms!',
    bpm: 128,
    voice: 'brass',
    chordsA: chords('50 57 62 65|46 53 58 62|48 55 60 64|45 52 57 61'),
    chordsB: chords('46 53 58 62|50 57 62 65|48 55 60 64|45 52 57 61'),
    a: bars('74 74 - 77 76 74 - 72|70 - 74 - 77 - 74 -|72 72 - 76 74 72 - 76|73 - 76 - 81 - 76 73'),
    b: bars('82 - 81 - 77 - 74 77|81 - 77 - 74 - 77 81|79 - 76 - 72 - 76 79|81 - 79 77 76 - 73 -'),
    drum: rhythm('9-5- 8-56'),
    tabor: rhythm('-4-4 -446'),
    jingle: rhythm('3-3- 3-3-'),
    bass: rhythm('1-1- 1-21'),
    drone: false,
  },
};

const PLAYLISTS = { peace: ['road', 'fair', 'watch'], war: ['arms'] } as const;
export type Mood = keyof typeof PLAYLISTS;

/** Seeded hash in [0, 1), so variations repeat the same way each pass. */
function hash(...values: number[]) {
  let h = 2166136261;
  for (const v of values) {
    h = Math.imul(h ^ (v | 0), 16777619);
    h ^= h >>> 13;
  }
  return (h >>> 0) / 4294967296;
}

export class MusicPlayer {
  private ctx: AudioContext;
  private out: GainNode;
  private enabled = false;
  private mood: Mood = 'peace';
  private songIndex = 0;
  private song: Song = SONGS.road;
  private bar = 0;
  private step = 0;
  private pass = 0;
  private next = 0;
  private noise: AudioBuffer;

  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(out);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  setEnabled(on: boolean) {
    if (on && !this.enabled) {
      this.next = this.ctx.currentTime + 0.1;
      this.bar = 0;
      this.step = 0;
    }
    this.enabled = on;
  }

  /** Switch playlists; the change happens at the next bar line. */
  setMood(mood: Mood) {
    if (mood === this.mood) return;
    this.mood = mood;
    this.pendingSwitch = true;
  }

  private pendingSwitch = false;

  /** Called often; schedules notes a little ahead of the audio clock. */
  tick() {
    if (!this.enabled || this.ctx.state !== 'running') return;
    const ahead = this.ctx.currentTime + 0.3;
    if (this.next < this.ctx.currentTime - 0.5) this.next = this.ctx.currentTime + 0.05;
    while (this.next < ahead) {
      this.playStep(this.next);
      const dur = 60 / this.song.bpm / 2;
      // A gentle swing on the lively tunes.
      const swing = this.song.voice === 'lute' ? (this.step % 2 === 0 ? 1.12 : 0.88) : 1;
      this.next += dur * swing;
      this.step++;
      if (this.step === 8) {
        this.step = 0;
        this.bar++;
        if (this.pendingSwitch) {
          this.pendingSwitch = false;
          this.startSong(0);
        } else if (this.bar >= 16) {
          this.startSong(this.songIndex + 1);
        }
      }
    }
  }

  private startSong(i: number) {
    const list = PLAYLISTS[this.mood];
    this.songIndex = i % list.length;
    if (this.songIndex === 0) this.pass++;
    this.song = SONGS[list[this.songIndex]];
    this.bar = 0;
    this.step = 0;
  }

  private playStep(t: number) {
    const s = this.song;
    // Form A A B A, four bars per section.
    const section = Math.floor(this.bar / 4);
    const inBar = this.bar % 4;
    const useB = section === 2;
    const chord = (useB ? s.chordsB : s.chordsA)[inBar];
    let note = (useB ? s.b : s.a)[inBar][this.step];
    const beat = 60 / s.bpm / 2;
    // The repeat of A varies a little: a neighbor chord tone here, a breath there.
    if (note !== null && section === 1) {
      const r = hash(this.pass, this.bar, this.step, s.bpm);
      if (r < 0.12) note = null;
      else if (r < 0.26) {
        const tones = chord.map((c) => c % 12);
        for (let k = 1; k < 6; k++) if (tones.includes((note + k) % 12)) {
          note += k;
          break;
        }
      }
    }
    if (note !== null) {
      let len = 1;
      const line = (useB ? s.b : s.a)[inBar];
      while (this.step + len < 8 && line[this.step + len] === null) len++;
      this.lead(s.voice, note, t, Math.min(len, 3) * beat);
    }
    // Harmony: drone or plucked chord at the bar line.
    if (this.step === 0) {
      if (s.drone) this.drone(chord[0], chord[1], t, beat * 8);
      else this.strum(chord, t, s.voice === 'brass' ? 0.035 : 0.05);
    }
    const b = s.bass[this.step];
    if (b) this.bassNote(chord[Math.min(b - 1, chord.length - 1)] - 12, t, beat * 1.6);
    const d = s.drum[this.step];
    if (d) this.drum(t, d / 9);
    const tb = s.tabor[this.step];
    if (tb) this.tabor(t, tb / 9);
    const j = s.jingle[this.step];
    if (j) this.jingle(t, j / 9);
  }

  // -------------------------------------------------------------------------
  // Voices

  private env(t: number, peak: number, attack: number, dur: number, release = 0.08) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.setTargetAtTime(peak * 0.7, t + attack, dur * 0.4);
    g.gain.setTargetAtTime(0.0001, t + dur, release);
    g.connect(this.out);
    return g;
  }

  private osc(type: OscillatorType, freq: number, t: number, stop: number, dest: AudioNode) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.connect(dest);
    o.start(t);
    o.stop(stop);
    return o;
  }

  private lead(voice: Voice, note: number, t: number, dur: number) {
    const f = hz(note);
    const end = t + dur + 0.6;
    if (voice === 'recorder') {
      const g = this.env(t, 0.07, 0.04, dur, 0.06);
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 2400;
      filter.connect(g);
      const o = this.osc('sine', f, t, end, filter);
      this.osc('triangle', f * 2, t, end, filter).detune.value = 3;
      // Breathy vibrato after the attack.
      const lfo = this.ctx.createOscillator();
      const depth = this.ctx.createGain();
      lfo.frequency.value = 5.2;
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(f * 0.006, t + 0.25);
      lfo.connect(depth).connect(o.frequency);
      lfo.start(t);
      lfo.stop(end);
    } else if (voice === 'lute') {
      const g = this.env(t, 0.09, 0.005, Math.min(dur, 0.25), 0.25);
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(3200, t);
      filter.frequency.exponentialRampToValueAtTime(700, t + 0.4);
      filter.connect(g);
      this.osc('sawtooth', f, t, end, filter);
      this.osc('triangle', f * 1.002, t, end, filter);
    } else if (voice === 'harp') {
      const g = this.env(t, 0.08, 0.004, 0.05, 0.9);
      this.osc('sine', f, t, t + 2.5, g);
      const g2 = this.env(t, 0.025, 0.004, 0.03, 0.35);
      this.osc('sine', f * 3, t, t + 1.5, g2);
    } else {
      const g = this.env(t, 0.06, 0.03, dur, 0.07);
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 2;
      filter.frequency.setValueAtTime(600, t);
      filter.frequency.exponentialRampToValueAtTime(2200, t + 0.06);
      filter.frequency.setTargetAtTime(1200, t + 0.08, 0.15);
      filter.connect(g);
      this.osc('sawtooth', f, t, end, filter);
      this.osc('square', f / 2, t, end, filter).detune.value = -4;
    }
  }

  private strum(chord: number[], t: number, gap: number) {
    chord.forEach((n, i) => {
      const g = this.env(t + i * gap, 0.035, 0.005, 0.1, 0.5);
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1600;
      filter.connect(g);
      this.osc('triangle', hz(n + 12), t + i * gap, t + i * gap + 2, filter);
    });
  }

  private drone(root: number, fifth: number, t: number, dur: number) {
    const g = this.env(t, 0.022, 0.3, dur, 0.3);
    this.osc('sine', hz(root), t, t + dur + 1.2, g);
    this.osc('sine', hz(fifth), t, t + dur + 1.2, g).detune.value = 2;
  }

  private bassNote(note: number, t: number, dur: number) {
    const g = this.env(t, 0.1, 0.01, dur, 0.12);
    this.osc('triangle', hz(note), t, t + dur + 0.6, g);
  }

  private noiseBurst(t: number, dur: number, gain: number, type: BiquadFilterType, freq: number, q = 1) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  /** Frame drum: a pitched thump with a skin slap. */
  private drum(t: number, v: number) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.25 * v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    g.connect(this.out);
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.25);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.4);
    this.noiseBurst(t, 0.06, 0.08 * v, 'lowpass', 900);
  }

  private tabor(t: number, v: number) {
    this.noiseBurst(t, 0.09, 0.12 * v, 'bandpass', 1400, 1.5);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.06 * v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    g.connect(this.out);
    this.osc('sine', 240, t, t + 0.15, g);
  }

  private jingle(t: number, v: number) {
    this.noiseBurst(t, 0.12, 0.06 * v, 'highpass', 7000, 0.7);
  }
}
