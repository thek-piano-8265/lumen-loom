/**
 * Tiny procedural sound kit (WebAudio). No audio files, nothing to load,
 * so cold start stays instant.
 */
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19];

/** Event log (used to rebuild the trailer soundtrack in sync). */
type LogEntry = { t: number; k: string; a: number[] };
const w = window as unknown as { __loomAudioLog?: LogEntry[] };
w.__loomAudioLog = [];
function log(k: string, ...a: number[]) {
  const arr = w.__loomAudioLog!;
  if (arr.length < 4000) arr.push({ t: performance.now(), k, a });
}

export class LoomAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lastTick = 0;

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.35;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  resume() {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    gain: number,
    delay = 0,
    pan = 0,
  ) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    p.pan.value = pan;
    osc.connect(g).connect(p).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** detent click while a mirror turns */
  tick(step: number) {
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.currentTime - this.lastTick < 0.03) return;
    this.lastTick = ctx.currentTime;
    log('tick', step);
    this.tone(1400 + (step % 8) * 60, 0.05, 'triangle', 0.12);
  }

  pick() {
    log('pick');
    this.tone(520, 0.12, 'sine', 0.18);
    this.tone(780, 0.1, 'sine', 0.08, 0.02);
  }

  drop() {
    log('drop');
    this.tone(330, 0.16, 'sine', 0.2);
  }

  bloom(index: number, pan = 0) {
    log('bloom', index, pan);
    const semis = PENTA[index % PENTA.length];
    const f = 523.25 * Math.pow(2, semis / 12);
    this.tone(f, 1.6, 'sine', 0.22, 0, pan);
    this.tone(f * 2, 0.9, 'triangle', 0.05, 0.01, pan);
  }

  woven() {
    log('woven');
    const base = 392;
    [0, 4, 7, 12, 16].forEach((s, i) =>
      this.tone(base * Math.pow(2, s / 12), 2.4, 'sine', 0.14, i * 0.09),
    );
  }

  step() {
    log('step');
    this.tone(880, 0.09, 'triangle', 0.12);
  }
}
