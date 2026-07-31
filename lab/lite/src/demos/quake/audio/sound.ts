// Clean-room Quake sound-effect playback through the Lite audio engine.
//
// The LibreQuake assets ship sounds as standard RIFF/WAVE PCM lumps (mono,
// 11025/22050 Hz, 8- or 16-bit), so we let the browser decode them with
// `decodeAudioData` rather than hand-parsing PCM. Sounds are fetched + decoded
// lazily and cached. Positional sounds (monsters, doors) are attenuated by
// distance and panned left/right relative to the listener's facing, mirroring
// Quake's ATTN_NORM falloff without copying any game code.
//
// All mixing happens on nodes built in the Lite audio engine's own context and
// routed into the engine via `createSoundSourceAsync`, so playback shares the
// engine's master bus, unlock handling, and master volume instead of a private
// AudioContext.

import { createAudioEngineAsync, createSoundSourceAsync, unlockAudioEngineAsync, type AudioEngine } from "babylon-lite";
import { demoAssetUrl } from "../../demo-asset-url.js";

type V3 = [number, number, number];

const SND_BASE = demoAssetUrl("./librequake/sound/", import.meta.url);
/** Distance (Quake units) past which a positional sound is inaudible. */
const ATTN_RANGE = 1400;
/** Minimum gap between two plays of the same sound, in seconds. */
const REPEAT_GAP = 0.05;

interface PlayOptions {
    /** Quake-space source position; enables distance attenuation + stereo pan. */
    origin?: V3;
    /** Extra volume scale (0..1), applied on top of distance attenuation. */
    volume?: number;
}

export class QuakeSound {
    private engine: AudioEngine | null = null;
    private ctx: BaseAudioContext | null = null;
    private master: GainNode | null = null;
    private ready: Promise<void> | null = null;
    private readonly buffers = new Map<string, AudioBuffer | null>();
    private readonly loading = new Map<string, Promise<AudioBuffer | null>>();
    private readonly lastPlay = new Map<string, number>();
    private listener: V3 = [0, 0, 0];
    private listenYaw = 0;

    constructor() {
        // Warm the engine early (its context starts suspended until a gesture),
        // so preloaded clips can decode before the first `resume()`.
        void this.ensure();
    }

    /** Lazily create the Lite audio engine + master node (memoized). */
    private ensure(): Promise<void> {
        if (!this.ready) {
            this.ready = (async (): Promise<void> => {
                const engine = await createAudioEngineAsync();
                const master = engine.audioContext.createGain();
                master.gain.value = 0.8;
                await createSoundSourceAsync(engine, master);
                this.engine = engine;
                this.ctx = engine.audioContext;
                this.master = master;
            })().catch(() => {
                // Audio unavailable (e.g. headless E2E) — stay silent. Clear the
                // memoized promise (and any partial state) so a later gesture can
                // retry a transient failure instead of staying muted forever.
                this.engine = null;
                this.ctx = null;
                this.master = null;
                this.ready = null;
            });
        }
        return this.ready;
    }

    /** Resume the engine after a user gesture (context starts suspended). */
    resume(): void {
        void this.ensure().then(() => {
            if (this.engine) void unlockAudioEngineAsync(this.engine);
        });
    }

    /** Update the listener pose (Quake space) so positional sounds pan/attenuate. */
    setListener(origin: V3, yaw: number): void {
        this.listener = origin;
        this.listenYaw = yaw;
    }

    /** Warm the cache for a set of sounds (fire-and-forget fetch + decode). */
    preload(paths: readonly string[]): void {
        for (const p of paths) void this.load(p);
    }

    /** Play a sound by its path under sound/ (e.g. "weapons/guncock.wav"). */
    play(path: string, opts?: PlayOptions): void {
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        const last = this.lastPlay.get(path) ?? -Infinity;
        if (now - last < REPEAT_GAP) return;
        this.lastPlay.set(path, now);
        void this.load(path).then((buf) => this.start(buf, opts));
    }

    /** Play a random one of several variants (pain/death cries). */
    playRandom(paths: readonly string[], opts?: PlayOptions): void {
        if (paths.length === 0) return;
        this.play(paths[(Math.random() * paths.length) | 0]!, opts);
    }

    private start(buf: AudioBuffer | null, opts?: PlayOptions): void {
        const ctx = this.ctx;
        const master = this.master;
        if (!buf || !ctx || !master || this.engine?.state !== "running") return;

        let gain = opts?.volume ?? 1;
        let pan = 0;
        if (opts?.origin) {
            const dx = opts.origin[0] - this.listener[0];
            const dy = opts.origin[1] - this.listener[1];
            const dz = opts.origin[2] - this.listener[2];
            const dist = Math.hypot(dx, dy, dz);
            gain *= Math.max(0, 1 - dist / ATTN_RANGE);
            if (gain <= 0.001) return;
            // Stereo pan from the horizontal angle to the listener's right vector.
            // Quake forward = (cos yaw, sin yaw); right = (sin yaw, -cos yaw).
            const horiz = Math.hypot(dx, dy) || 1;
            const rx = Math.sin(this.listenYaw);
            const ry = -Math.cos(this.listenYaw);
            pan = Math.max(-1, Math.min(1, (dx * rx + dy * ry) / horiz)) * 0.85;
        }

        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain();
        g.gain.value = gain;
        src.connect(g);
        let tail: AudioNode = g;
        if (pan !== 0 && typeof ctx.createStereoPanner === "function") {
            const panner = ctx.createStereoPanner();
            panner.pan.value = pan;
            g.connect(panner);
            tail = panner;
        }
        tail.connect(master);
        src.start();
    }

    private load(path: string): Promise<AudioBuffer | null> {
        const cached = this.buffers.get(path);
        if (cached !== undefined) return Promise.resolve(cached);
        const inFlight = this.loading.get(path);
        if (inFlight) return inFlight;
        const p = (async (): Promise<AudioBuffer | null> => {
            await this.ensure();
            if (!this.ctx) return null;
            try {
                const res = await fetch(SND_BASE + path);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
                this.buffers.set(path, buf);
                return buf;
            } catch {
                this.buffers.set(path, null); // negative-cache so we don't retry
                return null;
            } finally {
                this.loading.delete(path);
            }
        })();
        this.loading.set(path, p);
        return p;
    }
}
