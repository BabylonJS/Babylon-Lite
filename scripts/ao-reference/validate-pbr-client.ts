import { createEngine, renderFrame } from "../../packages/babylon-lite/src/engine/engine.js";
import { createSceneContext, addToScene, registerScene, disposeScene } from "../../packages/babylon-lite/src/scene/scene-core.js";
import { registerEnvSceneUniforms } from "../../packages/babylon-lite/src/scene/scene-ubo-extras.js";
import { createFreeCamera } from "../../packages/babylon-lite/src/camera/free-camera.js";
import { createPlane } from "../../packages/babylon-lite/src/mesh/mesh-factories.js";
import { createPbrMaterial } from "../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { setPbrEmissive } from "../../packages/babylon-lite/src/material/pbr/set-emissive.js";
import { createDirectionalLight } from "../../packages/babylon-lite/src/light/directional-light.js";
import { createRenderTarget, buildRenderTarget } from "../../packages/babylon-lite/src/engine/render-target.js";
import { createRenderTask } from "../../packages/babylon-lite/src/frame-graph/render-task.js";
import { addTask } from "../../packages/babylon-lite/src/frame-graph/frame-graph-actions.js";
import { createSsaoTask } from "../../packages/babylon-lite/src/post-process/ssao.js";
import { enablePbrSsao } from "../../packages/babylon-lite/src/post-process/ssao-pbr.js";
import { createSolidTexture2D } from "../../packages/babylon-lite/src/texture/solid-texture.js";
import { getTextureReferenceStore } from "../../packages/babylon-lite/src/resource/texture-reference-store.js";
import { waitForGpuResourceRetirements } from "../../packages/babylon-lite/src/engine/gpu-resource-retirement.js";
import { disposeRenderTarget } from "../../packages/babylon-lite/src/engine/render-target.js";
import { releaseTexture } from "../../packages/babylon-lite/src/resource/texture-release.js";

function half(value: number): number {
    const e = (value >> 10) & 31,
        m = value & 1023,
        s = value & 32768 ? -1 : 1;
    return s * (e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15));
}

export async function validatePbrAo() {
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:64px;height:64px";
    document.body.append(canvas);
    const engine = await createEngine(canvas, { msaaSamples: 1, maxDevicePixelRatio: 1 });
    const device = engine._device;
    const errors: string[] = [];
    device.addEventListener("uncapturederror", (event) => errors.push(event.error.message));
    const results = [];
    const cases = [
        { name: "indirect", irradiance: 0.65, direct: 0, emissive: 0, baked: 1 },
        { name: "direct", irradiance: 0, direct: 0.8, emissive: 0, baked: 1 },
        { name: "emissive", irradiance: 0, direct: 0, emissive: 0.2, baked: 1 },
        { name: "mixed", irradiance: 0.65, direct: 0.4, emissive: 0.12, baked: 1 },
        { name: "baked", irradiance: 0.65, direct: 0, emissive: 0, baked: 0.25 },
        { name: "specular", irradiance: 0.65, direct: 0, emissive: 0, baked: 1 },
    ];
    try {
        for (const test of cases) {
            const scene = createSceneContext(engine, { defaultRenderTask: false });
            const camera = createFreeCamera({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
            camera.nearPlane = 0.1;
            camera.farPlane = 20;
            scene.camera = camera;
            scene.imageProcessing.toneMappingEnabled = false;
            scene.imageProcessing.exposure = 1;
            scene.imageProcessing.contrast = 1;
            const cube = device.createTexture({ size: [1, 1, 6], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
            const lut = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
            device.queue.writeTexture({ texture: cube }, new Uint8Array(24).fill(test.name === "specular" ? 128 : 0), { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1, 6]);
            device.queue.writeTexture({ texture: lut }, new Uint8Array([0, test.name === "specular" ? 128 : 0, 0, 255]), { bytesPerRow: 4 }, [1, 1]);
            const sh = new Float32Array(36);
            sh[0] = sh[1] = sh[2] = test.irradiance;
            scene._envTextures = {
                specularCube: cube,
                specularCubeView: cube.createView({ dimension: "cube" }),
                brdfLut: lut,
                brdfLutView: lut.createView(),
                cubeSampler: device.createSampler({ minFilter: "linear", magFilter: "linear" }),
                brdfSampler: device.createSampler({ minFilter: "linear", magFilter: "linear" }),
                irradianceSH: new Float32Array(27),
                sphericalHarmonics: sh,
                lodGenerationScale: 0.8,
            };
            registerEnvSceneUniforms(scene);
            const material = createPbrMaterial();
            material.baseColorFactor = [0.35, 0.25, 0.15, 1];
            material.metallicFactor = test.name === "specular" ? 1 : 0;
            material.roughnessFactor = 0.8;
            material.reflectance = 0;
            if (test.baked !== 1) material.ormTexture = createSolidTexture2D(engine, test.baked, 1, 0);
            if (test.emissive) setPbrEmissive(material, [test.emissive, test.emissive * 0.7, test.emissive * 0.3]);
            const mesh = createPlane(engine, { size: 4 });
            mesh.position.z = 3;
            mesh.material = material;
            addToScene(scene, mesh);
            if (test.direct) addToScene(scene, createDirectionalLight([0, 0, 1], test.direct));
            const depth = createRenderTarget({ dFormat: "depth32float", samples: 1, size: { width: 64, height: 64 } });
            buildRenderTarget(depth, engine);
            const ao = createSsaoTask({ depthTexture: depth, camera }, engine, scene);
            ao.record();
            await enablePbrSsao(scene, ao);
            const color = createRenderTarget({ format: "rgba16float", dFormat: "depth32float", samples: 1, size: { width: 64, height: 64 } });
            const task = createRenderTask({ name: "pbr-ao-check", rt: color, clr: true }, engine, scene);
            addTask(scene, task);
            await registerScene(scene);
            const setAo = (visibility: number) => {
                const encoder = device.createCommandEncoder();
                const pass = encoder.beginRenderPass({
                    colorAttachments: [
                        { view: ao.outputTexture._colorView!, loadOp: "clear", storeOp: "store", clearValue: { r: visibility, g: visibility, b: visibility, a: 1 } },
                    ],
                });
                pass.end();
                device.queue.submit([encoder.finish()]);
            };
            const read = async (): Promise<number[]> => {
                renderFrame(engine, 16);
                const encoder = device.createCommandEncoder();
                const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                encoder.copyTextureToBuffer({ texture: color._colorTexture!, origin: [32, 32] }, { buffer, bytesPerRow: 256 }, [1, 1]);
                device.queue.submit([encoder.finish()]);
                await buffer.mapAsync(GPUMapMode.READ);
                const view = new DataView(buffer.getMappedRange());
                const pixel = [half(view.getUint16(0, true)), half(view.getUint16(2, true)), half(view.getUint16(4, true))];
                buffer.destroy();
                return pixel.map((value) => value ** 2.2);
            };
            setAo(1);
            const baseline = await read();
            setAo(0.5);
            const occluded = await read();
            if (test.name === "indirect") {
                for (let i = 0; i < 3; i++) if (Math.abs(occluded[i]! / baseline[i]! - 0.5) > 0.003) throw new Error("Diffuse IBL was not attenuated by screen-space AO.");
            }
            if (test.name === "direct" || test.name === "emissive" || test.name === "baked" || test.name === "specular") {
                for (let i = 0; i < 3; i++) if (occluded[i] !== baseline[i]) throw new Error(`${test.name} contribution changed unexpectedly under AO.`);
            }
            if (test.name === "mixed") {
                for (let i = 0; i < 3; i++) {
                    const expectedRemoved = 0.65 * material.baseColorFactor[i]! * 0.5;
                    if (Math.abs(baseline[i]! - occluded[i]! - expectedRemoved) > 0.003) throw new Error("AO affected mixed direct/emissive lighting instead of only diffuse IBL.");
                }
            }
            if (baseline.some((value) => !Number.isFinite(value) || value < 0.01)) {
                throw new Error(`${test.name} test did not produce meaningful lit pixels.`);
            }
            if (test.name === "baked") {
                setAo(0.125);
                const stronger = await read();
                const ratio = 0.125 / (64 / 255);
                for (let i = 0; i < 3; i++) {
                    if (Math.abs(stronger[i]! / baseline[i]! - ratio) > 0.003) {
                        throw new Error("Screen visibility did not replace weaker baked AO by min.");
                    }
                }
            }
            // Reallocation must refresh the bind group and cached opaque bundle in the same frame.
            const oldOutput = ao.outputTexture._colorTexture!;
            depth._descriptor.size = { width: 96, height: 96 };
            buildRenderTarget(depth, engine);
            ao.record();
            setAo(0.5);
            const resized = await read();
            await waitForGpuResourceRetirements(engine);
            if (getTextureReferenceStore().get(oldOutput) !== 0) {
                throw new Error("A resized AO generation remained leased after its replacement frame drained.");
            }
            for (let i = 0; i < 3; i++) if (Math.abs(resized[i]! - occluded[i]!) > 0.001) throw new Error("PBR AO binding did not follow the resized output.");
            ao.dispose();
            const disposed = await read();
            for (let i = 0; i < 3; i++)
                if (Math.abs(disposed[i]! - baseline[i]!) > 0.001)
                    throw new Error(
                        `Disposed AO did not restore neutral material sampling: ${JSON.stringify({ case: test.name, baseline, disposed, version: material.plugins?.[0]?._bindingVersion?.() })}`
                    );
            results.push({ case: test.name, baseline, occluded, resized, disposed });
            disposeScene(scene);
            disposeRenderTarget(depth);
            if (material.ormTexture) {
                releaseTexture(material.ormTexture);
            }
            await waitForGpuResourceRetirements(engine);
            cube.destroy();
            lut.destroy();
        }
        if (errors.length) throw new Error(errors.join("\n"));
        return results;
    } finally {
        canvas.remove();
    }
}
