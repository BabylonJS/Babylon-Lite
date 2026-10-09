import type { FreeCamera, SceneContext, SplatVoxelCollision } from "babylon-lite";
import { moveSplatVoxelCamera } from "babylon-lite";

/** Install after camera controls so every proposed displacement is swept before rendering. */
export function attachTrogirCollision(camera: FreeCamera, scene: SceneContext, collision: SplatVoxelCollision): () => void {
    let previous: [number, number, number] = [camera.position.x, camera.position.y, -camera.position.z];
    const correct = (): void => {
        if (camera.position.x === previous[0] && camera.position.y === previous[1] && -camera.position.z === previous[2]) {
            return;
        }
        const requested: [number, number, number] = [camera.position.x, camera.position.y, -camera.position.z];
        const position = moveSplatVoxelCamera(collision, previous, requested);
        camera.target.set(camera.target.x + position[0] - camera.position.x, camera.target.y + position[1] - camera.position.y, camera.target.z - position[2] - camera.position.z);
        camera.position.set(position[0], position[1], -position[2]);
        previous = position;
    };
    scene._beforeRender.push(correct);
    return () => {
        const index = scene._beforeRender.indexOf(correct);
        if (index >= 0) {
            scene._beforeRender.splice(index, 1);
        }
    };
}
