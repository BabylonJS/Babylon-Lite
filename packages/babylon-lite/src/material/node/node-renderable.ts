/** Node Material — MeshGroupBuilder + Renderable implementation.
 *
 *  Parallel to `standard-renderable.ts`. Each NodeMaterial owns one compile
 *  result (pipeline + BGLs); this builder creates per-mesh GPU resources
 *  (mesh UBO, node UBO, bind groups) and returns a Renderable
 *  that emits draws in the main pass.
 */

import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshGPU } from "../../mesh/mesh.js";
import type { MeshGroupBuildResult, Renderable } from "../../render/renderable.js";
import type { Material } from "../material.js";
import type { NodeMaterial } from "./node-material.js";
import { writeNodeUBO } from "./node-material.js";
import { compileNodePipeline } from "./node-pipeline.js";
import { NODE_ESM_SHADOW_OUTPUT, NODE_NO_COLOR_OUTPUT } from "./node-flags.js";
import { writeMeshLightSelection } from "../../render/lights-ubo.js";
import { MAX_LIGHTS } from "../../light/types.js";
import { packMat4IntoF32 } from "../../math/pack-mat4-into-f32.js";

// Per-engine cached no-op morph target: a 1×1 rgba32float texture + a UBO with
// count=0 + sensible texWidth/rowsPerBand. Meshes without their own morph
// targets reuse this so materials that contain a MorphTargetsBlock still work
// (the WGSL loops over `count` and passes through when zero).
const emptyMorphByEngine = new WeakMap<EngineContext, { texture: GPUTexture; weightsBuffer: GPUBuffer }>();
function getEmptyMorph(engine: EngineContext): { texture: GPUTexture; weightsBuffer: GPUBuffer } {
    const cached = emptyMorphByEngine.get(engine);
    if (cached) {
        return cached;
    }
    const texture = engine._device.createTexture({
        label: "node-morph-empty",
        size: [1, 1],
        format: "rgba32float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    engine._device.queue.writeTexture({ texture }, new Float32Array([0, 0, 0, 0]).buffer, { bytesPerRow: 16 }, { width: 1, height: 1 });
    const ubo = new ArrayBuffer(32);
    const u32 = new Uint32Array(ubo, 16, 4);
    u32[0] = 0; // count
    u32[1] = 1; // texWidth
    u32[2] = 1; // rowsPerBand
    const weightsBuffer = engine._device.createBuffer({ label: "node-morph-empty-ubo", size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    engine._device.queue.writeBuffer(weightsBuffer, 0, new Uint8Array(ubo));
    const entry = { texture, weightsBuffer };
    emptyMorphByEngine.set(engine, entry);
    return entry;
}

interface NodePacket {
    readonly _mesh: Mesh;
    readonly _meshUBO: GPUBuffer;
    readonly _meshBG: GPUBindGroup;
    readonly _meshScratch: Float32Array;
    _lastWorldVersion: number;
    _lastReceivesShadow: number;
    _lastLightsCount: number;
}

type NodeRenderPass = GPURenderPassEncoder | GPURenderBundleEncoder;

/** Build NME renderables for a set of meshes that share a NodeMaterial. */
export function buildNodeMeshRenderables(scene: SceneContext, meshes: Mesh[], materialOverride?: Material): MeshGroupBuildResult {
    const engine = scene.engine;
    const device = engine._device;

    // All meshes in this group use the same NodeMaterial (scene-core batches by ctor).
    // We deliberately do NOT re-group by material instance: each renderable loops
    // packets of the same pipeline. For phase 1 every mesh with an NME material
    // shares that one material instance.
    const byMaterial = new Map<NodeMaterial, Mesh[]>();
    for (const m of meshes) {
        const mat = (materialOverride ?? m.material) as NodeMaterial;
        let list = byMaterial.get(mat);
        if (!list) {
            list = [];
            byMaterial.set(mat, list);
        }
        list.push(m);
    }

    const renderables: Renderable[] = [];

    for (const [material, matMeshes] of byMaterial) {
        const featureFlags = material._renderFeatures?.features ?? 0;
        const noColorOutput = (featureFlags & NODE_NO_COLOR_OUTPUT) !== 0;
        const esmShadowOutput = (featureFlags & NODE_ESM_SHADOW_OUTPUT) !== 0;
        const shadowOutput = noColorOutput || esmShadowOutput;
        const compile = shadowOutput
            ? compileNodePipeline(material._state, material._vertexBody, material._fragmentBody, {
                  _engine: engine,
                  _format: esmShadowOutput ? "rgba16float" : engine.format,
                  _depthStencilFormat: "depth32float",
                  _depthCompare: "less-equal",
                  _msaaSamples: 1,
                  _backFaceCulling: material._graph.backFaceCulling,
                  _noColorOutput: noColorOutput,
                  _esmShadowOutput: esmShadowOutput,
                  _esmShadowDepthCode: esmShadowOutput ? material._esmShadowDepthCode : undefined,
                  _alphaMode: esmShadowOutput ? 0 : undefined,
                  // The shared fragment body still references env IBL/BRDF samplers
                  // (e.g. nmeBrdfLUT) even in the no-color shadow-depth variant, so we
                  // must emit the env decls + BGL entries here too; otherwise WGSL fails
                  // to resolve those identifiers. _envEmitter is undefined for non-env
                  // materials (state.usesEnv === false), leaving them unaffected.
                  _envEmitter: material._envHelpers?.emitEnv,
              })
            : material._compile;
        const meshBGL = compile._meshBGL;

        // Node UBO is per-material (same across all meshes using it).
        let nodeUBO: GPUBuffer | null = null;
        if (compile._nodeUboBinding !== null && compile._nodeUboSize > 0) {
            nodeUBO = device.createBuffer({ label: "node-ubo", size: compile._nodeUboSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            writeNodeUBO(engine, nodeUBO, material);
            material._nodeUBO = nodeUBO;
        }

        const _packMeshWorld = engine._makePackMeshWorld?.(scene as SceneContext) ?? packMat4IntoF32;
        const packets: NodePacket[] = [];
        for (const _mesh of matMeshes) {
            // Mesh UBO layout: world (64B) + receivesShadow (vec4, 16B) + lightCount/indices.
            const meshUboBytes = 96 + 16 * Math.ceil(MAX_LIGHTS / 4);
            const _meshUBO = device.createBuffer({ label: "node-mesh-ubo", size: (meshUboBytes + 15) & ~15, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            const _meshScratch = new Float32Array(((meshUboBytes + 15) & ~15) / 4);
            _packMeshWorld(_meshScratch, _mesh.worldMatrix, 0, 0);
            const recv = _mesh.receiveShadows ? 1 : 0;
            _meshScratch[16] = recv;
            if (compile._usesMeshAttributeFlags) {
                writeAttributeFlags(_mesh, _meshScratch);
            }
            writeMeshLightSelection(_mesh, scene.lights, _meshScratch.subarray(4));
            device.queue.writeBuffer(_meshUBO, 0, _meshScratch);

            const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: _meshUBO } }];
            if (nodeUBO) {
                entries.push({ binding: compile._nodeUboBinding!, resource: { buffer: nodeUBO } });
            }
            for (const tb of compile._textureBindings) {
                const slot = material._textureSlots.get(tb._name);
                const tex = slot?.current;
                if (!tex) {
                    throw new Error(
                        `NodeMaterial: texture binding "${tb._name}" not set. Provide it via options.textures or material.inputs["${tb._name}"].texture before the first render.`
                    );
                }
                entries.push({ binding: tb._texBinding, resource: tex.view });
                entries.push({ binding: tb._sampBinding, resource: tex.sampler });
            }
            if (compile._morphBindings !== null) {
                const mt = (_mesh as { morphTargets?: { texture: GPUTexture; weightsBuffer: GPUBuffer } | null }).morphTargets ?? getEmptyMorph(engine);
                entries.push({ binding: compile._morphBindings._textureBinding, resource: mt.texture.createView() });
                entries.push({ binding: compile._morphBindings._uboBinding, resource: { buffer: mt.weightsBuffer } });
            }
            if (compile._envBindings) {
                material._envHelpers!.pushEnvBindGroupEntries(scene, compile._envBindings, entries);
            }
            for (let si = 0; si < compile._shadowBindings.length; si++) {
                const sb = compile._shadowBindings[si]!;
                const sg = material._shadowGenerators[si];
                if (!sg) {
                    throw new Error(`NodeMaterial: material requires shadow generator #${si} but none was supplied to parseNodeMaterialFromSnippet({ shadowGenerators }).`);
                }
                entries.push({ binding: sb._texBinding, resource: sg._depthTexture.createView() });
                entries.push({ binding: sb._sampBinding, resource: sg._depthSampler });
                entries.push({ binding: sb._uboBinding, resource: { buffer: sg._shadowUBO } });
            }
            if (compile._esmShadowParamsBinding !== null) {
                entries.push({
                    binding: compile._esmShadowParamsBinding,
                    resource: { buffer: material._esmShadowParamsUBO! },
                });
            }
            const _meshBG = device.createBindGroup({ label: "node-mesh-bg", layout: meshBGL, entries });

            packets.push({
                _mesh,
                _meshUBO,
                _meshBG,
                _meshScratch,
                _lastWorldVersion: _mesh.worldMatrixVersion,
                _lastReceivesShadow: recv,
                _lastLightsCount: scene.lights.length,
            });
        }

        // Vertex attribute order (matches compile.state — captured on material).
        const attrNames = material._vertexAttrNames;

        const updatePacketUBO = (pkt: NodePacket): void => {
            const recv = pkt._mesh.receiveShadows ? 1 : 0;
            const worldVersion = pkt._mesh.worldMatrixVersion;
            const worldChanged = worldVersion !== pkt._lastWorldVersion;
            const recvChanged = recv !== pkt._lastReceivesShadow;
            const lightsChanged = scene.lights.length !== pkt._lastLightsCount;
            if (worldChanged || recvChanged || lightsChanged) {
                _packMeshWorld(pkt._meshScratch, pkt._mesh.worldMatrix, 0, 0);
                pkt._meshScratch[16] = recv;
                if (compile._usesMeshAttributeFlags) {
                    writeAttributeFlags(pkt._mesh, pkt._meshScratch);
                }
                writeMeshLightSelection(pkt._mesh, scene.lights, pkt._meshScratch.subarray(4));
                device.queue.writeBuffer(pkt._meshUBO, 0, pkt._meshScratch as Float32Array<ArrayBuffer>);
                pkt._lastWorldVersion = worldVersion;
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
            const g = pkt._mesh._gpu;
            for (let i = 0; i < attrNames.length; i++) {
                const buf = getAttrBuffer(engine, g, attrNames[i]!);
                pass.setVertexBuffer(i, buf);
            }
            pass.setIndexBuffer(g.indexBuffer, g.indexFormat);
            pass.setBindGroup(1, pkt._meshBG);
            pass.drawIndexed(g.indexCount);
        };

        const isTransparent = !noColorOutput && !esmShadowOutput && material._needsAlphaBlending;

        if (isTransparent) {
            // Transparent materials: one renderable per mesh so each gets an
            // independent _worldCenter for back-to-front distance sorting.
            for (const pkt of packets) {
                const wm = pkt._mesh.worldMatrix as unknown as ArrayLike<number>;
                const cx = pkt._mesh.position?.x ?? wm[12]!;
                const cy = pkt._mesh.position?.y ?? wm[13]!;
                const cz = pkt._mesh.position?.z ?? wm[14]!;
                const sortCenter: [number, number, number] = [cx, cy, cz];
                const _baseUpdate = (): void => {
                    updatePacketUBO(pkt);
                    updateNodeUBO();
                    // Update world center for sorting.
                    const m = pkt._mesh.worldMatrix as unknown as ArrayLike<number>;
                    sortCenter[0] = m[12]!;
                    sortCenter[1] = m[13]!;
                    sortCenter[2] = m[14]!;
                };
                const _invalidate = (): void => {
                    pkt._lastWorldVersion = -1;
                };
                const update = engine._wrapRenderableForFO?.(_baseUpdate, scene as SceneContext, _invalidate) ?? _baseUpdate;
                const draw = (pass: NodeRenderPass): number => {
                    drawPacket(pass, pkt);
                    return 1;
                };
                const rTrans: Renderable = {
                    order: 200,
                    isTransparent: true,
                    mesh: pkt._mesh,
                    _worldCenter: sortCenter,
                    bind() {
                        return { renderable: rTrans, pipeline: compile._pipeline, update, draw };
                    },
                };
                renderables.push(rTrans);
            }
        } else {
            // Opaque: batch all meshes into one renderable for state efficiency.
            const _baseUpdate = (): void => {
                for (const pkt of packets) {
                    updatePacketUBO(pkt);
                }
                updateNodeUBO();
            };
            const _invalidate = (): void => {
                for (const pkt of packets) {
                    pkt._lastWorldVersion = -1;
                }
            };
            const update = engine._wrapRenderableForFO?.(_baseUpdate, scene as SceneContext, _invalidate) ?? _baseUpdate;
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
                    return { renderable: rOpaque, pipeline: compile._pipeline, update, draw };
                },
            };
            renderables.push(rOpaque);
        }
    }

    const rebuildSingle = (s: SceneContext, mesh: Mesh, override?: Material): Renderable => {
        return buildNodeMeshRenderables(s, [mesh], override).renderables[0]!;
    };

    return { renderables, rebuildSingle };
}

// Per-gpu-object cached zero buffers for attributes that a NodeMaterial's
// vertex layout declares but the mesh itself doesn't provide (e.g. vertex
// color on meshes that don't use VERTEXCOLOR). We allocate one zero buffer
// lazily per gpu object, sized to its position vertex count × stride.
const zeroAttrCache = new WeakMap<object, Map<string, GPUBuffer>>();
function getZeroAttrBuffer(engine: EngineContext, gpu: MeshGPU, name: string): GPUBuffer {
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
    const buf = engine._device.createBuffer({ label: `node-zero-${name}`, size: vertexCount * stride, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    // Initialize with zeros (buffer starts zeroed when not mappedAtCreation).
    cache.set(name, buf);
    return buf;
}

function getAttrBuffer(engine: EngineContext, gpu: MeshGPU, name: string): GPUBuffer {
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

function writeAttributeFlags(mesh: Mesh, scratch: Float32Array): void {
    const gpu = mesh._gpu;
    scratch[17] = gpu.hasUv === false ? 0 : 1;
    scratch[18] = gpu.hasTangent ? 1 : 0;
    scratch[19] = gpu.hasColor ? 1 : 0;
}
