/** Node Material — MeshGroupBuilder + Renderable implementation.
 *
 *  Parallel to `standard-renderable.ts`. Each NodeMaterial owns one compile
 *  result (pipeline + BGLs); this builder creates per-mesh GPU resources
 *  (mesh UBO, node UBO, bind groups) and returns a Renderable
 *  that emits draws in the main pass.
 */

import { F32 } from "../../engine/typed-arrays.js";
import { BU } from "../../engine/gpu-flags.js";
import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshGPU } from "../../mesh/mesh.js";
import type { MeshGroupBuildResult, MeshRebuildResources, Renderable } from "../../render/renderable.js";
import type { Material } from "../material.js";
import type { NodeMaterial } from "./node-material.js";
import { writeNodeUBO } from "./node-material.js";
import { compileNodePipeline } from "./node-pipeline.js";
import { NODE_ESM_SHADOW_OUTPUT, NODE_NO_COLOR_OUTPUT } from "./node-flags.js";
import { packMat4IntoF32 } from "../../math/pack-mat4-into-f32.js";
import { createEmptyUniformBuffer } from "../../resource/empty-uniform-buffer.js";
import { createUniformBuffer } from "../../resource/uniform-buffer.js";

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
export function buildNodeMeshRenderables(scene: SceneContext, meshes: Mesh[], materialOverride?: Material, resources?: MeshRebuildResources): MeshGroupBuildResult {
    const engine = scene.surface.engine;
    const device = engine._device;
    const lifetimeDisposers = resources?._lifetimeDisposers ?? scene._disposables;

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
        const writeMeshFeature = compile._writeMeshFeature;

        // Node UBO is per-material (same across all meshes using it).
        const nodeUBO = compile._nodeUboBinding !== null && compile._nodeUboSize > 0 ? createEmptyUniformBuffer(engine, compile._nodeUboSize, "node-ubo") : null;
        if (nodeUBO) {
            lifetimeDisposers.push(() => nodeUBO.destroy());
            writeNodeUBO(engine, nodeUBO, material);
        }

        const _packMeshWorld = engine._makePackMeshWorld?.(scene as SceneContext) ?? packMat4IntoF32;
        const packets: NodePacket[] = [];
        for (const _mesh of matMeshes) {
            // Base mesh UBO: world + receivesShadow/attribute flags. Optional
            // mesh features extend and populate the tail.
            const _meshScratch = new F32(compile._meshUboFloats);
            _packMeshWorld(_meshScratch, _mesh.worldMatrix, 0, 0);
            const recv = _mesh.receiveShadows ? 1 : 0;
            _meshScratch[16] = recv;
            if (compile._usesMeshAttributeFlags) {
                writeAttributeFlags(_mesh, _meshScratch);
            }
            writeMeshFeature?.(_mesh, scene.lights, _meshScratch);
            const _meshUBO = createUniformBuffer(engine, _meshScratch, "node-mesh-ubo");
            lifetimeDisposers.push(() => _meshUBO.destroy());

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
            compile._bindVertexFeature?.(engine, _mesh, entries);
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
                _lastLightsCount: writeMeshFeature ? scene.lights.length : 0,
            });
        }

        // Vertex attribute order (matches compile.state — captured on material).
        const attrNames = material._vertexAttrNames;

        const updatePacketUBO = (pkt: NodePacket): void => {
            const recv = pkt._mesh.receiveShadows ? 1 : 0;
            const worldVersion = pkt._mesh.worldMatrixVersion;
            const worldChanged = worldVersion !== pkt._lastWorldVersion;
            const recvChanged = recv !== pkt._lastReceivesShadow;
            const lightsChanged = !!writeMeshFeature && scene.lights.length !== pkt._lastLightsCount;
            if (worldChanged || recvChanged || lightsChanged) {
                _packMeshWorld(pkt._meshScratch, pkt._mesh.worldMatrix, 0, 0);
                pkt._meshScratch[16] = recv;
                if (compile._usesMeshAttributeFlags) {
                    writeAttributeFlags(pkt._mesh, pkt._meshScratch);
                }
                writeMeshFeature?.(pkt._mesh, scene.lights, pkt._meshScratch);
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
                mesh: packets.length === 1 ? packets[0]!._mesh : undefined,
                bind() {
                    return { renderable: rOpaque, pipeline: compile._pipeline, update, draw };
                },
            };
            renderables.push(rOpaque);
        }
    }

    const rebuildSingle = (s: SceneContext, mesh: Mesh, override?: Material, rebuildResources?: MeshRebuildResources): Renderable => {
        return buildNodeMeshRenderables(s, [mesh], override, rebuildResources).renderables[0]!;
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
    const buf = engine._device.createBuffer({ label: `node-zero-${name}`, size: vertexCount * stride, usage: BU.VERTEX | BU.COPY_DST });
    // Initialize with zeros (buffer starts zeroed when not mappedAtCreation).
    cache.set(name, buf);
    return buf;
}

export function getAttrBuffer(engine: EngineContext, gpu: MeshGPU, name: string): GPUBuffer {
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

export function writeAttributeFlags(mesh: Mesh, scratch: Float32Array): void {
    const gpu = mesh._gpu;
    scratch[17] = gpu.hasUv === false ? 0 : 1;
    scratch[18] = gpu.hasTangent ? 1 : 0;
    scratch[19] = gpu.hasColor ? 1 : 0;
}
