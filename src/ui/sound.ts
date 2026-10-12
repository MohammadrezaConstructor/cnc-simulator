// Optional machine sound (WebAudio): spindle motor hum that follows the rpm, cutting noise
// that follows the spindle load, and a servo whine during rapid moves. Off until the user enables it.

/** what the sound needs to know about a machine (lathe or mill) */
export interface SoundSource {
  live: { rpm: number; cutting: boolean; powerKW: number; vc: number; moveType: string };
  status: string;
  spindle: { dir: 'cw' | 'ccw' | 'off' };
  settings: { powerKW: number };
}

export class MachineSound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private motor!: OscillatorNode;
  private motor2!: OscillatorNode;
  private motorGain!: GainNode;
  private cutGain!: GainNode;
  private cutFilter!: BiquadFilterNode;
  private servo!: OscillatorNode;
  private servoGain!: GainNode;
  enabled = false;

  /** must be called from a user gesture */
  enable() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return false;
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(ctx.destination);
      // spindle motor: two detuned oscillators through a low-pass
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      this.motorGain = ctx.createGain();
      this.motorGain.gain.value = 0;
      this.motor = ctx.createOscillator();
      this.motor.type = 'sawtooth';
      this.motor2 = ctx.createOscillator();
      this.motor2.type = 'triangle';
      this.motor.connect(lp);
      this.motor2.connect(lp);
      lp.connect(this.motorGain).connect(this.master);
      this.motor.start();
      this.motor2.start();
      // cutting: filtered noise
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      noise.loop = true;
      this.cutFilter = ctx.createBiquadFilter();
      this.cutFilter.type = 'bandpass';
      this.cutFilter.Q.value = 1.4;
      this.cutGain = ctx.createGain();
      this.cutGain.gain.value = 0;
      noise.connect(this.cutFilter).connect(this.cutGain).connect(this.master);
      noise.start();
      // axis servo whine
      this.servo = ctx.createOscillator();
      this.servo.type = 'sine';
      this.servoGain = ctx.createGain();
      this.servoGain.gain.value = 0;
      this.servo.connect(this.servoGain).connect(this.master);
      this.servo.start();
    }
    void this.ctx.resume();
    this.enabled = true;
    return true;
  }

  disable() {
    this.enabled = false;
    if (this.ctx) void this.ctx.suspend();
  }

  update(m: SoundSource) {
    if (!this.enabled || !this.ctx) return;
    const now = this.ctx.currentTime;
    const live = m.live;
    const spinning = m.spindle.dir !== 'off' && live.rpm > 0;
    const rpm = spinning ? live.rpm : 0;
    const f = 40 + rpm * 0.09;
    this.motor.frequency.setTargetAtTime(f, now, 0.25);
    this.motor2.frequency.setTargetAtTime(f * 2.01, now, 0.25);
    this.motorGain.gain.setTargetAtTime(spinning ? 0.06 + Math.min(0.06, rpm / 60000) : 0, now, 0.3);
    const load = Math.min(1, live.powerKW / Math.max(1, m.settings.powerKW));
    const cutting = live.cutting && m.status === 'running';
    this.cutFilter.frequency.setTargetAtTime(900 + Math.min(4000, live.vc * 8), now, 0.1);
    this.cutGain.gain.setTargetAtTime(cutting ? 0.05 + load * 0.35 : 0, now, 0.06);
    const rapid = m.status === 'running' && live.moveType === 'rapid';
    this.servo.frequency.setTargetAtTime(rapid ? 700 : 400, now, 0.1);
    this.servoGain.gain.setTargetAtTime(rapid ? 0.025 : 0, now, 0.05);
  }
}
