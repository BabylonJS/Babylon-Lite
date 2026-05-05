/** Node Material — MeshGroupBuilder + Renderable implementation.
 *
 *  Parallel to `standard-renderable.ts`. Each NodeMaterial owns one compile
 *  result (pipeline + BGLs); this builder creates per-mesh GPU resources
 *  (mesh UBO, node UBO, bind groups) and returns a Renderable
 *  that emits draws in the main pass.
 */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Mesh, MeshInternal } from "../../mesh/mesh.js";
import type { MeshGPU } from "../../mesh/mesh.js";
import type { Renderable } from "../../render/renderable.js";
import type { NodeMaterialInternal } from "./node-material.js";
import { writeNodeUBO } from "./node-material.js";
import { writeMeshLightSelection } from "../../render/lights-ubo.js";
import { MAX_LIGHTS } from "../../light/types.js";

// Per-engine cached no-op morph target: a 1×1 rgba32float texture + a UBO with
// count=0 + sensible texWidth/rowsPerBand. Meshes without their own morph
// targets reuse this so materials that contain a MorphTargetsBlock still work
// (the WGSL loops over `count` and passes through when zero).
const emptyMorphByEngine = new WeakMap<EngineContextInternal, { texture: GPUTexture; weightsBuffer: GPUBuffer }>();
function getEmptyMorph(engine: EngineContextInternal): { texture: GPUTexture; weightsBuffer: GPUBuffer } {
    const cached = emptyMorphByEngine.get(engine);
    if (cached) {
        return cached;
    }
    const texture = engine.device.createTexture({
        label: "node-morph-empty",
        size: [1, 1],
        format: "rgba32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    engine.device.queue.writeTexture({ texture }, new Float32Array([0, 0, 0, 0]).buffer, { bytesPerRow: 16 }, { width: 1, height: 1 });
    const ubo = new ArrayBuffer(32);
    const u32 = new Uint32Array(ubo, 16, 4);
    u32[0] = 0; // count
    u32[1] = 1; // texWidth
    u32[2] = 1; // rowsPerBand
    const weightsBuffer = engine.device.createBuffer({ label: "node-morph-empty-ubo", size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    engine.device.queue.writeBuffer(weightsBuffer, 0, new Uint8Array(ubo));
    const entry = { texture, weightsBuffer };
    emptyMorphByEngine.set(engine, entry);
    return entry;
}

interface NodePacket {
    readonly mesh: Mesh;
    readonly meshUBO: GPUBuffer;
    readonly meshBG: GPUBindGroup;
    readonly meshScratch: Float32Array;
    _lastWorldVersion: number;
    _lastReceivesShadow: number;
    _lastLightsCount: number;
}

type NodeRenderPass = GPURenderPassEncoder | GPURenderBundleEncoder;

/** Build NME renderables for a set of meshes that share a NodeMaterial. */
export function buildNodeMeshRenderables(scene: SceneContext, meshes: Mesh[]): { renderables: Renderable[] } {
    const engine = scene.engine as EngineContextInternal;
    const device = engine.device;

    // All meshes in this group use the same NodeMaterial (scene-core batches by ctor).
    // We deliberately do NOT re-group by material instance: each renderable loops
    // packets of the same pipeline. For phase 1 every mesh with an NME material
    // shares that one material instance.
    const byMaterial = new Map<NodeMaterialInternal, Mesh[]>();
    for (const m of meshes) {
        const mat = m.material as NodeMaterialInternal;
        let list = byMaterial.get(mat);
        if (!list) {
            list = [];
            byMaterial.set(mat, list);
        }
        list.push(m);
    }

    const renderables: Renderable[] = [];

    for (const [material, matMeshes] of byMaterial) {
        const compile = material._compile;
        const meshBGL = compile.meshBGL;

        // Node UBO is per-material (same across all meshes using it).
        let nodeUBO: GPUBuffer | null = null;
        if (compile.nodeUboBinding !== null && compile.nodeUboSize > 0) {
            nodeUBO = device.createBuffer({ label: "node-ubo", size: compile.nodeUboSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            writeNodeUBO(engine, nodeUBO, material);
            material._nodeUBO = nodeUBO;
        }

        const packets: NodePacket[] = [];
        for (const mesh of matMeshes) {
            // Mesh UBO layout: world (64B) + receivesShadow (vec4, 16B) + lightCount/indices.
            const meshUboBytes = 96 + 16 * Math.ceil(MAX_LIGHTS / 4);
            const meshUBO = device.createBuffer({ label: "node-mesh-ubo", size: (meshUboBytes + 15) & ~15, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            const meshScratch = new Float32Array(((meshUboBytes + 15) & ~15) / 4);
            meshScratch.set(mesh.worldMatrix as unknown as Float32Array, 0);
            const recv = mesh.receiveShadows ? 1 : 0;
            meshScratch[16] = recv;
            writeMeshLightSelection(mesh, scene.lights, meshScratch.subarray(4));
            device.queue.writeBuffer(meshUBO, 0, meshScratch);

            const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: meshUBO } }];
            if (nodeUBO) {
                entries.push({ binding: compile.nodeUboBinding!, resource: { buffer: nodeUBO } });
            }
            for (const tb of compile.textureBindings) {
                const slot = material._textureSlots.get(tb.name);
                const tex = slot?.current;
                if (!tex) {
                    throw new Error(
                        `NodeMaterial: texture binding "${tb.name}" not set. Provide it via options.textures or material.inputs["${tb.name}"].texture before the first render.`
                    );
                }
                entries.push({ binding: tb.texBinding, resource: tex.view });
                entries.push({ binding: tb.sampBinding, resource: tex.sampler });
            }
            if (compile.morphBindings !== null) {
                const mt = (mesh as { morphTargets?: { texture: GPUTexture; weightsBuffer: GPUBuffer } | null }).morphTargets ?? getEmptyMorph(engine);
                entries.push({ binding: compile.morphBindings.textureBinding, resource: mt.texture.createView() });
                entries.push({ binding: compile.morphBindings.uboBinding, resource: { buffer: mt.weightsBuffer } });
            }
            if (compile.envBindings) {
                material._envHelpers!.pushEnvBindGroupEntries(scene, compile.envBindings, entries);
            }
            for (let si = 0; si < compile.shadowBindings.length; si++) {
                const sb = compile.shadowBindings[si]!;
                const sg = material._shadowGenerators[si];
                if (!sg) {
                    throw new Error(`NodeMaterial: material requires shadow generator #${si} but none was supplied to parseNodeMaterialFromSnippet({ shadowGenerators }).`);
                }
                entries.push({ binding: sb.texBinding, resource: sg.blurredTexture.createView() });
                entries.push({ binding: sb.sampBinding, resource: sg.blurredSampler });
                entries.push({ binding: sb.uboBinding, resource: { buffer: sg.shadowUBO } });
            }
            const meshBG = device.createBindGroup({ label: "node-mesh-bg", layout: meshBGL, entries });

            packets.push({
                mesh,
                meshUBO,
                meshBG,
                meshScratch,
                _lastWorldVersion: mesh.worldMatrixVersion,
                _lastReceivesShadow: recv,
                _lastLightsCount: scene.lights.length,
            });
        }

        // Vertex attribute order (matches compile.state — captured on material).
        const attrNames = material._vertexAttrNames;

        const updatePacketUBO = (pkt: NodePacket): void => {
            const recv = pkt.mesh.receiveShadows ? 1 : 0;
            const worldChanged = pkt.mesh.worldMatrixVersion !== pkt._lastWorldVersion;
            const recvChanged = recv !== pkt._lastReceivesShadow;
            const lightsChanged = scene.lights.length !== pkt._lastLightsCount;
            if (worldChanged || recvChanged || lightsChanged) {
                pkt.meshScratch.set(pkt.mesh.worldMatrix as unknown as Float32Array, 0);
                pkt.meshScratch[16] = recv;
                writeMeshLightSelection(pkt.mesh, scene.lights, pkt.meshScratch.subarray(4));
                device.queue.writeBuffer(pkt.meshUBO, 0, pkt.meshScratch as Float32Array<ArrayBuffer>);
                pkt._lastWorldVersion = pkt.mesh.worldMatrixVersion;
                pkt._lastReceivesShadow = recv;
                pkt._lastLightsCount = scene.lights.length;
            }
        };

        const updateNodeUBO = (): void => {
            if (nodeUBO && material._uboDirty) {
                material._uboDirty = false;
                writeNodeUBO(engine, nodeUBO, material);
            }
        };

        const drawPacket = (pass: NodeRenderPass, pkt: NodePacket): void => {
            const g = (pkt.mesh as MeshInternal)._gpu;
            for (let i = 0; i < attrNames.length; i++) {
                const buf = getAttrBuffer(engine, g, attrNames[i]!);
                pass.setVertexBuffer(i, buf);
            }
            pass.setIndexBuffer(g.indexBuffer, g.indexFormat);
            pass.setBindGroup(1, pkt.meshBG);
            pass.drawIndexed(g.indexCount);
        };

        const isTransparent = material._needsAlphaBlending;

        if (isTransparent) {
            // Transparent materials: one renderable per mesh so each gets an
            // independent _worldCenter for back-to-front distance sorting.
            for (const pkt of packets) {
                const wm = pkt.mesh.worldMatrix as unknown as ArrayLike<number>;
                const cx = pkt.mesh.position?.x ?? wm[12]!;
                const cy = pkt.mesh.position?.y ?? wm[13]!;
                const cz = pkt.mesh.position?.z ?? wm[14]!;
                const updateUBOs = (): void => {
                    updatePacketUBO(pkt);
                    updateNodeUBO();
                    const m = pkt.mesh.worldMatrix as unknown as ArrayLike<number>;
                    rTrans._worldCenter = [m[12]!, m[13]!, m[14]!];
                };
                const draw = (pass: NodeRenderPass): number => {
                    drawPacket(pass, pkt);
                    return 1;
                };
                const rTrans: Renderable = {
                    order: 200,
                    isTransparent: true,
                    mesh: pkt.mesh,
                    _worldCenter: [cx, cy, cz],
                    bind() {
                        return { renderable: rTrans, pipeline: compile.pipeline, updateUBOs, draw };
                    },
                };
                renderables.push(rTrans);
            }
        } else {
            // Opaque: batch all meshes into one renderable for state efficiency.
            const updateUBOs = (): void => {
                for (const pkt of packets) {
                    updatePacketUBO(pkt);
                }
                updateNodeUBO();
            };
            const draw = (pass: NodeRenderPass): number => {
                let draws = 0;
                for (const pkt of packets) {
                    drawPacket(pass, pkt);
                    draws++;
                }
                return draws;
            };
            const rOpaque: Renderable = {
                order: 100,
                isTransparent: false,
                bind() {
                    return { renderable: rOpaque, pipeline: compile.pipeline, updateUBOs, draw };
                },
            };
            renderables.push(rOpaque);
        }
    }

    return { renderables };
}

// Per-gpu-object cached zero buffers for attributes that a NodeMaterial's
// vertex layout declares but the mesh itself doesn't provide (e.g. vertex
// color on meshes that don't use VERTEXCOLOR). We allocate one zero buffer
// lazily per gpu object, sized to its position vertex count × stride.
const zeroAttrCache = new WeakMap<object, Map<string, GPUBuffer>>();
function getZeroAttrBuffer(engine: EngineContextInternal, gpu: MeshGPU, name: string): GPUBuffer {
    let cache = zeroAttrCache.get(gpu as unknown as object);
    if (!cache) {
        cache = new Map();
        zeroAttrCache.set(gpu as unknown as object, cache);
    }
    const existing = cache.get(name);
    if (existing) {
        return existing;
    }
    // position buffer size in bytes / 12 (vec3) = vertex count.
    const vertexCount = gpu.positionBuffer.size / 12;
    const stride = name === "uv" || name === "uv2" ? 8 : name === "normal" ? 12 : name === "tangent" || name === "color" ? 16 : 16;
    const buf = engine.device.createBuffer({ label: `node-zero-${name}`, size: vertexCount * stride, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    // Initialize with zeros (buffer starts zeroed when not mappedAtCreation).
    cache.set(name, buf);
    return buf;
}

function getAttrBuffer(engine: EngineContextInternal, gpu: MeshGPU, name: string): GPUBuffer {
    switch (name) {
        case "position":
            return gpu.positionBuffer;
        case "normal":
            return gpu.normalBuffer;
        case "uv":
            return gpu.uvBuffer;
        case "uv2":
            return gpu.uv2Buffer ?? getZeroAttrBuffer(engine, gpu, "uv2");
        case "tangent":
            return gpu.tangentBuffer ?? getZeroAttrBuffer(engine, gpu, "tangent");
        case "color":
            return gpu.colorBuffer ?? getZeroAttrBuffer(engine, gpu, "color");
        default:
            throw new Error(`NodeMaterial: unsupported attribute "${name}"`);
    }
}
