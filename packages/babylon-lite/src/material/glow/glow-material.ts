import type { EngineContext } from "../../engine/engine.js";
import { retireGpuResources } from "../../engine/gpu-resource-retirement.js";
import { F32 } from "../../engine/typed-arrays.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { Material } from "../material.js";
import { getMaterialSource } from "../material-view.js";
import type { NodeMaterial } from "../node/node-material.js";
import type { SceneContext } from "../../scene/scene-core.js";
import { _computeMeshFeatures, MSH_HAS_MORPH_TARGETS, MSH_HAS_SKELETON, MSH_HAS_SKELETON_8, MSH_HAS_THIN_INSTANCES, MSH_VAT } from "../mesh-features.js";
import type { ShaderFragment, ShaderTemplate, ComposedShader, BindingDecl } from "../../shader/fragment-types.js";
import { composeShader } from "../../shader/shader-composer.js";
import { wgsl } from "../../shader/wgsl.js";
import { getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { createEmptyUniformBuffer } from "../../resource/empty-uniform-buffer.js";
import { acquireTexture } from "../../resource/texture-acquire.js";
import { releaseTexture } from "../../resource/texture-release.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import { packMat4IntoF32 } from "../../math/pack-mat4-into-f32.js";
import type { createSkeletonFragment } from "../../shader/fragments/skeleton-fragment.js";
import type { createMorphFragment } from "../../shader/fragments/morph-fragment-core.js";
import type { createThinInstanceFragment } from "../../shader/fragments/thin-instance-fragment.js";
import type { syncThinInstanceBuffers, syncThinInstanceForDraw } from "../../mesh/thin-instance-gpu.js";
import type * as GlowNode from "./glow-node.js";
import type { GlowColor, GlowSurface } from "./glow-source.js";
import { writeGlowUv } from "./glow-source.js";
import { glowBlend } from "./glow-merge.js";
import { _rightHanded } from "#coordinate-system";

/** Mirrored winding (bit 11) and glTF topology (bits 12-15), pre-encoded on PBR meshes by the primitive feature. */
const MIRRORED = 1 << 11;
const PRIMITIVE_BITS = 0xf800;
/** Mesh features that change the glow shader or pipeline; the rest would only split identical variants. */
const GLOW_MESH_FEATURES = MSH_HAS_SKELETON | MSH_HAS_SKELETON_8 | MSH_HAS_MORPH_TARGETS | MSH_HAS_THIN_INSTANCES | MSH_VAT | PRIMITIVE_BITS;

const ALPHA_TEST = 1;
const ALPHA_BLEND = 2;
const DOUBLE_SIDED = 4;
const OPACITY_RGB = 8;
const VERTEX_ALPHA = 16;
/** Shifted by texture slot: diffuse/albedo alpha 0, opacity 1, emissive 2. */
const TEXTURE = 32;
/** Shifted by texture slot: sampled through the second UV set. */
const SECOND_UV = 256;
const LINEAR_EMISSIVE = 2048;
/** Babylon alpha mode of a blended surface (4 bits), then a non-triangle topology (2 bits). */
const BLEND_MODE_SHIFT = 12;
const TOPOLOGY_SHIFT = 16;
const TOPOLOGIES: readonly GPUPrimitiveTopology[] = ["triangle-list", "line-list", "point-list"];
const DRAW_FLOATS = 48;

interface GlowVariant {
    readonly features: number;
    readonly flags: number;
    readonly vertexKey: string | undefined;
    readonly pipeline: GPURenderPipeline;
    readonly layout: GPUBindGroupLayout;
    readonly morph: boolean;
    readonly skeleton: boolean;
    readonly bones8: boolean;
    readonly instances: boolean;
    readonly uv: boolean;
    readonly uv2: boolean;
    readonly vertexAlpha: boolean;
}

/** @internal Task-owned, lazily prepared material resources. */
export interface GlowMaterialContext {
    readonly engine: EngineContext;
    readonly scene: SceneContext;
    readonly format: GPUTextureFormat;
    readonly variants: Map<string, GlowVariant>;
    /** NodeMaterial glow-mode programs, owned by the lazily loaded node module. */
    readonly programs: Map<Material, GlowNode.GlowNodeProgram>;
    targetTexture: GPUTexture | null;
    /** Current task frame, for once-per-frame shared uploads. */
    frame: number;
    skeleton: typeof createSkeletonFragment | null;
    morph: typeof createMorphFragment | null;
    instances: typeof createThinInstanceFragment | null;
    syncInstances: typeof syncThinInstanceBuffers | null;
    updateInstances: typeof syncThinInstanceForDraw | null;
    node: typeof GlowNode | null;
    /** Helpers requested by a mesh introduced after preparation. */
    loading: Promise<void> | null;
    /** Set by task disposal: late asynchronous preparation must not allocate or publish resources. */
    disposed: boolean;
}

/** @internal One draw's material view, uniforms, and borrowed source resources. */
export interface GlowMaterialDraw {
    readonly mesh: Mesh;
    /** Source-material state, refreshed only when the source changes. */
    readonly surface: GlowSurface;
    /** Per-frame selector result; `surface.color` keeps the source color. */
    readonly color: GlowColor;
    readonly data: Float32Array;
    /** Created by the first generic update; glow-mode NodeMaterial draws use their own bindings. */
    buffer: GPUBuffer | null;
    readonly views: (GPUTextureView | GPUSampler | null)[];
    heldTextures: Texture2D[];
    /** Material, `_uboVersion` and task epoch of the last surface read. */
    material: Material | null;
    version: number;
    epoch: number;
    /** Mesh world version and floating-origin view epoch of the packed world matrix. */
    world: number;
    view: number;
    seen: number;
    disposed: boolean;
    variant: GlowVariant | null;
    pipeline: GPURenderPipeline | null;
    group: GPUBindGroup | null;
    boneTexture: GPUTexture | null;
    morphDeltas: GPUBuffer | null;
    morphWeights: GPUBuffer | null;
    indirect: GPUBuffer | null;
    instances: GPUBuffer | null;
    own: GlowNode.GlowNodeDraw | null;
}

/** NodeMaterial whose glow input is connected, rendered through its own shader. */
function ownGlowMaterial(material: Material | null): NodeMaterial | null {
    const source = material && getMaterialSource(material);
    return source?._buildGroup._materialFamily === "node" && (source as NodeMaterial)._state._glowOutput ? (source as NodeMaterial) : null;
}

/** @internal Prepare only the helpers needed by this population: deformation families and NodeMaterial glow programs. */
export async function preloadGlowMaterials(context: GlowMaterialContext, meshes: readonly Mesh[]): Promise<void> {
    const loads: Promise<void>[] = [];
    const own = new Set<NodeMaterial>();
    let skeleton = false;
    let morph = false;
    let instances = false;
    for (const mesh of meshes) {
        const material = ownGlowMaterial(mesh.material);
        if (material) {
            own.add(material);
        } else {
            skeleton ||= !!mesh.skeleton;
            morph ||= !!mesh.morphTargets;
            instances ||= !!mesh.thinInstances;
        }
    }
    if (!context.skeleton && skeleton) {
        loads.push(
            import("../../shader/fragments/skeleton-fragment.js").then((mod) => {
                context.skeleton = mod.createSkeletonFragment;
            })
        );
    }
    if (!context.morph && morph) {
        loads.push(
            import("../../shader/fragments/morph-fragment-core.js").then((mod) => {
                context.morph = mod.createMorphFragment;
            })
        );
    }
    if (!context.instances && instances) {
        loads.push(
            Promise.all([import("../../shader/fragments/thin-instance-fragment.js"), import("../../mesh/thin-instance-gpu.js")]).then(([shader, gpu]) => {
                context.instances = shader.createThinInstanceFragment;
                context.syncInstances = gpu.syncThinInstanceBuffers;
                context.updateInstances = gpu.syncThinInstanceForDraw;
            })
        );
    }
    if (own.size) {
        loads.push(
            import("./glow-node.js").then(async (mod) => {
                context.node = mod;
                await Promise.all([...own].map((material) => mod.prepareGlowNode(context, material)));
            })
        );
    }
    await Promise.all(loads);
}

function makeShader(context: GlowMaterialContext, mesh: Mesh, features: number, flags: number): ComposedShader {
    const morph = !!(features & MSH_HAS_MORPH_TARGETS);
    const textures = (flags >> 5) & 7;
    const second = (flags >> 8) & 7;
    const uv = (textures & ~second) !== 0;
    const uv2 = second !== 0;
    const vertexAlpha = !!(flags & VERTEX_ALPHA);
    const attributes: ShaderTemplate["_baseVertexAttributes"][number][] = [{ _name: "position", _type: "vec3<f32>", _gpuFormat: "float32x3", _arrayStride: 12 }];
    const varyings: ShaderTemplate["_baseVaryings"][number][] = [];
    if (morph) {
        attributes.push({ _name: "normal", _type: "vec3<f32>", _gpuFormat: "float32x3", _arrayStride: 12 });
    }
    if (uv) {
        attributes.push({ _name: "uv", _type: "vec2<f32>", _gpuFormat: "float32x2", _arrayStride: 8 });
        varyings.push({ _name: "uv", _type: "vec2<f32>" });
    }
    if (uv2) {
        attributes.push({ _name: "uv2", _type: "vec2<f32>", _gpuFormat: "float32x2", _arrayStride: 8 });
        varyings.push({ _name: "uv2", _type: "vec2<f32>" });
    }
    if (vertexAlpha) {
        attributes.push({ _name: "color", _type: "vec4<f32>", _gpuFormat: "float32x4", _arrayStride: 16 });
        varyings.push({ _name: "alpha", _type: "f32" });
    }
    const bindings: BindingDecl[] = [];
    const samples: string[] = [];
    for (let i = 0; i < 3; i++) {
        if (flags & (TEXTURE << i)) {
            bindings.push(
                { _name: `t${i}`, _type: { _kind: "texture", _textureType: "texture_2d<f32>" }, _visibility: 2 },
                { _name: `s${i}`, _type: { _kind: "sampler", _samplerType: "sampler" }, _visibility: 2 }
            );
            // The glow map is half resolution, so the affine UV rows are cheaper per fragment than as extra varyings.
            const coord = flags & (SECOND_UV << i) ? "input.uv2" : "input.uv";
            samples[i] = wgsl`textureSample(t${i},s${i},vec2f(dot(mesh.uv${i}a.xy,${coord})+mesh.uv${i}a.z,dot(mesh.uv${i}b.xy,${coord})+mesh.uv${i}b.z))`;
        }
    }
    let fragment = wgsl`var alpha=mesh.glowColor.a;`;
    if (samples[0]) {
        fragment = wgsl`${fragment}alpha*=${samples[0]}.a;`;
    }
    if (samples[1]) {
        fragment = wgsl`${fragment}let opacity=${samples[1]};alpha*=${flags & OPACITY_RGB ? "dot(opacity.rgb,vec3f(0.3,0.59,0.11))" : "opacity.a"}*mesh.glowOptions.x;`;
    }
    if (vertexAlpha) {
        fragment = wgsl`${fragment}alpha*=input.alpha;`;
    }
    if (flags & ALPHA_TEST) {
        fragment = wgsl`${fragment}if(alpha<0.4){discard;}`;
    }
    const color = wgsl`vec4f(mesh.glowColor.rgb,alpha)`;
    if (samples[2]) {
        // Linear sources (PBR, hardware-decoded sRGB, float) are re-encoded with the reference glow pass's 1/2.2 gamma.
        fragment = wgsl`${fragment}let emission=${samples[2]};return ${color}*${flags & LINEAR_EMISSIVE ? "vec4f(pow(emission.rgb,vec3f(1.0/2.2)),emission.a)" : "emission"};`;
    } else {
        fragment = wgsl`${fragment}return ${color};`;
    }
    const template: ShaderTemplate = {
        _baseVertexAttributes: attributes,
        _baseVaryings: varyings,
        _baseMeshUboFields: [
            { _name: "world", _type: "mat4x4<f32>" },
            { _name: "glowColor", _type: "vec4<f32>" },
            ...[0, 1, 2].flatMap((i) => [
                { _name: `uv${i}a`, _type: "vec4<f32>" as const },
                { _name: `uv${i}b`, _type: "vec4<f32>" as const },
            ]),
            { _name: "glowOptions", _type: "vec4<f32>" },
        ],
        _baseBindings: bindings,
        _vertexTemplate: wgsl`/*SU*/
/*MU*/
@group(1)@binding(0)var<uniform>mesh:MeshUniforms;
/*VH*/
/*VD*/
/*VO*/
@vertex fn main(/*VP*/)->VertexOutput{
var out:VertexOutput;
/*VR*/
var finalWorld=mesh.world;
/*VW*/
let worldPosition=finalWorld*vec4f(${morph ? "morphedPos" : "position"},1);
out.clipPos=scene.viewProjection*worldPosition;
${uv ? "out.uv=uv;" : ""}${uv2 ? "out.uv2=uv2;" : ""}${vertexAlpha ? "out.alpha=color.a;" : ""}
/*VB*/
return out;}`,
        _fragmentTemplate: wgsl`/*MU*/
@group(1)@binding(0)var<uniform>mesh:MeshUniforms;
/*FI*/
/*FB*/
@fragment fn main(input:FragmentInput)->@location(0)vec4f{${fragment}}`,
    };
    const fragments: ShaderFragment[] = [];
    if (morph) {
        fragments.push(context.morph!());
    }
    if (features & MSH_HAS_SKELETON) {
        fragments.push(context.skeleton!(!!(features & MSH_HAS_SKELETON_8)));
    }
    if (features & MSH_HAS_THIN_INSTANCES) {
        fragments.push(context.instances!(false));
    }
    let composed = composeShader(template, fragments, mesh._gpu._vbLayout);
    for (const item of fragments) {
        composed = item._pc?.(composed) ?? composed;
    }
    return composed;
}

/** Variant for the draw's current surface, or null while a newly introduced deformation family loads. */
function getVariant(context: GlowMaterialContext, draw: GlowMaterialDraw): GlowVariant | null {
    const mesh = draw.mesh;
    const surface = draw.surface;
    const gpu = mesh._gpu;
    // PBR meshes take their winding and topology from the glTF primitive feature, as their forward pipeline does.
    const features = (_computeMeshFeatures(mesh) | (surface.pbr ? ((mesh as Mesh & { _primitiveFeatures?: number })._primitiveFeatures ?? 0) : 0)) & GLOW_MESH_FEATURES;
    let flags =
        +surface.alphaTest |
        (+surface.alphaBlend << 1) |
        (+surface.doubleSided << 2) |
        (+surface.opacityFromRGB << 3) |
        (+(!!mesh.hasVertexAlpha && !!gpu.colorBuffer) << 4) |
        ((surface.alphaBlend ? surface.alphaMode & 15 : 0) << BLEND_MODE_SHIFT) |
        (surface.topology << TOPOLOGY_SHIFT);
    for (let i = 0; i < 3; i++) {
        const texture = surface.textures[i];
        if (texture) {
            if (texture._sampleType === "depth") {
                throw new Error("GlowPostProcessTask emissive and opacity inputs must be color textures.");
            }
            flags |= TEXTURE << i;
            if (surface.uvChannels[i] && gpu.uv2Buffer) {
                flags |= SECOND_UV << i;
            }
            // PBR treats every emissive sample as linear, matching a reference texture with `gammaSpace = false`.
            if (i === 2 && (surface.pbr || texture.texture.format.endsWith("-srgb") || texture.texture.format.includes("float"))) {
                flags |= LINEAR_EMISSIVE;
            }
        }
    }
    const vertexKey = gpu._vbKey;
    const current = draw.variant;
    if (current && current.features === features && current.flags === flags && current.vertexKey === vertexKey) {
        return current;
    }
    const key = `${features}:${flags}:${vertexKey ?? ""}`;
    const cached = context.variants.get(key);
    if (cached) {
        return cached;
    }
    const morph = !!(features & MSH_HAS_MORPH_TARGETS);
    const skeleton = !!(features & MSH_HAS_SKELETON);
    const instances = !!(features & MSH_HAS_THIN_INSTANCES);
    if (features & MSH_VAT) {
        throw new Error("GlowPostProcessTask does not support baked vertex animation.");
    }
    if (skeleton && instances) {
        throw new Error("GlowPostProcessTask does not support skeletal and thin-instance deformation on the same mesh.");
    }
    if ((skeleton && !context.skeleton) || (morph && !context.morph) || (instances && !context.instances)) {
        // Like an unready reference submesh, the mesh is skipped until its deformation helpers arrive.
        context.loading ??= preloadGlowMaterials(context, [mesh]).then(
            () => {
                context.loading = null;
            },
            (error: unknown) => {
                context.loading = null;
                console.error(error);
            }
        );
        return null;
    }
    const composed = makeShader(context, mesh, features, flags);
    const device = context.engine._device;
    const layout = device.createBindGroupLayout(composed._meshBGLDescriptor);
    const vertex = device.createShaderModule({ label: "glow-vertex", code: composed._vertexWGSL });
    const fragment = device.createShaderModule({ label: "glow-fragment", code: composed._fragmentWGSL });
    const blend = flags & ALPHA_BLEND;
    const mirrored = features & MIRRORED;
    const topology = flags >> TOPOLOGY_SHIFT;
    const pipeline = device.createRenderPipeline({
        label: "glow-emissive",
        layout: device.createPipelineLayout({ bindGroupLayouts: [getSceneBindGroupLayout(context.engine), layout] }),
        vertex: { module: vertex, entryPoint: "main", buffers: composed._vertexBufferLayouts },
        fragment: {
            module: fragment,
            entryPoint: "main",
            // The source material's Babylon alpha mode, as the reference glow map applies it.
            targets: [blend ? { format: context.format, blend: glowBlend((flags >> BLEND_MODE_SHIFT) & 15) } : { format: context.format }],
        },
        depthStencil: { format: "depth32float", depthWriteEnabled: !blend, depthCompare: "greater-equal" },
        primitive: {
            // Topology and strip format only; the winding below already accounts for the mirror bit.
            ...(surface.pbr ? (mesh as Mesh & { _primitive?: GPUPrimitiveState })._primitive : topology ? { topology: TOPOLOGIES[topology] } : undefined),
            cullMode: flags & DOUBLE_SIDED ? "none" : "back",
            // A right-handed engine reverses every camera-pass winding (its view matrix mirrors Z).
            frontFace: _rightHanded ? (mirrored ? "ccw" : "cw") : mirrored ? "cw" : "ccw",
        },
    });
    const textures = (flags >> 5) & 7;
    const second = (flags >> 8) & 7;
    const variant: GlowVariant = {
        features,
        flags,
        vertexKey,
        pipeline,
        layout,
        morph,
        skeleton,
        bones8: !!(features & MSH_HAS_SKELETON_8),
        instances,
        uv: (textures & ~second) !== 0,
        uv2: second !== 0,
        vertexAlpha: !!(flags & VERTEX_ALPHA),
    };
    context.variants.set(key, variant);
    return variant;
}

/** @internal Create one material-owned draw, without changing its source material. */
export function createGlowDraw(_context: GlowMaterialContext, mesh: Mesh): GlowMaterialDraw {
    return {
        mesh,
        surface: {
            source: mesh.material!,
            pbr: false,
            own: false,
            neutral: false,
            alphaMode: 2,
            topology: 0,
            color: { r: 0, g: 0, b: 0, a: 1 },
            textures: [null, null, null],
            uvChannels: [0, 0, 0],
            alphaTest: false,
            alphaBlend: false,
            doubleSided: false,
            opacityFromRGB: false,
            opacityLevel: 1,
            uvScaleX: 1,
            uvScaleY: 1,
            uvOffsetX: 0,
            uvOffsetY: 0,
        },
        color: { r: 0, g: 0, b: 0, a: 1 },
        data: new F32(DRAW_FLOATS),
        buffer: null,
        views: [],
        heldTextures: [],
        material: null,
        version: -1,
        epoch: -1,
        world: -1,
        view: -1,
        seen: 0,
        disposed: false,
        variant: null,
        pipeline: null,
        group: null,
        boneTexture: null,
        morphDeltas: null,
        morphWeights: null,
        indirect: null,
        instances: null,
        own: null,
    };
}

function bindGlowDraw(context: GlowMaterialContext, draw: GlowMaterialDraw, variant: GlowVariant): void {
    const mesh = draw.mesh;
    const surface = draw.surface;
    const skeleton = variant.skeleton ? mesh.skeleton! : null;
    const morph = variant.morph ? mesh.morphTargets! : null;
    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: draw.buffer! } }];
    let binding = 1;
    if (morph) {
        entries.push({ binding: binding++, resource: { buffer: morph.deltasBuffer } }, { binding: binding++, resource: { buffer: morph.weightsBuffer } });
    }
    if (skeleton) {
        entries.push({ binding: binding++, resource: skeleton.boneTexture.createView() });
    }
    const old = draw.heldTextures;
    const held: Texture2D[] = [];
    for (let i = 0; i < 3; i++) {
        const texture = surface.textures[i];
        if (texture) {
            entries.push({ binding: binding++, resource: texture.view }, { binding: binding++, resource: texture.sampler });
            // Lease the actual resources: a replaceable texture facade must not release its new backing.
            const lease = { texture: texture.texture, view: texture.view, sampler: texture.sampler, width: texture.width, height: texture.height };
            acquireTexture(lease);
            held.push(lease);
        }
        draw.views[i * 2] = texture?.view ?? null;
        draw.views[i * 2 + 1] = texture?.sampler ?? null;
    }
    draw.group = context.engine._device.createBindGroup({ label: "glow-draw", layout: variant.layout, entries });
    retireGpuResources(context.engine, () => {
        for (const texture of old) {
            releaseTexture(texture);
        }
    });
    draw.heldTextures = held;
    draw.variant = variant;
    draw.boneTexture = skeleton?.boneTexture ?? null;
    draw.morphDeltas = morph?.deltasBuffer ?? null;
    draw.morphWeights = morph?.weightsBuffer ?? null;
}

/**
 * @internal Bring a draw up to date before the emissive pass. `refresh` follows a source-surface change.
 * Returns -1 while its helpers load, 1 when its recorded draw commands changed, otherwise 0.
 */
export function updateGlowDraw(
    context: GlowMaterialContext,
    draw: GlowMaterialDraw,
    refresh: boolean,
    color: GlowColor,
    packWorld: (data: Float32Array, world: Mesh["worldMatrix"], offset: number, sourceOffset: number) => void = packMat4IntoF32,
    view = 0
): number {
    if (draw.surface.own) {
        const node = context.node;
        if (node) {
            return node.updateGlowNodeDraw(context, draw, refresh, packWorld, view);
        }
        context.loading ??= import("./glow-node.js").then(
            (mod) => {
                context.node = mod;
                context.loading = null;
            },
            (error: unknown) => {
                context.loading = null;
                console.error(error);
            }
        );
        return -1;
    }
    if (draw.own) {
        context.node!.releaseGlowNodeDraw(context, draw);
        draw.world = -1;
    }
    const mesh = draw.mesh;
    const data = draw.data;
    let variant = draw.variant;
    let dirty = false;
    let rebind = false;
    if (refresh || !variant) {
        const next = getVariant(context, draw);
        if (!next) {
            return -1;
        }
        rebind = next !== variant || !draw.group;
        variant = next;
        draw.buffer ??= createEmptyUniformBuffer(context.engine, DRAW_FLOATS * 4, "glow-draw");
        const surface = draw.surface;
        for (let i = 0; i < 3; i++) {
            const texture = surface.textures[i];
            if (texture) {
                if (texture.texture === context.targetTexture) {
                    throw new Error("GlowPostProcessTask cannot sample its own emissive render attachment.");
                }
                dirty = writeGlowUv(data, 20 + i * 8, texture, surface, surface.uvChannels[i]!) || dirty;
            }
            if (draw.views[i * 2] !== (texture?.view ?? null) || draw.views[i * 2 + 1] !== (texture?.sampler ?? null)) {
                rebind = true;
            }
        }
        const level = data[44];
        data[44] = surface.opacityLevel;
        dirty = dirty || data[44] !== level;
    }
    if (variant.skeleton || variant.morph) {
        const morph = variant.morph ? mesh.morphTargets! : null;
        if (
            draw.boneTexture !== (variant.skeleton ? mesh.skeleton!.boneTexture : null) ||
            draw.morphDeltas !== (morph?.deltasBuffer ?? null) ||
            draw.morphWeights !== (morph?.weightsBuffer ?? null)
        ) {
            rebind = true;
        }
    }
    if (rebind) {
        bindGlowDraw(context, draw, variant);
    }
    const r = data[16];
    const g = data[17];
    const b = data[18];
    const a = data[19];
    data[16] = color.r;
    data[17] = color.g;
    data[18] = color.b;
    data[19] = color.a;
    // Compare after float32 storage rounding.
    dirty = dirty || data[16] !== r || data[17] !== g || data[18] !== b || data[19] !== a;
    const world = mesh.worldMatrixVersion;
    if (draw.world !== world || draw.view !== view) {
        packWorld(data, mesh.worldMatrix, 0, 0);
        draw.world = world;
        draw.view = view;
        dirty = true;
    }
    if (dirty) {
        context.engine._device.queue.writeBuffer(draw.buffer!, 0, data as Float32Array<ArrayBuffer>);
    }
    if (variant.instances) {
        const instances = mesh.thinInstances!;
        const indirect = context.updateInstances!(context.engine, instances, false, mesh._gpu);
        if (indirect !== draw.indirect || instances._gpuBuffer !== draw.instances) {
            draw.indirect = indirect;
            draw.instances = instances._gpuBuffer;
            rebind = true;
        }
    } else if (draw.indirect || draw.instances) {
        // Thin instances were removed: the draw must not keep the previous instance count.
        draw.indirect = draw.instances = null;
        rebind = true;
    }
    if (draw.pipeline !== variant.pipeline) {
        draw.pipeline = variant.pipeline;
        rebind = true;
    }
    return +rebind;
}

/** @internal Encode one draw through its already-selected emissive pipeline. */
export function drawGlowMaterial(context: GlowMaterialContext, draw: GlowMaterialDraw, encoder: GPURenderPassEncoder | GPURenderBundleEncoder): void {
    if (draw.own) {
        context.node!.drawGlowNode(context, draw, encoder);
        return;
    }
    const mesh = draw.mesh;
    const gpu = mesh._gpu;
    const variant = draw.variant!;
    let slot = 0;
    encoder.setVertexBuffer(slot++, gpu.positionBuffer);
    if (variant.morph) {
        encoder.setVertexBuffer(slot++, gpu.normalBuffer);
    }
    if (variant.uv) {
        encoder.setVertexBuffer(slot++, gpu.uvBuffer);
    }
    if (variant.uv2) {
        encoder.setVertexBuffer(slot++, gpu.uv2Buffer!);
    }
    if (variant.vertexAlpha) {
        encoder.setVertexBuffer(slot++, gpu.colorBuffer!);
    }
    if (variant.skeleton) {
        const skeleton = mesh.skeleton!;
        encoder.setVertexBuffer(slot++, skeleton.jointsBuffer);
        encoder.setVertexBuffer(slot++, skeleton.weightsBuffer);
        if (variant.bones8) {
            encoder.setVertexBuffer(slot++, skeleton.joints1Buffer!);
            encoder.setVertexBuffer(slot++, skeleton.weights1Buffer!);
        }
    }
    if (variant.instances) {
        context.syncInstances!(context.engine, mesh.thinInstances!, encoder, slot, false);
    }
    encoder.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
    encoder.setBindGroup(1, draw.group!);
    if (draw.indirect) {
        encoder.drawIndexedIndirect(draw.indirect, 0);
    } else {
        encoder.drawIndexed(gpu.indexCount, mesh.thinInstances?.count ?? 1, gpu._firstIndex ?? 0, gpu._baseVertex);
    }
}

/** @internal Release only this pass's resources, never source mesh/texture ownership. */
export function disposeGlowDraw(context: GlowMaterialContext, draw: GlowMaterialDraw): void {
    if (draw.disposed) {
        return;
    }
    draw.disposed = true;
    if (draw.own) {
        context.node!.releaseGlowNodeDraw(context, draw);
    }
    const textures = draw.heldTextures;
    const buffer = draw.buffer;
    retireGpuResources(context.engine, () => {
        buffer?.destroy();
        for (const texture of textures) {
            releaseTexture(texture);
        }
    });
}
