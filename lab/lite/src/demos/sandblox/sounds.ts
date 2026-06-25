/**
 * Sounds — procedural WebAudio, no external assets.
 *
 * Each effect is synthesized directly and keeps the demo free of external
 * audio assets.
 *
 * - Jump: an airy noise SWISH — bandpass noise sweeping ~380→850 Hz over
 *   ~120 ms, peak ~0.23 (reference: rising dominants 345→840 Hz, no tonal
 *   "boing").
 * - Clone ping: sustained ~920 Hz bell, flat ~250 ms body then a quiet
 *   echo tail to ~0.7 s (reference: dominant cluster 904–947 Hz, body 0.25
 *   amp, tail 0.10).
 * - Explosion: a long rolling boom — brown noise with baked-in crackle
 *   modulation, ~1.3 s sustain around 130–240 Hz dominants, fast cutoff
 *   (reference: peak 0.93, envelope holds 0.6–0.9 the whole ride).
 * - Footsteps: same plastic tap, but cycled through a short accent pattern
 *   1-3-3-2-3-2 (quiet/LOUD/LOUD/mid/LOUD/mid) with humanizing jitter
 *   (reference steps vary 0.14–0.95 amp, 880–1825 Hz centroid).
 *
 * The AudioContext is created lazily on first play (autoplay policy: the
 * first call always follows a user gesture — a click or keypress). Everything
 * no-ops silently if WebAudio is unavailable (headless E2E).
 */

export interface Sounds {
    playClonePing(): void;
    playDeleteExplosion(): void;
    playResizeClick(): void;
    playFootstep(): void;
    playJump(): void;
}

/** Footstep accent pattern: 1 = soft, 2 = medium, 3 = accented. */
const STEP_PATTERN = [1, 3, 3, 2, 3, 2] as const;

export function createSounds(): Sounds {
    let ctx: AudioContext | null = null;
    let noiseBuffer: AudioBuffer | null = null;
    let boomBuffer: AudioBuffer | null = null;
    let stepIndex = 0;

    const ac = (): AudioContext | null => {
        if (ctx) {
            return ctx.state === "suspended" ? (void ctx.resume(), ctx) : ctx;
        }
        try {
            ctx = new AudioContext();
        } catch {
            ctx = null;
        }
        return ctx;
    };

    const noise = (c: AudioContext): AudioBuffer => {
        if (!noiseBuffer) {
            noiseBuffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
            const data = noiseBuffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) {
                data[i] = Math.random() * 2 - 1;
            }
        }
        return noiseBuffer;
    };

    /**
     * Rolling-boom source: brown noise (integrated white) with a slow random
     * amplitude walk baked in — the crackle/roll the reference sustains for
     * over a second. Precomputed once.
     */
    const boom = (c: AudioContext): AudioBuffer => {
        if (!boomBuffer) {
            const dur = 1.35;
            boomBuffer = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
            const data = boomBuffer.getChannelData(0);
            let brown = 0;
            let roll = 0.8;
            let peak = 0;
            for (let i = 0; i < data.length; i++) {
                brown = (brown + 0.04 * (Math.random() * 2 - 1)) / 1.04;
                if (i % 441 === 0) {
                    // ~50 Hz random walk between 0.55 and 1.0 — the "roll"
                    roll = Math.min(1, Math.max(0.55, roll + (Math.random() - 0.5) * 0.35));
                }
                data[i] = brown * roll;
                peak = Math.max(peak, Math.abs(data[i]!));
            }
            for (let i = 0; i < data.length; i++) {
                data[i] = data[i]! / peak; // normalize
            }
        }
        return boomBuffer;
    };

    /** Oscillator helper: type/freq sweep/gain envelope, auto-cleanup. */
    const blip = (c: AudioContext, type: OscillatorType, f0: number, f1: number, t1: number, g0: number, decay: number): void => {
        const t = c.currentTime;
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(f0, t);
        if (f1 !== f0) {
            osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + t1);
        }
        gain.gain.setValueAtTime(g0, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + decay);
        osc.connect(gain).connect(c.destination);
        osc.start(t);
        osc.stop(t + decay + 0.02);
    };

    /** Noise burst through a filter with optional frequency sweep. */
    const burst = (c: AudioContext, filterType: BiquadFilterType, fStart: number, fEnd: number, dur: number, gainStart: number, q = 1): void => {
        const t = c.currentTime;
        const src = c.createBufferSource();
        src.buffer = noise(c);
        src.loop = true;
        const filter = c.createBiquadFilter();
        filter.type = filterType;
        filter.Q.value = q;
        filter.frequency.setValueAtTime(fStart, t);
        if (fEnd !== fStart) {
            filter.frequency.exponentialRampToValueAtTime(Math.max(1, fEnd), t + dur);
        }
        const gain = c.createGain();
        gain.gain.setValueAtTime(gainStart, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.connect(filter).connect(gain).connect(c.destination);
        src.start(t, Math.random() * 0.5); // random read offset — varied grains
        src.stop(t + dur + 0.02);
    };

    return {
        /** Classic copy ding: sustained ~920 Hz bell + quiet echo tail. */
        playClonePing(): void {
            const c = ac();
            if (!c) {
                return;
            }
            const t = c.currentTime;
            const gain = c.createGain();
            // Reference envelope: 5 ms attack → flat 0.22 body for 250 ms →
            // step down to the 0.09 echo tail → gone by 0.7 s.
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(0.22, t + 0.005);
            gain.gain.setValueAtTime(0.22, t + 0.25);
            gain.gain.linearRampToValueAtTime(0.09, t + 0.27);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
            gain.connect(c.destination);
            for (const f of [915, 935]) {
                // close detune pair — the reference's gentle beating
                const osc = c.createOscillator();
                osc.type = "sine";
                osc.frequency.value = f;
                const g = c.createGain();
                g.gain.value = 0.5;
                osc.connect(g).connect(gain);
                osc.start(t);
                osc.stop(t + 0.75);
            }
        },

        /** Long rolling boom — the classic explosion, not a metallic pop. */
        playDeleteExplosion(): void {
            const c = ac();
            if (!c) {
                return;
            }
            const t = c.currentTime;
            const src = c.createBufferSource();
            src.buffer = boom(c);
            // Body: keep the 130–240 Hz dominants, let some mid grit through.
            const lp = c.createBiquadFilter();
            lp.type = "lowpass";
            lp.frequency.value = 950;
            const body = c.createBiquadFilter();
            body.type = "peaking";
            body.frequency.value = 180;
            body.gain.value = 9;
            const gain = c.createGain();
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(0.85, t + 0.02); // crack on
            gain.gain.setValueAtTime(0.85, t + 1.0); // ride the roll
            gain.gain.exponentialRampToValueAtTime(0.001, t + 1.35);
            src.connect(lp).connect(body).connect(gain).connect(c.destination);
            src.start(t);
            // Initial sharper crack on top (reference slice0 has 350–430 Hz)
            burst(c, "bandpass", 420, 150, 0.18, 0.5, 1.5);
        },

        /** Resize snap: a tiny dry tick per stud increment. */
        playResizeClick(): void {
            const c = ac();
            if (!c) {
                return;
            }
            burst(c, "highpass", 1500, 1500, 0.035, 0.18);
        },

        /**
         * Footstep: same plastic tap, accented per the 1-3-3-2-3-2 pattern
         * with ±jitter so it never sounds machine-gunned.
         */
        playFootstep(): void {
            const c = ac();
            if (!c) {
                return;
            }
            const accent = STEP_PATTERN[stepIndex % STEP_PATTERN.length]!;
            stepIndex++;
            const jitter = 0.85 + Math.random() * 0.3;
            // accent 1/2/3 → quiet dull / medium / bright punchy
            const gain = [0, 0.05, 0.09, 0.13][accent]! * jitter;
            const cutoff = [0, 650, 1000, 1500][accent]! * (0.92 + Math.random() * 0.16);
            burst(c, "lowpass", cutoff, cutoff * 0.55, 0.05, gain);
            if (accent === 3) {
                // accented steps get the little 180 Hz heel thump
                blip(c, "sine", 185, 120, 0.04, 0.05 * jitter, 0.05);
            }
        },

        /** Jump: airy rising SWISH — filtered noise, no tonal boing. */
        playJump(): void {
            const c = ac();
            if (!c) {
                return;
            }
            const t = c.currentTime;
            const src = c.createBufferSource();
            src.buffer = noise(c);
            src.loop = true;
            const bp = c.createBiquadFilter();
            bp.type = "bandpass";
            bp.Q.value = 1.8;
            // Reference dominants rise 345→840 Hz across the swish
            bp.frequency.setValueAtTime(380, t);
            bp.frequency.exponentialRampToValueAtTime(780, t + 0.13);
            const gain = c.createGain();
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(0.62, t + 0.03); // soft air-on
            gain.gain.setValueAtTime(0.62, t + 0.08);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.19);
            src.connect(bp).connect(gain).connect(c.destination);
            src.start(t, Math.random());
            src.stop(t + 0.22);
        },
    };
}
