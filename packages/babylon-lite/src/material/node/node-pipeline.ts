/** Node Material — WGSL wrap + GPU pipeline builder.
 *
 *  Takes the pair of WGSL bodies produced by `emitGraph` plus the accumulated
 *  build state, and produces:
 *    • Full WGSL shader text (vertex + fragment, single module)
 *    • Bind-group layouts (group 0 = scene, group 1 = mesh/material/textures)
 *    • A cached GPURenderPipeline keyed by shader source + format + MSAA
 *
 *  This module is loaded lazily by `node-renderable.ts` and is the only place
 *  that knows how to substitute engine-owned sentinels (`_NME_FRAG_OUTPUT_`,
 *  `_NME_VTX_OUTPUT_`, `_NME_FRONT_FACING_`, …). Keeping all WGSL assembly here
 *  leaves block emitters free of cross-cutting knowledge about the pipeline.
 */

import type { EngineContextInternal } from "../../engine/engine.js";
import { getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { createStandardPipelineDescriptor } from "../../render/scene-helpers.js";
import { computeUboLayout } from "../../shader/ubo-layout.js";
import { MAX_LIGHTS, LIGHT_ENTRY_FLOATS } from "../../light/types.js";
import type { NodeBuildState } from "./node-types.js";

// ─── Shared WGSL preamble ───────────────────────────────────────────
//
//  Base scene UBO matches Lite's Standard scene UBO layout (176 B). Env
//  IBL extension (extra 160 B = 9 SH vec4 + envRotationY/lodGenerationScale/
//  environmentIntensity) is provided lazily by node-env.ts, dynamic-imported
//  only when state.usesEnv is true.

const WGSL_SCENE_STRUCT_BASE_FIELDS = `viewProjection: mat4x4<f32>,
    view: mat4x4<f32>,
    vEyePosition: vec4<f32>,
    vFogInfos: vec4<f32>,
    vFogColor: vec4<f32>,`;

function buildSceneStruct(envFields: string | null): string {
    const fields = envFields ? `${WGSL_SCENE_STRUCT_BASE_FIELDS}\n    ${envFields}` : WGSL_SCENE_STRUCT_BASE_FIELDS;
    return `struct SceneU {\n    ${fields}\n};\n@group(0) @binding(0) var<uniform> sceneU: SceneU;`;
}

/** Byte size of the NME scene UBO (excluding env: 176; with env tail: 336). */
export const NME_SCENE_UBO_BASE_BYTES = 176;
export function getNmeSceneUboBytes(envExtraBytes: number): number {
    return NME_SCENE_UBO_BASE_BYTES + envExtraBytes;
}

const WGSL_MESH_STRUCT = `struct MeshU {
    world: mat4x4<f32>,
    receivesShadow: vec4<f32>,
};
@group(1) @binding(0) var<uniform> meshU: MeshU;`;

/** Sentinels the builder substitutes away before compile. */
const SENTINEL_FRAG_OUTPUT = "_NME_FRAG_OUTPUT_";
const SENTINEL_VTX_OUTPUT = "_NME_VTX_OUTPUT_";
const SENTINEL_FRONT_FACING = "_NME_FRONT_FACING_";

// ─── Compile result ─────────────────────────────────────────────────

export interface NodeCompileResult {
    readonly wgsl: string;
    readonly pipeline: GPURenderPipeline;
    readonly sceneBGL: GPUBindGroupLayout;
    readonly meshBGL: GPUBindGroupLayout;
    readonly nodeUboSize: number;
    readonly nodeUboOffsets: ReadonlyMap<string, number>;
    /** Total byte size of the NME scene UBO for this material (176 base, +160
     *  when env IBL is enabled). */
    readonly sceneUboBytes: number;
    /** The resolved bind-group slot (within group 1) for the node UBO. `null` if no uniforms. */
    readonly nodeUboBinding: number | null;
    /** Per-texture binding slots assigned by the pipeline builder. */
    readonly textureBindings: ReadonlyArray<{ readonly name: string; readonly texBinding: number; readonly sampBinding: number }>;
    /** The bind-group slot (within group 1) for the shared lights UBO, or `null` when no block uses lights. */
    readonly lightsBinding: number | null;
    /** Slots for the morph-target texture + weights UBO, or `null` when no MorphTargetsBlock is present. */
    readonly morphBindings: { readonly textureBinding: number; readonly uboBinding: number } | null;
    /** Slot assignments for env IBL bindings within group 1, when state.usesEnv is true. */
    readonly envBindings: {
        readonly iblTexture: number;
        readonly iblSampler: number;
        readonly brdfLUT: number;
        readonly brdfSampler: number;
    } | null;
    /** Per shadow-casting light: slot assignments in group 1 for the shadow texture, sampler, and shadowInfo UBO. Empty when the material uses no shadows. */
    readonly shadowBindings: ReadonlyArray<{
        readonly lightIndex: number;
        readonly texBinding: number;
        readonly sampBinding: number;
        readonly uboBinding: number;
        readonly shadowType: "esm" | "pcf";
    }>;
}

// ─── Pipeline cache ─────────────────────────────────────────────────

let _cache: Map<string, NodeCompileResult> | null = null;
let _cachedDevice: GPUDevice | null = null;

function getCache(engine: EngineContextInternal): Map<string, NodeCompileResult> {
    if (!_cache || _cachedDevice !== engine.device) {
        _cache = new Map();
        _cachedDevice = engine.device;
    }
    return _cache;
}

/** Clear the cached NME pipelines (call on device loss / test cleanup). */
export function clearNodePipelineCache(): void {
    _cache?.clear();
    _cache = null;
    _cachedDevice = null;
}

// ─── WGSL assembly ──────────────────────────────────────────────────

function buildVertexIn(state: NodeBuildState): string {
    if (state.vertexAttributes.length === 0) {
        return `struct VertexIn {};`;
    }
    const lines = state.vertexAttributes.map((a, i) => `    @location(${i}) ${a.name}: ${a.type},`);
    return `struct VertexIn {\n${lines.join("\n")}\n};`;
}

function buildVertexOut(state: NodeBuildState): string {
    const lines = [`    @builtin(position) position: vec4<f32>,`];
    state.varyings.forEach((v, i) => {
        lines.push(`    @location(${i}) ${v.name}: ${v.type},`);
    });
    return `struct VertexOut {\n${lines.join("\n")}\n};`;
}

function buildNodeUbo(state: NodeBuildState, binding: number): { struct: string; size: number; offsets: ReadonlyMap<string, number> } | null {
    if (state.nodeUboFields.length === 0) {
        return null;
    }
    const layout = computeUboLayout(state.nodeUboFields);
    const lines = state.nodeUboFields.map((f) => `    ${f.name}: ${f.type},`);
    const struct = `struct NodeU {\n${lines.join("\n")}\n};\n@group(1) @binding(${binding}) var<uniform> nodeU: NodeU;`;
    return { struct, size: layout.totalBytes, offsets: layout.offsets };
}

function indent(body: string): string {
    return body
        .split("\n")
        .map((l) => (l.length === 0 ? l : `    ${l}`))
        .join("\n");
}

// ─── Pipeline creation ──────────────────────────────────────────────

export interface CompileOpts {
    readonly engine: EngineContextInternal;
    readonly format: GPUTextureFormat;
    readonly msaaSamples: number;
    readonly backFaceCulling?: boolean;
    /** BJS alpha mode (0=DISABLE, 2=COMBINE). Determines blend state. */
    readonly alphaMode?: number;
    /** When `state.usesEnv` is true, this factory produces the env IBL
     *  bindings + WGSL. Loaded via `await import("./node-env.js")` from
     *  node-material.ts only when `state.usesEnv` was set during emitGraph,
     *  so non-env scenes never bundle the env helpers. */
    readonly envEmitter?: typeof import("./node-env.js").emitEnv;
    /** Extra bytes appended to the scene UBO when env is in use. Provided
     *  by the same lazy node-env import (NME_SCENE_UBO_ENV_EXTRA_BYTES). */
    readonly envExtraBytes?: number;
    /** WGSL scene-struct field fragment to append to SceneU. Provided by
     *  node-env.SCENE_STRUCT_ENV_FIELDS when env is in use. */
    readonly envSceneStructFields?: string;
    /** When `state.shadowLights` is non-empty, this factory produces shadow
     *  bindings + WGSL. Loaded via `await import("./node-shadow.js")` from
     *  `node-material.ts` only when `shadowGenerators` was supplied, so
     *  non-shadow scenes never bundle the PCF/ESM helpers. */
    readonly shadowEmitter?: typeof import("./node-shadow.js").emitShadow;
}

export function compileNodePipeline(state: NodeBuildState, vertexBody: string, fragmentBody: string, opts: CompileOpts): NodeCompileResult {
    const { engine, format, msaaSamples } = opts;
    const device = engine.device;

    // Binding layout for group 1:
    //   slot 0         = mesh UBO (world matrix)
    //   slot 1         = node UBO (if nodeUboFields non-empty)
    //   slot N, N+1    = texture + sampler (paired) for each entry in state.textures
    //   slot L         = shared lights UBO (if state.usesLightsUbo)
    let nextBinding = 1;
    const nodeUboBinding = state.nodeUboFields.length > 0 ? nextBinding++ : null;
    const nodeUbo = nodeUboBinding !== null ? buildNodeUbo(state, nodeUboBinding) : null;
    const nodeUboSize = nodeUbo?.size ?? 0;
    const nodeUboOffsets: ReadonlyMap<string, number> = nodeUbo?.offsets ?? new Map<string, number>();

    const textureBindings: { name: string; texBinding: number; sampBinding: number }[] = [];
    const textureWgslDecls: string[] = [];
    for (const tex of state.textures) {
        const texBinding = nextBinding++;
        const sampBinding = nextBinding++;
        textureBindings.push({ name: tex.name, texBinding, sampBinding });
        const wgslTexType = tex.kind === "textureCube" ? "texture_cube<f32>" : "texture_2d<f32>";
        textureWgslDecls.push(`@group(1) @binding(${texBinding}) var nodeTex_${tex.name}: ${wgslTexType};`);
        textureWgslDecls.push(`@group(1) @binding(${sampBinding}) var nodeSamp_${tex.name}: sampler;`);
    }

    const lightsBinding = state.usesLightsUbo ? nextBinding++ : null;
    const lightsWgslDecls: string[] = [];
    if (lightsBinding !== null) {
        lightsWgslDecls.push(
            `struct LightEntry { vLightData: vec4<f32>, vLightDiffuse: vec4<f32>, vLightSpecular: vec4<f32>, vLightDirection: vec4<f32> };`,
            `struct lightsUniforms { count: u32, _p0: u32, _p1: u32, _p2: u32, lights: array<LightEntry, ${MAX_LIGHTS}> };`,
            `@group(1) @binding(${lightsBinding}) var<uniform> nmeLights: lightsUniforms;`
        );
    }

    // Morph-target bindings (vertex-only). Two slots: texture atlas + weights UBO.
    let morphBindings: { textureBinding: number; uboBinding: number } | null = null;
    const morphWgslDecls: string[] = [];
    if (state.usesMorphTargets) {
        const textureBinding = nextBinding++;
        const uboBinding = nextBinding++;
        morphBindings = { textureBinding, uboBinding };
        morphWgslDecls.push(
            `@group(1) @binding(${textureBinding}) var morphTargets: texture_2d<f32>;`,
            `struct morphUniforms { weights: vec4<f32>, count: u32, texWidth: u32, rowsPerBand: u32, _p0: u32 };`,
            `@group(1) @binding(${uboBinding}) var<uniform> morph: morphUniforms;`,
            // Helpers are emitted inline (module-scope) so they can reference `morph` + `morphTargets`.
            `fn nme_morph_coord(vi: u32) -> vec2<i32> { let col = i32(vi % morph.texWidth); let row = i32(vi / morph.texWidth); return vec2<i32>(col, row); }`,
            `fn nme_morphPosition(base: vec3<f32>, vi: u32) -> vec3<f32> {\n` +
                `    var acc = base;\n` +
                `    let co = nme_morph_coord(vi);\n` +
                `    for (var i = 0u; i < morph.count; i = i + 1u) {\n` +
                `        let posBase = i32(i * 2u) * i32(morph.rowsPerBand);\n` +
                `        acc = acc + morph.weights[i] * textureLoad(morphTargets, vec2<i32>(co.x, posBase + co.y), 0).xyz;\n` +
                `    }\n` +
                `    return acc;\n` +
                `}`,
            `fn nme_morphNormal(base: vec3<f32>, vi: u32) -> vec3<f32> {\n` +
                `    var acc = base;\n` +
                `    let co = nme_morph_coord(vi);\n` +
                `    for (var i = 0u; i < morph.count; i = i + 1u) {\n` +
                `        let normBase = i32(i * 2u + 1u) * i32(morph.rowsPerBand);\n` +
                `        acc = acc + morph.weights[i] * textureLoad(morphTargets, vec2<i32>(co.x, normBase + co.y), 0).xyz;\n` +
                `    }\n` +
                `    return acc;\n` +
                `}`
        );
    }

    // Env IBL bindings (specular cube + sampler, BRDF LUT 2D + sampler).
    // Allocated only when state.usesEnv was set during emitGraph AND the caller
    // supplied envEmitter (lazy-imported by node-material.ts). All env-specific
    // WGSL strings + BGL entries live in node-env.ts so non-env scenes never
    // bundle them.
    let envBindings: { iblTexture: number; iblSampler: number; brdfLUT: number; brdfSampler: number } | null = null;
    const envWgslDecls: string[] = [];
    let envBglEntries: readonly GPUBindGroupLayoutEntry[] = [];
    if (state.usesEnv && opts.envEmitter) {
        const env = opts.envEmitter(nextBinding);
        envBindings = env.bindings;
        envWgslDecls.push(env.wgslDecls);
        envBglEntries = env.bglEntries;
        nextBinding += env.bindingCount;
    }

    // Shadow bindings (per shadow-casting light). Emission/WGSL live in the
    // dynamically-imported `node-shadow.ts` module so scenes without shadows
    // never bundle the PCF/ESM helper code. `shadowEmitter` is supplied only
    // when `shadowGenerators` was passed to `parseNodeMaterialFromSnippet`.
    const shadowEmit = state.shadowLights.length > 0 && opts.shadowEmitter ? opts.shadowEmitter(state.shadowLights, nextBinding, state.varyings) : null;
    if (shadowEmit) {
        nextBinding += shadowEmit.bindingCount;
    }
    const shadowBindings = shadowEmit?.bindings ?? [];
    const shadowWgslDecls = shadowEmit ? [shadowEmit.wgslDecls] : [];
    const shadowVertexInject = shadowEmit?.vertexInject ?? "";
    const shadowFragmentHelper = shadowEmit?.fragmentHelper ?? "";

    // Module-scope helpers (function defs, struct defs) — dedupe across both
    // stages by key. Fail on same-key/different-source to avoid silent loss.
    const helperSources = new Map<string, string>();
    for (const s of [state.vertex, state.fragment]) {
        for (const [k, v] of s.helpers) {
            const existing = helperSources.get(k);
            if (existing !== undefined && existing !== v) {
                throw new Error(`NodeMaterial: helper key "${k}" registered with conflicting source bodies`);
            }
            helperSources.set(k, v);
        }
    }

    // Compose WGSL (node UBO struct inserted conditionally between mesh + VertexIn).
    const vertexIn = buildVertexIn(state);
    const vertexOut = buildVertexOut(state);
    const wgslParts: string[] = ["// Auto-generated by NodeMaterial — DO NOT EDIT", buildSceneStruct(opts.envSceneStructFields ?? null), WGSL_MESH_STRUCT];
    if (nodeUbo) {
        wgslParts.push(nodeUbo.struct);
    }
    if (textureWgslDecls.length > 0) {
        wgslParts.push(textureWgslDecls.join("\n"));
    }
    if (lightsWgslDecls.length > 0) {
        wgslParts.push(lightsWgslDecls.join("\n"));
    }
    if (morphWgslDecls.length > 0) {
        wgslParts.push(morphWgslDecls.join("\n"));
    }
    if (envWgslDecls.length > 0) {
        wgslParts.push(envWgslDecls.join("\n"));
    }
    wgslParts.push(vertexIn);
    wgslParts.push(vertexOut);
    if (shadowWgslDecls.length > 0) {
        wgslParts.push(shadowWgslDecls.join("\n"));
    }
    if (shadowFragmentHelper.length > 0) {
        wgslParts.push(shadowFragmentHelper);
    }
    for (const src of helperSources.values()) {
        wgslParts.push(src);
    }

    const vsSig = state.usesMorphTargets ? `(in: VertexIn, @builtin(vertex_index) vertexIndex: u32)` : `(in: VertexIn)`;
    wgslParts.push(
        `@vertex\nfn vs_main${vsSig} -> VertexOut {\n` +
            `    var out: VertexOut;\n` +
            `    var ${SENTINEL_VTX_OUTPUT}: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 1.0);\n` +
            `${indent(vertexBody)}\n` +
            (shadowVertexInject.length > 0 ? `    ${shadowVertexInject}\n` : ``) +
            `    out.position = ${SENTINEL_VTX_OUTPUT};\n` +
            `    return out;\n` +
            `}`
    );
    wgslParts.push(
        `@fragment\nfn fs_main(in: VertexOut, @builtin(front_facing) ${SENTINEL_FRONT_FACING}: bool) -> @location(0) vec4<f32> {\n` +
            `    var ${SENTINEL_FRAG_OUTPUT}: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 1.0);\n` +
            `${indent(fragmentBody)}\n` +
            `    return ${SENTINEL_FRAG_OUTPUT};\n` +
            `}`
    );
    const rawWgsl = wgslParts.join("\n\n");
    // Substitute scene-uniform sentinels emitted by blocks (FogBlock, LightBlock,
    // ReflectionTextureBlock). These all resolve to scene-UBO fields.
    const wgsl = rawWgsl.replaceAll("_NME_CAMERA_POS_", "sceneU.vEyePosition.xyz").replaceAll("_NME_FOG_PARAMS_", "sceneU.vFogInfos");

    const alphaMode = opts.alphaMode ?? 0;
    const cacheKey = `${wgsl}|${format}|${msaaSamples}|${opts.backFaceCulling !== false ? "bfc" : "nobfc"}|a${alphaMode}`;
    const cache = getCache(engine);
    const existing = cache.get(cacheKey);
    if (existing) {
        return existing;
    }

    // Blend state for alpha-blended materials.
    const blend = alphaModeToBlend(alphaMode);
    const depthWriteEnabled = blend === undefined;

    const sceneBGL = getSceneBindGroupLayout(engine);

    // group 1 BGL
    const meshBglEntries: GPUBindGroupLayoutEntry[] = [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }];
    if (nodeUboBinding !== null) {
        meshBglEntries.push({ binding: nodeUboBinding, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } });
    }
    for (const tb of textureBindings) {
        meshBglEntries.push({ binding: tb.texBinding, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } });
        meshBglEntries.push({ binding: tb.sampBinding, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } });
    }
    if (lightsBinding !== null) {
        const lightsUboByteSize = 16 + MAX_LIGHTS * LIGHT_ENTRY_FLOATS * 4;
        meshBglEntries.push({ binding: lightsBinding, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: lightsUboByteSize } });
    }
    if (morphBindings !== null) {
        meshBglEntries.push({
            binding: morphBindings.textureBinding,
            visibility: GPUShaderStage.VERTEX,
            texture: { sampleType: "unfilterable-float", viewDimension: "2d" },
        });
        meshBglEntries.push({
            binding: morphBindings.uboBinding,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: "uniform", minBindingSize: 32 },
        });
    }
    if (envBindings) {
        meshBglEntries.push(...envBglEntries);
    }
    if (shadowEmit) {
        meshBglEntries.push(...shadowEmit.bglEntries);
    }
    const meshBGL = device.createBindGroupLayout({ label: "node-mesh", entries: meshBglEntries });

    // Vertex buffers: one GPUVertexBufferLayout per declared attribute, each at location=i.
    const vertexBuffers: GPUVertexBufferLayout[] = state.vertexAttributes.map((a, i) => ({
        arrayStride: a.arrayStride,
        stepMode: a.stepMode ?? "vertex",
        attributes: [{ format: a.gpuFormat, offset: a.offset ?? 0, shaderLocation: i }],
    }));

    const shaderModule = device.createShaderModule({ label: "node-material", code: wgsl });

    const fragTarget: GPUColorTargetState = blend ? { format, blend } : { format };
    const pipeline = device.createRenderPipeline({
        ...createStandardPipelineDescriptor({
            label: "node-material",
            engine,
            bgls: [sceneBGL, meshBGL],
            vertModule: shaderModule,
            fragModule: shaderModule,
            vertexBuffers,
            format,
            msaaSamples,
            cullMode: opts.backFaceCulling !== false ? "back" : "none",
            blend,
            depthWriteEnabled,
        }),
        vertex: { module: shaderModule, entryPoint: "vs_main", buffers: vertexBuffers },
        fragment: { module: shaderModule, entryPoint: "fs_main", targets: [fragTarget] },
    });

    const result: NodeCompileResult = {
        wgsl,
        pipeline,
        sceneBGL,
        meshBGL,
        nodeUboSize,
        nodeUboOffsets,
        sceneUboBytes: getNmeSceneUboBytes(opts.envExtraBytes ?? 0),
        nodeUboBinding,
        textureBindings,
        lightsBinding,
        morphBindings,
        envBindings,
        shadowBindings,
    };
    cache.set(cacheKey, result);
    return result;
}

// ─── Alpha mode → blend state ───────────────────────────────────────

/** Map BJS alpha mode to a WebGPU blend state. Returns undefined for opaque (mode 0). */
function alphaModeToBlend(mode: number): GPUBlendState | undefined {
    switch (mode) {
        case 1: // ALPHA_ADD
            return {
                color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
            };
        case 2: // ALPHA_COMBINE (standard)
            return {
                color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            };
        case 7: // ALPHA_PREMULTIPLIED
            return {
                color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            };
        default: // 0 = DISABLE and any unsupported mode
            return undefined;
    }
}
