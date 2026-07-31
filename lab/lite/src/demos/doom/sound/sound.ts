// Clean-room DMX (DS*) sound effect playback through the Lite audio engine.
//
// The DMX digital sound lump format (publicly documented):
//   u16 format (always 3)
//   u16 sample rate (Hz, typically 11025)
//   u32 sample count
//   then `sample count` bytes of unsigned 8-bit PCM.
// Many lumps include 16 padding samples at the start and end (duplicates of the
// first/last real sample); we trim them when present.
//
// Decoded lumps become `AudioBuffer`s played through the Lite audio engine: a
// persistent master `GainNode` (built in the engine's own context) is routed into
// the engine via `createSoundSourceAsync`, so all playback shares the engine's
// master bus, unlock handling, and master volume rather than a private context.

import { createAudioEngineAsync, createSoundSourceAsync, unlockAudioEngineAsync, type AudioEngine } from "babylon-lite";
import type { Wad } from "../wad/wad-file.js";
import { tryGetLump } from "../wad/wad-file.js";

export class DoomSound {
    private engine: AudioEngine | null = null;
    private ctx: BaseAudioContext | null = null;
    private master: GainNode | null = null;
    private starting = false;
    private readonly cache = new Map<string, AudioBuffer | null>();
    private lastPlay = new Map<string, number>();

    constructor(private readonly wad: Wad) {}

    /** Create + unlock the Lite audio engine after a user gesture (browsers
     *  require a gesture before a context can produce sound). Idempotent. */
    resume(): void {
        if (this.engine) {
            void unlockAudioEngineAsync(this.engine);
            return;
        }
        if (this.starting) return;
        this.starting = true;
        void this.start();
    }

    private async start(): Promise<void> {
        try {
            const engine = await createAudioEngineAsync();
            const master = engine.audioContext.createGain();
            master.gain.value = 0.6;
            await createSoundSourceAsync(engine, master);
            this.engine = engine;
            this.ctx = engine.audioContext;
            this.master = master;
            await unlockAudioEngineAsync(engine);
        } catch {
            // Audio unavailable (e.g. headless E2E) — stay silent.
        }
    }

    /** Plays a sound by its base name (e.g. "PISTOL" -> lump "DSPISTOL"). */
    play(name: string): void {
        const ctx = this.ctx;
        const master = this.master;
        if (!ctx || !master || this.engine?.state !== "running") return;
        // Rate-limit identical sounds within the same render frame.
        const now = ctx.currentTime;
        const last = this.lastPlay.get(name) ?? -1;
        if (now - last < 1 / 35) return;
        this.lastPlay.set(name, now);

        const buffer = this.getBuffer(name);
        if (!buffer) return;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(master);
        src.start();
    }

    private getBuffer(name: string): AudioBuffer | null {
        if (this.cache.has(name)) return this.cache.get(name) ?? null;
        const buffer = this.decode(name);
        this.cache.set(name, buffer);
        return buffer;
    }

    private decode(name: string): AudioBuffer | null {
        if (!this.ctx) return null;
        const lump = tryGetLump(this.wad, `DS${name}`);
        if (!lump || lump.length < 8) return null;
        const view = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);
        const format = view.getUint16(0, true);
        if (format !== 3) return null;
        const rate = view.getUint16(2, true) || 11025;
        let count = view.getUint32(4, true);
        let offset = 8;
        if (offset + count > lump.length) count = lump.length - offset;
        if (count <= 0) return null;

        // Trim the 16-sample lead/tail padding when present.
        let start = offset;
        let end = offset + count;
        if (count > 32) {
            start += 16;
            end -= 16;
        }
        const n = end - start;
        if (n <= 0) return null;

        const audio = this.ctx.createBuffer(1, n, rate);
        const channel = audio.getChannelData(0);
        for (let i = 0; i < n; i++) {
            channel[i] = (lump[start + i]! - 128) / 128;
        }
        return audio;
    }
}
