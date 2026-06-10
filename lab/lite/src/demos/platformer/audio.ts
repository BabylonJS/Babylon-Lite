/**
 * Tiny Web Audio sound effects + looping background music for the platformer demo,
 * all synthesised at runtime (no audio files to ship). The engine has no audio
 * subsystem, so this is a small clean-room oscillator/noise kit — chiptune-flavoured
 * blips for jump, coin, stomp, bump, power-up, pipe, death, and the level-complete
 * jingle, plus a look-ahead-scheduled chiptune loop ({@link Music}).
 *
 * The AudioContext is created lazily and resumed on first user gesture (browser
 * autoplay policy); the music scheduler self-guards until the context is running.
 */

type Wave = OscillatorType;

/** MIDI note number → frequency (Hz). A4 (MIDI 69) = 440 Hz. */
const midiToFreq = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/**
 * A looping chiptune track on an 8th-note grid. `lead`/`bass` hold one MIDI note per
 * 8th (0 = rest); `chords` is one triad per bar (8 steps) that drives a soft arpeggio.
 * The whole song loops once `lead.length` steps elapse.
 */
interface Song {
    /** Beats per minute (each array entry is an 8th note = 60/tempo/2 seconds). */
    tempo: number;
    /** One MIDI triad per bar (8 steps), arpeggiated quietly under the lead. */
    chords: number[][];
    /** Lead melody: one MIDI note per 8th note (0 = rest). */
    lead: number[];
    /** Bassline: one MIDI note per 8th note (0 = rest). */
    bass: number[];
}

// Bright, bouncy overworld loop — 4 bars of I–vi–IV–V in C major (C · Am · F · G).
const OVERWORLD_SONG: Song = {
    tempo: 132,
    chords: [
        [60, 64, 67], // C  (C4 E4 G4)
        [57, 60, 64], // Am (A3 C4 E4)
        [53, 57, 60], // F  (F3 A3 C4)
        [55, 59, 62], // G  (G3 B3 D4)
    ],
    // 4 bars × 8 eighths. (E5 G5 E5 C5 D5 E5 – C5) then resolving phrases per chord.
    lead: [
        76, 79, 76, 72, 74, 76, 0, 72, // C
        72, 76, 72, 69, 71, 72, 0, 67, // Am
        69, 72, 77, 72, 74, 77, 0, 76, // F
        74, 79, 71, 74, 79, 77, 74, 0, // G
    ],
    // Root/fifth bounce, low octave, one per eighth — a steady walking pulse.
    bass: [
        48, 55, 48, 55, 48, 55, 48, 55, // C  (C3/G3)
        45, 52, 45, 52, 45, 52, 45, 52, // Am (A2/E3)
        41, 48, 41, 48, 41, 48, 41, 48, // F  (F2/C3)
        43, 50, 43, 50, 43, 50, 43, 43, // G  (G2/D3)
    ],
};

// Moody underground / castle loop — 4 bars in A minor (Am · F · C · E), slower, with
// rests for tension. Reused for both the cave and the castle boss fight.
const CAVE_SONG: Song = {
    tempo: 104,
    chords: [
        [57, 60, 64], // Am (A3 C4 E4)
        [53, 57, 60], // F  (F3 A3 C4)
        [60, 64, 67], // C  (C4 E4 G4)
        [52, 56, 59], // E  (E3 G#3 B3)
    ],
    lead: [
        69, 0, 72, 0, 76, 0, 74, 72, // Am
        0, 69, 0, 72, 0, 69, 65, 0, // F
        67, 0, 64, 0, 72, 0, 71, 67, // C
        68, 0, 71, 0, 76, 0, 71, 68, // E (G#4 leading tone)
    ],
    bass: [
        45, 0, 45, 52, 45, 0, 45, 52, // Am (A2/E3)
        41, 0, 41, 48, 41, 0, 41, 48, // F  (F2/C3)
        48, 0, 48, 55, 48, 0, 48, 55, // C  (C3/G3)
        40, 0, 40, 47, 40, 0, 40, 47, // E  (E2/B2)
    ],
};

/** Looping background music (procedural chiptune). */
export interface Music {
    /** Start (or switch to) a looping track. No-op if it is already the current track. */
    play: (track: "overworld" | "cave") => void;
    /** Stop the music (any already-scheduled notes ring out). */
    stop: () => void;
    /** Freeze / unfreeze scheduling — used by the game's pause so music halts too. */
    setPaused: (paused: boolean) => void;
}

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
    /** Pipe-warp whoosh (descending blip) played when entering a pipe. */
    warp: () => void;
    /** Short "pew" when throwing a fireball. */
    fireball: () => void;
    /** Crunchy shatter when a big player smashes a brick. */
    breakBlock: () => void;
    /** Looping chiptune background music. */
    music: Music;
    /** Resume the context after a user gesture; safe to call repeatedly. */
    resume: () => void;
    dispose: () => void;
}

export function createSfx(): Sfx {
    let ctx: AudioContext | null = null;
    let master: GainNode | null = null;
    /** Sub-mix for music, so the loop sits under the SFX without separate volume wiring. */
    let musicGain: GainNode | null = null;

    const ensure = (): AudioContext | null => {
        if (ctx === null) {
            const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!Ctor) return null;
            ctx = new Ctor();
            master = ctx.createGain();
            master.gain.value = 0.22;
            master.connect(ctx.destination);
            musicGain = ctx.createGain();
            musicGain.gain.value = 0.8;
            musicGain.connect(master);
        }
        return ctx;
    };

    const tone = (freq: number, dur: number, wave: Wave, t0: number, gain = 1, slideTo?: number, dest?: AudioNode): void => {
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
        g.connect(dest ?? master);
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

    // ── Music: a look-ahead scheduler that loops a {@link Song} ───────────────
    // A timer wakes every ~30 ms and schedules any notes falling in the next
    // ~120 ms window at precise AudioContext times (the standard Web Audio pattern;
    // setInterval alone is too jittery for tight rhythm). It self-guards until the
    // context is running, so calling `play()` before the first gesture is harmless.
    let musicTimer: ReturnType<typeof setInterval> | null = null;
    let musicSong: Song | null = null;
    let musicStep = 0;
    let musicNextTime = 0;
    let musicPaused = false;
    const STEPS_PER_BAR = 8;

    const scheduleMusicStep = (song: Song, step: number, t0: number): void => {
        const stepDur = 60 / song.tempo / 2; // one 8th note
        const lead = song.lead[step] ?? 0;
        if (lead > 0) tone(midiToFreq(lead), stepDur * 0.95, "square", t0, 0.55, undefined, musicGain ?? undefined);
        const bass = song.bass[step] ?? 0;
        if (bass > 0) tone(midiToFreq(bass), stepDur * 0.95, "triangle", t0, 0.6, undefined, musicGain ?? undefined);
        // Soft arpeggio: cycle the current bar's triad for gentle harmonic movement.
        const triad = song.chords[Math.floor(step / STEPS_PER_BAR) % song.chords.length]!;
        tone(midiToFreq(triad[step % triad.length]!), stepDur * 0.45, "square", t0, 0.16, undefined, musicGain ?? undefined);
    };

    const musicTick = (): void => {
        const c = ctx;
        if (!c || !musicSong || c.state !== "running") return;
        if (musicNextTime < c.currentTime) musicNextTime = c.currentTime + 0.05; // catch up after a suspend
        while (musicNextTime < c.currentTime + 0.12) {
            scheduleMusicStep(musicSong, musicStep, musicNextTime);
            musicNextTime += 60 / musicSong.tempo / 2;
            musicStep = (musicStep + 1) % musicSong.lead.length;
        }
    };

    const startMusicTimer = (): void => {
        if (musicTimer !== null) return;
        musicNextTime = ctx ? ctx.currentTime : 0;
        musicTimer = setInterval(musicTick, 30);
    };
    const stopMusicTimer = (): void => {
        if (musicTimer !== null) {
            clearInterval(musicTimer);
            musicTimer = null;
        }
    };

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
        warp(): void {
            if (!ensure()) return;
            const t = now();
            // Descending "down the pipe" whoosh plus a soft noise puff.
            tone(880, 0.28, "sine", t, 0.5, 160);
            tone(440, 0.22, "square", t + 0.04, 0.3, 110);
            noise(0.18, t, 0.18);
        },
        fireball(): void {
            if (!ensure()) return;
            // Quick upward "pew".
            tone(620, 0.09, "square", now(), 0.4, 1040);
        },
        breakBlock(): void {
            if (!ensure()) return;
            const t = now();
            // Crunchy shatter: noise burst + a short descending thunk.
            noise(0.16, t, 0.5);
            tone(240, 0.12, "square", t, 0.5, 90);
            tone(360, 0.08, "triangle", t + 0.02, 0.3, 140);
        },
        music: {
            play(track: "overworld" | "cave"): void {
                const song = track === "cave" ? CAVE_SONG : OVERWORLD_SONG;
                if (musicSong === song) return; // already on this track
                musicSong = song;
                musicStep = 0;
                if (!musicPaused) startMusicTimer();
            },
            stop(): void {
                musicSong = null;
                stopMusicTimer();
            },
            setPaused(paused: boolean): void {
                musicPaused = paused;
                if (paused) stopMusicTimer();
                else if (musicSong) startMusicTimer();
            },
        },
        dispose(): void {
            stopMusicTimer();
            if (ctx) void ctx.close();
            ctx = null;
            master = null;
            musicGain = null;
        },
    };
}
