/**
 * Racer audio — engine loop, tyre skid, and impact, via the Web Audio API (the
 * convention used by the other Lite demos). Levels and pitch follow the kit's
 * `effect_engine` / `effect_trails` / `_on_sphere_body_entered` logic in
 * `vehicle.gd`, converting its decibel targets to linear Web Audio gain.
 *
 * The context starts suspended (browser autoplay policy) and is resumed on the
 * first user gesture, at which point the looping engine + skid sources start.
 * Everything is wrapped defensively so a missing/blocked audio device never
 * breaks the demo.
 */

/** CC0 kit audio clips (engine loop, tyre skid loop, one-shot impact). */
export interface RacerAudioUrls {
    engine: string;
    engineMotorcycle: string;
    skid: string;
    impact: string;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

function remap(v: number, inLo: number, inHi: number, outLo: number, outHi: number): number {
    return outLo + ((outHi - outLo) * (v - inLo)) / (inHi - inLo);
}

/** Decibels → linear amplitude (Web Audio gain). */
function dbToGain(db: number): number {
    return Math.pow(10, db / 20);
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * Math.min(1, Math.max(0, t));
}

async function decode(ctx: AudioContext, url: string): Promise<AudioBuffer | null> {
    try {
        const res = await fetch(url);
        if (!res.ok) {
            return null;
        }
        return await ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
        return null;
    }
}

export class RacerAudio {
    private readonly _ctx: AudioContext | null;
    private readonly _master: GainNode | null;
    private readonly _engineBuf: AudioBuffer | null;
    private readonly _engineMotoBuf: AudioBuffer | null;
    private readonly _skidBuf: AudioBuffer | null;
    private readonly _impactBuf: AudioBuffer | null;

    private _engineGain: GainNode | null = null;
    private _engineSrc: AudioBufferSourceNode | null = null;
    private _skidGain: GainNode | null = null;
    private _started = false;
    private _wantMoto = false;

    // Smoothed parameters (kit lerps these toward their targets each frame).
    private _engineDb = -30;
    private _enginePitch = 0.5;
    private _skidDb = -80;

    private constructor(
        ctx: AudioContext | null,
        master: GainNode | null,
        engineBuf: AudioBuffer | null,
        engineMotoBuf: AudioBuffer | null,
        skidBuf: AudioBuffer | null,
        impactBuf: AudioBuffer | null
    ) {
        this._ctx = ctx;
        this._master = master;
        this._engineBuf = engineBuf;
        this._engineMotoBuf = engineMotoBuf;
        this._skidBuf = skidBuf;
        this._impactBuf = impactBuf;
        if (ctx) {
            const unlock = (): void => this._start();
            window.addEventListener("keydown", unlock, { once: true });
            window.addEventListener("pointerdown", unlock, { once: true });
        }
    }

    /** Create the context and load the clips. Never throws — falls back to silence. */
    static async create(urls: RacerAudioUrls): Promise<RacerAudio> {
        try {
            const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!Ctor) {
                return new RacerAudio(null, null, null, null, null, null);
            }
            const ctx = new Ctor();
            const master = ctx.createGain();
            master.gain.value = 0.5;
            master.connect(ctx.destination);
            const [engineBuf, engineMotoBuf, skidBuf, impactBuf] = await Promise.all([
                decode(ctx, urls.engine),
                decode(ctx, urls.engineMotorcycle),
                decode(ctx, urls.skid),
                decode(ctx, urls.impact),
            ]);
            return new RacerAudio(ctx, master, engineBuf, engineMotoBuf, skidBuf, impactBuf);
        } catch {
            return new RacerAudio(null, null, null, null, null, null);
        }
    }

    /** Start the looping engine + skid sources (once), resuming the context. */
    private _start(): void {
        if (this._started || !this._ctx || !this._master) {
            return;
        }
        this._started = true;
        void this._ctx.resume();
        const engine = this._startLoop(this._wantMoto && this._engineMotoBuf ? this._engineMotoBuf : this._engineBuf);
        this._engineSrc = engine?.src ?? null;
        this._engineGain = engine?.gain ?? null;
        this._skidGain = this._startLoop(this._skidBuf)?.gain ?? null;
    }

    /** Select the engine clip: the motorcycle has its own loop. */
    setEngine(motorcycle: boolean): void {
        if (this._wantMoto === motorcycle) {
            return;
        }
        this._wantMoto = motorcycle;
        if (!this._started || !this._ctx || !this._engineGain) {
            return;
        }
        const buffer = motorcycle && this._engineMotoBuf ? this._engineMotoBuf : this._engineBuf;
        if (!buffer) {
            return;
        }
        if (this._engineSrc) {
            try {
                this._engineSrc.stop();
            } catch {
                // already stopped
            }
            this._engineSrc.disconnect();
        }
        const src = this._ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        src.playbackRate.value = this._enginePitch;
        src.connect(this._engineGain);
        src.start();
        this._engineSrc = src;
    }

    private _startLoop(buffer: AudioBuffer | null): { src: AudioBufferSourceNode; gain: GainNode } | null {
        if (!buffer || !this._ctx || !this._master) {
            return null;
        }
        const src = this._ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        const gain = this._ctx.createGain();
        gain.gain.value = 0;
        src.connect(gain).connect(this._master);
        src.start();
        return { src, gain };
    }

    /**
     * Update engine + skid each frame (kit's `effect_engine` / `effect_trails`).
     * @param dt Seconds since last frame.
     * @param speed Vehicle forward speed (~[-1, 1]).
     * @param throttle Throttle input (~[-1, 1]).
     * @param drift Vehicle drift intensity.
     */
    update(dt: number, speed: number, throttle: number, drift: number): void {
        if (!this._started || !this._ctx) {
            return;
        }
        const speedFactor = clamp(Math.abs(speed), 0, 1);
        const throttleFactor = clamp(Math.abs(throttle), 0, 1);

        // Engine: volume rises with speed + throttle; pitch tracks speed.
        const targetEngineDb = remap(speedFactor + throttleFactor * 0.5, 0, 1.5, -15, -5);
        this._engineDb = lerp(this._engineDb, targetEngineDb, dt * 5);
        const targetPitch = remap(speedFactor, 0, 1, 0.5, 3) + (throttleFactor > 0.1 ? 0.2 : 0);
        this._enginePitch = lerp(this._enginePitch, targetPitch, dt * 2);
        if (this._engineGain) {
            this._engineGain.gain.value = dbToGain(this._engineDb);
        }
        if (this._engineSrc) {
            this._engineSrc.playbackRate.value = this._enginePitch;
        }

        // Skid: audible only while drifting (kit threshold 0.25).
        const targetSkidDb = drift > 0.25 ? remap(clamp(drift, 0.25, 2), 0.25, 2, -10, 0) : -80;
        this._skidDb = lerp(this._skidDb, targetSkidDb, dt * 10);
        if (this._skidGain) {
            this._skidGain.gain.value = dbToGain(this._skidDb);
        }
    }

    /** Play the one-shot impact (kit's `_on_sphere_body_entered`), scaled by hit speed. */
    impact(velocity: number): void {
        if (!this._started || !this._ctx || !this._master || !this._impactBuf) {
            return;
        }
        const src = this._ctx.createBufferSource();
        src.buffer = this._impactBuf;
        const gain = this._ctx.createGain();
        gain.gain.value = dbToGain(clamp(remap(velocity, 1, 14, -22, -2), -22, -2));
        src.connect(gain).connect(this._master);
        src.onended = (): void => {
            src.disconnect();
            gain.disconnect();
        };
        src.start();
    }
}
