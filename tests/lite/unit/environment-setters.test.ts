import { describe, expect, it } from "vitest";

import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { RenderTarget } from "../../../packages/babylon-lite/src/engine/render-target";
import { _writePassSceneUBO, type RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task";
import type { EnvironmentTextures } from "../../../packages/babylon-lite/src/loader-env/load-env";
import { registerEnvSceneUniforms as registerGltfEnvSceneUniforms } from "../../../packages/babylon-lite/src/loader-gltf/ibl-env-assembly";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types";
import { createSceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { registerEnvSceneUniforms } from "../../../packages/babylon-lite/src/scene/scene-ubo-extras";
import { setEnvironmentBlur, setEnvironmentRotation } from "../../../packages/babylon-lite/src";
import { SCENE_UBO_WGSL } from "../../../packages/babylon-lite/src/shader/scene-uniforms";
import ddsSkyboxFragment from "../../../packages/babylon-lite/shaders/skybox-dds.fragment.wgsl?raw";
import hdrSkyboxFragment from "../../../packages/babylon-lite/shaders/skybox-hdr.fragment.wgsl?raw";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUBufferUsage"> & { GPUBufferUsage?: { UNIFORM: number; COPY_DST: number } };
gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 } as unknown as GPUBufferUsage;

function makeIdentityMatrix(): Mat4 {
    const matrix = new Float32Array(16);
    matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
    return matrix as unknown as Mat4;
}

function makeCamera(): Camera {
    return {
        fov: Math.PI / 4,
        nearPlane: 0.1,
        farPlane: 100,
        children: [],
        worldMatrix: makeIdentityMatrix(),
        worldMatrixVersion: 1,
        _viewCache: new Float32Array(16),
        _projCache: new Float32Array(16),
        _vpCache: new Float32Array(16),
    } as unknown as Camera;
}

function makeMockEngine(writeCount: { n: number }): EngineContext {
    const device = {
        createBuffer: (descriptor: GPUBufferDescriptor) => ({ descriptor, destroy: () => undefined }) as unknown as GPUBuffer,
        createBindGroupLayout: (descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout,
        createBindGroup: (descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup,
        queue: {
            writeBuffer: () => {
                writeCount.n++;
            },
        },
    } as unknown as GPUDevice;
    const scRT = {
        _colorTexture: {},
        _colorView: {},
        _depthTexture: null,
        _depthView: null,
        _descriptor: { format: "bgra8unorm", samples: 1, size: { width: 800, height: 600 } },
        _width: 800,
        _height: 600,
        _eager: true,
    } as unknown as RenderTarget;
    const engine = {
        canvas: { width: 800, height: 600 } as HTMLCanvasElement,
        msaaSamples: 1,
        useFloatingOrigin: false,
        useHighPrecisionMatrix: false,
        format: "bgra8unorm",
        _device: device,
        scRT,
    } as unknown as EngineContext;
    Object.assign(engine, { engine, surfaces: [engine], _surfaces: [engine] });
    return engine;
}

function makeScene() {
    const writeCount = { n: 0 };
    const engine = makeMockEngine(writeCount);
    const scene = createSceneContext(engine) as SceneContext;
    const camera = makeCamera();
    scene.camera = camera;
    scene._envTextures = {
        lodGenerationScale: 0.8,
        lodGenerationOffset: 0.125,
    } as EnvironmentTextures;
    const task = scene._frameGraph._tasks.find((candidate): candidate is RenderTask => candidate._sceneUboCacheKey !== undefined)!;
    writeCount.n = 0;
    return { camera, engine, scene, task, writeCount };
}

async function applyEnvironmentSkyboxPatches(scene: SceneContext, fragment: string, kind: "dds" | "hdr"): Promise<string> {
    return (await scene._environmentSkyboxShaderComposer?.(fragment, kind)) ?? fragment;
}

describe("environment setters", () => {
    it.each([
        ["environment loaders", registerEnvSceneUniforms],
        ["glTF image-based lights", registerGltfEnvSceneUniforms],
    ])("registers opt-in rotation data for %s", (_name, register) => {
        const { camera, engine, scene, task, writeCount } = makeScene();
        scene._environmentRotation = 0.75;

        register(scene);
        register(scene);
        expect(scene._sceneUboContributors).toHaveLength(1);

        _writePassSceneUBO(task, engine, scene, camera);
        expect(task._suData[36]).toBeCloseTo(0.75);
        expect(writeCount.n).toBe(1);
    });

    it("writes blur metadata and invalidates every cached render-task scene UBO", () => {
        const { camera, engine, scene, task, writeCount } = makeScene();
        const secondCache = [1];
        scene._frameGraph._tasks.push({ ...task, _sceneUboCacheKey: secondCache });

        _writePassSceneUBO(task, engine, scene, camera);
        _writePassSceneUBO(task, engine, scene, camera);
        expect(writeCount.n).toBe(1);

        setEnvironmentBlur(scene, 0.8);
        expect(task._sceneUboCacheKey).toHaveLength(0);
        expect(secondCache).toHaveLength(0);

        _writePassSceneUBO(task, engine, scene, camera);
        expect(writeCount.n).toBe(2);
        expect(task._suData[38]).toBeCloseTo(0.8);
        expect(task._suData[39]).toBeCloseTo(0.125);

        setEnvironmentBlur(scene, 0.25);
        expect(scene._sceneUboContributors).toHaveLength(1);
        _writePassSceneUBO(task, engine, scene, camera);
        expect(writeCount.n).toBe(3);
        expect(task._suData[38]).toBeCloseTo(0.25);
    });

    it("registers the rotation UBO writer and invalidates every cached render-task scene UBO", () => {
        const { camera, engine, scene, task, writeCount } = makeScene();
        const secondCache = [1];
        scene._frameGraph._tasks.push({ ...task, _sceneUboCacheKey: secondCache });

        scene._environmentRotation = 0.5;
        _writePassSceneUBO(task, engine, scene, camera);
        _writePassSceneUBO(task, engine, scene, camera);
        expect(writeCount.n).toBe(1);
        expect(task._suData[36]).toBe(0);

        setEnvironmentRotation(scene, 0.5);
        expect(task._sceneUboCacheKey).toHaveLength(0);
        expect(secondCache).toHaveLength(0);
        _writePassSceneUBO(task, engine, scene, camera);
        expect(writeCount.n).toBe(2);
        expect(task._suData[36]).toBeCloseTo(0.5);

        setEnvironmentRotation(scene, 1.5);
        expect(task._sceneUboCacheKey).toHaveLength(0);
        _writePassSceneUBO(task, engine, scene, camera);
        expect(writeCount.n).toBe(3);
        expect(task._suData[36]).toBeCloseTo(1.5);
    });

    it("composes blur and rotation independently in a stable order for DDS and HDR skyboxes", async () => {
        const base = makeScene().scene;
        const baseDds = await applyEnvironmentSkyboxPatches(base, ddsSkyboxFragment, "dds");
        const baseHdr = await applyEnvironmentSkyboxPatches(base, hdrSkyboxFragment, "hdr");
        expect(baseHdr).toBe(hdrSkyboxFragment);
        for (const source of [baseDds, baseHdr]) {
            expect(source).not.toContain("scene._envPad1");
            expect(source).not.toContain("scene.envRotationY");
            expect(source).toContain("textureSampleLevel(envCubemap, envSampler, dir, 0.0).rgb");
        }

        const rotated = makeScene().scene;
        setEnvironmentRotation(rotated, 1.5);
        expect(rotated._environmentSkyboxShaderComposer).toBeDefined();
        expect(rotated._environmentSkyboxShaderPatchLoaders?.filter(Boolean)).toHaveLength(1);
        const rotatedDds = await applyEnvironmentSkyboxPatches(rotated, ddsSkyboxFragment, "dds");
        expect(rotatedDds).toContain("scene.envRotationY");
        expect(rotatedDds).toContain("let _erc=cos(scene.envRotationY);let _ers=sin(scene.envRotationY);");
        expect(rotatedDds).not.toContain("scene._envPad1");

        const blurred = makeScene().scene;
        setEnvironmentBlur(blurred, 0.35);
        expect(blurred._environmentSkyboxShaderComposer).toBeDefined();
        expect(blurred._environmentSkyboxShaderPatchLoaders?.filter(Boolean)).toHaveLength(1);
        const blurredDds = await applyEnvironmentSkyboxPatches(blurred, ddsSkyboxFragment, "dds");
        const blurredHdr = await applyEnvironmentSkyboxPatches(blurred, hdrSkyboxFragment, "hdr");
        for (const source of [blurredDds, blurredHdr]) {
            expect(source).toContain("scene._envPad1");
            expect(source).toContain("textureNumLevels(envCubemap)");
            expect(source).not.toContain("scene.envRotationY");
        }
        expect(blurredDds).toContain("*0.8,0.0,");
        expect(blurredHdr).toContain("*scene.vImageInfos.z+scene._envPad2,0.0,");
        expect(blurredDds.startsWith(SCENE_UBO_WGSL)).toBe(false);
        expect(blurredHdr.startsWith(SCENE_UBO_WGSL)).toBe(true);

        const configured = makeScene().scene;
        setEnvironmentBlur(configured, 0.8);
        setEnvironmentRotation(configured, 1.5);
        setEnvironmentBlur(configured, 0.25);
        expect(configured._environmentSkyboxShaderPatchLoaders).toHaveLength(2);
        const blurThenRotation = await applyEnvironmentSkyboxPatches(configured, ddsSkyboxFragment, "dds");

        const reverseOrder = makeScene().scene;
        setEnvironmentRotation(reverseOrder, 1.5);
        setEnvironmentBlur(reverseOrder, 0.25);
        const rotationThenBlur = await applyEnvironmentSkyboxPatches(reverseOrder, ddsSkyboxFragment, "dds");
        expect(rotationThenBlur).toBe(blurThenRotation);

        for (const source of [blurThenRotation, await applyEnvironmentSkyboxPatches(configured, hdrSkyboxFragment, "hdr")]) {
            expect(source).toContain("scene._envPad1");
            expect(source).toContain("scene.envRotationY");
        }
    });
});
