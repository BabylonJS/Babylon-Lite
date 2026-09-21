import { attachControl, attachFreeControl, createArcRotateCamera, createFreeCamera, getCameraPosition, setCameraLimits } from "babylon-lite";
import type { ArcRotateCamera, FreeCamera, SceneContext, Vec3 } from "babylon-lite";
import { CAMERA, GAME_SCALE } from "./constants.js";
import type { PlayroomState } from "./types.js";

export interface PlayroomCameras {
    readonly orbit: ArcRotateCamera;
    readonly free: FreeCamera;
    readonly setMode: (mode: "none" | "orbit" | "free") => void;
    readonly dispose: () => void;
}

type AttachOrbit = typeof attachControl;
type AttachFree = typeof attachFreeControl;

export function createCameraControlSwitcher(
    scene: SceneContext,
    canvas: HTMLCanvasElement,
    orbit: ArcRotateCamera,
    free: FreeCamera,
    attachOrbit: AttachOrbit = attachControl,
    attachFree: AttachFree = attachFreeControl
): Pick<PlayroomCameras, "setMode" | "dispose"> {
    let disposeOrbit: (() => void) | null = null;
    let disposeFree: (() => void) | null = null;
    const setMode = (mode: "none" | "orbit" | "free"): void => {
        disposeOrbit?.();
        disposeFree?.();
        disposeOrbit = null;
        disposeFree = null;
        if (mode === "free") {
            scene.camera = free;
            disposeFree = attachFree(free, canvas, scene);
        } else {
            scene.camera = orbit;
            if (mode === "orbit") {
                disposeOrbit = attachOrbit(orbit, canvas, scene);
            }
        }
    };
    return { setMode, dispose: () => setMode("none") };
}

export function createPlayroomCameras(scene: SceneContext, canvas: HTMLCanvasElement): PlayroomCameras {
    const orbit = createArcRotateCamera(CAMERA.alpha, CAMERA.beta, CAMERA.aimingRadius, { x: 0, y: 1.5 * GAME_SCALE, z: 0 });
    orbit.fov = CAMERA.fov;
    orbit.nearPlane = CAMERA.near;
    orbit.farPlane = CAMERA.far;
    orbit.wheelPrecision = Infinity;
    setCameraLimits(orbit, { lowerBetaLimit: CAMERA.minBeta, upperBetaLimit: CAMERA.maxBeta });
    scene.camera = orbit;
    const position = getCameraPosition(orbit);
    const free = createFreeCamera({ x: position.x, y: position.y, z: position.z }, orbit.target);
    free.nearPlane = CAMERA.near;
    free.farPlane = CAMERA.far;
    free.speed = GAME_SCALE;
    return { orbit, free, ...createCameraControlSwitcher(scene, canvas, orbit, free) };
}

export function aimDirection(camera: ArcRotateCamera): Vec3 {
    const pitch = camera.beta - Math.PI * 0.25;
    const horizontal = Math.cos(pitch);
    return {
        x: -Math.cos(camera.alpha) * horizontal,
        y: Math.sin(pitch),
        z: -Math.sin(camera.alpha) * horizontal,
    };
}

export function setFreeCamera(state: Pick<PlayroomState, "camera" | "freeCamera" | "setCameraMode">, enabled: boolean): void {
    if (enabled) {
        const position = getCameraPosition(state.camera);
        state.freeCamera.position.set(position.x, position.y, position.z);
        state.freeCamera.target.x = state.camera.target.x;
        state.freeCamera.target.y = state.camera.target.y;
        state.freeCamera.target.z = state.camera.target.z;
        state.setCameraMode("free");
    } else {
        state.setCameraMode("orbit");
    }
}

export function updateFollowCamera(state: PlayroomState): void {
    const root = state.ragdoll.root.mesh.position;
    if (state.phase === "aiming") {
        const offset = 2 * GAME_SCALE;
        state.camera.target.x = root.x + Math.sin(state.camera.alpha) * offset;
        state.camera.target.y = root.y + 1.5 * GAME_SCALE;
        state.camera.target.z = root.z - Math.cos(state.camera.alpha) * offset;
    } else if (state.phase === "watching") {
        state.camera.target.x += (root.x - state.camera.target.x) * 0.1;
        state.camera.target.y += (root.y - state.camera.target.y) * 0.1;
        state.camera.target.z += (root.z - state.camera.target.z) * 0.1;
        state.camera.radius += (CAMERA.watchingRadius - state.camera.radius) * 0.01;
        state.camera.beta = Math.max(CAMERA.minBeta, state.camera.beta - 0.005);
    }
}
