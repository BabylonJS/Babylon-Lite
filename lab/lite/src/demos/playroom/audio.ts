import { createAudioEngineAsync, createSoundSourceAsync, disposeAudioEngine, disposeSoundSource, unlockAudioEngineAsync } from "babylon-lite";
import type { AudioState, BodyRecord } from "./types.js";

export type PlayroomSound = "launch" | "flight" | "score" | "popper";

export interface ContactAudioProfile {
    readonly name: string;
    readonly files: readonly string[];
    readonly colliderTags: readonly string[];
    readonly collideeTags: readonly string[];
    readonly collisionDeduplicationMs?: number;
    readonly minTimeBetweenPlaysMs?: number;
    readonly playbackRate: number;
    readonly playbackRateRandomizationRange?: number;
    readonly velocityThreshold: number;
    readonly velocityThresholdForGround?: number;
    readonly volume: number;
    readonly volumeRandomizationRange?: number;
    readonly volumeMin?: number;
    readonly projectileOnly?: boolean;
}

export const CONTACT_AUDIO_PROFILES: readonly ContactAudioProfile[] = [
    {
        name: "bowling-ball-ground",
        files: ["bowling-ball-carpet-thump.mp3"],
        colliderTags: ["bowlingBall"],
        collideeTags: ["ground"],
        minTimeBetweenPlaysMs: 100,
        playbackRate: 0.9,
        playbackRateRandomizationRange: 0.1,
        velocityThreshold: 1,
        velocityThresholdForGround: 0.1,
        volume: 5,
    },
    {
        name: "bowling-pin-hard",
        files: ["bowling-pin-hard-1.mp3"],
        colliderTags: ["bowlingPin"],
        collideeTags: ["hard"],
        collisionDeduplicationMs: 3000,
        minTimeBetweenPlaysMs: 100,
        playbackRate: 0.85,
        playbackRateRandomizationRange: 0.1,
        velocityThreshold: 2,
        volume: 1,
    },
    {
        name: "bowling-pin-soft",
        files: ["bowling-pin-soft-1.mp3", "bowling-pin-soft-2.mp3"],
        colliderTags: ["bowlingPin"],
        collideeTags: ["soft"],
        minTimeBetweenPlaysMs: 500,
        playbackRate: 0.85,
        playbackRateRandomizationRange: 0.1,
        velocityThreshold: 5,
        volume: 1,
    },
    {
        name: "domino-hard",
        files: Array(8).fill("domino.mp3") as string[],
        colliderTags: ["domino"],
        collideeTags: ["domino"],
        collisionDeduplicationMs: 3000,
        minTimeBetweenPlaysMs: 20,
        playbackRate: 2,
        playbackRateRandomizationRange: 0.2,
        velocityThreshold: 0.1,
        volume: 0.25,
        volumeRandomizationRange: 2,
        volumeMin: 0.05,
    },
    {
        name: "plastic-block-hard",
        files: ["plastic-block-hard-1.mp3", "plastic-block-hard-2.mp3", "plastic-block-hard-3.mp3"],
        colliderTags: ["hard", "plastic", "block"],
        collideeTags: ["hard"],
        collisionDeduplicationMs: 500,
        minTimeBetweenPlaysMs: 100,
        playbackRate: 0.8,
        playbackRateRandomizationRange: 0.2,
        velocityThreshold: 10,
        volume: 0.5,
    },
    {
        name: "plastic-block-soft",
        files: ["plastic-block-soft-1.mp3", "plastic-block-soft-2.mp3", "plastic-block-soft-3.mp3"],
        colliderTags: ["hard", "plastic", "block"],
        collideeTags: ["soft"],
        collisionDeduplicationMs: 500,
        minTimeBetweenPlaysMs: 75,
        playbackRate: 0.8,
        playbackRateRandomizationRange: 0.2,
        velocityThreshold: 10,
        velocityThresholdForGround: 1,
        volume: 0.4,
    },
    {
        name: "plastic-cup-hard",
        files: ["plastic-cup-hard-1.mp3", "plastic-cup-hard-2.mp3", "plastic-cup-hard-3.mp3"],
        colliderTags: ["hard", "plastic", "cup"],
        collideeTags: ["hard"],
        collisionDeduplicationMs: 1000,
        minTimeBetweenPlaysMs: 30,
        playbackRate: 0.5,
        playbackRateRandomizationRange: 0.5,
        velocityThreshold: 5,
        volume: 0.75,
        volumeMin: 0.01,
    },
    {
        name: "plastic-cup-soft",
        files: ["plastic-cup-soft-1.mp3"],
        colliderTags: ["hard", "plastic", "cup"],
        collideeTags: ["soft"],
        minTimeBetweenPlaysMs: 50,
        playbackRate: 0.75,
        playbackRateRandomizationRange: 0.25,
        velocityThreshold: 50,
        velocityThresholdForGround: 1,
        volume: 0.2,
    },
    {
        name: "chess-piece-hard",
        files: ["chess-piece-hard-1.mp3", "chess-piece-hard-2.mp3", "chess-piece-hard-3.mp3"],
        colliderTags: ["chessPiece"],
        collideeTags: ["hard"],
        collisionDeduplicationMs: 250,
        minTimeBetweenPlaysMs: 100,
        playbackRate: 0.8,
        playbackRateRandomizationRange: 0.3,
        velocityThreshold: 10,
        volume: 0.5,
    },
    {
        name: "chess-piece-soft",
        files: ["chess-piece-hard-1.mp3", "chess-piece-hard-2.mp3", "chess-piece-hard-3.mp3"],
        colliderTags: ["chessPiece"],
        collideeTags: ["soft"],
        collisionDeduplicationMs: 250,
        minTimeBetweenPlaysMs: 100,
        playbackRate: 0.8,
        playbackRateRandomizationRange: 0.3,
        velocityThreshold: 10,
        volume: 0.25,
    },
    {
        name: "chess-board-hard",
        files: ["chess-board-hard-1.mp3"],
        colliderTags: ["chessBoard"],
        collideeTags: ["hard"],
        collisionDeduplicationMs: 500,
        minTimeBetweenPlaysMs: 200,
        playbackRate: 0.9,
        playbackRateRandomizationRange: 0.1,
        velocityThreshold: 30,
        volume: 2,
    },
    {
        name: "wood-block-hard",
        files: ["wood-block-hard-1.mp3", "wood-block-hard-2.mp3"],
        colliderTags: ["hard", "wood", "block"],
        collideeTags: ["hard", "wood"],
        collisionDeduplicationMs: 1000,
        minTimeBetweenPlaysMs: 10,
        playbackRate: 0.6,
        playbackRateRandomizationRange: 0.1,
        velocityThreshold: 5,
        volume: 5,
    },
    {
        name: "wood-block-soft",
        files: ["wood-block-soft-1.mp3", "wood-block-soft-2.mp3"],
        colliderTags: ["hard", "wood", "block"],
        collideeTags: ["soft"],
        collisionDeduplicationMs: 1000,
        minTimeBetweenPlaysMs: 200,
        playbackRate: 0.9,
        playbackRateRandomizationRange: 0.1,
        velocityThreshold: 20,
        velocityThresholdForGround: 1,
        volume: 0.5,
    },
    {
        name: "projectile-ground",
        files: ["projectile-carpet-thump.mp3"],
        colliderTags: ["projectile"],
        collideeTags: ["ground"],
        minTimeBetweenPlaysMs: 200,
        playbackRate: 0.9,
        playbackRateRandomizationRange: 0.1,
        velocityThreshold: 20,
        volume: 1,
        projectileOnly: true,
    },
] as const;

const SOUND_POOLS: Readonly<Record<Exclude<PlayroomSound, "flight">, readonly string[]>> = {
    launch: ["projectile-launch.mp3"],
    score: ["point-scored.mp3"],
    popper: ["popper.mp3"],
};

export const ACTIVE_SOUND_FILES = [
    "bowling-ball-carpet-thump.mp3",
    "bowling-pin-hard-1.mp3",
    "bowling-pin-soft-1.mp3",
    "bowling-pin-soft-2.mp3",
    "domino.mp3",
    "plastic-block-hard-1.mp3",
    "plastic-block-hard-2.mp3",
    "plastic-block-hard-3.mp3",
    "plastic-block-soft-1.mp3",
    "plastic-block-soft-2.mp3",
    "plastic-block-soft-3.mp3",
    "plastic-cup-hard-1.mp3",
    "plastic-cup-hard-2.mp3",
    "plastic-cup-hard-3.mp3",
    "plastic-cup-soft-1.mp3",
    "chess-piece-hard-1.mp3",
    "chess-piece-hard-2.mp3",
    "chess-piece-hard-3.mp3",
    "chess-board-hard-1.mp3",
    "wood-block-hard-1.mp3",
    "wood-block-hard-2.mp3",
    "wood-block-soft-1.mp3",
    "wood-block-soft-2.mp3",
    "projectile-carpet-thump.mp3",
    "projectile-launch.mp3",
    "point-scored.mp3",
    "popper.mp3",
    "projectile-flight.mp3",
] as const;

interface PlayroomAudioApi {
    readonly createAudioEngineAsync: typeof createAudioEngineAsync;
    readonly createSoundSourceAsync: typeof createSoundSourceAsync;
    readonly disposeAudioEngine: typeof disposeAudioEngine;
    readonly disposeSoundSource: typeof disposeSoundSource;
    readonly unlockAudioEngineAsync: typeof unlockAudioEngineAsync;
}

let audioApis: WeakMap<AudioState, PlayroomAudioApi> | null = null;

function defaultAudioApi(): PlayroomAudioApi {
    return {
        createAudioEngineAsync,
        createSoundSourceAsync,
        disposeAudioEngine,
        disposeSoundSource,
        unlockAudioEngineAsync,
    };
}

function hasTags(actual: readonly string[], required: readonly string[]): boolean {
    return required.every((tag) => actual.includes(tag));
}

export interface ContactAudioMatch {
    profile: ContactAudioProfile;
    collider: BodyRecord;
    colliderIndex: number;
    collidee: BodyRecord;
    collideeIndex: number;
    preparedKey?: string | null;
}

export function matchContactAudio(
    collider: BodyRecord,
    colliderIndex: number,
    collidee: BodyRecord,
    collideeIndex: number,
    matches: ContactAudioMatch[] = []
): ContactAudioMatch[] {
    let count = 0;
    const write = (profile: ContactAudioProfile, matchedCollider: BodyRecord, matchedColliderIndex: number, matchedCollidee: BodyRecord, matchedCollideeIndex: number): void => {
        const match = matches[count];
        if (match) {
            match.profile = profile;
            match.collider = matchedCollider;
            match.colliderIndex = matchedColliderIndex;
            match.collidee = matchedCollidee;
            match.collideeIndex = matchedCollideeIndex;
            match.preparedKey = undefined;
        } else {
            matches.push({
                profile,
                collider: matchedCollider,
                colliderIndex: matchedColliderIndex,
                collidee: matchedCollidee,
                collideeIndex: matchedCollideeIndex,
            });
        }
        count++;
    };
    for (const profile of CONTACT_AUDIO_PROFILES) {
        if (hasTags(collider.audioTags, profile.colliderTags) && hasTags(collidee.audioTags, profile.collideeTags)) {
            write(profile, collider, colliderIndex, collidee, collideeIndex);
        } else if (hasTags(collidee.audioTags, profile.colliderTags) && hasTags(collider.audioTags, profile.collideeTags)) {
            write(profile, collidee, collideeIndex, collider, colliderIndex);
        }
    }
    matches.length = count;
    return matches;
}

export function relativeCollisionMetrics(
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number },
    result: { speedSquared: number; verticalSpeed: number } = { speedSquared: 0, verticalSpeed: 0 }
): { speedSquared: number; verticalSpeed: number } {
    const x = a.x - b.x;
    const y = a.y - b.y;
    const z = a.z - b.z;
    result.speedSquared = x * x + y * y + z * z;
    result.verticalSpeed = Math.max(Math.abs(a.y), Math.abs(b.y));
    return result;
}

async function decode(context: BaseAudioContext, url: string): Promise<AudioBuffer> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`${response.status} ${url}`);
    }
    return context.decodeAudioData(await response.arrayBuffer());
}

function createPlayroomAudioState(): AudioState {
    return {
        disposed: false,
        engine: null,
        context: null,
        master: null,
        route: null,
        buffers: new Map(),
        voices: new Set(),
        flight: null,
        flightGain: null,
        flightStartedAt: 0,
        projectileFlying: false,
        status: "loading",
        lastScoreMs: -Infinity,
        lastPopMs: -Infinity,
        contactLastPlayMs: new Map(),
        contactPairTimes: new Map(),
        contactPoolIndices: new Map(),
    };
}

function releasePlayroomAudioResources(state: AudioState, api: PlayroomAudioApi): void {
    stopFlightAudio(state);
    for (const voice of state.voices) {
        try {
            voice.stop();
        } catch {
            // Already stopped.
        }
        voice.disconnect();
    }
    state.voices.clear();
    if (state.route) {
        api.disposeSoundSource(state.route);
    } else {
        state.master?.disconnect();
    }
    if (state.engine) {
        api.disposeAudioEngine(state.engine);
    }
    state.route = null;
    state.master = null;
    state.context = null;
    state.engine = null;
    state.buffers.clear();
}

async function loadPlayroomAudio(state: AudioState, urlFor: (file: string) => string, api: PlayroomAudioApi): Promise<void> {
    try {
        const engine = await api.createAudioEngineAsync();
        if (state.disposed) {
            api.disposeAudioEngine(engine);
            return;
        }
        const context = engine.audioContext;
        const master = context.createGain();
        master.gain.value = 6;
        state.engine = engine;
        state.context = context;
        state.master = master;
        const route = await api.createSoundSourceAsync(engine, master);
        if (state.disposed) {
            api.disposeSoundSource(route);
            return;
        }
        state.route = route;
        const buffers = await Promise.all(ACTIVE_SOUND_FILES.map(async (file) => [file, await decode(context, urlFor(file))] as const));
        if (state.disposed) {
            return;
        }
        for (const [file, buffer] of buffers) {
            state.buffers.set(file, buffer);
        }
        state.status = "ready";
    } catch {
        if (!state.disposed) {
            releasePlayroomAudioResources(state, api);
            audioApis?.delete(state);
            state.status = "unavailable";
        }
    }
}

export interface PlayroomAudioLoad {
    readonly state: AudioState;
    readonly ready: Promise<void>;
}

export function startPlayroomAudioLoad(urlFor: (file: string) => string, api: PlayroomAudioApi = defaultAudioApi()): PlayroomAudioLoad {
    const state = createPlayroomAudioState();
    (audioApis ??= new WeakMap()).set(state, api);
    return { state, ready: loadPlayroomAudio(state, urlFor, api) };
}

export async function createPlayroomAudio(urlFor: (file: string) => string): Promise<AudioState> {
    const load = startPlayroomAudioLoad(urlFor);
    await load.ready;
    return load.state;
}

export function unlockPlayroomAudio(state: AudioState): void {
    if (state.engine) {
        void (audioApis?.get(state)?.unlockAudioEngineAsync ?? unlockAudioEngineAsync)(state.engine);
    }
}

function playBuffer(state: AudioState, file: string, gainValue: number, playbackRate: number): void {
    if (!state.context || !state.master || state.status !== "ready") {
        return;
    }
    const buffer = state.buffers.get(file);
    if (!buffer) {
        return;
    }
    const source = state.context.createBufferSource();
    const gain = state.context.createGain();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    gain.gain.value = gainValue;
    source.connect(gain).connect(state.master);
    state.voices.add(source);
    source.onended = (): void => {
        state.voices.delete(source);
        source.disconnect();
        gain.disconnect();
    };
    source.start();
}

export function playPlayroomSound(state: AudioState, kind: Exclude<PlayroomSound, "flight">): void {
    const now = performance.now();
    if ((kind === "score" && now - state.lastScoreMs < 100) || (kind === "popper" && now - state.lastPopMs < 200)) {
        return;
    }
    if (kind === "score") {
        state.lastScoreMs = now;
    }
    if (kind === "popper") {
        state.lastPopMs = now;
    }
    const gain = kind === "launch" ? 0.35 : kind === "score" ? 0.05 : 0.08;
    playBuffer(state, SOUND_POOLS[kind][0]!, gain, 1);
}

function pairKey(match: ContactAudioMatch): string {
    const a = `${match.collider.id}:${match.colliderIndex}`;
    const b = `${match.collidee.id}:${match.collideeIndex}`;
    return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function isContactAudioEligible(state: AudioState, match: ContactAudioMatch, collisionKey: string, now: number): boolean {
    const profile = match.profile;
    return !(
        state.status !== "ready" ||
        state.voices.size >= 8 ||
        (profile.projectileOnly && !state.projectileFlying) ||
        now - (state.contactLastPlayMs.get(profile.name) ?? 0) < (profile.minTimeBetweenPlaysMs ?? 0) ||
        (profile.collisionDeduplicationMs && now - (state.contactPairTimes.get(collisionKey) ?? -Infinity) < profile.collisionDeduplicationMs)
    );
}

export function prepareContactAudio(state: AudioState, match: ContactAudioMatch, now: number): string | null {
    const collisionKey = `${match.profile.name}:${pairKey(match)}`;
    return isContactAudioEligible(state, match, collisionKey, now) ? collisionKey : null;
}

export function playContactAudio(state: AudioState, match: ContactAudioMatch, speedSquared: number, verticalSpeed: number, now: number, preparedKey?: string): boolean {
    const profile = match.profile;
    const collisionKey = preparedKey ?? `${profile.name}:${pairKey(match)}`;
    if (!isContactAudioEligible(state, match, collisionKey, now)) {
        return false;
    }
    if (profile.collisionDeduplicationMs) {
        state.contactPairTimes.set(collisionKey, now);
    }
    if (speedSquared < profile.velocityThreshold || (profile.velocityThresholdForGround !== undefined && verticalSpeed < profile.velocityThresholdForGround)) {
        return false;
    }
    const poolIndex = state.contactPoolIndices.get(profile.name) ?? 0;
    const file = profile.files[poolIndex % profile.files.length]!;
    state.contactPoolIndices.set(profile.name, poolIndex + 1);
    const volume = Math.max(profile.volumeMin ?? 0.001, Math.sqrt(speedSquared - profile.velocityThreshold) / 100);
    const randomizedVolume = volume * profile.volume * (profile.volumeRandomizationRange ? 1 + Math.random() * profile.volumeRandomizationRange : 1);
    const playbackRate = profile.playbackRate + Math.random() * (profile.playbackRateRandomizationRange ?? 0);
    playBuffer(state, file, randomizedVolume, playbackRate);
    state.contactLastPlayMs.set(profile.name, now);
    return true;
}

export function startFlightAudio(state: AudioState): void {
    state.projectileFlying = true;
    state.flightStartedAt = performance.now();
    if (!state.context || !state.master || state.flight || state.status !== "ready") {
        return;
    }
    const buffer = state.buffers.get("projectile-flight.mp3");
    if (!buffer) {
        return;
    }
    const source = state.context.createBufferSource();
    const gain = state.context.createGain();
    source.buffer = buffer;
    source.loop = true;
    gain.gain.value = 0.005;
    source.connect(gain).connect(state.master);
    source.start();
    state.flight = source;
    state.flightGain = gain;
}

export function updateFlightAudio(state: AudioState, height: number, now = performance.now()): void {
    if (state.flight) {
        const fade = Math.max(0, 1 - (now - state.flightStartedAt) / 5000);
        state.flight.playbackRate.value = Math.max(0.0001, 1.5 * Math.max(0, height) * fade);
        if (state.flightGain) {
            state.flightGain.gain.value = 0.005 * fade;
        }
    }
}

export function stopFlightAudio(state: AudioState): void {
    state.projectileFlying = false;
    if (state.flight) {
        try {
            state.flight.stop();
        } catch {
            // Already stopped.
        }
        state.flight.disconnect();
        state.flight = null;
    }
    state.flightGain?.disconnect();
    state.flightGain = null;
}

export function resetPlayroomAudio(state: AudioState): void {
    stopFlightAudio(state);
    state.lastScoreMs = -Infinity;
    state.lastPopMs = -Infinity;
    state.contactLastPlayMs.clear();
    state.contactPairTimes.clear();
    state.contactPoolIndices.clear();
}

export function disposePlayroomAudio(state: AudioState): void {
    if (state.disposed) {
        return;
    }
    state.disposed = true;
    state.status = "unavailable";
    resetPlayroomAudio(state);
    const api = audioApis?.get(state) ?? defaultAudioApi();
    releasePlayroomAudioResources(state, api);
    audioApis?.delete(state);
}
