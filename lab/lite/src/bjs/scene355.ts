import { Camera } from "@babylonjs/core/Cameras/camera";
import { runSsaoReferenceScene } from "../shared/ssao-reference-scene.js";

runSsaoReferenceScene((camera) => {
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    const updateBounds = (): void => {
        const halfWidth = 0.6 * camera.getScene().getEngine().getAspectRatio(camera);
        camera.orthoLeft = -halfWidth;
        camera.orthoRight = halfWidth;
        camera.orthoBottom = -0.6;
        camera.orthoTop = 0.6;
    };
    updateBounds();
    camera.getScene().getEngine().onResizeObservable.add(updateBounds);
});
