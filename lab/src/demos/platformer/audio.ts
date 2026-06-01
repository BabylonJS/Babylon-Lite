/**
 * Tiny Web Audio sound effects for the platformer demo, synthesised at runtime
 * (no audio files to ship). The engine has no audio subsystem, so this is a small
 * clean-room oscillator/noise kit — chiptune-flavoured blips for jump, coin, stomp,
 * bump, power-up, pipe, death, and the level-complete jingle.
 *
 * The AudioContext is created lazily and resumed on first user gesture (browser
 * autoplay policy).
 */

type Wave = OscillatorType;

export interface Sfx {
    jump: () => void;
    coin: () => void;
    stomp: () => void;
    bump: () => void;
    powerUp: () => void;
    powerDown: () => void;
    kick: () => void;
    die: () => void;
    oneUp: () => void;
    complete: () => void;
    /** Resume the context after a user gesture; safe to call repeatedly. */
    resume: () => void;
    dispose: () => void;
}

export function createSfx(): Sfx {
    let ctx: AudioContext | null = null;
    let master: GainNode | null = null;

    const ensure = (): AudioContext | null => {
        if (ctx === null) {
            const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!Ctor) return null;
            ctx = new Ctor();
            master = ctx.createGain();
            master.gain.value = 0.22;
            master.connect(ctx.destination);
        }
        return ctx;
    };

    const tone = (freq: number, dur: number, wave: Wave, t0: number, gain = 1, slideTo?: number): void => {
        const c = ctx;
        if (!c || !master) return;
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = wave;
        osc.frequency.setValueAtTime(freq, t0);
        if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g);
        g.connect(master);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
    };

    const noise = (dur: number, t0: number, gain = 0.5): void => {
        const c = ctx;
        if (!c || !master) return;
        const frames = Math.floor(c.sampleRate * dur);
        const buf = c.createBuffer(1, frames, c.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
        const src = c.createBufferSource();
        src.buffer = buf;
        const g = c.createGain();
        g.gain.value = gain;
        src.connect(g);
        g.connect(master);
        src.start(t0);
    };

    const now = (): number => (ctx ? ctx.currentTime : 0);

    return {
        resume(): void {
            const c = ensure();
            if (c && c.state === "suspended") void c.resume();
        },
        jump(): void {
            if (!ensure()) return;
            tone(420, 0.16, "square", now(), 0.7, 760);
        },
        coin(): void {
            if (!ensure()) return;
            const t = now();
            tone(988, 0.07, "square", t, 0.6);
            tone(1319, 0.12, "square", t + 0.06, 0.6);
        },
        stomp(): void {
            if (!ensure()) return;
            tone(300, 0.1, "square", now(), 0.6, 120);
            noise(0.08, now(), 0.3);
        },
        bump(): void {
            if (!ensure()) return;
            tone(180, 0.08, "square", now(), 0.5, 90);
        },
        powerUp(): void {
            if (!ensure()) return;
            const t = now();
            const notes = [392, 523, 659, 784, 1047];
            notes.forEach((f, i) => tone(f, 0.1, "square", t + i * 0.06, 0.6));
        },
        powerDown(): void {
            if (!ensure()) return;
            const t = now();
            tone(523, 0.1, "square", t, 0.6, 392);
            tone(392, 0.12, "square", t + 0.1, 0.6, 262);
        },
        kick(): void {
            if (!ensure()) return;
            tone(520, 0.09, "square", now(), 0.5, 220);
        },
        die(): void {
            if (!ensure()) return;
            const t = now();
            tone(440, 0.12, "square", t, 0.6);
            tone(330, 0.12, "square", t + 0.12, 0.6);
            tone(247, 0.4, "square", t + 0.24, 0.6, 110);
        },
        oneUp(): void {
            if (!ensure()) return;
            const t = now();
            [659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.12, "triangle", t + i * 0.09, 0.5));
        },
        complete(): void {
            if (!ensure()) return;
            const t = now();
            const mel = [523, 659, 784, 1047, 784, 1047, 1319];
            mel.forEach((f, i) => tone(f, 0.18, "square", t + i * 0.16, 0.55));
        },
        dispose(): void {
            if (ctx) void ctx.close();
            ctx = null;
            master = null;
        },
    };
}
