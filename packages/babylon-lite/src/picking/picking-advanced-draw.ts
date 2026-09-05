import { F32, U32, U8 } from "../engine/typed-arrays.js";
import { BU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { Mat4 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import { createMappedBuffer, createUniformBuffer } from "../resource/gpu-buffers.js";
import type { PickDiscardRule, PickIgnore } from "./gpu-picker.js";
import * as pipelines from "./picking-advanced-pipeline.js";

const UBO_BYTES = 80;
const _scratch = new ArrayBuffer(UBO_BYTES);
const _f32 = new F32(_scratch);
const _u32 = new U32(_scratch);
const _view = new U8(_scratch);

export interface AdvancedCandidate {
    readonly mesh: Mesh;
    readonly ignore: PickIgnore | null;
}

export interface AdvancedMeshRange {
    readonly base: number;
    readonly count: number;
    readonly mesh: Mesh;
    readonly thin: boolean;
    readonly world: Mat4 | null;
    readonly thinVersion: number;
    readonly worldAdjusted: boolean;
}

interface DetailedModule {
    copyDetailedWorldMatrix(source: Mat4): Mat4;
}

function ignoredRange(ignore: PickIgnore | null): readonly [number, number] {
    if (ignore?.thinInstanceRange) {
        return [Math.max(0, ignore.thinInstanceRange.start | 0), Math.max(0, ignore.thinInstanceRange.count | 0)];
    }
    return ignore?.thinInstanceIndex === undefined ? [0, 0] : [Math.max(0, ignore.thinInstanceIndex | 0), 1];
}

function discardGroup(engine: EngineContext, layout: GPUBindGroupLayout, rule: PickDiscardRule, mesh: Mesh, temporary: GPUBuffer[]): GPUBindGroup | null {
    if (!rule.storage?.length) {
        return null;
    }
    const entries: GPUBindGroupEntry[] = [];
    for (let i = 0; i < rule.storage.length; i++) {
        const data = rule.storage[i]!.data(mesh);
        if (!data) {
            return null;
        }
        const buffer = createMappedBuffer(engine, data, BU.STORAGE, "pick-discard-storage");
        temporary.push(buffer);
        entries.push({ binding: i, resource: { buffer } });
    }
    return engine._device.createBindGroup({ layout, entries });
}

export async function prepareAdvancedDraw(
    engine: EngineContext,
    candidates: readonly AdvancedCandidate[]
): Promise<{
    draw(
        pass: GPURenderPassEncoder,
        sceneBG: GPUBindGroup,
        startId: number,
        rule: PickDiscardRule | null,
        detailed: boolean,
        detail: DetailedModule | null,
        temporary: GPUBuffer[],
        detailedPositions: Map<Mesh, Float32Array> | null,
        detailedNormals: Map<Mesh, Float32Array> | null
    ): { readonly nextId: number; readonly ranges: AdvancedMeshRange[] };
}> {
    const vat = candidates.some((candidate) => !!candidate.mesh.vat) ? await import("./vat-picking-pipeline.js") : null;
    // VAT owns the single projection slot, so a VAT mesh never needs the skeleton/morph projection.
    const deform = candidates.some((candidate) => !candidate.mesh.vat && (candidate.mesh.morphTargets || candidate.mesh.skeleton))
        ? await import("./deform-picking-projection.js")
        : null;
    return {
        draw(pass, sceneBG, startId, rule, detailed, detail, temporary, detailedPositions, detailedNormals) {
            let nextId = startId;
            const ranges: AdvancedMeshRange[] = [];
            for (const candidate of candidates) {
                const mesh = candidate.mesh;
                const gpu = mesh._gpu;
                const ti = mesh.thinInstances;
                const vatProjection = vat?.getVatPickingProjection(engine, mesh) ?? null;
                const projection = vatProjection ?? deform?.getDeformPickingProjection(engine, mesh) ?? null;
                const defaults = pipelines.getPickingPipelineSet(engine, null, detailed, projection);
                const discarded = rule ? pipelines.getPickingPipelineSet(engine, rule, detailed, projection) : null;
                const discardBG = rule && discarded?.discardBGL ? discardGroup(engine, discarded.discardBGL, rule, mesh, temporary) : null;
                const set = discarded && (!discarded.discardBGL || discardBG) ? discarded : defaults;
                const activeRule = set === discarded ? rule : null;
                const position = gpu.positionBuffer;
                if (detailedPositions && mesh._cpuPositions) {
                    detailedPositions.set(mesh, mesh._cpuPositions);
                }
                if (detailedNormals && mesh._cpuNormals) {
                    detailedNormals.set(mesh, mesh._cpuNormals);
                }
                const world = detail ? detail.copyDetailedWorldMatrix(mesh.worldMatrix) : null;

                _f32.set(mesh.worldMatrix, 0);
                _u32[16] = nextId;
                if (ti) {
                    if (ti.count <= 0 || !ti._gpuBuffer) {
                        continue;
                    }
                    const [ignoredStart, ignoredCount] = ignoredRange(candidate.ignore);
                    _u32[17] = ignoredStart;
                    _u32[18] = ignoredCount;
                    const ubo = createUniformBuffer(engine, _view, "pick-thin-instance-ubo");
                    temporary.push(ubo);
                    const interleave = gpu._vbLayout?._p;
                    const pipeline = pipelines.getPickingThinInstancePipeline(engine, set, activeRule, interleave);
                    pass.setPipeline(pipeline);
                    pass.setBindGroup(0, sceneBG);
                    pass.setBindGroup(
                        1,
                        engine._device.createBindGroup({
                            layout: pipeline.getBindGroupLayout(1),
                            entries: [
                                { binding: 0, resource: { buffer: ubo } },
                                { binding: 1, resource: { buffer: ti._gpuBuffer } },
                            ],
                        })
                    );
                    if (discardBG) {
                        pass.setBindGroup(2, discardBG);
                    }
                    pass.setVertexBuffer(0, position);
                    if (vatProjection && vat) {
                        vat.bindVatPickingProjection(engine, pass, pipeline, mesh, true, 1);
                    } else if (projection && deform) {
                        deform.bindDeformPickingProjection(engine, pass, pipeline, mesh, 1, !!discardBG);
                    }
                    pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
                    pass.drawIndexed(gpu.indexCount, ti.count, 0, gpu._baseVertex);
                    ranges.push({
                        base: nextId,
                        count: ti.count,
                        mesh,
                        thin: true,
                        world,
                        thinVersion: ti._version,
                        worldAdjusted: !!activeRule?.worldAdjustWgsl || !!vatProjection,
                    });
                    nextId += ti.count;
                    continue;
                }

                const ubo = createUniformBuffer(engine, _view, "pick-mesh-ubo");
                temporary.push(ubo);
                const vertexData = activeRule?.vertexData ? pipelines.getPickVertexDataBinding(mesh, activeRule.vertexData) : null;
                const interleave = gpu._vbLayout?._p;
                const pipeline = pipelines.getPickingRegularPipeline(
                    engine,
                    set,
                    activeRule,
                    interleave,
                    vertexData && activeRule?.vertexData ? { attribute: activeRule.vertexData, interleave: vertexData.interleave } : null
                );
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, sceneBG);
                pass.setBindGroup(
                    1,
                    engine._device.createBindGroup({
                        layout: pipeline.getBindGroupLayout(1),
                        entries: [{ binding: 0, resource: { buffer: ubo } }],
                    })
                );
                if (discardBG) {
                    pass.setBindGroup(2, discardBG);
                }
                pass.setVertexBuffer(0, position);
                if (vertexData) {
                    pass.setVertexBuffer(1, vertexData.buffer);
                }
                if (vatProjection && vat) {
                    vat.bindVatPickingProjection(engine, pass, pipeline, mesh, false, vertexData ? 2 : 1);
                } else if (projection && deform) {
                    deform.bindDeformPickingProjection(engine, pass, pipeline, mesh, vertexData ? 2 : 1, !!discardBG);
                }
                pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
                pass.drawIndexed(gpu.indexCount, 1, 0, gpu._baseVertex);
                ranges.push({
                    base: nextId,
                    count: 1,
                    mesh,
                    thin: false,
                    world,
                    thinVersion: 0,
                    worldAdjusted: !!activeRule?.worldAdjustWgsl || !!vatProjection,
                });
                nextId++;
            }
            return { nextId, ranges };
        },
    };
}
