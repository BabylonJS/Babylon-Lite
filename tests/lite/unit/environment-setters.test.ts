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
    const task = scene._frameGraph._tasks.find((candidate): candidate is RenderTask => "_su" in candidate)!;
    writeCount.n = 0;
    return { camera, engine, scene, task, writeCount };
}

function applyEnvironmentSkyboxPatches(scene: SceneContext, kind: "dds" | "hdr", fragment: string): string {
    let patched = fragment;
    patched = scene._environmentRotationSkyboxPatch?._apply(kind, patched) ?? patched;
    patched = scene._environmentBlurSkyboxPatch?._apply(kind, patched) ?? patched;
    return patched;
}

describe("environment setters", () => {
    it.each([
        ["environment loaders", registerEnvSceneUniforms],
        ["glTF image-based lights", registerGltfEnvSceneUniforms],
    ])("registers dynamic opt-in rotation updates for %s", (_name, register) => {
        const { camera, engine, scene, task, writeCount } = makeScene();
        scene.envRotationY = 0.75;

        register(scene);
        register(scene);
        expect(scene._sceneUboContributors).toHaveLength(1);

        _writePassSceneUBO(task, engine, scene, camera);
        expect(task._suData[36]).toBeCloseTo(0.75);
        expect(writeCount.n).toBe(1);

        scene.envRotationY = 1.25;
        expect(task._su).toHaveLength(0);
        _writePassSceneUBO(task, engine, scene, camera);
        expect(task._suData[36]).toBeCloseTo(1.25);
        expect(writeCount.n).toBe(2);
    });

    it("writes blur metadata and invalidates every cached render-task scene UBO", () => {
        const { camera, engine, scene, task, writeCount } = makeScene();
        const secondCache = [1];
        scene._frameGraph._tasks.push({ _su: secondCache } as unknown as (typeof scene._frameGraph._tasks)[number]);

        _writePassSceneUBO(task, engine, scene, camera);
        _writePassSceneUBO(task, engine, scene, camera);
        expect(writeCount.n).toBe(1);

        setEnvironmentBlur(scene, 0.8);
        expect(task._su).toHaveLength(0);
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
        scene._frameGraph._tasks.push({ _su: secondCache } as unknown as (typeof scene._frameGraph._tasks)[number]);

        scene.envRotationY = 0.5;
        _writePassSceneUBO(task, engine, scene, camera);
        _writePassSceneUBO(task, engine, scene, camera);
        expect(writeCount.n).toBe(1);
        expect(task._suData[36]).toBe(0);

        setEnvironmentRotation(scene, 1.5);
        expect(task._su).toHaveLength(0);
        expect(secondCache).toHaveLength(0);
        _writePassSceneUBO(task, engine, scene, camera);
        expect(writeCount.n).toBe(2);
        expect(task._suData[36]).toBeCloseTo(1.5);
    });

    it("applies blur and rotation patches independently for DDS and HDR skyboxes", () => {
        const base = makeScene().scene;
        const baseDds = applyEnvironmentSkyboxPatches(base, "dds", ddsSkyboxFragment);
        const baseHdr = applyEnvironmentSkyboxPatches(base, "hdr", hdrSkyboxFragment);
        for (const source of [baseDds, baseHdr]) {
            expect(source).not.toContain("scene._envPad1");
            expect(source).not.toContain("scene.envRotationY");
            expect(source).toContain("textureSampleLevel(envCubemap, envSampler, dir, 0.0/*ENV_LOD*/)");
        }

        const rotated = makeScene().scene;
        setEnvironmentRotation(rotated, 1.5);
        expect(rotated._environmentRotationSkyboxPatch).toBeDefined();
        expect(rotated._environmentBlurSkyboxPatch).toBeUndefined();
        const rotatedDds = applyEnvironmentSkyboxPatches(rotated, "dds", ddsSkyboxFragment);
        expect(rotatedDds).toContain("scene.envRotationY");
        expect(rotatedDds).toContain("let cr=cos(scene.envRotationY);let sr=sin(scene.envRotationY);");
        expect(rotatedDds).not.toContain("scene._envPad1");

        const blurred = makeScene().scene;
        setEnvironmentBlur(blurred, 0.35);
        expect(blurred._environmentBlurSkyboxPatch).toBeDefined();
        expect(blurred._environmentRotationSkyboxPatch).toBeUndefined();
        const blurredDds = applyEnvironmentSkyboxPatches(blurred, "dds", ddsSkyboxFragment);
        const blurredHdr = applyEnvironmentSkyboxPatches(blurred, "hdr", hdrSkyboxFragment);
        for (const source of [blurredDds, blurredHdr]) {
            expect(source).toContain("scene._envPad1");
            expect(source).toContain("textureNumLevels(envCubemap)");
            expect(source).not.toContain("scene.envRotationY");
        }
        expect(blurredDds).toContain("*0.8,0.0,");
        expect(blurredHdr).toContain("*scene.vImageInfos.z+scene._envPad2,0.0,");

        const configured = makeScene().scene;
        setEnvironmentBlur(configured, 0.8);
        setEnvironmentRotation(configured, 1.5);
        for (const source of [applyEnvironmentSkyboxPatches(configured, "dds", ddsSkyboxFragment), applyEnvironmentSkyboxPatches(configured, "hdr", hdrSkyboxFragment)]) {
            expect(source).toContain("scene._envPad1");
            expect(source).toContain("scene.envRotationY");
        }
    });
});
