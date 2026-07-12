/** ShaderMaterial thin-instance support — dynamically imported ONLY when a
 *  ShaderMaterial scene actually uses thin instances, so non-instanced scenes pull
 *  in zero extra bytes and the shared `shader-renderable.ts` / `shader-pipeline.ts`
 *  chunks stay identical to their non-instanced form.
 *
 *  The renderable helpers this module needs (packet create/update, attribute
 *  buffers, pipeline builders, the plain-mesh builder) are passed in as positional
 *  arguments by `buildShaderGroup`, NOT imported. Importing them would force the
 *  shared chunk to export them, which de-mangles their names and grows every
 *  ShaderMaterial scene's bundle. As parameters they keep their mangled identity in
 *  the shared chunk and are only named here, in this culling/instancing-only chunk.
 *
 *  The instance buffer layout MUST match the buffers produced by
 *  `thin-instance-gpu.ts` (matrix buffer arrayStride 64, 4x float32x4 at offsets
 *  0/16/32/48; color buffer arrayStride 16, float32x4 at offset 0). */

import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Material } from "../material.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import type { UboSpec } from "../../shader/fragment-types.js";
import type { DrawUpdateContext, MeshGroupBuildResult, Renderable } from "../../render/renderable.js";
import type { ShaderAttributeName, ShaderMaterial } from "./shader-material.js";
import type { ShaderPipelineBindings } from "./shader-pipeline.js";
import type { ShaderPacket, ShaderRenderPass } from "./shader-renderable.js";
import { syncThinInstanceBuffers, syncThinInstanceForDraw } from "../../mesh/thin-instance-gpu.js";
import type { UniformCopyBatch } from "../../render/uniform-copy-batch.js";

type CullModule = typeof import("../../mesh/thin-instance-cull-binding.js");

/** The shader-renderable helpers handed in positionally by `buildShaderGroup`. */
interface ShaderHelpers {
    buildPlain: (scene: SceneContext, meshes: Mesh[]) => MeshGroupBuildResult;
    createPacket: (scene: SceneContext, material: ShaderMaterial, systemSpec: UboSpec, mesh: Mesh, aux?: boolean) => ShaderPacket;
    updatePacket: (scene: SceneContext, material: ShaderMaterial, packet: ShaderPacket, context: DrawUpdateContext, uniformBatch?: UniformCopyBatch) => void;
    updateCustomUbo: (engine: EngineContext, material: ShaderMaterial, uniformBatch?: UniformCopyBatch) => void;
    getAttrBuffer: (engine: EngineContext, mesh: Mesh, name: ShaderAttributeName) => GPUBuffer;
    getOrCreateShaderPipeline: (
        engine: EngineContext,
        sig: RenderTargetSignature,
        material: ShaderMaterial,
        bindings: ShaderPipelineBindings,
        variantKey?: string,
        vertexBuffers?: readonly GPUVertexBufferLayout[],
        instanceAttrs?: string
    ) => GPURenderPipeline;
    getOrCreateShaderPipelineBindings: (engine: EngineContext, material: ShaderMaterial) => ShaderPipelineBindings;
    getUniformBatch?: (signature: RenderTargetSignature) => UniformCopyBatch;
}

/** Instance vertex buffer layouts. `baseLocation` is the first free shader
 *  location after the material's own attributes. */
function instanceVertexLayouts(baseLocation: number, hasColor: boolean): GPUVertexBufferLayout[] {
    const layouts: GPUVertexBufferLayout[] = [
        {
            arrayStride: 64,
            stepMode: "instance",
            attributes: [
                { shaderLocation: baseLocation, offset: 0, format: "float32x4" },
                { shaderLocation: baseLocation + 1, offset: 16, format: "float32x4" },
                { shaderLocation: baseLocation + 2, offset: 32, format: "float32x4" },
                { shaderLocation: baseLocation + 3, offset: 48, format: "float32x4" },
            ],
        },
    ];
    if (hasColor) {
        layouts.push({
            arrayStride: 16,
            stepMode: "instance",
            attributes: [{ shaderLocation: baseLocation + 4, offset: 0, format: "float32x4" }],
        });
    }
    return layouts;
}

/** WGSL lines appended inside `VertexInput` for instanced variants. */
function instancePreludeAttributes(baseLocation: number, hasColor: boolean): string {
    let wgsl = `@location(${baseLocation}) world0: vec4<f32>,
@location(${baseLocation + 1}) world1: vec4<f32>,
@location(${baseLocation + 2}) world2: vec4<f32>,
@location(${baseLocation + 3}) world3: vec4<f32>,
`;
    if (hasColor) {
        wgsl += `@location(${baseLocation + 4}) instanceColor: vec4<f32>,
`;
    }
    return wgsl;
}

/** Build ONE thin-instance renderable for a ShaderMaterial mesh (opaque or transparent). */
function createShaderInstancedRenderable(
    scene: SceneContext,
    material: ShaderMaterial,
    packet: ShaderPacket,
    isOverride: boolean,
    h: ShaderHelpers,
    cull?: CullModule
): Renderable {
    const isTransparent = material.needAlphaBlending;
    const mesh = packet.mesh;
    const ti = mesh.thinInstances!;
    // `_tic` is undefined by default; loose comparison maps only the explicit `false` opt-out to zero.
    const hasColor = !!ti.colors && material._tic != 0;
    const baseLocation = material.attributes.length;
    const instanceLayouts = instanceVertexLayouts(baseLocation, hasColor);
    const instanceAttrs = instancePreludeAttributes(baseLocation, hasColor);
    const variantKey = "" + +hasColor;
    const wm = mesh.worldMatrix as unknown as ArrayLike<number>;
    const sortCenter: [number, number, number] = [wm[12]!, wm[13]!, wm[14]!];
    let drawArgs: GPUBuffer | null = null;
    const update = (context: DrawUpdateContext, uniformBatch?: UniformCopyBatch): void => {
        if (packet._disposed) {
            return;
        }
        if (!isOverride && mesh.material !== material) {
            return;
        }
        h.updateCustomUbo(scene.surface.engine, material, uniformBatch);
        h.updatePacket(scene, material, packet, context, uniformBatch);
        drawArgs = syncThinInstanceForDraw(scene.surface.engine, ti, hasColor, mesh._gpu.indexCount);
        if (isTransparent) {
            const m = mesh.worldMatrix as unknown as ArrayLike<number>;
            sortCenter[0] = m[12]!;
            sortCenter[1] = m[13]!;
            sortCenter[2] = m[14]!;
        }
    };
    const draw = (pass: ShaderRenderPass, engine: EngineContext, cullBinding?: import("../../mesh/thin-instance-cull-binding.js").TiCullBinding): number => {
        if (packet._disposed) {
            return 0;
        }
        if (!isOverride && mesh.material !== material) {
            return 0;
        }
        const gpu = mesh._gpu;
        let slot = 0;
        for (let i = 0; i < material.attributes.length; i++) {
            pass.setVertexBuffer(slot++, h.getAttrBuffer(engine, mesh, material.attributes[i]!));
        }
        slot = syncThinInstanceBuffers(engine, ti, pass, slot, hasColor, cullBinding?.cullDrawBufs);
        pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
        pass.setBindGroup(1, packet._bindGroup);
        if (cullBinding) {
            cullBinding.draw(pass, gpu.indexCount, ti.count);
        } else if (drawArgs) {
            pass.drawIndexedIndirect(drawArgs, 0);
        } else {
            pass.drawIndexed(gpu.indexCount, ti.count);
        }
        return 1;
    };
    const r: Renderable = {
        order: mesh.renderOrder ?? (isTransparent ? 200 : 100),
        isTransparent,
        mesh,
        _worldCenter: sortCenter,
        bind(eng, sig) {
            const bindings = h.getOrCreateShaderPipelineBindings(eng, material);
            const vertexBuffers = [...bindings.vertexBuffers, ...instanceLayouts];
            const pipeline = h.getOrCreateShaderPipeline(eng, sig, material, bindings, variantKey, vertexBuffers, instanceAttrs);
            const uniformBatch = h.getUniformBatch?.(sig);
            const baseUpdate = (context: DrawUpdateContext): void => update(context, uniformBatch);
            const cb = cull?.tryBind(r, scene, mesh, eng, hasColor, isTransparent, baseUpdate, sig);
            return {
                renderable: r,
                pipeline,
                _updateBatches: uniformBatch ? (cb ? [uniformBatch, cb._updateBatch] : [uniformBatch]) : cb ? [cb._updateBatch] : undefined,
                update: cb ? cb.update : baseUpdate,
                draw: (pass) => draw(pass, eng, cb),
            };
        },
    };
    return r;
}

/** Build one instanced renderable for `mesh` (used by the combined `rebuildSingle`). */
function buildInstancedSingle(scene: SceneContext, mesh: Mesh, material: ShaderMaterial, isOverride: boolean, h: ShaderHelpers, cull?: CullModule): Renderable {
    const bindings = h.getOrCreateShaderPipelineBindings(scene.surface.engine, material);
    const packet = h.createPacket(scene, material, bindings.systemSpec, mesh, isOverride);
    return createShaderInstancedRenderable(scene, material, packet, isOverride, h, cull);
}

/** Group entry point used whenever a ShaderMaterial scene has at least one
 *  thin-instanced mesh. Plain meshes flow through the passed-in `buildPlain`
 *  (`buildShaderMaterialRenderables`); instanced meshes get a dedicated renderable. */
export function buildShaderRenderablesWithInstancing(
    scene: SceneContext,
    meshes: Mesh[],
    buildPlain: ShaderHelpers["buildPlain"],
    createPacket: ShaderHelpers["createPacket"],
    updatePacket: ShaderHelpers["updatePacket"],
    updateCustomUbo: ShaderHelpers["updateCustomUbo"],
    getAttrBuffer: ShaderHelpers["getAttrBuffer"],
    getOrCreateShaderPipeline: ShaderHelpers["getOrCreateShaderPipeline"],
    getOrCreateShaderPipelineBindings: ShaderHelpers["getOrCreateShaderPipelineBindings"],
    getUniformBatch?: ShaderHelpers["getUniformBatch"],
    cull?: CullModule
): MeshGroupBuildResult {
    const h: ShaderHelpers = {
        buildPlain,
        createPacket,
        updatePacket,
        updateCustomUbo,
        getAttrBuffer,
        getOrCreateShaderPipeline,
        getOrCreateShaderPipelineBindings,
        getUniformBatch,
    };
    const instanced: Mesh[] = [];
    const plain: Mesh[] = [];
    for (const mesh of meshes) {
        if (mesh.thinInstances) {
            instanced.push(mesh);
        } else {
            plain.push(mesh);
        }
    }

    const renderables: Renderable[] = [];
    let plainRebuild: MeshGroupBuildResult["rebuildSingle"] | undefined;
    if (plain.length > 0) {
        const plainResult = buildPlain(scene, plain);
        renderables.push(...plainResult.renderables);
        plainRebuild = plainResult.rebuildSingle;
    }
    for (const mesh of instanced) {
        renderables.push(buildInstancedSingle(scene, mesh, mesh.material as ShaderMaterial, false, h, cull));
    }

    const rebuildSingle = (s: SceneContext, mesh: Mesh, materialOverride?: Material): Renderable => {
        const material = (materialOverride ?? mesh.material) as ShaderMaterial;
        if (mesh.thinInstances) {
            return buildInstancedSingle(s, mesh, material, materialOverride != null, h, cull);
        }
        if (plainRebuild) {
            return plainRebuild(s, mesh, materialOverride);
        }
        return buildPlain(s, [mesh]).rebuildSingle(s, mesh, materialOverride);
    };

    return { renderables, rebuildSingle };
}
