export type SfxName =
  | "move"
  | "rotate"
  | "softDrop"
  | "hold"
  | "lock"
  | "hardDrop"
  | "lineClear"
  | "gameOver";

interface SfxOptions {
  lines?: number;
  distance?: number;
}

const STORAGE_KEY = "phaser-tetris-muted";
const MASTER_GAIN = 0.32;

export class Sfx {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = window.localStorage.getItem(STORAGE_KEY) === "true";

  unlock(): void {
    const context = this.getContext();

    if (context.state === "suspended") {
      void context.resume();
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    window.localStorage.setItem(STORAGE_KEY, String(muted));
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  play(name: SfxName, options: SfxOptions = {}): void {
    if (this.muted) {
      return;
    }

    const context = this.getContext();
    const now = context.currentTime;

    switch (name) {
      case "move":
        this.tone(92, now, 0.035, 0.055, "square");
        break;
      case "rotate":
        this.sweep(130, 205, now, 0.055, 0.07, "triangle");
        break;
      case "softDrop":
        this.tone(70, now, 0.045, 0.05, "sine");
        break;
      case "hold":
        this.sweep(260, 150, now, 0.09, 0.08, "sine");
        this.tone(470, now + 0.035, 0.045, 0.035, "triangle");
        break;
      case "lock":
        this.tone(74, now, 0.12, 0.13, "sine");
        break;
      case "hardDrop":
        this.tone(54, now, 0.18, Math.min(0.22, 0.1 + (options.distance ?? 0) * 0.008), "sine");
        this.noise(now, 0.075, 0.16);
        this.sweep(180, 70, now, 0.12, 0.08, "sawtooth");
        break;
      case "lineClear": {
        const lines = Math.max(1, options.lines ?? 1);

        for (let index = 0; index < lines + 1; index += 1) {
          this.tone(260 + index * 82, now + index * 0.045, 0.1, 0.07, "triangle");
        }
        break;
      }
      case "gameOver":
        this.sweep(220, 55, now, 0.5, 0.14, "sawtooth");
        break;
    }
  }

  private getContext(): AudioContext {
    if (this.context && this.master) {
      return this.context;
    }

    this.context = new AudioContext();
    this.master = this.context.createGain();
    this.master.gain.value = MASTER_GAIN;
    this.master.connect(this.context.destination);

    return this.context;
  }

  private getMaster(): GainNode {
    this.getContext();

    if (!this.master) {
      throw new Error("SFX master gain was not initialized.");
    }

    return this.master;
  }

  private tone(
    frequency: number,
    start: number,
    duration: number,
    peakGain: number,
    type: OscillatorType,
  ): void {
    const context = this.getContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    oscillator.connect(gain);
    gain.connect(this.getMaster());
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  private sweep(
    from: number,
    to: number,
    start: number,
    duration: number,
    peakGain: number,
    type: OscillatorType,
  ): void {
    const context = this.getContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, to), start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    oscillator.connect(gain);
    gain.connect(this.getMaster());
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  private noise(start: number, duration: number, peakGain: number): void {
    const context = this.getContext();
    const buffer = context.createBuffer(1, context.sampleRate * duration, context.sampleRate);
    const data = buffer.getChannelData(0);

    for (let index = 0; index < data.length; index += 1) {
      data[index] = Math.random() * 2 - 1;
    }

    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(420, start);
    gain.gain.setValueAtTime(peakGain, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    source.buffer = buffer;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.getMaster());
    source.start(start);
    source.stop(start + duration);
  }
}
