import { attachFreeControl, createFreeCamera, type FreeCamera, type SceneContext } from "babylon-lite";

const DEG_TO_RAD = Math.PI / 180;
const STARTUP_EYE = { x: -33.03, y: 0.24, z: -65.76 };
const STARTUP_YAW = 27.7 * DEG_TO_RAD;
const STARTUP_PITCH = 6.62 * DEG_TO_RAD;

type AttachFirstPersonControl = typeof attachFreeControl;

export function createTrogirCamera(): FreeCamera {
    const cosPitch = Math.cos(STARTUP_PITCH);
    const camera = createFreeCamera(STARTUP_EYE, {
        x: STARTUP_EYE.x + Math.sin(STARTUP_YAW) * cosPitch,
        y: STARTUP_EYE.y + Math.sin(STARTUP_PITCH),
        z: STARTUP_EYE.z + Math.cos(STARTUP_YAW) * cosPitch,
    });
    camera.nearPlane = 0.1;
    camera.farPlane = 1500;
    return camera;
}

export function attachTrogirCameraControls(
    camera: FreeCamera,
    canvas: HTMLCanvasElement,
    scene: SceneContext,
    attach: AttachFirstPersonControl = attachFreeControl
): () => void {
    const detach = attach(camera, canvas, scene);
    let attached = true;
    return () => {
        if (!attached) {
            return;
        }
        attached = false;
        detach();
    };
}
