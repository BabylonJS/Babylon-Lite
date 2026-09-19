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
    _drawArgs?: GPUBuffer | null;
    _disposed?: boolean;
    _owner?: NodePacket[];
    _onOwnerEmpty?: () => void;
}

type NodeDisposer = (() => void) & { p: NodePacket };

type NodeRenderPass = GPURenderPassEncoder | GPURenderBundleEncoder;

/** Build NME renderables for a set of meshes that share a NodeMaterial. */
export function buildNodeMeshRenderables(scene: SceneContext, meshes: Mesh[], materialOverride?: Material, resources?: MeshRebuildResources): MeshGroupBuildResult {
    const createdDisposers: (() => void)[] = [];
    const mainRegistrations: Array<{ mesh: Mesh; dispose: NodeDisposer }> = [];
    try {
        return buildNodeMeshRenderablesImpl(scene, meshes, materialOverride, resources, createdDisposers, mainRegistrations);
    } catch (error) {
        for (const { mesh, dispose } of mainRegistrations) {
            const registered = scene._meshDisposables.get(mesh);
            const index = registered?.indexOf(dispose) ?? -1;
            if (index >= 0) {
                registered!.splice(index, 1);
                if (registered!.length === 0) {
                    scene._meshDisposables.delete(mesh);
                }
            }
        }
        if (!resources) {
            for (const dispose of createdDisposers) {
                removeCallback(scene._disposables, dispose);
            }
        }
        for (let i = createdDisposers.length - 1; i >= 0; i--) {
            createdDisposers[i]!();
        }
        throw error;
    }
}

function buildNodeMeshRenderablesImpl(
    scene: SceneContext,
    meshes: Mesh[],
    materialOverride: Material | undefined,
    resources: MeshRebuildResources | undefined,
    createdDisposers: (() => void)[],
    mainRegistrations: Array<{ mesh: Mesh; dispose: NodeDisposer }>
): MeshGroupBuildResult {
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
        const nodeSpec = compile._nodeUboSpec;
        const nodeUBO = nodeSpec && nodeSpec._totalBytes > 0 ? createEmptyUniformBuffer(engine, nodeSpec._totalBytes, "node-ubo") : null;
        let nodeUboDisposed = false;
        const disposeNodeUbo = (): void => {
            if (!nodeUboDisposed) {
                nodeUboDisposed = true;
                nodeUBO?.destroy();
            }
        };
        if (nodeUBO) {
            createdDisposers.push(disposeNodeUbo);
            lifetimeDisposers.push(disposeNodeUbo);
            writeNodeUBO(engine, nodeUBO, material);
        }
        let livePackets = matMeshes.length;

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
            const packet = {} as NodePacket;
            let resourcesDisposed = false;
            const dispose = Object.assign(
                () => {
                    if (!resources) {
                        removeCallback(scene._disposables, dispose);
                    }
                    if (packet._mesh) {
                        packet._disposed = true;
                        const owner = packet._owner;
                        if (owner) {
                            const index = owner.indexOf(packet);
                            if (index >= 0) {
                                owner.splice(index, 1);
                            }
                            packet._owner = undefined;
                            if (owner.length === 0) {
                                packet._onOwnerEmpty?.();
                            }
                        } else {
                            packet._onOwnerEmpty?.();
                        }
                        packet._onOwnerEmpty = undefined;
                    }
                    if (resourcesDisposed) {
                        return;
                    }
                    resourcesDisposed = true;
                    _meshUBO.destroy();
                    if (--livePackets === 0) {
                        disposeNodeUbo();
                        if (!resources) {
                            removeCallback(scene._disposables, disposeNodeUbo);
                        }
                    }
                },
                { p: packet }
            );
            createdDisposers.push(dispose);
            lifetimeDisposers.push(dispose);

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

            Object.assign(packet, {
                _mesh,
                _meshUBO,
                _meshBG,
                _meshScratch,
                _lastWorldVersion: _mesh.worldMatrixVersion,
                _lastReceivesShadow: recv,
                _lastLightsCount: writeMeshFeature ? scene.lights.length : 0,
            });
            packets.push(packet);
            if (!resources) {
                const disposers = scene._meshDisposables.get(_mesh) ?? [];
                disposers.push(dispose);
                scene._meshDisposables.set(_mesh, disposers);
                mainRegistrations.push({ mesh: _mesh, dispose });
            }
        }

        // Vertex attribute order (matches compile.state — captured on material).
        const attrNames = material._vertexAttrNames;
        const hasInstanceWorld = attrNames.includes("world0");

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

        const syncPacketThinInstances = (pkt: NodePacket): void => {
            const ti = pkt._mesh.thinInstances;
            if (ti && hasInstanceWorld) {
                pkt._drawArgs = material._syncThinInstanceForDraw!(engine, ti, false, pkt._mesh._gpu);
            }
        };

        const drawPacket = (pass: NodeRenderPass, pkt: NodePacket): void => {
            const g = pkt._mesh._gpu;
            const ti = pkt._mesh.thinInstances;
            syncPacketThinInstances(pkt);
            for (let i = 0; i < attrNames.length; i++) {
                const name = attrNames[i]!;
                const buf = name.startsWith("world") && ti?._gpuBuffer ? ti._gpuBuffer : getAttrBuffer(engine, g, name);
                pass.setVertexBuffer(i, buf);
            }
            pass.setIndexBuffer(g.indexBuffer, g.indexFormat);
            pass.setBindGroup(1, pkt._meshBG);
            if (pkt._drawArgs) {
                pass.drawIndexedIndirect(pkt._drawArgs, 0);
            } else {
                pass.drawIndexed(g.indexCount, hasInstanceWorld ? ti?.count : 1, 0, g._baseVertex);
            }
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
                    if (pkt._disposed || pkt._mesh.visible === false || (!materialOverride && pkt._mesh.material !== material)) {
                        return;
                    }
                    updatePacketUBO(pkt);
                    updateNodeUBO();
                    syncPacketThinInstances(pkt);
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
                    if (pkt._disposed || pkt._mesh.visible === false || (!materialOverride && pkt._mesh.material !== material)) {
                        return 0;
                    }
                    drawPacket(pass, pkt);
                    return 1;
                };
                const rTrans: Renderable = {
                    order: 200,
                    isTransparent: true,
                    mesh: pkt._mesh,
                    _worldCenter: sortCenter,
                    bind() {
                        return { renderable: rTrans, pipeline: compile._pipelineForMesh(pkt._mesh._gpu), update, draw };
                    },
                };
                if (!resources) {
                    pkt._onOwnerEmpty = () => {
                        detachRenderable(scene, material, rTrans);
                    };
                }
                renderables.push(rTrans);
            }
        } else {
            for (const selectedPackets of groupNodeMeshPackets(packets)) {
                if (selectedPackets.length > 1) {
                    for (const packet of selectedPackets) {
                        packet._owner = selectedPackets;
                    }
                }
                const _baseUpdate = (): void => {
                    for (const pkt of selectedPackets) {
                        if (pkt._disposed || pkt._mesh.visible === false || (!materialOverride && pkt._mesh.material !== material)) {
                            continue;
                        }
                        updatePacketUBO(pkt);
                        syncPacketThinInstances(pkt);
                    }
                    if (selectedPackets.length) {
                        updateNodeUBO();
                    }
                };
                const _invalidate = (): void => {
                    for (const pkt of selectedPackets) {
                        pkt._lastWorldVersion = -1;
                    }
                };
                const update = engine._wrapRenderableForFO?.(_baseUpdate, scene as SceneContext, _invalidate) ?? _baseUpdate;
                const draw = (pass: NodeRenderPass): number => {
                    let draws = 0;
                    for (const pkt of selectedPackets) {
                        if (pkt._disposed || pkt._mesh.visible === false || (!materialOverride && pkt._mesh.material !== material)) {
                            continue;
                        }
                        drawPacket(pass, pkt);
                        draws++;
                    }
                    return draws;
                };
                const rOpaque: Renderable = {
                    order: 100,
                    isTransparent: false,
                    mesh: selectedPackets.length === 1 ? selectedPackets[0]!._mesh : undefined,
                    bind() {
                        return { renderable: rOpaque, pipeline: compile._pipelineForMesh(selectedPackets[0]!._mesh._gpu), update, draw };
                    },
                };
                if (!resources) {
                    for (const packet of selectedPackets) {
                        packet._onOwnerEmpty = () => {
                            detachRenderable(scene, material, rOpaque);
                        };
                    }
                }
                renderables.push(rOpaque);
            }
        }
    }

    const rebuildSingle = (s: SceneContext, mesh: Mesh, override?: Material, rebuildResources?: MeshRebuildResources): Renderable => {
        return buildNodeMeshRenderables(s, [mesh], override, rebuildResources).renderables[0]!;
    };

    return { renderables, rebuildSingle };
}

function detachRenderable(scene: SceneContext, material: NodeMaterial, renderable: Renderable): void {
    const renderableIndex = scene._renderables?.indexOf(renderable) ?? -1;
    if (renderableIndex >= 0) {
        scene._renderables.splice(renderableIndex, 1);
    }
    const output = scene._groups?.get(material._buildGroup)?.o;
    const outputIndex = output?.indexOf(renderable) ?? -1;
    if (outputIndex >= 0) {
        output!.splice(outputIndex, 1);
    }
}

function removeCallback(callbacks: (() => void)[], callback: () => void): void {
    const index = callbacks.indexOf(callback);
    if (index >= 0) {
        callbacks.splice(index, 1);
    }
}

function groupNodeMeshPackets(packets: NodePacket[]): Iterable<NodePacket[]> {
    const first = packets[0]?._mesh._gpu._vbKey ?? "";
    for (const packet of packets) {
        if ((packet._mesh._gpu._vbKey ?? "") !== first) {
            const groups = new Map<string, NodePacket[]>();
            for (const groupedPacket of packets) {
                const key = groupedPacket._mesh._gpu._vbKey ?? "";
                const group = groups.get(key);
                if (group) {
                    group.push(groupedPacket);
                } else {
                    groups.set(key, [groupedPacket]);
                }
            }
            return groups.values();
        }
    }
    return [packets];
}

// Legacy tightly packed geometry uses per-GPU zero buffers. GPU-produced ranges
// opt into the shared constant stream before reaching this cache.
let zeroAttrCache: WeakMap<MeshGPU, Record<string, GPUBuffer | undefined>> | null = null;
function getZeroAttrBuffer(engine: EngineContext, gpu: MeshGPU, name: "uv2" | "tangent" | "color"): GPUBuffer {
    const constant = engine._getVertexDefaultBuffer?.(gpu);
    if (constant) {
        return constant;
    }
    let cache = zeroAttrCache?.get(gpu);
    if (!cache) {
        cache = Object.create(null) as Record<string, GPUBuffer | undefined>;
        (zeroAttrCache ??= new WeakMap()).set(gpu, cache);
    }
    return (cache[name] ??= engine._device.createBuffer({
        label: `node-zero-${name}`,
        size: Math.max((gpu._vbLayout?.position?._count ?? Math.floor(gpu.positionBuffer.size / 12)) * (name === "uv2" ? 8 : 16), 4),
        usage: BU.VERTEX | BU.COPY_DST,
    }));
}

export function getAttrBuffer(engine: EngineContext, gpu: MeshGPU, name: string): GPUBuffer {
    let buffer: GPUBuffer | null | undefined;
    switch (name) {
        case "position":
            return gpu.positionBuffer;
        case "normal":
            return gpu.normalBuffer;
        case "uv":
            return gpu.uvBuffer;
        case "uv2":
            buffer = gpu.uv2Buffer;
            break;
        case "tangent":
            buffer = gpu.tangentBuffer;
            break;
        case "color":
            buffer = gpu.colorBuffer;
            break;
        default:
            throw new Error(`NodeMaterial: unsupported attribute "${name}"`);
    }
    return buffer ?? getZeroAttrBuffer(engine, gpu, name);
}

export function writeAttributeFlags(mesh: Mesh, scratch: Float32Array): void {
    const gpu = mesh._gpu;
    scratch[17] = gpu.hasUv === false ? 0 : 1;
    scratch[18] = gpu.hasTangent ? 1 : 0;
    scratch[19] = gpu.hasColor ? 1 : 0;
}
