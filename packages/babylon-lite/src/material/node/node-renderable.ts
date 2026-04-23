/** Node Material — MeshGroupBuilder + Renderable implementation.
 *
 *  Parallel to `standard-renderable.ts`. Each NodeMaterial owns one compile
 *  result (pipeline + BGLs); this builder creates per-mesh GPU resources
 *  (mesh UBO, node UBO, scene UBO, bind groups) and returns a Renderable
 *  that emits draws in the main pass.
 */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Mesh, MeshInternal } from "../../mesh/mesh.js";
import type { Renderable, SceneUniformUpdater } from "../../render/renderable.js";
import { updateSceneUniforms } from "../standard/standard-material.js";
import { getViewProjectionMatrix, getViewMatrix, getCameraPosition } from "../../camera/camera.js";
import { writeLightsUBO, refreshLightsUBO, getLightsUboSize, computeLightsVersion } from "../../render/lights-ubo.js";
import type { NodeMaterialInternal } from "./node-material.js";
import { writeNodeUBO } from "./node-material.js";

interface NodePacket {
    readonly mesh: Mesh;
    readonly meshUBO: GPUBuffer;
    readonly meshBG: GPUBindGroup;
    _lastWorldVersion: number;
}

/** Build NME renderables for a set of meshes that share a NodeMaterial. */
export function buildNodeMeshRenderables(scene: SceneContext, meshes: Mesh[]): { renderables: Renderable[]; updater: SceneUniformUpdater } {
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
    // First scene UBO wins as the shared one the updater writes into.
    let sharedSceneUBO: GPUBuffer | null = null;

    // Shared NME lights UBO — created lazily when any material requires it.
    let nmeLightsUBO: GPUBuffer | null = null;
    let nmeLightsScratch: Float32Array | null = null;
    let lastLightsVersion = -1;
    function ensureLightsUBO(): GPUBuffer {
        if (!nmeLightsUBO) {
            nmeLightsUBO = writeLightsUBO(engine, scene.lights);
            nmeLightsScratch = new Float32Array(getLightsUboSize() / 4);
            lastLightsVersion = computeLightsVersion(scene.lights);
        }
        return nmeLightsUBO;
    }

    for (const [material, matMeshes] of byMaterial) {
        const compile = material._compile;
        const sceneBGL = compile.sceneBGL;
        const meshBGL = compile.meshBGL;

        // One scene UBO per material (cheap; scenes are small).
        const sceneUBO = device.createBuffer({ label: "node-scene-ubo", size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const sceneBG = device.createBindGroup({ label: "node-scene-bg", layout: sceneBGL, entries: [{ binding: 0, resource: { buffer: sceneUBO } }] });
        material._sceneUBO = sceneUBO;
        if (!sharedSceneUBO) {
            sharedSceneUBO = sceneUBO;
        }

        // Node UBO is per-material (same across all meshes using it).
        let nodeUBO: GPUBuffer | null = null;
        if (compile.nodeUboBinding !== null && compile.nodeUboSize > 0) {
            nodeUBO = device.createBuffer({ label: "node-ubo", size: compile.nodeUboSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            writeNodeUBO(engine, nodeUBO, material);
            material._nodeUBO = nodeUBO;
        }

        const packets: NodePacket[] = [];
        for (const mesh of matMeshes) {
            const meshUBO = device.createBuffer({ label: "node-mesh-ubo", size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            device.queue.writeBuffer(meshUBO, 0, mesh.worldMatrix as unknown as Float32Array<ArrayBuffer>);

            const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: meshUBO } }];
            if (nodeUBO) {
                entries.push({ binding: compile.nodeUboBinding!, resource: { buffer: nodeUBO } });
            }
            for (const tb of compile.textureBindings) {
                const slot = material._textureSlots.get(tb.name);
                const tex = slot?.current;
                if (!tex) {
                    throw new Error(`NodeMaterial: texture binding "${tb.name}" not set. Provide it via options.textures or material.inputs["${tb.name}"].texture before the first render.`);
                }
                entries.push({ binding: tb.texBinding, resource: tex.view });
                entries.push({ binding: tb.sampBinding, resource: tex.sampler });
            }
            if (compile.lightsBinding !== null) {
                entries.push({ binding: compile.lightsBinding, resource: { buffer: ensureLightsUBO() } });
            }
            if (compile.morphBindings !== null) {
                const mt = (mesh as { morphTargets?: { texture: GPUTexture; weightsBuffer: GPUBuffer } | null }).morphTargets;
                if (!mt) {
                    throw new Error(
                        `NodeMaterial: material uses MorphTargetsBlock but mesh "${mesh.name ?? "(unnamed)"}" has no morphTargets. ` +
                            `Assign mesh.morphTargets = createMorphTargets(engine, …) before rendering.`
                    );
                }
                entries.push({ binding: compile.morphBindings.textureBinding, resource: mt.texture.createView() });
                entries.push({ binding: compile.morphBindings.uboBinding, resource: { buffer: mt.weightsBuffer } });
            }
            const meshBG = device.createBindGroup({ label: "node-mesh-bg", layout: meshBGL, entries });

            packets.push({ mesh, meshUBO, meshBG, _lastWorldVersion: mesh.worldMatrixVersion });
        }

        // Vertex attribute order (matches compile.state — captured on material).
        const attrNames = material._vertexAttrNames;

        renderables.push({
            order: 100,
            isTransparent: false,
            _pipeline: compile.pipeline,
            _sceneBG: sceneBG,
            updateUBOs(): void {
                for (const pkt of packets) {
                    if (pkt.mesh.worldMatrixVersion !== pkt._lastWorldVersion) {
                        device.queue.writeBuffer(pkt.meshUBO, 0, pkt.mesh.worldMatrix as unknown as Float32Array<ArrayBuffer>);
                        pkt._lastWorldVersion = pkt.mesh.worldMatrixVersion;
                    }
                }
                if (nodeUBO && material._uboDirty) {
                    material._uboDirty = false;
                    writeNodeUBO(engine, nodeUBO, material);
                }
            },
            draw(pass: GPURenderPassEncoder | GPURenderBundleEncoder): number {
                let draws = 0;
                for (const pkt of packets) {
                    const g = (pkt.mesh as MeshInternal)._gpu;
                    for (let i = 0; i < attrNames.length; i++) {
                        const buf = getAttrBuffer(g, attrNames[i]!);
                        pass.setVertexBuffer(i, buf);
                    }
                    pass.setIndexBuffer(g.indexBuffer, g.indexFormat);
                    pass.setBindGroup(1, pkt.meshBG);
                    pass.drawIndexed(g.indexCount);
                    draws++;
                }
                return draws;
            },
        });
    }

    const updater: SceneUniformUpdater = {
        update(eng): void {
            const cam = scene.camera;
            if (!cam) {
                return;
            }
            const aspect = eng.canvas.width / eng.canvas.height;
            const vp = getViewProjectionMatrix(cam, aspect);
            const v = getViewMatrix(cam);
            const eye = getCameraPosition(cam);
            const eyeTuple: [number, number, number] = [eye.x, eye.y, eye.z];
            for (const material of byMaterial.keys()) {
                const ubo = material._sceneUBO;
                if (ubo) {
                    updateSceneUniforms(engine, ubo, vp as Float32Array, v as Float32Array, eyeTuple);
                }
            }
            if (nmeLightsUBO && nmeLightsScratch) {
                const v2 = computeLightsVersion(scene.lights);
                if (v2 !== lastLightsVersion) {
                    lastLightsVersion = v2;
                    refreshLightsUBO(engine, nmeLightsUBO, scene.lights, nmeLightsScratch);
                }
            }
        },
    };

    return { renderables, updater };
}

function getAttrBuffer(gpu: MeshInternal["_gpu"], name: string): GPUBuffer {
    switch (name) {
        case "position":
            return gpu.positionBuffer;
        case "normal":
            return gpu.normalBuffer;
        case "uv":
            return gpu.uvBuffer;
        case "uv2":
            if (!gpu.uv2Buffer) {
                throw new Error("NodeMaterial: mesh has no uv2 buffer");
            }
            return gpu.uv2Buffer;
        default:
            throw new Error(`NodeMaterial: unsupported attribute "${name}"`);
    }
}
