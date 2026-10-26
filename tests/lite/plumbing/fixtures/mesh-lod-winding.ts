import { createEngine } from "../../../../packages/babylon-lite/src/engine/engine.js";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine.js";
import { disposeEngine } from "../../../../packages/babylon-lite/src/engine/engine-dispose.js";
import { createSceneContext, disposeScene } from "../../../../packages/babylon-lite/src/scene/scene-core.js";
import { createFreeCamera } from "../../../../packages/babylon-lite/src/camera/free-camera.js";
import { getViewProjectionMatrix } from "../../../../packages/babylon-lite/src/camera/camera.js";
import { vec3 } from "../../../../packages/babylon-lite/src/math/vec3.js";
import { createPbrMaterial } from "../../../../packages/babylon-lite/src/material/pbr/pbr-material.js";
import { createMeshLoDInstance, disposeMeshLoDAsset, loadMeshLoD, setMeshLoDSelectionMode } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import type { MeshLoDAsset, MeshLoDSelectionMode } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod.js";
import { addMeshLoDInstanceToScene } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-scene.js";
import { _setMeshLoDPageDecoder } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-page-decoder.js";
import { getSceneBindGroupLayout } from "../../../../packages/babylon-lite/src/render/scene-helpers.js";
import { SCENE_UBO_BYTES } from "../../../../packages/babylon-lite/src/shader/scene-uniforms.js";
import { MAX_LIGHTS } from "../../../../packages/babylon-lite/src/light/types.js";
import { buildMinimalContainer, resealContainer } from "../../unit/mesh-lod/fixtures/mlod-fixture.js";

/** Production selection, expansion, indirect draw, and front-facing PBR on two reflected instances. */
export async function createMeshLoDWindingProbe(canvas: HTMLCanvasElement, doubleSided: boolean, cone: boolean) {
    const engine = await createEngine(canvas);
    try {
        return await buildProbe(engine, doubleSided, cone);
    } catch (error) {
        await disposeEngine(engine);
        throw error;
    }
}

async function buildProbe(engine: EngineContext, doubleSided: boolean, cone: boolean) {
    const device = engine._device;
    const scene = createSceneContext(engine);
    const fixture = buildMinimalContainer();
    if (cone) {
        const view = new DataView(fixture.bytes.buffer);
        for (let cluster = 0; cluster < 2; cluster++) {
            const base = fixture.layout.clusterOffset + cluster * 64;
            view.setUint32(base + 48, 1, true);
            view.setUint32(base + 52, 127 << 16, true); // +Z exterior, matching the CCW triangles
        }
        resealContainer(fixture.bytes);
    }
    _setMeshLoDPageDecoder({
        ready: Promise.resolve(),
        decodeGltfBuffer(target, count, stride, _source, mode) {
            const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
            if (mode === "ATTRIBUTES") {
                const positions = [-0.35, -0.35, 0, 0.35, -0.35, 0, 0, 0.35, 0];
                for (let vertex = 0; vertex < count; vertex++) {
                    for (let axis = 0; axis < 3; axis++) {
                        view.setFloat32(vertex * stride + axis * 4, positions[(vertex % 3) * 3 + axis]!, true);
                    }
                }
            } else if (mode === "TRIANGLES") {
                for (let index = 0; index < count; index++) {
                    view.setUint16(index * stride, index, true);
                }
            } else {
                throw new Error(`unexpected probe decoder mode: ${mode}`);
            }
        },
    });
    let asset: MeshLoDAsset;
    try {
        asset = await loadMeshLoD(engine, fixture.bytes.slice().buffer);
    } finally {
        _setMeshLoDPageDecoder(null);
    }
    const material = createPbrMaterial({
        doubleSided,
        _unlit: !doubleSided,
        metallicFactor: 0,
        reflectance: 0,
        roughnessFactor: 1,
    });
    const instances = [-1, 1].map((x) => {
        const instance = createMeshLoDInstance(asset, material);
        instance.position.set(x, 0, 0);
        instance.scaling.set(x, 1, 1);
        addMeshLoDInstanceToScene(scene, instance);
        return instance;
    });
    for (const builder of scene._deferredBuilders) {
        await builder();
    }
    if (scene._meshLoDRegistry!.batches.length !== 1 || scene._renderables.length !== 1) {
        throw new Error("winding probe must share one asset/material batch");
    }
    const binding = scene._renderables[0]!.bind(engine, { _colorFormat: "rgba32float", _sampleCount: 1 });
    const camera = createFreeCamera(vec3(0, 0, 4), vec3(0, 0, 0));
    camera.fov = 2 * Math.atan(0.25);
    const sceneData = new Float32Array(SCENE_UBO_BYTES / 4);
    sceneData.set([1, 1, 0.8, 0], 76);
    const sceneBuffer = device.createBuffer({ size: sceneData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const lights = new Float32Array(4 + MAX_LIGHTS * 16);
    new Uint32Array(lights.buffer)[0] = 1;
    lights.set([0, 0, 1, 3, 1, 1, 1, 100, 0, 0, 0, 0, 0, 0, 0, 0], 4);
    const lightBuffer = device.createBuffer({ size: lights.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(lightBuffer, 0, lights);
    const group = device.createBindGroup({
        layout: getSceneBindGroupLayout(engine),
        entries: [
            { binding: 0, resource: { buffer: sceneBuffer } },
            { binding: 1, resource: { buffer: lightBuffer } },
        ],
    });
    const target = device.createTexture({
        size: [64, 32],
        format: "rgba32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const view = target.createView();
    const staging = device.createBuffer({ size: 512, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const record = (mode: MeshLoDSelectionMode, flipped: boolean, backside = false): number => {
        setMeshLoDSelectionMode(asset, mode);
        instances[0]!.scaling.x = flipped ? 1 : -1;
        camera.position.z = backside ? -4 : 4;
        sceneData.set(getViewProjectionMatrix(camera, 2));
        sceneData.set([0, 0, backside ? -4 : 4, 0], 32);
        device.queue.writeBuffer(sceneBuffer, 0, sceneData);
        const encoder = device.createCommandEncoder();
        engine._currentEncoder = encoder;
        for (const batch of binding._updateBatches ?? []) {
            batch.reset();
        }
        binding.update!({ targetWidth: 64, targetHeight: 32, _camera: camera });
        for (const batch of binding._updateBatches ?? []) {
            batch.flush(engine);
        }
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" }] });
        pass.setPipeline(binding.pipeline);
        pass.setBindGroup(0, group);
        const draws = binding.draw(pass, engine);
        pass.end();
        for (let sample = 0; sample < 2; sample++) {
            encoder.copyTextureToBuffer({ texture: target, origin: [16 + sample * 32, 16] }, { buffer: staging, offset: sample * 256, bytesPerRow: 256 }, [1, 1]);
        }
        device.queue.submit([encoder.finish()]);
        return draws;
    };
    return {
        device,
        record,
        async read(mode: MeshLoDSelectionMode, flipped: boolean, backside = false) {
            device.pushErrorScope("validation");
            const draws = record(mode, flipped, backside);
            await staging.mapAsync(GPUMapMode.READ);
            const floats = new Float32Array(staging.getMappedRange());
            const samples = [Array.from(floats.slice(0, 4)), Array.from(floats.slice(64, 68))];
            staging.unmap();
            const error = await device.popErrorScope();
            if (error) {
                throw new Error(error.message);
            }
            return { draws, samples };
        },
        async dispose() {
            await device.queue.onSubmittedWorkDone();
            sceneBuffer.destroy();
            lightBuffer.destroy();
            target.destroy();
            staging.destroy();
            disposeScene(scene);
            disposeMeshLoDAsset(asset);
            await disposeEngine(engine);
        },
    };
}
