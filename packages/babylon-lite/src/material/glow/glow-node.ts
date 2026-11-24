/** NodeMaterial glow mode, loaded only by a glow task whose population has a NodeMaterial with a connected glow input.
 *
 *  As in Babylon.js, the mesh renders through its own material shader (vertex graph, deformation, uniforms,
 *  textures and blending) and outputs `vec4(glow, a)` instead of its colour. The material's build state already
 *  contains the glow chain, so the glow pipeline shares its bindings and uniform layout and differs only by
 *  its final output assignment and render-target signature. */
import { F32 } from "../../engine/typed-arrays.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { NodeMaterial } from "../node/node-material.js";
import { compileNodePipeline } from "../node/node-pipeline.js";
import type { NodeCompileResult } from "../node/node-pipeline.js";
import { getAttrBuffer, writeAttributeFlags } from "../node/node-renderable.js";
import { createEmptyUniformBuffer } from "../../resource/empty-uniform-buffer.js";
import { retireGpuResources } from "../../engine/gpu-resource-retirement.js";
import { wgsl } from "../../shader/wgsl.js";
import type { GlowMaterialContext, GlowMaterialDraw } from "./glow-material.js";
import { _rightHanded } from "#coordinate-system";

/** @internal One NodeMaterial compiled for a task's glow map, with that task's copy of its uniforms. */
export interface GlowNodeProgram {
    readonly device: GPUDevice;
    readonly compile: NodeCompileResult;
    readonly buffer: GPUBuffer | null;
    readonly data: Float32Array | null;
    /** The material's uniform slots, fixed at parse time; their values change in place. */
    readonly slots: readonly NonNullable<ReturnType<NodeMaterial["_uniformValues"]["get"]>>[];
    readonly instanced: boolean;
    /** Context frame of the last uniform synchronization; -1 before the first upload. */
    frame: number;
    refs: number;
}

/** @internal A mesh's glow-mode bindings. */
export interface GlowNodeDraw {
    readonly program: GlowNodeProgram;
    readonly buffer: GPUBuffer;
    readonly data: Float32Array;
    group: GPUBindGroup | null;
    lights: number;
}

/** @internal Compile a material's glow program once per task; shadow receivers first load their sampling code. */
export async function prepareGlowNode(context: GlowMaterialContext, material: NodeMaterial): Promise<void> {
    if (context.disposed || context.programs.has(material)) {
        return;
    }
    const state = material._state;
    const shadows = state.shadowLights.length ? await (await import("../node/node-shadow-emitter.js")).prepareNodeShadowEmitter(state.shadowLights) : undefined;
    // The task may have been disposed, or another call may have compiled this program, while the emitter loaded.
    if (context.disposed || context.programs.has(material)) {
        return;
    }
    const [color, alpha] = state._glowOutput!;
    const graph = material._graph;
    const compile = compileNodePipeline(
        state,
        material._vertexBody,
        wgsl`${material._fragmentBody}\n_NME_FRAG_OUTPUT_ = vec4<f32>(${color.expr}, ${alpha ? alpha.expr : "1.0"});`,
        {
            _engine: context.engine,
            _format: context.format,
            _depthStencilFormat: "depth32float",
            _msaaSamples: 1,
            _backFaceCulling: graph.backFaceCulling,
            _alphaMode: graph.needsAlphaBlending ? graph.alphaMode : 0,
            _envEmitter: material._envHelpers?.emitEnv,
            _shadowEmitter: shadows,
        }
    );
    const bytes = compile._nodeUboSpec?._totalBytes ?? 0;
    context.programs.set(material, {
        device: context.engine._device,
        compile,
        buffer: bytes ? createEmptyUniformBuffer(context.engine, bytes, "glow-node-ubo") : null,
        data: bytes ? new F32(bytes / 4) : null,
        slots: [...material._uniformValues.values()],
        instanced: material._vertexAttrNames.includes("world0") || state.usesInstanceIndex,
        frame: -1,
        refs: 0,
    });
}

/** @internal Release a draw's glow-mode bindings, and its program once unused. */
export function releaseGlowNodeDraw(context: GlowMaterialContext, draw: GlowMaterialDraw): void {
    const own = draw.own;
    if (!own) {
        return;
    }
    draw.own = null;
    const program = own.program;
    const last = --program.refs === 0;
    if (last) {
        for (const [material, value] of context.programs) {
            if (value === program) {
                context.programs.delete(material);
            }
        }
    }
    retireGpuResources(context.engine, () => {
        own.buffer.destroy();
        if (last) {
            program.buffer?.destroy();
        }
    });
}

/** @internal Destroy every program not compiled for `keep` (all of them on task disposal); their draws must already be released. */
export function disposeGlowNodePrograms(context: GlowMaterialContext, keep?: GPUDevice): void {
    for (const [material, program] of context.programs) {
        if (program.device !== keep) {
            program.buffer?.destroy();
            context.programs.delete(material);
        }
    }
}

/** Upload the material's uniforms at most once per frame, and only when one changed. */
function syncUniforms(context: GlowMaterialContext, program: GlowNodeProgram): void {
    if (program.frame === context.frame) {
        return;
    }
    const data = program.data;
    let dirty = program.frame < 0;
    program.frame = context.frame;
    if (!data) {
        return;
    }
    const slots = program.slots;
    for (let s = 0; s < slots.length; s++) {
        const slot = slots[s]!;
        const values = slot._values;
        const offset = slot._offsetBytes >> 2;
        for (let i = 0; i < values.length; i++) {
            if (data[offset + i] !== values[i]) {
                data[offset + i] = values[i]!;
                dirty = true;
            }
        }
    }
    if (dirty) {
        context.engine._device.queue.writeBuffer(program.buffer!, 0, data as Float32Array<ArrayBuffer>);
    }
}

function bind(context: GlowMaterialContext, draw: GlowMaterialDraw, own: GlowNodeDraw, material: NodeMaterial): void {
    const compile = own.program.compile;
    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: own.buffer } }];
    if (own.program.buffer) {
        entries.push({ binding: compile._nodeUboBinding!, resource: { buffer: own.program.buffer } });
    }
    const textures = compile._textureBindings;
    for (let i = 0; i < textures.length; i++) {
        const binding = textures[i]!;
        const texture = material._textureSlots.get(binding._name)?.current ?? null;
        if (!texture) {
            throw new Error(`NodeMaterial: texture binding "${binding._name}" not set.`);
        }
        if (texture.texture === context.targetTexture) {
            throw new Error("GlowPostProcessTask cannot sample its own emissive render attachment.");
        }
        entries.push({ binding: binding._texBinding, resource: texture.view }, { binding: binding._sampBinding, resource: texture.sampler });
    }
    compile._bindVertexFeature?.(context.engine, draw.mesh, entries);
    if (compile._envBindings) {
        material._envHelpers!.pushEnvBindGroupEntries(context.scene, compile._envBindings, entries);
    }
    for (let i = 0; i < compile._shadowBindings.length; i++) {
        const binding = compile._shadowBindings[i]!;
        const generator = material._shadowGenerators[i]!;
        entries.push(
            { binding: binding._texBinding, resource: generator._depthTexture.createView() },
            { binding: binding._sampBinding, resource: generator._depthSampler },
            { binding: binding._uboBinding, resource: { buffer: generator._shadowUBO } }
        );
    }
    own.group = context.engine._device.createBindGroup({ label: "glow-node", layout: compile._meshBGL, entries });
}

/**
 * @internal Bring a glow-mode draw up to date; same contract as `updateGlowDraw`: -1 while its program
 * prepares, 1 when its recorded draw commands changed, otherwise 0.
 */
export function updateGlowNodeDraw(
    context: GlowMaterialContext,
    draw: GlowMaterialDraw,
    refresh: boolean,
    packWorld: (data: Float32Array, world: Mesh["worldMatrix"], offset: number, sourceOffset: number) => void,
    view: number
): number {
    const mesh = draw.mesh;
    const material = draw.surface.source as NodeMaterial;
    const program = context.programs.get(material);
    if (!program) {
        context.loading ??= prepareGlowNode(context, material).then(
            () => {
                context.loading = null;
            },
            (error: unknown) => {
                context.loading = null;
                console.error(error);
            }
        );
        return -1;
    }
    let own = draw.own;
    let rebind = refresh;
    if (!own || own.program !== program) {
        releaseGlowNodeDraw(context, draw);
        const data = new F32(program.compile._meshUboFloats);
        own = draw.own = { program, buffer: createEmptyUniformBuffer(context.engine, data.byteLength, "glow-node-mesh"), data, group: null, lights: -1 };
        program.refs++;
        draw.world = -1;
        rebind = true;
    }
    const compile = program.compile;
    // Like the forward renderable, bindings and pipeline follow source rebuilds (textures, environment, shadows, layout).
    if (rebind) {
        bind(context, draw, own, material);
        draw.pipeline =
            _rightHanded && ((mesh as Mesh & { _primitiveFeatures?: number })._primitiveFeatures ?? 0) & (1 << 11)
                ? compile._pipelineForCcwMesh!(mesh._gpu)
                : compile._pipelineForMesh(mesh._gpu);
    }
    const data = own.data;
    const writeMesh = compile._writeMeshFeature;
    const lights = writeMesh ? context.scene.lights.length : 0;
    const shadows = mesh.receiveShadows ? 1 : 0;
    const world = mesh.worldMatrixVersion;
    if (draw.world !== world || draw.view !== view || own.lights !== lights || data[16] !== shadows) {
        packWorld(data, mesh.worldMatrix, 0, 0);
        data[16] = shadows;
        if (compile._usesMeshAttributeFlags) {
            writeAttributeFlags(mesh, data);
        }
        writeMesh?.(mesh, context.scene.lights, data);
        context.engine._device.queue.writeBuffer(own.buffer, 0, data as Float32Array<ArrayBuffer>);
        draw.world = world;
        draw.view = view;
        own.lights = lights;
    }
    syncUniforms(context, program);
    const instances = program.instanced ? mesh.thinInstances : undefined;
    if (instances) {
        const indirect = material._syncThinInstanceForDraw!(context.engine, instances, false, mesh._gpu);
        if (indirect !== draw.indirect || instances._gpuBuffer !== draw.instances) {
            draw.indirect = indirect;
            draw.instances = instances._gpuBuffer;
            rebind = true;
        }
    } else if (draw.indirect || draw.instances) {
        // No instance input (removed thin instances, or a program without them): draw a single instance.
        draw.indirect = draw.instances = null;
        rebind = true;
    }
    return +rebind;
}

/** @internal Encode one glow-mode draw through the pipeline selected by its update. */
export function drawGlowNode(context: GlowMaterialContext, draw: GlowMaterialDraw, encoder: GPURenderPassEncoder | GPURenderBundleEncoder): void {
    const mesh = draw.mesh;
    const gpu = mesh._gpu;
    const own = draw.own!;
    const names = (draw.surface.source as NodeMaterial)._vertexAttrNames;
    const instances = mesh.thinInstances;
    for (let i = 0; i < names.length; i++) {
        const name = names[i]!;
        encoder.setVertexBuffer(i, name.startsWith("world") && instances?._gpuBuffer ? instances._gpuBuffer : getAttrBuffer(context.engine, gpu, name));
    }
    encoder.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
    encoder.setBindGroup(1, own.group!);
    if (draw.indirect) {
        encoder.drawIndexedIndirect(draw.indirect, 0);
    } else {
        encoder.drawIndexed(gpu.indexCount, own.program.instanced ? instances?.count : 1, gpu._firstIndex ?? 0, gpu._baseVertex);
    }
}
