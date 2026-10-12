import { getPhysicsBodyLinearVelocity, onBeforeRender } from "babylon-lite";
import type { AudioState, PlayroomAssets, PlayroomState, WorldState } from "./types.js";
import { aimDirection, setFreeCamera, updateFollowCamera } from "./camera.js";
import { disposePlayroomAudio, playPlayroomSound, resetPlayroomAudio, startFlightAudio, stopFlightAudio, unlockPlayroomAudio, updateFlightAudio } from "./audio.js";
import { createBunnyRagdoll, disposeBunny, installBunnyPoseSync, launchBunny, relocateBunny } from "./ragdoll.js";
import { installPhysicsEvents } from "./physics.js";
import type { PlayroomEffects } from "./effects.js";
import { resetPlayroomEffects, showConfetti, showScoreStar, updateAimingEffect, updatePlayroomEffects } from "./effects.js";
import { installPlayroomUi, updatePlayroomUi } from "./ui.js";
import { installFreeModeInput } from "./input.js";
import { disposePlayroomWorld, resetPlayroomWorld } from "./world.js";
import type { ArcRotateCamera, EngineContext, FreeCamera, PhysicsWorld, SceneContext, ShadowGenerator } from "babylon-lite";

function nextBunny(state: PlayroomState): void {
    relocateBunny(state.physics, state.ragdoll, { x: 0, y: 1, z: 0 });
    state.settlingFrames = 0;
    state.camera.radius = 1;
    state.camera.target.x = 0;
    state.camera.target.y = 0.3;
    state.camera.target.z = 0;
}

function beginAiming(state: PlayroomState): void {
    state.phase = "aiming";
    state.underlyingPhase = "aiming";
    state.scorePaused = true;
    state.poppersArmed = false;
    state.setCameraMode("orbit");
    updatePlayroomUi(state);
}

function kick(state: PlayroomState): void {
    if (state.phase !== "aiming" || state.ragdoll.launched) return;
    unlockPlayroomAudio(state.audio);
    launchBunny(state.physics, state.ragdoll, aimDirection(state.camera));
    playPlayroomSound(state.audio, "launch");
    startFlightAudio(state.audio);
    state.phase = "watching";
    state.underlyingPhase = "watching";
    state.scorePaused = false;
    state.poppersArmed = true;
    state.settlingFrames = 0;
    updatePlayroomUi(state);
}

function nextThrow(state: PlayroomState): void {
    if (!canAdvanceThrow(state)) {
        return;
    }
    state.throwCount++;
    stopFlightAudio(state.audio);
    nextBunny(state);
    beginAiming(state);
}

export function canAdvanceThrow(state: Pick<PlayroomState, "phase" | "settlingFrames" | "throwCount">): boolean {
    return state.phase === "watching" && state.settlingFrames >= 2 && state.throwCount < 3;
}

export function resetGameplayCounters(state: Pick<PlayroomState, "throwCount" | "score" | "scorePaused" | "scorePausedBeforeFree" | "poppersArmed" | "settlingFrames">): void {
    state.throwCount = 1;
    state.score = 0;
    state.scorePaused = true;
    state.scorePausedBeforeFree = true;
    state.poppersArmed = false;
    state.settlingFrames = 0;
}

function toggleFree(state: PlayroomState): void {
    if (state.phase === "loading" || state.phase === "ready") return;
    if (state.phase === "free") {
        state.cancelCharge();
        state.phase = state.underlyingPhase;
        state.scorePaused = state.scorePausedBeforeFree;
        setFreeCamera(state, false);
    } else {
        state.underlyingPhase = state.phase;
        state.scorePausedBeforeFree = state.scorePaused;
        state.phase = "free";
        state.scorePaused = true;
        state.poppersArmed = true;
        setFreeCamera(state, true);
    }
    state.cancelCharge();
    updatePlayroomUi(state);
}

export interface CreatePlayroomGameOptions {
    canvas: HTMLCanvasElement;
    engine: EngineContext;
    scene: SceneContext;
    physics: PhysicsWorld;
    assets: PlayroomAssets;
    camera: ArcRotateCamera;
    freeCamera: FreeCamera;
    world: WorldState;
    audio: AudioState;
    effects: PlayroomEffects;
    shadow: ShadowGenerator;
    setCameraMode: (mode: "none" | "orbit" | "free") => void;
    disposeCameras: () => void;
}

export function resetPlayroomGame(state: PlayroomState, effects: PlayroomEffects): void {
    state.cancelCharge();
    resetPlayroomAudio(state.audio);
    resetPlayroomEffects(effects);
    delete state.canvas.dataset.lastExplosionCount;
    resetPlayroomWorld(state.physics, state.world);
    relocateBunny(state.physics, state.ragdoll, { x: 0, y: 1, z: 0 });
    for (const record of state.ragdoll.records) {
        record.scored.clear();
    }
    resetGameplayCounters(state);
    state.camera.alpha = -1.25;
    state.camera.beta = 1.2;
    state.camera.radius = 1;
    state.camera.target.x = 0;
    state.camera.target.y = 0.3;
    state.camera.target.z = 0;
    beginAiming(state);
}

export function createPlayroomGame(options: CreatePlayroomGameOptions): PlayroomState {
    const state: PlayroomState = {
        ...options,
        ragdoll: createBunnyRagdoll(options.scene, options.physics, options.assets, options.world, { x: 0, y: 0.9, z: 0 }),
        phase: "loading",
        underlyingPhase: "ready",
        throwCount: 1,
        score: 0,
        scorePaused: true,
        scorePausedBeforeFree: true,
        poppersArmed: false,
        charge: null,
        settlingFrames: 0,
        disposed: false,
        setCameraMode: options.setCameraMode,
        cancelCharge: (): void => {},
        cleanup: [],
        timers: new Set(),
        retiredWorlds: [],
    };
    installBunnyPoseSync(
        options.physics,
        options.assets,
        () => state.ragdoll,
        () => state.disposed
    );
    installPhysicsEvents(state);
    state.cleanup.push(
        installFreeModeInput(state, options.effects),
        installPlayroomUi({
            play: () => {
                if (state.phase !== "ready") return;
                unlockPlayroomAudio(state.audio);
                beginAiming(state);
            },
            kick: () => kick(state),
            next: () => nextThrow(state),
            replay: () => resetPlayroomGame(state, options.effects),
            free: () => toggleFree(state),
        })
    );
    const scoreListener = (event: Event): void => {
        const detail = (event as CustomEvent<{ point: { x: number; y: number; z: number } }>).detail;
        showScoreStar(options.effects, detail.point);
        playPlayroomSound(state.audio, "score");
        updatePlayroomUi(state);
    };
    const popListener = (event: Event): void => {
        const detail = (event as CustomEvent<{ point: { x: number; y: number; z: number } }>).detail;
        showConfetti(options.effects, detail.point);
        playPlayroomSound(state.audio, "popper");
    };
    document.addEventListener("playroom-score", scoreListener);
    document.addEventListener("playroom-popper", popListener);
    state.cleanup.push(
        () => document.removeEventListener("playroom-score", scoreListener),
        () => document.removeEventListener("playroom-popper", popListener),
        options.disposeCameras
    );
    onBeforeRender(options.scene, (deltaMs) => {
        if (state.disposed) {
            return;
        }
        updateAimingEffect(options.effects, state.ragdoll.root.mesh.position, state.camera, state.phase === "aiming");
        updatePlayroomEffects(options.effects, deltaMs);
        updateFollowCamera(state);
        if (state.phase === "watching") {
            const velocity = getPhysicsBodyLinearVelocity(state.physics, state.ragdoll.root.body);
            const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
            updateFlightAudio(state.audio, state.ragdoll.root.mesh.position.y);
            if (
                state.ragdoll.root.mesh.position.x > 16 ||
                state.ragdoll.root.mesh.position.x < -16 ||
                state.ragdoll.root.mesh.position.z > 16 ||
                state.ragdoll.root.mesh.position.z < -16
            ) {
                state.settlingFrames = 2;
            } else if (speed < 0.1) {
                state.settlingFrames++;
            }
            if (state.settlingFrames >= 2) {
                stopFlightAudio(state.audio);
                if (state.throwCount === 3) {
                    state.phase = "ended";
                    state.underlyingPhase = "ended";
                    state.scorePaused = true;
                }
                updatePlayroomUi(state);
            }
        }
    });
    updatePlayroomUi(state);
    return state;
}

export function disposePlayroomGame(state: PlayroomState, effects: PlayroomEffects): void {
    if (state.disposed) {
        return;
    }
    state.disposed = true;
    state.cancelCharge();
    for (const cleanup of state.cleanup.splice(0)) {
        cleanup();
    }
    resetPlayroomEffects(effects);
    disposePlayroomAudio(state.audio);
    disposeBunny(state.scene, state.physics, state.world, state.ragdoll);
    disposePlayroomWorld(state.scene, state.physics, state.world);
}
