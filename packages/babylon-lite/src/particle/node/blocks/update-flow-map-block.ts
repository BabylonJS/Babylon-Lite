import { getEffectiveAspectRatio, getViewProjectionMatrix } from "../../../camera/camera.js";
import { allocateMat4 } from "../../../math/_matrix-allocator.js";
import { transformCoordinatesToRef } from "../../../math/mat4-transform.js";
import type { Mat4, Mat4Storage, Vec3 } from "../../../math/types.js";
import type { ParticleBuffer } from "../../particle-buffer.js";
import type { NpeBlockEvaluator } from "../npe-build.js";
import { loadNpeTextureContent } from "../npe-texture-content.js";
import type { NpeTextureContent } from "../npe-value.js";

/** Apply one screen-space flow-map sample to a particle direction. */
function applyFlowMapToParticle(map: NpeTextureContent, matrix: Mat4, scaledStrength: number, buffer: ParticleBuffer, i: number, screen: Vec3): void {
    transformCoordinatesToRef(buffer.posX[i]!, buffer.posY[i]!, buffer.posZ[i]!, matrix, screen);
    const x = Math.floor((screen.x * 0.5 + 0.5) * map.width);
    const y = Math.floor((1 - (screen.y * 0.5 + 0.5)) * map.height);
    if (x < 0 || x >= map.width || y < 0 || y >= map.height) {
        return;
    }

    const index = (y * map.width + x) * 4;
    const scale = scaledStrength * (map.data[index + 3]! / 255);
    buffer.dirX[i] = buffer.dirX[i]! + ((map.data[index]! / 255) * 2 - 1) * scale;
    buffer.dirY[i] = buffer.dirY[i]! + ((map.data[index + 1]! / 255) * 2 - 1) * scale;
    buffer.dirZ[i] = buffer.dirZ[i]! + ((map.data[index + 2]! / 255) * 2 - 1) * scale;
}

/** `UpdateFlowMapBlock` — update particle direction from a projected RGBA flow field. */
export const npeBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const system = ctx.state.system!;
        const buffer = ctx.state.buffer!;
        const scene = ctx.state.scene;
        const sourceValue = ctx.texture(block, "flowMap");
        const strengthGetter = ctx.input(block, "strength", () => 1);
        const screen: Vec3 = { x: 0, y: 0, z: 0 };
        const matrix = allocateMat4();
        const matrixStorage = matrix as unknown as Mat4Storage;
        let flowMap: NpeTextureContent | null = null;
        let matrixReady = false;

        const prepareMatrix = (): void => {
            const camera = scene.camera;
            if (!camera) {
                matrixReady = false;
                return;
            }
            const canvas = scene.surface.canvas;
            const targetWidth = Number.isFinite(canvas.width) && canvas.width > 0 ? Math.max(1, canvas.width) : 1;
            const targetHeight = Number.isFinite(canvas.height) && canvas.height > 0 ? Math.max(1, canvas.height) : 1;
            matrixStorage.set(getViewProjectionMatrix(camera, getEffectiveAspectRatio(camera, targetWidth, targetHeight)) as unknown as Mat4Storage);
            matrixReady = true;
        };

        // The system owns the per-frame projection, and only once the map decodes: a failed decode, or a build that is
        // discarded or rejected, leaves no frame work behind.
        if (sourceValue?.url) {
            ctx.addBuildPromise(
                loadNpeTextureContent(sourceValue)
                    .then((content) => {
                        if (!content) {
                            return;
                        }
                        flowMap = content;
                        const previous = system._prepareFrame;
                        system._prepareFrame = previous
                            ? () => {
                                  previous();
                                  prepareMatrix();
                              }
                            : prepareMatrix;
                    })
                    .catch(() => undefined)
            );
        }
        system.updateSteps.push((i) => {
            if (!flowMap || !matrixReady) {
                return;
            }
            applyFlowMapToParticle(flowMap, matrix, (strengthGetter(i) as number) * system._scaledStep, buffer, i, screen);
        });
    },
};
