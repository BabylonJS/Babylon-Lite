// Clean-room DMX (DS*) sound effect playback via the Web Audio API.
//
// The DMX digital sound lump format (publicly documented):
//   u16 format (always 3)
//   u16 sample rate (Hz, typically 11025)
//   u32 sample count
//   then `sample count` bytes of unsigned 8-bit PCM.
// Many lumps include 16 padding samples at the start and end (duplicates of the
// first/last real sample); we trim them when present.

import type { Wad } from "../wad/wad-file.js";
import { tryGetLump } from "../wad/wad-file.js";

export class DoomSound {
    private ctx: AudioContext | null = null;
    private readonly cache = new Map<string, AudioBuffer | null>();
    private lastPlay = new Map<string, number>();

    constructor(private readonly wad: Wad) {}

    /** Resume the audio context after a user gesture (browsers require this). */
    resume(): void {
        if (!this.ctx) {
            const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (Ctor) this.ctx = new Ctor();
        }
        if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume();
    }

    /** Plays a sound by its base name (e.g. "PISTOL" -> lump "DSPISTOL"). */
    play(name: string): void {
        if (!this.ctx || this.ctx.state !== "running") return;
        // Rate-limit identical sounds within the same render frame.
        const now = this.ctx.currentTime;
        const last = this.lastPlay.get(name) ?? -1;
        if (now - last < 1 / 35) return;
        this.lastPlay.set(name, now);

        const buffer = this.getBuffer(name);
        if (!buffer) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        const gain = this.ctx.createGain();
        gain.gain.value = 0.6;
        src.connect(gain).connect(this.ctx.destination);
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
