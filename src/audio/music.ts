const STORAGE_KEY = "phaser-tetris-music-muted";
const TARGET_GAIN = 0.065;
const BPM = 80;
const SIXTEENTH_SEC = 60 / BPM / 4;
const STEPS_PER_BAR = 16;
const BARS_PER_CHORD = 4;
const STEPS_PER_CHORD = STEPS_PER_BAR * BARS_PER_CHORD;
const SCHEDULER_LOOKAHEAD = 0.25;
const SCHEDULER_TICK_MS = 60;

interface Chord {
  bass: number;
  notes: number[];
  pad: number;
  fifth: number;
}

// Loose minor-modal progression chosen for a calm, contemplative feel.
// Am9 -> Fmaj9 -> Cmaj7 -> G(add9), each held for 4 bars.
const PROGRESSION: Chord[] = [
  { bass: 45, notes: [57, 60, 64, 67, 71], pad: 64, fifth: 52 },
  { bass: 41, notes: [53, 57, 60, 64, 67], pad: 60, fifth: 48 },
  { bass: 48, notes: [60, 64, 67, 71], pad: 67, fifth: 55 },
  { bass: 43, notes: [55, 59, 62, 69], pad: 59, fifth: 50 },
];

function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class Music {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;
  private playing = false;
  private stepCount = 0;
  private nextStepTime = 0;
  private timerId: number | null = null;

  constructor() {
    if (typeof window !== "undefined" && window.localStorage) {
      this.muted = window.localStorage.getItem(STORAGE_KEY) === "true";
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;

    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, String(muted));
    }

    this.applyMute(false);
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  unlock(): void {
    if (this.context) {
      if (this.context.state === "suspended") {
        void this.context.resume();
      }
      return;
    }

    const Ctor: typeof AudioContext | undefined =
      typeof window === "undefined"
        ? undefined
        : window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!Ctor) {
      return;
    }

    this.context = new Ctor();
    this.master = this.context.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.context.destination);

    this.applyMute(true);
    this.start();
  }

  stop(): void {
    this.playing = false;

    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  private applyMute(initial: boolean): void {
    if (!this.context || !this.master) {
      return;
    }

    const target = this.muted ? 0 : TARGET_GAIN;
    const now = this.context.currentTime;
    const fade = initial ? 2.5 : 0.5;

    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(target, now + fade);
  }

  private start(): void {
    if (this.playing || !this.context) {
      return;
    }

    this.playing = true;
    this.stepCount = 0;
    this.nextStepTime = this.context.currentTime + 0.15;
    this.tick();
  }

  private tick = (): void => {
    if (!this.playing || !this.context) {
      return;
    }

    const horizon = this.context.currentTime + SCHEDULER_LOOKAHEAD;

    while (this.nextStepTime < horizon) {
      this.scheduleStep(this.stepCount, this.nextStepTime);
      this.nextStepTime += SIXTEENTH_SEC;
      this.stepCount += 1;
    }

    this.timerId = window.setTimeout(this.tick, SCHEDULER_TICK_MS);
  };

  private scheduleStep(step: number, time: number): void {
    const loopLength = STEPS_PER_CHORD * PROGRESSION.length;
    const stepInLoop = ((step % loopLength) + loopLength) % loopLength;
    const chordIndex = Math.floor(stepInLoop / STEPS_PER_CHORD);
    const stepInChord = stepInLoop % STEPS_PER_CHORD;
    const chord = PROGRESSION[chordIndex];

    // Bass: root on the downbeat of bars 1 and 3 within the chord (2-bar sustain each).
    if (stepInChord === 0) {
      this.playNote(chord.bass, time, SIXTEENTH_SEC * 30, "triangle", 0.42, 0.05, 1.4);
    } else if (stepInChord === STEPS_PER_BAR * 2) {
      this.playNote(chord.fifth, time, SIXTEENTH_SEC * 30, "triangle", 0.34, 0.05, 1.4);
    }

    // Pad: two stacked sine voices that sustain through the chord, slow swell in and out.
    if (stepInChord === 0) {
      const padDuration = SIXTEENTH_SEC * STEPS_PER_CHORD;
      this.playNote(chord.pad, time, padDuration, "sine", 0.11, 1.4, 2.2);
      this.playNote(chord.pad + 7, time, padDuration, "sine", 0.07, 1.4, 2.2);
    }

    // Arpeggio: gentle quarter-note cascade through chord tones, only during bars 2 and 4
    // so the loop has natural breathing room.
    const inArpRegion =
      (stepInChord >= STEPS_PER_BAR && stepInChord < STEPS_PER_BAR * 2) ||
      (stepInChord >= STEPS_PER_BAR * 3 && stepInChord < STEPS_PER_BAR * 4);

    if (inArpRegion && stepInChord % 4 === 0) {
      const arpIndex = Math.floor((stepInChord % STEPS_PER_BAR) / 4);
      const note = chord.notes[arpIndex % chord.notes.length];
      this.playNote(note + 12, time, SIXTEENTH_SEC * 3.6, "triangle", 0.14, 0.02, 0.32);
    }

    // Very sparse top-line shimmer: a single high chord-tone twinkle on bar 4 of each chord
    // for subtle motion without a real melody.
    if (stepInChord === STEPS_PER_BAR * 3 + 8) {
      const sparkleIndex = (chordIndex + 1) % chord.notes.length;
      const note = chord.notes[sparkleIndex] + 24;
      this.playNote(note, time, SIXTEENTH_SEC * 6, "sine", 0.06, 0.05, 0.45);
    }
  }

  private playNote(
    midi: number,
    time: number,
    duration: number,
    type: OscillatorType,
    volume: number,
    attack: number,
    release: number,
  ): void {
    if (!this.context || !this.master) {
      return;
    }

    const safeDuration = Math.max(duration, 0.06);
    const safeAttack = Math.min(attack, safeDuration * 0.45);
    const safeRelease = Math.min(release, safeDuration * 0.55);
    const sustainStart = time + safeAttack;
    const releaseStart = Math.max(sustainStart, time + safeDuration - safeRelease);
    const end = time + safeDuration;

    const oscillator = this.context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.value = midiToFrequency(midi);

    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(volume, sustainStart);
    envelope.gain.setValueAtTime(volume, releaseStart);
    envelope.gain.linearRampToValueAtTime(0, end);

    oscillator.connect(envelope);
    envelope.connect(this.master);
    oscillator.start(time);
    oscillator.stop(end + 0.05);
  }
}
