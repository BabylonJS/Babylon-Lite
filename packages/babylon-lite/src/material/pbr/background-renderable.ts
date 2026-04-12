/** Background renderables — skybox + ground for PBR environment scenes.
 *
 *  Only built when an environment is loaded. Ground and HDR skybox are
 *  dynamically imported so scenes that don't use them pay zero cost.
 *  (skybox = order 0, ground = order 200 for transparency). */

import type { SceneContext } from "../../scene/scene.js";
import type { EngineInternal } from "../../engine/engine.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { Mat4 } from "../../math/types.js";
import type { Renderable } from "../../render/renderable.js";
import { createSkyboxMaterial, createSkyboxBuffers, buildSkyboxWorldMatrix } from "./background-material.js";

const SKY_MESH_UNIFORM_SIZE = 96; // mat4x4 + primaryColor vec3 + pad + skyOutputColor vec3 + pad

export interface BackgroundRenderableOptions {
    /** When true, skip the solid-color skybox (e.g. caller provides HDR skybox separately). */
    skipSkybox?: boolean;
    /** When true, skip ground plane rendering. */
    skipGround?: boolean;
    /** Skybox size matching BJS createDefaultEnvironment skyboxSize option. */
    skyboxSize?: number;
}

/** Build background renderables (skybox + ground) for a PBR environment scene. */
export async function buildBackgroundRenderables(
    scene: SceneContext,
    envTextures: EnvironmentTextures,
    sceneBindGroupLayout: GPUBindGroupLayout,
    sceneBindGroup: GPUBindGroup,
    groundTextureUrl?: string,
    options?: BackgroundRenderableOptions,
    groundImagePromise?: Promise<ImageBitmap>
): Promise<Renderable[]> {
    const engine = scene.engine as EngineInternal;
    const device = engine.device;
    const primaryColor = scene.environmentPrimaryColor ?? [0.08697355964132344, 0.08697355964132344, 0.2122208331110881];

    // Compute scene size (matches BJS EnvironmentHelper._getSceneSize)
    const { groundSize, rootPosition } = computeSceneSize(scene);

    const renderables: Renderable[] = [];

    // ─── Skybox ────────────────────────────────────────────────
    if (!options?.skipSkybox) {
        const { skyHalfSize } = computeSkyboxGeometry(scene, options?.skyboxSize);
        const skyboxWorld = buildSkyboxWorldMatrix(rootPosition);
        const cc = scene.clearColor;
        const skyBufs = createSkyboxBuffers(device, skyHalfSize);

        const skyMat = createSkyboxMaterial(sceneBindGroupLayout);
        const skyOutputColor: [number, number, number] = [cc.r, cc.g, cc.b];
        const skyUBO = createSkyMeshUBO(device, skyboxWorld, primaryColor, skyOutputColor);
        const skyPipeline = skyMat.getPipeline(device, engine.format, engine.msaaSamples);
        const skyBG = skyMat.createBindGroup(device, skyUBO, envTextures);

        renderables.push({
            order: 0, // skybox renders first (behind everything)
            isTransparent: false,
            draw(pass) {
                pass.setBindGroup(0, sceneBindGroup);
                pass.setPipeline(skyPipeline);
                pass.setBindGroup(1, skyBG);
                pass.setVertexBuffer(0, skyBufs.posBuffer);
                pass.setIndexBuffer(skyBufs.idxBuffer, "uint16");
                pass.drawIndexed(skyBufs.idxCount);
                return 1;
            },
        });
    }

    // ─── Ground ────────────────────────────────────────────────
    if (!options?.skipGround) {
        const { buildGroundRenderable } = await import("./background-ground.js");
        const groundRenderable = await buildGroundRenderable(
            device,
            sceneBindGroupLayout,
            engine.format,
            engine.msaaSamples,
            sceneBindGroup,
            groundSize,
            rootPosition,
            primaryColor,
            groundTextureUrl,
            groundImagePromise
        );
        renderables.push(groundRenderable);
    }

    return renderables;
}

function createSkyMeshUBO(device: GPUDevice, world: Mat4, primaryColor: [number, number, number], skyOutputColor: [number, number, number]): GPUBuffer {
    const data = new Float32Array(SKY_MESH_UNIFORM_SIZE / 4);
    data.set(world, 0);
    data[16] = primaryColor[0];
    data[17] = primaryColor[1];
    data[18] = primaryColor[2];
    data[20] = skyOutputColor[0];
    data[21] = skyOutputColor[1];
    data[22] = skyOutputColor[2];
    const buf = device.createBuffer({
        size: SKY_MESH_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, data);
    return buf;
}

/** Compute ground size and skybox size from scene bounds.
 *  Matches BJS EnvironmentHelper._setupSizes() with sizeAuto=true.
 *  @param userSkyboxSize  Optional user-provided skyboxSize (BJS still applies
 *                         diagonal override + ×1.5 even for explicit values). */
export function computeSceneSize(
    scene: SceneContext,
    userSkyboxSize?: number
): {
    groundSize: number;
    skyboxSize: number;
    rootPosition: [number, number, number];
} {
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
    for (const m of scene.meshes) {
        if (!m.boundMin || !m.boundMax) {
            continue;
        }
        // Offset local bounds by mesh world-space translation.
        // glTF: worldMatrix = identity, so translation = (0,0,0), bounds untouched.
        // Procedural: worldMatrix translation = accumulated position (incl. parent chain).
        // Matches BJS getWorldExtends() for non-rotated/non-scaled meshes.
        const w = m.worldMatrix;
        const tx = w[12]!,
            ty = w[13]!,
            tz = w[14]!;
        const wMinX = m.boundMin[0]! + tx;
        const wMinY = m.boundMin[1]! + ty;
        const wMinZ = m.boundMin[2]! + tz;
        const wMaxX = m.boundMax[0]! + tx;
        const wMaxY = m.boundMax[1]! + ty;
        const wMaxZ = m.boundMax[2]! + tz;
        if (wMinX < minX) {
            minX = wMinX;
        }
        if (wMinY < minY) {
            minY = wMinY;
        }
        if (wMinZ < minZ) {
            minZ = wMinZ;
        }
        if (wMaxX > maxX) {
            maxX = wMaxX;
        }
        if (wMaxY > maxY) {
            maxY = wMaxY;
        }
        if (wMaxZ > maxZ) {
            maxZ = wMaxZ;
        }
    }

    if (!isFinite(minX)) {
        return { groundSize: 15, skyboxSize: userSkyboxSize ?? 20, rootPosition: [0, 0, 0] };
    }

    const dx = maxX - minX,
        dy = maxY - minY,
        dz = maxZ - minZ;
    const sceneDiagonalLength = Math.sqrt(dx * dx + dy * dy + dz * dz);

    let groundSize = 15;
    let skyboxSize = userSkyboxSize ?? 20;
    // Match BJS: if camera has upperRadiusLimit, use it as base size
    const cam = scene.camera;
    if (cam && "upperRadiusLimit" in cam && (cam as { upperRadiusLimit: number }).upperRadiusLimit) {
        groundSize = (cam as { upperRadiusLimit: number }).upperRadiusLimit * 2;
        skyboxSize = groundSize;
    }
    if (sceneDiagonalLength > groundSize) {
        groundSize = sceneDiagonalLength * 2;
        skyboxSize = groundSize;
    }
    groundSize *= 1.1;
    skyboxSize *= 1.5;

    const rootPosition: [number, number, number] = [minX + dx * 0.5, minY - 0.00001, minZ + dz * 0.5];

    return { groundSize, skyboxSize, rootPosition };
}

/** Compute skybox half-size and root position.
 *  Matches BJS EnvironmentHelper._setupSizes() with sizeAuto=true (default):
 *  even when user provides explicit skyboxSize, BJS still applies the diagonal
 *  override and the ×1.5 multiplier. */
export function computeSkyboxGeometry(scene: SceneContext, userSkyboxSize?: number): { skyHalfSize: number; rootPosition: [number, number, number] } {
    const { skyboxSize: autoSkyboxSize, rootPosition } = computeSceneSize(scene, userSkyboxSize);
    return { skyHalfSize: autoSkyboxSize / 2, rootPosition };
}
