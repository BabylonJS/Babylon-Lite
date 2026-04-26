/** Pass-owned scene UBO writer.
 *
 *  Each RenderPassTask owns a single GPUBuffer (unified SceneUniforms layout)
 *  allocated up-front in createRenderPassTask. This module writes that buffer
 *  once per frame from the pass's resolved camera + scene-wide state (lights,
 *  env, fog, image-processing).
 *
 *  No dirty-cache: the UBO is small and a single writeBuffer call per pass
 *  per frame is cheap. Skipping the cache also keeps the bundle smaller. */
import type { RenderPassTask } from "../frame-graph/render-pass-task.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { SceneContext, SceneContextInternal } from "./scene.js";
import type { Camera } from "../camera/camera.js";
import { SCENE_UBO_BYTES } from "../shader/scene-uniforms-fields.js";
import { getViewProjectionMatrix, getViewMatrix, getCameraPosition } from "../camera/camera.js";
import { _getLightExtension } from "../light/extension-registry.js";

/** Free the pass's scene UBO. */
export function destroyTaskSceneState(task: RenderPassTask): void {
    task._sceneUBO.destroy();
    _scratch.delete(task);
}

const _scratch = new WeakMap<RenderPassTask, Float32Array>();

/** Write the unified scene UBO once per frame for `task` from `camera` + scene state.
 *  Hard-coded float-indices match shaders/scene-uniforms.wgsl. */
export function writePassSceneUBO(task: RenderPassTask, engine: EngineContextInternal, scene: SceneContext, camera: Camera | null): void {
    if (!camera) {
        return;
    }
    const rt = task.renderTarget;
    // BJS quirk: the camera projection matrix uses the engine canvas aspect ratio,
    // not the render target's aspect, even when rendering into an offscreen RTT
    // with its own activeCamera. Match this so the same scene authored against
    // BJS produces the same image — even when intentionally non-square RTTs are used.
    const canvas = engine.canvas;
    const aspect = canvas.height > 0 ? canvas.width / canvas.height : rt._height > 0 ? rt._width / rt._height : 1;

    const len = SCENE_UBO_BYTES / 4;
    let data = _scratch.get(task);
    if (!data) {
        data = new Float32Array(len);
        _scratch.set(task, data);
    } else {
        data.fill(0);
    }

    const viewProj = getViewProjectionMatrix(camera, aspect);
    const view = getViewMatrix(camera);
    const camPos = getCameraPosition(camera);

    data.set(viewProj, 0); // viewProjection @ 0
    // BJS quirk: when rendering into an offscreen RTT, the projection matrix's Y
    // is flipped so the resulting texture, when sampled with normal V (top-left
    // origin), appears right-side-up to consumers. Without this, the RTT shows
    // upside-down when used as e.g. diffuseTexture on a mesh.
    if (!rt.descriptor.resolveToSwapchain) {
        // Negate row 1 of the column-major matrix (indices 1, 5, 9, 13).
        data[1] = -data[1]!;
        data[5] = -data[5]!;
        data[9] = -data[9]!;
        data[13] = -data[13]!;
    }
    data.set(view, 16); // view @ 64
    // vEyePosition @ 128
    data[32] = camPos.x;
    data[33] = camPos.y;
    data[34] = camPos.z;
    data[35] = 1;

    // Lights — only render pipelines that need light data register the light extension.
    // Standard-only scenes leave the light slots zero (their shaders read from group 1's lights UBO).
    const lightExt = _getLightExtension();
    if (lightExt && scene.lights.length > 0) {
        lightExt.writeSceneUbo(data, scene.lights[0]!);
    }

    // Env / image processing
    const envTextures = (scene as SceneContextInternal)._envTextures ?? null;
    data[52] = scene.envRotationY ?? 0; // envRotationY @ 208
    if (envTextures?.sphericalHarmonics) {
        const sh = envTextures.sphericalHarmonics;
        // vSphericalL00 @ 224 → float index 56; 9 vec4 slots
        data.set(sh.l00, 56);
        data.set(sh.l1_1, 60);
        data.set(sh.l10, 64);
        data.set(sh.l11, 68);
        data.set(sh.l2_2, 72);
        data.set(sh.l2_1, 76);
        data.set(sh.l20, 80);
        data.set(sh.l21, 84);
        data.set(sh.l22, 88);
    }
    // exposureLinear @ 368, contrast @ 372, lodGenerationScale @ 376
    data[92] = scene.imageProcessing.exposure;
    data[93] = scene.imageProcessing.contrast;
    data[94] = envTextures?.lodGenerationScale ?? 0.8;

    const fog = scene.fog;
    if (fog) {
        // vFogInfos @ 384 → 96; vFogColor @ 400 → 100
        data[96] = fog.mode;
        data[97] = fog.start;
        data[98] = fog.end;
        data[99] = fog.density;
        data[100] = fog.color[0]!;
        data[101] = fog.color[1]!;
        data[102] = fog.color[2]!;
    }

    engine.device.queue.writeBuffer(task._sceneUBO, 0, data.buffer, data.byteOffset, data.byteLength);
}
