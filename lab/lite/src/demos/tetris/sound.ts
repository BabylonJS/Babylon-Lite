/**
 * Asset-free sound effects for the tetris demo, synthesised on the fly with the
 * Web Audio API — no audio files to fetch, so the demo stays as thin as the
 * rest of Lite. Each effect is a short stack of enveloped oscillator notes
 * (chiptune-style blips, sweeps and arpeggios).
 *
 * Browser autoplay policy: an AudioContext may only start from a user gesture,
 * so the context is created lazily inside `resume()`, which the wiring layer
 * calls from the first key press / pointer down. `play()` is a no-op until a
 * context exists, so events fired before the first gesture are silently
 * dropped rather than throwing or warning.
 *
 * Per repo convention this module has zero import-time side effects: all state
 * lives inside the closure returned by `createTetrisAudio()`.
 */

import type { GameSound } from "./game.js";

/** Every effect the audio layer can play: rules-layer outcomes (`GameSound`)
 *  plus the input-driven "intent" sounds the wiring layer triggers directly. */
export type TetrisSound = GameSound | "move" | "rotate" | "softDrop" | "hardDrop" | "pause";

export interface TetrisAudio {
    /** (Re)create + resume the AudioContext. Must be called from a user-gesture
     *  handler (key down / pointer down / button click). Idempotent. */
    resume(): void;
    /** Play a one-shot effect. No-op while muted or before `resume()` has run. */
    play(sound: TetrisSound): void;
    /** Whether output is currently muted. */
    readonly muted: boolean;
    /** Set the mute state. */
    setMuted(muted: boolean): void;
    /** Flip the mute state; returns the new value. */
    toggleMuted(): boolean;
}

interface Note {
    /** Oscillator wave shape. */
    type: OscillatorType;
    /** Start frequency (Hz). */
    freq: number;
    /** Optional end frequency for a glide over the note's duration. */
    to?: number;
    /** Start offset from "now" (s). */
    at?: number;
    /** Note length (s). */
    dur: number;
    /** Peak gain (0..1). */
    gain: number;
}

const MASTER_GAIN = 0.32;

export function createTetrisAudio(): TetrisAudio {
    let ctx: AudioContext | null = null;
    let master: GainNode | null = null;
    let muted = false;

    function resume(): void {
        try {
            if (typeof AudioContext === "undefined") {
                return;
            }
            if (!ctx) {
                ctx = new AudioContext();
                master = ctx.createGain();
                master.gain.value = muted ? 0 : MASTER_GAIN;
                master.connect(ctx.destination);
            }
            if (ctx.state === "suspended") {
                void ctx.resume();
            }
        } catch {
            // Audio unavailable (e.g. no output device) — disable silently.
            ctx = null;
            master = null;
        }
    }

    function note(n: Note): void {
        if (!ctx || !master) {
            return;
        }
        const start = ctx.currentTime + (n.at ?? 0);
        const end = start + n.dur;
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = n.type;
        osc.frequency.setValueAtTime(n.freq, start);
        if (n.to !== undefined) {
            osc.frequency.exponentialRampToValueAtTime(Math.max(1, n.to), end);
        }
        // Click-free AD envelope using exponential ramps (kept strictly > 0).
        env.gain.setValueAtTime(0.0001, start);
        env.gain.exponentialRampToValueAtTime(n.gain, start + 0.006);
        env.gain.exponentialRampToValueAtTime(0.0001, end);
        osc.connect(env);
        env.connect(master);
        osc.start(start);
        osc.stop(end + 0.03);
    }

    function chord(notes: readonly Note[]): void {
        for (const n of notes) {
            note(n);
        }
    }

    function play(sound: TetrisSound): void {
        // Gate on an existing context (only created from a gesture by resume()),
        // so nothing is scheduled — and no autoplay warning fired — beforehand.
        if (muted || !ctx) {
            return;
        }
        switch (sound) {
            case "move":
                note({ type: "square", freq: 220, dur: 0.05, gain: 0.22 });
                break;
            case "rotate":
                note({ type: "square", freq: 330, to: 392, dur: 0.07, gain: 0.28 });
                break;
            case "softDrop":
                note({ type: "triangle", freq: 160, dur: 0.04, gain: 0.18 });
                break;
            case "hardDrop":
                note({ type: "square", freq: 200, to: 70, dur: 0.16, gain: 0.42 });
                break;
            case "lock":
                note({ type: "triangle", freq: 150, to: 90, dur: 0.1, gain: 0.4 });
                break;
            case "clear":
                chord([
                    { type: "square", freq: 523, dur: 0.12, gain: 0.38 },
                    { type: "square", freq: 659, at: 0.06, dur: 0.14, gain: 0.38 },
                ]);
                break;
            case "tetris":
                chord([
                    { type: "square", freq: 523, at: 0.0, dur: 0.12, gain: 0.42 },
                    { type: "square", freq: 659, at: 0.09, dur: 0.12, gain: 0.42 },
                    { type: "square", freq: 784, at: 0.18, dur: 0.12, gain: 0.42 },
                    { type: "square", freq: 1047, at: 0.27, dur: 0.22, gain: 0.46 },
                ]);
                break;
            case "levelUp":
                chord([
                    { type: "triangle", freq: 440, at: 0.0, dur: 0.1, gain: 0.4 },
                    { type: "triangle", freq: 587, at: 0.08, dur: 0.1, gain: 0.4 },
                    { type: "triangle", freq: 880, at: 0.16, dur: 0.18, gain: 0.42 },
                ]);
                break;
            case "gameOver":
                chord([
                    { type: "sawtooth", freq: 392, to: 330, at: 0.0, dur: 0.26, gain: 0.36 },
                    { type: "sawtooth", freq: 294, to: 196, at: 0.24, dur: 0.42, gain: 0.36 },
                    { type: "sawtooth", freq: 196, to: 98, at: 0.62, dur: 0.6, gain: 0.36 },
                ]);
                break;
            case "pause":
                note({ type: "sine", freq: 330, dur: 0.09, gain: 0.24 });
                break;
        }
    }

    function setMuted(value: boolean): void {
        muted = value;
        if (master && ctx) {
            master.gain.setValueAtTime(value ? 0 : MASTER_GAIN, ctx.currentTime);
        }
    }

    function toggleMuted(): boolean {
        setMuted(!muted);
        return muted;
    }

    return {
        resume,
        play,
        get muted() {
            return muted;
        },
        setMuted,
        toggleMuted,
    };
}
