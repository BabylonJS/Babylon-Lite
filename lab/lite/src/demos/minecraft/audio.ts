// Tiny synthesized sound effects for block edits — no audio assets, just WebAudio
// oscillator/noise bursts. The AudioContext must be created from a user gesture
// (the pointer-lock click), so call initAudio() from there before playing.

let ctx: AudioContext | null = null;

/** Lazily create the AudioContext. Safe to call repeatedly; must run in a gesture. */
export function initAudio(): void {
    if (ctx) {
        if (ctx.state === "suspended") void ctx.resume();
        return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor) ctx = new Ctor();
    startAmbience();
}

let ambienceStarted = false;

/** Start a quiet looping wind bed (filtered noise) once the context exists. */
function startAmbience(): void {
    if (!ctx || ambienceStarted) return;
    ambienceStarted = true;
    // A long, non-round buffer so the loop seam is hard to perceive.
    const dur = 19;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const ch = buffer.getChannelData(0);
    // Brown-ish noise (integrated white) for a soft, low wind rather than hiss.
    let last = 0;
    for (let i = 0; i < ch.length; i++) {
        last = (last + (Math.random() * 2 - 1) * 0.02) * 0.995;
        ch[i] = last;
    }
    const gain = ctx.createGain();
    gain.gain.value = 0.28;
    // Slow gust LFO gently swells the wind around the base level.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.08;
    lfo.connect(lfoGain).connect(gain.gain);
    // Two layers at slightly different playback rates: their combined period is far
    // longer than either buffer, so the wind never sounds obviously repetitive.
    for (const rate of [1.0, 0.83]) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        src.playbackRate.value = rate;
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 440;
        src.connect(filter).connect(gain);
        src.start();
    }
    gain.connect(ctx.destination);
    lfo.start();
}

/** Soft, low footstep thud. Call when the walking player covers ~a block. */
export function playStep(): void {
    if (!ctx) return;
    const now = ctx.currentTime;
    const dur = 0.09;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < ch.length; i++) {
        const t = i / ch.length;
        ch[i] = (Math.random() * 2 - 1) * (1 - t);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(380, now);
    filter.frequency.exponentialRampToValueAtTime(160, now + dur);
    const gain = ctx.createGain();
    // Tiny randomisation so consecutive steps don't sound identical.
    gain.gain.setValueAtTime(0.12 + Math.random() * 0.05, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(now);
    src.stop(now + dur);
}

/** Short filtered-noise "thock" for breaking a block. */
export function playBreak(): void {
    if (!ctx) return;
    const now = ctx.currentTime;
    const dur = 0.18;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < ch.length; i++) {
        const t = i / ch.length;
        ch[i] = (Math.random() * 2 - 1) * (1 - t) * (1 - t);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1400, now);
    filter.frequency.exponentialRampToValueAtTime(400, now + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(now);
    src.stop(now + dur);
}

/** Softer, higher "tap" for placing a block. */
export function playPlace(): void {
    if (!ctx) return;
    const now = ctx.currentTime;
    const dur = 0.1;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(330, now);
    osc.frequency.exponentialRampToValueAtTime(180, now + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur);
}
