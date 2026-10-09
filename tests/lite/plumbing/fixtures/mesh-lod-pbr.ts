import { createPbrComposer } from "../../../../packages/babylon-lite/src/material/pbr/pbr-compose.js";
import { composeMeshLoDWgsl } from "../../../../packages/babylon-lite/src/material/pbr/pbr-mesh-lod-compose.js";
import { COMPUTE_PBR_LIGHT, getMultiLightLoop, MULTI_LIGHT_STRUCTS } from "../../../../packages/babylon-lite/src/material/pbr/fragments/multilight-wgsl.js";
import { PBR_HAS_SPECULAR_AA } from "../../../../packages/babylon-lite/src/material/pbr/pbr-flag-bits.js";
import { INSTANCE_WORDS, packInstanceRecord } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-selection-gpu.js";
import { SCENE_UBO_BYTES } from "../../../../packages/babylon-lite/src/shader/scene-uniforms.js";
import { MAX_LIGHTS } from "../../../../packages/babylon-lite/src/light/types.js";

export interface MeshLoDPbrCase {
    readonly roughness: number;
    readonly specularAA: boolean;
    readonly varyingNormals: boolean;
    readonly lightType: "hemispheric" | "directional";
}

/** Numeric fragment-output fixture; both paths consume the same decoded geometry. */
export async function createMeshLoDPbrProbe(device: GPUDevice): Promise<{
    configure(options: MeshLoDPbrCase): void;
    record(encoder: GPUCommandEncoder): void;
    read(options: MeshLoDPbrCase): Promise<{ ordinary: number[]; meshLoD: number[] }>;
    dispose(): void;
}> {
    const buffers: GPUBuffer[] = [];
    const textures: GPUTexture[] = [];
    const upload = (data: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>, usage: number, label: string): GPUBuffer => {
        const buffer = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST, label });
        device.queue.writeBuffer(buffer, 0, data);
        buffers.push(buffer);
        return buffer;
    };
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const scene = new Float32Array(SCENE_UBO_BYTES / 4);
    scene.set(identity);
    scene.set(identity, 16);
    scene.set([0, 0, 4, 0], 32);
    scene.set([1, 1, 0.8, 0], 76);
    const sceneUbo = upload(scene, GPUBufferUsage.UNIFORM, "probe-scene");
    const lights = new Float32Array(4 + MAX_LIGHTS * 16);
    new Uint32Array(lights.buffer)[0] = 1;
    const lightUbo = upload(lights, GPUBufferUsage.UNIFORM, "probe-lights");
    const sceneLayout = device.createBindGroupLayout({
        entries: [0, 1].map((binding) => ({ binding, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } })),
    });
    const sceneGroup = device.createBindGroup({
        layout: sceneLayout,
        entries: [
            { binding: 0, resource: { buffer: sceneUbo } },
            { binding: 1, resource: { buffer: lightUbo } },
        ],
    });
    const white = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: "probe-white" });
    textures.push(white);
    device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), {}, [1, 1]);
    const whiteView = white.createView();
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const positions = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]);
    const normals = new Float32Array(9);
    const positionBuffer = upload(positions, GPUBufferUsage.VERTEX, "probe-positions");
    const normalBuffer = upload(normals, GPUBufferUsage.VERTEX, "probe-normals");
    const uvBuffer = upload(new Float32Array(6), GPUBufferUsage.VERTEX, "probe-uv");
    const arena = new Uint32Array(18);
    const arenaFloats = new Float32Array(arena.buffer);
    for (let vertex = 0; vertex < 3; vertex++) {
        arenaFloats.set(positions.subarray(vertex * 3, vertex * 3 + 3), vertex * 6);
    }
    const arenaBuffer = upload(arena, GPUBufferUsage.STORAGE, "probe-arena");
    const drawBuffer = upload(new Uint32Array([0, 0, 0, 0, 6, 0, 0, 0, 12, 0, 0, 0]), GPUBufferUsage.STORAGE, "probe-draw-vertices");
    const instances = new Float32Array(INSTANCE_WORDS);
    packInstanceRecord(instances, new Uint32Array(instances.buffer), 0, identity, true, 0);
    const instanceBuffer = upload(instances, GPUBufferUsage.STORAGE, "probe-instances");
    const meshMaterial = new Float32Array(20);
    const meshMaterialUbo = upload(meshMaterial, GPUBufferUsage.UNIFORM, "probe-mlod-material");
    const meshLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
            ...[1, 3, 5, 7].flatMap((binding): GPUBindGroupLayoutEntry[] => [
                { binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
                { binding: binding + 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
            ]),
            ...[9, 10, 11].map((binding): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } })),
        ],
    });
    const meshGroup = device.createBindGroup({
        layout: meshLayout,
        entries: [
            { binding: 0, resource: { buffer: meshMaterialUbo } },
            ...[1, 3, 5, 7].flatMap((binding) => [
                { binding, resource: whiteView },
                { binding: binding + 1, resource: sampler },
            ]),
            ...[arenaBuffer, drawBuffer, instanceBuffer].map((buffer, index) => ({ binding: 9 + index, resource: { buffer } })),
        ],
    });
    const compose = createPbrComposer({
        _singleLightWGSL: "",
        _getSingleLightBlock: null,
        _multiLightWGSL: MULTI_LIGHT_STRUCTS() + COMPUTE_PBR_LIGHT,
        _multiLightLoop: getMultiLightLoop(),
        _fogHelper: "",
        _fogBlock: "",
        _createPbrTemplateExt: null,
        _flatNormalWgsl: "",
        _createPbrShadowFragment: null,
        _shadowLights: [],
        _createThinInstanceFragment: null,
    });
    const shaderModule = async (code: string, label: string): Promise<GPUShaderModule> => {
        const module = device.createShaderModule({ code, label });
        const errors = (await module.getCompilationInfo()).messages.filter((message) => message.type === "error");
        if (errors.length) {
            throw new Error(errors.map((message) => message.message).join("\n"));
        }
        return module;
    };
    const ordinary = compose(0, 0, 0, 0, 2);
    const ordinaryMaterialSpec = ordinary._materialUboSpec!;
    const ordinaryMaterial = new Float32Array(ordinaryMaterialSpec._totalBytes / 4);
    const ordinaryMaterialUbo = upload(ordinaryMaterial, GPUBufferUsage.UNIFORM, "probe-pbr-material");
    const world = new Float32Array(ordinary._meshUboSpec._totalBytes / 4);
    world.set(identity);
    new Uint32Array(world.buffer)[ordinary._meshUboSpec._offsets.get("lc")! / 4] = 1;
    const worldUbo = upload(world, GPUBufferUsage.UNIFORM, "probe-pbr-world");
    const ordinaryLayout = device.createBindGroupLayout(ordinary._meshBGLDescriptor);
    const ordinaryGroup = device.createBindGroup({
        layout: ordinaryLayout,
        entries: [
            { binding: 0, resource: { buffer: worldUbo } },
            { binding: 1, resource: { buffer: ordinaryMaterialUbo } },
            { binding: 2, resource: whiteView },
            { binding: 3, resource: sampler },
            { binding: 4, resource: whiteView },
            { binding: 5, resource: sampler },
        ],
    });
    const pipelines = await Promise.all(
        [false, true].map(async (specularAA) => {
            const pbr = compose(specularAA ? PBR_HAS_SPECULAR_AA : 0, 0, 0, 0, 2);
            const vertex = await shaderModule(pbr._vertexWGSL, "probe-pbr-vertex");
            const fragment = await shaderModule(pbr._fragmentWGSL, `probe-pbr-aa-${specularAA}`);
            const mesh = await shaderModule(
                composeMeshLoDWgsl({ hasNormalMap: false, hasEmissiveTexture: false, hasIbl: false, doubleSided: false, unlit: false, hasSpecularAA: specularAA }),
                `probe-mlod-aa-${specularAA}`
            );
            const [ordinaryPipeline, meshPipeline] = await Promise.all([
                device.createRenderPipelineAsync({
                    label: `probe-pbr-aa-${specularAA}`,
                    layout: device.createPipelineLayout({ bindGroupLayouts: [sceneLayout, ordinaryLayout] }),
                    vertex: { module: vertex, entryPoint: "main", buffers: pbr._vertexBufferLayouts },
                    fragment: { module: fragment, entryPoint: "main", targets: [{ format: "rgba32float" }] },
                }),
                device.createRenderPipelineAsync({
                    label: `probe-mlod-aa-${specularAA}`,
                    layout: device.createPipelineLayout({ bindGroupLayouts: [sceneLayout, meshLayout] }),
                    vertex: { module: mesh, entryPoint: "vs" },
                    fragment: { module: mesh, entryPoint: "fs", targets: [{ format: "rgba32float" }] },
                }),
            ]);
            return { ordinaryPipeline, meshPipeline };
        })
    );
    const targets = ["ordinary", "mesh-lod"].map((name) => {
        const texture = device.createTexture({
            size: [16, 16],
            format: "rgba32float",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            label: `probe-${name}`,
        });
        textures.push(texture);
        return { texture, view: texture.createView() };
    });
    const staging = device.createBuffer({ size: 512, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    buffers.push(staging);
    let active = pipelines[0]!;
    const configure = (options: MeshLoDPbrCase): void => {
        active = pipelines[options.specularAA ? 1 : 0]!;
        meshMaterial.set([1, 1, 1, 1, 0, 0, 0, 0, 1, options.roughness, 1, 1, 0, 1, 0.04, 1, 1, 0, 0, 0]);
        device.queue.writeBuffer(meshMaterialUbo, 0, meshMaterial);
        for (const [name, value] of Object.entries({
            environmentIntensity: 0,
            directIntensity: 1,
            reflectance: 0.04,
            materialAlpha: 1,
            metallicFactor: 1,
            roughnessFactor: options.roughness,
            normalScale: 1,
            lightFalloffMode: 1,
        })) {
            ordinaryMaterial[ordinaryMaterialSpec._offsets.get(name)! / 4] = value;
        }
        device.queue.writeBuffer(ordinaryMaterialUbo, 0, ordinaryMaterial);
        lights.set([0.6, 0, 0.8, 3, 1, 1, 1, 100, 1, 1, 1, 0, 0, 0, 0, 0], 4);
        if (options.lightType === "directional") {
            lights.set([-0.6, 0, -0.8, 1], 4);
        }
        device.queue.writeBuffer(lightUbo, 0, lights);
        for (let vertex = 0; vertex < 3; vertex++) {
            const octX = options.varyingNormals && vertex === 1 ? 16384 : 0;
            const octY = options.varyingNormals && vertex === 2 ? 16384 : 0;
            const x = octX / 32767;
            const y = octY / 32767;
            const z = 1 - Math.abs(x) - Math.abs(y);
            const length = Math.hypot(x, y, z);
            normals.set([x / length, y / length, z / length], vertex * 3);
            arena[vertex * 6 + 3] = octX | (octY << 16);
        }
        device.queue.writeBuffer(normalBuffer, 0, normals);
        device.queue.writeBuffer(arenaBuffer, 0, arena);
    };
    const record = (encoder: GPUCommandEncoder): void => {
        for (const [index, target] of targets.entries()) {
            const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.view, clearValue: [0, 0, 0, 0], loadOp: "clear", storeOp: "store" }] });
            pass.setBindGroup(0, sceneGroup);
            pass.setPipeline(index === 0 ? active.ordinaryPipeline : active.meshPipeline);
            pass.setBindGroup(1, index === 0 ? ordinaryGroup : meshGroup);
            if (index === 0) {
                [positionBuffer, normalBuffer, uvBuffer].forEach((buffer, slot) => pass.setVertexBuffer(slot, buffer));
            }
            pass.draw(3);
            pass.end();
        }
    };
    return {
        configure,
        record,
        async read(options) {
            configure(options);
            const encoder = device.createCommandEncoder();
            record(encoder);
            targets.forEach((target, index) =>
                encoder.copyTextureToBuffer({ texture: target.texture, origin: [8, 8] }, { buffer: staging, offset: index * 256, bytesPerRow: 256 }, [1, 1])
            );
            device.queue.submit([encoder.finish()]);
            await staging.mapAsync(GPUMapMode.READ);
            const data = new Float32Array(staging.getMappedRange());
            const result = { ordinary: Array.from(data.subarray(0, 4)), meshLoD: Array.from(data.subarray(64, 68)) };
            staging.unmap();
            return result;
        },
        dispose() {
            buffers.forEach((buffer) => buffer.destroy());
            textures.forEach((texture) => texture.destroy());
        },
    };
}
