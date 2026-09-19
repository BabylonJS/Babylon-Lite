import { attachControl, attachFreeControl, createArcRotateCamera, createFreeCamera, setCameraLimits, type ArcRotateCamera, type FreeCamera, type SceneContext } from "babylon-lite";

export type TrogirCameraMode = "orbit" | "firstPerson";

interface ProjectionSettings {
    readonly fov: number;
    readonly nearPlane: number;
    readonly farPlane: number;
}

const DEG_TO_RAD = Math.PI / 180;
const STARTUP_EYE = { x: -33.03, y: 0.24, z: -65.76 };
const STARTUP_YAW = 27.7 * DEG_TO_RAD;
const STARTUP_PITCH = 6.62 * DEG_TO_RAD;

export interface TrogirCameraModeBindings {
    readonly attachOrbit: (camera: ArcRotateCamera, canvas: HTMLCanvasElement, scene: SceneContext) => () => void;
    readonly attachFirstPerson: (camera: FreeCamera, canvas: HTMLCanvasElement, scene: SceneContext) => () => void;
}

function copyProjection(source: ProjectionSettings, target: ArcRotateCamera | FreeCamera): void {
    target.fov = source.fov;
    target.nearPlane = source.nearPlane;
    target.farPlane = source.farPlane;
}

function worldPose(camera: ArcRotateCamera | FreeCamera): { eye: { x: number; y: number; z: number }; forward: { x: number; y: number; z: number } } {
    const world = camera.worldMatrix;
    return {
        eye: { x: world[12]!, y: world[13]!, z: world[14]! },
        forward: { x: world[8]!, y: world[9]!, z: world[10]! },
    };
}

export function createTrogirFirstPersonCamera(camera: ArcRotateCamera): FreeCamera {
    const pose = worldPose(camera);
    const next = createFreeCamera(pose.eye, {
        x: pose.eye.x + pose.forward.x,
        y: pose.eye.y + pose.forward.y,
        z: pose.eye.z + pose.forward.z,
    });
    copyProjection(camera, next);
    return next;
}

export function createTrogirOrbitCamera(camera: FreeCamera, radius: number): ArcRotateCamera {
    const pose = worldPose(camera);
    const target = {
        x: pose.eye.x + pose.forward.x * radius,
        y: pose.eye.y + pose.forward.y * radius,
        z: pose.eye.z + pose.forward.z * radius,
    };
    const offsetX = pose.eye.x - target.x;
    const offsetY = pose.eye.y - target.y;
    const offsetZ = pose.eye.z - target.z;
    const next = createArcRotateCamera(Math.atan2(offsetZ, offsetX), Math.atan2(Math.hypot(offsetX, offsetZ), offsetY), radius, target);
    const generatedEye = next.worldMatrix;
    next.target.x = target.x + pose.eye.x - generatedEye[12]!;
    next.target.y = target.y + pose.eye.y - generatedEye[13]!;
    next.target.z = target.z + pose.eye.z - generatedEye[14]!;
    copyProjection(camera, next);
    return next;
}

export function createTrogirStartupOrbitCamera(radius: number): ArcRotateCamera {
    const cosPitch = Math.cos(STARTUP_PITCH);
    const forward = {
        x: Math.sin(STARTUP_YAW) * cosPitch,
        y: Math.sin(STARTUP_PITCH),
        z: Math.cos(STARTUP_YAW) * cosPitch,
    };
    const camera = createFreeCamera(STARTUP_EYE, {
        x: STARTUP_EYE.x + forward.x,
        y: STARTUP_EYE.y + forward.y,
        z: STARTUP_EYE.z + forward.z,
    });
    return createTrogirOrbitCamera(camera, radius);
}

function configureOrbit(camera: ArcRotateCamera, scene: SceneContext): void {
    setCameraLimits(
        camera,
        {
            lowerRadiusLimit: 3,
            upperRadiusLimit: 700,
            lowerBetaLimit: Math.min(0.08, camera.beta),
            upperBetaLimit: Math.max(Math.PI - 0.08, camera.beta),
        },
        scene
    );
}

export function attachTrogirCameraMode(
    scene: SceneContext,
    canvas: HTMLCanvasElement,
    button: HTMLButtonElement,
    hint: HTMLElement,
    initialCamera: ArcRotateCamera,
    bindings?: TrogirCameraModeBindings
): () => void {
    let mode: TrogirCameraMode = "orbit";
    let camera: ArcRotateCamera | FreeCamera = initialCamera;
    let orbitRadius = initialCamera.radius;
    let detach = (bindings?.attachOrbit ?? attachControl)(initialCamera, canvas, scene);
    let disposed = false;

    configureOrbit(initialCamera, scene);

    const updateUi = (): void => {
        const firstPerson = mode === "firstPerson";
        button.textContent = firstPerson ? "Camera: First person" : "Camera: Orbit";
        button.setAttribute("aria-pressed", String(firstPerson));
        button.setAttribute("aria-label", firstPerson ? "Switch to orbit camera" : "Switch to first-person camera");
        button.dataset.cameraMode = mode;
        canvas.dataset.cameraMode = mode;
        hint.textContent = firstPerson ? "Drag to look · WASD or arrows to move · Space / Shift to rise or lower" : "Drag to orbit · wheel or pinch to zoom";
    };

    const toggle = (): void => {
        if (disposed) {
            return;
        }
        detach();
        if (mode === "orbit") {
            const current = camera as ArcRotateCamera;
            orbitRadius = current.radius;
            camera = createTrogirFirstPersonCamera(current);
            mode = "firstPerson";
            detach = (bindings?.attachFirstPerson ?? attachFreeControl)(camera, canvas, scene);
        } else {
            camera = createTrogirOrbitCamera(camera as FreeCamera, orbitRadius);
            configureOrbit(camera, scene);
            mode = "orbit";
            detach = (bindings?.attachOrbit ?? attachControl)(camera, canvas, scene);
        }
        scene.camera = camera;
        updateUi();
    };

    button.addEventListener("click", toggle);
    updateUi();

    return () => {
        if (disposed) {
            return;
        }
        disposed = true;
        button.removeEventListener("click", toggle);
        detach();
    };
}
