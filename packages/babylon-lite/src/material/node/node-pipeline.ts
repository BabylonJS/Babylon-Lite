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

import { SS } from "../../engine/gpu-flags.js";
import type { EngineContext } from "../../engine/engine.js";
import { REVERSE_DEPTH_COMPARE } from "../../engine/render-target.js";
import { getSceneBindGroupLayout } from "../../render/scene-helpers.js";
import { createDefaultPipelineDescriptor } from "../../render/scene-helpers.js";
import { SCENE_UBO_WGSL } from "../../shader/scene-uniforms.js";
import { computeUboLayout } from "../../shader/ubo-layout.js";
import { MAX_LIGHTS } from "../../light/types.js";
import type { NodeBuildState } from "./node-types.js";

// ─── Shared WGSL preamble ───────────────────────────────────────────

function buildMeshStruct(): string {
    return `struct MeshU {
    world: mat4x4<f32>,
    receivesShadow: vec4<f32>,
    lc: u32,
    li: array<vec4<u32>, ${Math.ceil(MAX_LIGHTS / 4)}>,
};
@group(1) @binding(0) var<uniform> meshU: MeshU;
fn nli(i: u32) -> u32 { return meshU.li[i / 4u][i % 4u]; }`;
}

/** Sentinels the builder substitutes away before compile. */
const SENTINEL_FRAG_OUTPUT = "_NME_FRAG_OUTPUT_";
const SENTINEL_FRAG_DEPTH = "_NME_FRAG_DEPTH_";
const SENTINEL_VTX_OUTPUT = "_NME_VTX_OUTPUT_";
const SENTINEL_FRONT_FACING = "_NME_FRONT_FACING_";
const SENTINEL_FRAG_COORD = "_NME_FRAG_COORD_";
const SENTINEL_SCREEN_SIZE = "_NME_SCREEN_SIZE_";

// ─── Compile result ─────────────────────────────────────────────────

/** @internal */
export interface NodeCompileResult {
    /** @internal */
    readonly _wgsl: string;
    /** @internal */
    readonly _pipeline: GPURenderPipeline;
    /** @internal */
    readonly _meshBGL: GPUBindGroupLayout;
    /** @internal */
    readonly _nodeUboSize: number;
    /** @internal */
    readonly _nodeUboOffsets: ReadonlyMap<string, number>;
    /** @internal The resolved bind-group slot (within group 1) for the node UBO. `null` if no uniforms. */
    readonly _nodeUboBinding: number | null;
    /** @internal Per-texture binding slots assigned by the pipeline builder. */
    readonly _textureBindings: ReadonlyArray<{ readonly _name: string; readonly _texBinding: number; readonly _sampBinding: number }>;
    /** @internal Slots for the morph-target deltas + weights storage buffers, or `null` when no MorphTargetsBlock is present. */
    readonly _morphBindings: { readonly _deltasBinding: number; readonly _uboBinding: number } | null;
    /** @internal Slot assignments for env IBL bindings within group 1, when state.usesEnv is true. */
    readonly _envBindings: {
        /** @internal */
        readonly _iblTexture: number;
        /** @internal */
        readonly _iblSampler: number;
        /** @internal */
        readonly _brdfLUT: number;
        /** @internal */
        readonly _brdfSampler: number;
    } | null;
    /** @internal Per shadow-casting light: slot assignments in group 1 for the shadow texture, sampler, and shadowInfo UBO. Empty when the material uses no shadows. */
    readonly _shadowBindings: readonly import("./node-shadow.js").ShadowBinding[];
    /** @internal */
    readonly _usesClipPlanes: boolean;
    /** @internal */
    readonly _usesMeshAttributeFlags: boolean;
    /** @internal */
    readonly _esmShadowParamsBinding: number | null;
    /** @internal Group-1 binding of the geometry-params (`nmeGeom`) UBO, or
     *  `null` when the geometry pass does not need it. Only set by the geometry
     *  (`_mrtOutput`) path. */
    readonly _geometryGpBinding: number | null;
}

// ─── Pipeline cache ─────────────────────────────────────────────────

let _cache: Map<string, NodeCompileResult> | null = null;
let _cachedDevice: GPUDevice | null = null;

function getCache(engine: EngineContext): Map<string, NodeCompileResult> {
    if (!_cache || _cachedDevice !== engine._device) {
        _cache = new Map();
        _cachedDevice = engine._device;
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
    const lines = state.vertexAttributes.map((a, i) => `    @location(${i}) ${a._name}: ${a._type},`);
    return `struct VertexIn {\n${lines.join("\n")}\n};`;
}

function buildVertexOut(state: NodeBuildState): string {
    const lines = [`    @builtin(position) position: vec4<f32>,`];
    state.varyings.forEach((v, i) => {
        lines.push(`    @location(${i}) ${v._name}: ${v._type},`);
    });
    return `struct VertexOut {\n${lines.join("\n")}\n};`;
}

function buildNodeUbo(state: NodeBuildState, binding: number): { struct: string; size: number; offsets: ReadonlyMap<string, number> } | null {
    if (state.nodeUboFields.length === 0) {
        return null;
    }
    const layout = computeUboLayout(state.nodeUboFields);
    const lines = state.nodeUboFields.map((f) => `    ${f._name}: ${f._type},`);
    const struct = `struct NodeU {\n${lines.join("\n")}\n};\n@group(1) @binding(${binding}) var<uniform> nodeU: NodeU;`;
    return { struct, size: layout._totalBytes, offsets: layout._offsets };
}

function indent(body: string): string {
    return body
        .split("\n")
        .map((l) => (l.length === 0 ? l : `    ${l}`))
        .join("\n");
}

// ─── Pipeline creation ──────────────────────────────────────────────

export interface CompileOpts {
    /** @internal */
    readonly _engine: EngineContext;
    /** @internal */
    readonly _format: GPUTextureFormat;
    /** @internal */
    readonly _depthStencilFormat?: GPUTextureFormat;
    /** @internal */
    readonly _depthCompare?: GPUCompareFunction;
    /** @internal */
    readonly _msaaSamples: number;
    /** @internal */
    readonly _backFaceCulling?: boolean;
    /** @internal */
    readonly _noColorOutput?: boolean;
    /** @internal */
    readonly _esmShadowOutput?: boolean;
    /** @internal ESM shadow depth output code. Supplied by the ESM material view so normal Node bundles don't retain it. */
    readonly _esmShadowDepthCode?: string;
    /** @internal BJS alpha mode (0=DISABLE, 2=COMBINE). Determines blend state. */
    readonly _alphaMode?: number;
    /** When `state.usesEnv` is true, this factory produces the env IBL
     *  bindings + WGSL. Loaded via `await import("./node-env.js")` from
     *  node-material.ts only when `state.usesEnv` was set during emitGraph,
     *  so non-env scenes never bundle the env helpers. */
    /** @internal */
    readonly _envEmitter?: typeof import("./node-env.js").emitEnv;
    /** When `state.shadowLights` is non-empty, this factory produces shadow
     *  bindings + WGSL. Loaded via `await import("./node-shadow.js")` from
     *  `node-material.ts` only when `shadowGenerators` was supplied, so
     *  non-shadow scenes never bundle the PCF/ESM helpers. */
    /** @internal */
    readonly _shadowEmitter?: typeof import("./node-shadow.js").emitShadow;
    /** @internal Geometry-renderer (MRT) output. Supplied by the lazily
     *  dynamic-imported node geometry view, so normal node bundles never
     *  retain this path. When present, the fragment entry point returns a
     *  multi-attachment `FragmentOutput` (one `@location(i)` per attachment)
     *  built from the caller-provided `_struct` + `_writes` WGSL — the pipeline
     *  builder stays geometry-type agnostic (it only splices strings + builds
     *  the MRT colour targets). */
    readonly _mrtOutput?: MrtOutputOpts;
}

/** @internal Geometry-renderer MRT output description (see {@link CompileOpts._mrtOutput}).
 *  Every geometry-specific WGSL object-literal + the MRT pipeline descriptor is
 *  built by the lazily dynamic-imported `node-geometry-renderable.ts`, so
 *  `compileNodePipeline` only splices the pre-built strings and invokes the
 *  callbacks — non-geometry node scenes retain none of this code. */
export interface MrtOutputOpts {
    /** @internal WGSL `struct FragmentOutput { @location(i) f{i}: vec4<f32>, … };` declaration. */
    readonly _struct: string;
    /** @internal Fragment entry-point return-type suffix (e.g. `" -> FragmentOutput"`). */
    readonly _fsReturnType: string;
    /** @internal Fully-assembled + indented `fs_main` return body (`var out…; return out;`)
     *  with a trailing newline. References `scene.*`, the fragment temps, and
     *  `nmeGeom.*` when {@link _needsGpUbo}. */
    readonly _fsReturn: string;
    /** @internal Geometry cache-key discriminator + (colorFormats, cullMode) suffix.
     *  Spliced verbatim into the pipeline cache key — built in the lazy module so
     *  the always-loaded key path never bundles geometry string-assembly. */
    readonly _cacheKey: string;
    /** @internal Allocate the `nmeGeom` geometry-params UBO binding (camera near/far). */
    readonly _needsGpUbo: boolean;
    /** @internal Build the `nmeGeom` UBO WGSL decl + group-1 BGL entry at the
     *  resolved binding (only called when {@link _needsGpUbo}). */
    readonly _buildGeomUbo: (binding: number) => { readonly _wgsl: string; readonly _bglEntry: GPUBindGroupLayoutEntry };
    /** @internal Build the geometry MRT {@link GPURenderPipeline}. The whole
     *  descriptor object-literal lives in the lazy module. */
    readonly _buildPipeline: (device: GPUDevice, args: GeomPipelineArgs) => GPURenderPipeline;
}

/** @internal Inputs the {@link MrtOutputOpts._buildPipeline} callback needs from the pipeline builder. */
export interface GeomPipelineArgs {
    /** @internal */
    readonly _shaderModule: GPUShaderModule;
    /** @internal */
    readonly _sceneBGL: GPUBindGroupLayout;
    /** @internal */
    readonly _meshBGL: GPUBindGroupLayout;
    /** @internal */
    readonly _vertexBuffers: readonly GPUVertexBufferLayout[];
    /** @internal */
    readonly _depthFormat: GPUTextureFormat;
    /** @internal */
    readonly _depthCompare: GPUCompareFunction;
    /** @internal */
    readonly _msaaSamples: number;
}

export function compileNodePipeline(state: NodeBuildState, vertexBody: string, fragmentBody: string, opts: CompileOpts): NodeCompileResult {
    const { _engine, _format, _msaaSamples } = opts;
    const device = _engine._device;
    const mrt = opts._mrtOutput;

    // Binding layout for group 1:
    //   slot 0         = mesh UBO (world matrix)
    //   slot 1         = node UBO (if nodeUboFields non-empty)
    //   slot N, N+1    = texture + sampler (paired) for each entry in state.textures
    //   scene group 0 binding 1 = shared lights UBO (if state.usesLightsUbo)
    let nextBinding = 1;
    const _nodeUboBinding = state.nodeUboFields.length > 0 ? nextBinding++ : null;
    const nodeUbo = _nodeUboBinding !== null ? buildNodeUbo(state, _nodeUboBinding) : null;
    const _nodeUboSize = nodeUbo?.size ?? 0;
    const _nodeUboOffsets: ReadonlyMap<string, number> = nodeUbo?.offsets ?? new Map<string, number>();

    const _textureBindings: { _name: string; _texBinding: number; _sampBinding: number }[] = [];
    const textureWgslDecls: string[] = [];
    for (const tex of state.textures) {
        const _name = tex.name;
        const _texBinding = nextBinding++;
        const _sampBinding = nextBinding++;
        _textureBindings.push({ _name, _texBinding, _sampBinding });
        const wgslTexType = tex.kind === "textureCube" ? "texture_cube<f32>" : "texture_2d<f32>";
        textureWgslDecls.push(`@group(1) @binding(${_texBinding}) var nodeTex_${_name}: ${wgslTexType};`);
        textureWgslDecls.push(`@group(1) @binding(${_sampBinding}) var nodeSamp_${_name}: sampler;`);
    }

    const lightsWgslDecls = state.usesLightsUbo
        ? `struct LightEntry { vLightData: vec4<f32>, vLightDiffuse: vec4<f32>, vLightSpecular: vec4<f32>, vLightDirection: vec4<f32> };
struct lightsUniforms { count: u32, _p0: u32, _p1: u32, _p2: u32, lights: array<LightEntry, ${MAX_LIGHTS}> };
@group(0) @binding(1) var<uniform> nmeLights: lightsUniforms;`
        : "";

    // Morph-target bindings (vertex-only). Two slots: deltas storage buffer + weights storage buffer.
    let _morphBindings: { _deltasBinding: number; _uboBinding: number } | null = null;
    const morphWgslDecls: string[] = [];
    if (state.usesMorphTargets) {
        const _deltasBinding = nextBinding++;
        const _uboBinding = nextBinding++;
        _morphBindings = { _deltasBinding, _uboBinding };
        morphWgslDecls.push(
            `struct morphDeltasUniforms { d: array<f32> };`,
            `@group(1) @binding(${_deltasBinding}) var<storage, read> morphDeltas: morphDeltasUniforms;`,
            `struct morphUniforms { count: u32, vertexCount: u32, _p0: u32, _p1: u32, weights: array<f32> };`,
            `@group(1) @binding(${_uboBinding}) var<storage, read> morph: morphUniforms;`,
            // Helpers are emitted inline (module-scope) so they can reference `morph` + `morphDeltas`.
            `fn nme_morphPosition(base: vec3<f32>, vi: u32) -> vec3<f32> {\n` +
                `    var acc = base;\n` +
                `    for (var i = 0u; i < morph.count; i = i + 1u) {\n` +
                `        let b = (i * morph.vertexCount + vi) * 6u;\n` +
                `        acc = acc + morph.weights[i] * vec3<f32>(morphDeltas.d[b], morphDeltas.d[b + 1u], morphDeltas.d[b + 2u]);\n` +
                `    }\n` +
                `    return acc;\n` +
                `}`,
            `fn nme_morphNormal(base: vec3<f32>, vi: u32) -> vec3<f32> {\n` +
                `    var acc = base;\n` +
                `    for (var i = 0u; i < morph.count; i = i + 1u) {\n` +
                `        let b = (i * morph.vertexCount + vi) * 6u;\n` +
                `        acc = acc + morph.weights[i] * vec3<f32>(morphDeltas.d[b + 3u], morphDeltas.d[b + 4u], morphDeltas.d[b + 5u]);\n` +
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
    let _envBindings: { _iblTexture: number; _iblSampler: number; _brdfLUT: number; _brdfSampler: number } | null = null;
    let envWgslDecls = "";
    let envBglEntries: readonly GPUBindGroupLayoutEntry[] = [];
    if (state.usesEnv && opts._envEmitter) {
        const env = opts._envEmitter(nextBinding);
        _envBindings = env.bindings;
        envWgslDecls = env.wgslDecls;
        envBglEntries = env.bglEntries;
        nextBinding += env.bindingCount;
    }

    // Shadow bindings (per shadow-casting light). Emission/WGSL live in the
    // dynamically-imported `node-shadow.ts` module so scenes without shadows
    // never bundle the PCF/ESM helper code. `shadowEmitter` is supplied only
    // when `shadowGenerators` was passed to `parseNodeMaterialFromSnippet`.
    const noColorOutput = opts._noColorOutput === true;
    const esmShadowOutput = opts._esmShadowOutput === true;
    const shadowOutput = noColorOutput || esmShadowOutput;
    const shadowEmit = !shadowOutput && state.shadowLights.length > 0 && opts._shadowEmitter ? opts._shadowEmitter(state.shadowLights, nextBinding, state.varyings) : null;
    if (shadowEmit) {
        nextBinding += shadowEmit._bindingCount;
    }
    const _shadowBindings = shadowEmit?._bindings ?? [];
    const shadowWgslDecls = shadowEmit?._wgslDecls ?? "";
    const shadowVertexInject = shadowEmit?._vertexInject ?? "";
    const esmShadowDepthCode = opts._esmShadowDepthCode ?? "";
    const _esmShadowParamsBinding = esmShadowOutput ? nextBinding++ : null;
    // Geometry-params (`nmeGeom`) UBO binding — only when the geometry pass
    // derives normalized view depth and thus needs camera near/far. The decl +
    // BGL entry are built by the lazy geometry module via `_buildGeomUbo`.
    const _geometryGpBinding = mrt && mrt._needsGpUbo ? nextBinding++ : null;
    const _geomUbo = mrt && _geometryGpBinding !== null ? mrt._buildGeomUbo(_geometryGpBinding) : null;
    const shadowFragmentHelper =
        shadowEmit?._fragmentHelper ??
        (shadowOutput && state.shadowLights.length > 0
            ? `fn nme_computeShadowFactors(input: VertexOut) -> array<f32, ${MAX_LIGHTS}> {\n    return array<f32, ${MAX_LIGHTS}>(${new Array(MAX_LIGHTS).fill("1.0").join(", ")});\n}`
            : "");

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
    const fragmentOut =
        !mrt && !noColorOutput && state.usesFragDepth
            ? `struct FragmentOut {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) fragDepth: f32,
};`
            : "";
    const wgslParts: string[] = ["// Auto-generated by NodeMaterial — DO NOT EDIT", SCENE_UBO_WGSL, buildMeshStruct()];
    if (nodeUbo) {
        wgslParts.push(nodeUbo.struct);
    }
    if (textureWgslDecls.length > 0) {
        wgslParts.push(textureWgslDecls.join("\n"));
    }
    if (lightsWgslDecls) {
        wgslParts.push(lightsWgslDecls);
    }
    if (morphWgslDecls.length > 0) {
        wgslParts.push(morphWgslDecls.join("\n"));
    }
    if (envWgslDecls) {
        wgslParts.push(envWgslDecls);
    }
    wgslParts.push(vertexIn);
    wgslParts.push(vertexOut);
    if (fragmentOut) {
        wgslParts.push(fragmentOut);
    }
    if (mrt) {
        wgslParts.push(mrt._struct);
    }
    if (shadowWgslDecls) {
        wgslParts.push(shadowWgslDecls);
    }
    if (_esmShadowParamsBinding !== null) {
        wgslParts.push(
            `struct NmeShadowParams { biasAndScale: vec4<f32>, depthValues: vec4<f32> };\n@group(1) @binding(${_esmShadowParamsBinding}) var<uniform> nmeShadowParams: NmeShadowParams;`
        );
    }
    if (_geomUbo) {
        wgslParts.push(_geomUbo._wgsl);
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
            (!shadowOutput && shadowVertexInject.length > 0 ? `    ${shadowVertexInject}\n` : ``) +
            `    out.position = ${SENTINEL_VTX_OUTPUT};\n` +
            `    return out;\n` +
            `}`
    );
    const fsReturnType = mrt ? mrt._fsReturnType : noColorOutput ? "" : state.usesFragDepth && !esmShadowOutput ? " -> FragmentOut" : " -> @location(0) vec4<f32>";
    const fragDepthDecl = !mrt && (noColorOutput || esmShadowOutput || state.usesFragDepth) ? `    var ${SENTINEL_FRAG_DEPTH}: f32 = in.position.z;\n` : "";
    const fsReturn = mrt
        ? mrt._fsReturn
        : noColorOutput
          ? ""
          : esmShadowOutput
            ? `${indent(esmShadowDepthCode)}\n`
            : state.usesFragDepth
              ? `    return FragmentOut(${SENTINEL_FRAG_OUTPUT}, ${SENTINEL_FRAG_DEPTH});\n`
              : `    return ${SENTINEL_FRAG_OUTPUT};\n`;
    wgslParts.push(
        `@fragment\nfn fs_main(in: VertexOut, @builtin(front_facing) ${SENTINEL_FRONT_FACING}: bool)${fsReturnType} {\n` +
            `    var ${SENTINEL_FRAG_OUTPUT}: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 1.0);\n` +
            fragDepthDecl +
            `${indent(fragmentBody)}\n` +
            fsReturn +
            `}`
    );
    const rawWgsl = wgslParts.join("\n\n");
    // Substitute scene-uniform sentinels emitted by blocks (FogBlock, LightBlock,
    // ReflectionTextureBlock). These all resolve to scene-UBO fields.
    const _wgsl = rawWgsl
        .replaceAll("_NME_CAMERA_POS_", "scene.vEyePosition.xyz")
        .replaceAll("_NME_FOG_PARAMS_", "scene.vFogInfos")
        .replaceAll("sceneU.", "scene.")
        .replaceAll(SENTINEL_FRAG_COORD, "in.position")
        .replaceAll(SENTINEL_SCREEN_SIZE, "vec2<f32>(scene.vFogColor.w, scene._envPad0)");

    const alphaMode = opts._alphaMode ?? 0;
    const depthFormat = opts._depthStencilFormat ?? "depth24plus-stencil8";
    // Geometry pipelines carry their own discriminator + (colorFormats, cullMode)
    // suffix via `mrt._cacheKey`, built in the lazy module — the non-geometry
    // branch stays byte-for-byte identical to the colour/depth/esm path.
    const cacheKey = `${_wgsl}|${_format}|${depthFormat}|${_msaaSamples}|${opts._backFaceCulling !== false ? 1 : 0}|${alphaMode}|${mrt ? mrt._cacheKey : noColorOutput ? 1 : esmShadowOutput ? 2 : 0}`;
    const cache = getCache(_engine);
    const existing = cache.get(cacheKey);
    if (existing) {
        return existing;
    }

    // Blend state for alpha-blended materials.
    const blend = alphaModeToBlend(alphaMode);
    const depthWriteEnabled = blend === undefined;

    const sceneBGL = getSceneBindGroupLayout(_engine);

    // group 1 BGL
    const meshBglEntries: GPUBindGroupLayoutEntry[] = [{ binding: 0, visibility: SS.VERTEX | SS.FRAGMENT, buffer: { type: "uniform" } }];
    if (_nodeUboBinding !== null) {
        meshBglEntries.push({ binding: _nodeUboBinding, visibility: SS.VERTEX | SS.FRAGMENT, buffer: { type: "uniform" } });
    }
    for (const tb of _textureBindings) {
        meshBglEntries.push({ binding: tb._texBinding, visibility: SS.VERTEX | SS.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } });
        meshBglEntries.push({ binding: tb._sampBinding, visibility: SS.VERTEX | SS.FRAGMENT, sampler: { type: "filtering" } });
    }
    if (_morphBindings !== null) {
        meshBglEntries.push({
            binding: _morphBindings._deltasBinding,
            visibility: SS.VERTEX,
            buffer: { type: "read-only-storage" },
        });
        meshBglEntries.push({
            binding: _morphBindings._uboBinding,
            visibility: SS.VERTEX,
            buffer: { type: "read-only-storage" },
        });
    }
    if (_envBindings) {
        meshBglEntries.push(...envBglEntries);
    }
    if (shadowEmit) {
        meshBglEntries.push(...shadowEmit._bglEntries);
    }
    if (_esmShadowParamsBinding !== null) {
        meshBglEntries.push({ binding: _esmShadowParamsBinding, visibility: SS.FRAGMENT, buffer: { type: "uniform" } });
    }
    if (_geomUbo) {
        meshBglEntries.push(_geomUbo._bglEntry);
    }
    const _meshBGL = device.createBindGroupLayout({ label: "node-mesh", entries: meshBglEntries });

    // Vertex buffers: one GPUVertexBufferLayout per declared attribute, each at location=i.
    const _vertexBuffers: GPUVertexBufferLayout[] = state.vertexAttributes.map((a, i) => ({
        arrayStride: a._arrayStride,
        stepMode: a._stepMode ?? "vertex",
        attributes: [{ format: a._gpuFormat, offset: a._offset ?? 0, shaderLocation: i }],
    }));

    const shaderModule = device.createShaderModule({ label: "node-material", code: _wgsl });

    const _pipeline = mrt
        ? mrt._buildPipeline(device, {
              _shaderModule: shaderModule,
              _sceneBGL: sceneBGL,
              _meshBGL,
              _vertexBuffers,
              _depthFormat: depthFormat,
              _depthCompare: opts._depthCompare ?? REVERSE_DEPTH_COMPARE,
              _msaaSamples,
          })
        : device.createRenderPipeline(
              noColorOutput
                  ? {
                        label: "node-material-depth",
                        layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBGL, _meshBGL] }),
                        vertex: { module: shaderModule, entryPoint: "vs_main", buffers: _vertexBuffers },
                        fragment: { module: shaderModule, entryPoint: "fs_main", targets: [] },
                        depthStencil: { format: depthFormat, depthCompare: opts._depthCompare ?? REVERSE_DEPTH_COMPARE, depthWriteEnabled: true },
                        multisample: { count: _msaaSamples },
                        primitive: { topology: "triangle-list", cullMode: opts._backFaceCulling !== false ? "back" : "none" },
                    }
                  : {
                        ...createDefaultPipelineDescriptor({
                            _label: "node-material",
                            _engine,
                            _bgls: [sceneBGL, _meshBGL],
                            _vertModule: shaderModule,
                            _fragModule: shaderModule,
                            _vertexBuffers,
                            _format,
                            _depthStencilFormat: opts._depthStencilFormat,
                            _depthCompare: opts._depthCompare,
                            _msaaSamples,
                            _cullMode: opts._backFaceCulling !== false ? "back" : "none",
                            _blend: esmShadowOutput ? undefined : blend,
                            _depthWriteEnabled: esmShadowOutput || depthWriteEnabled,
                        }),
                        vertex: { module: shaderModule, entryPoint: "vs_main", buffers: _vertexBuffers },
                        fragment: { module: shaderModule, entryPoint: "fs_main", targets: [!esmShadowOutput && blend ? { format: _format, blend } : { format: _format }] },
                    }
          );

    const result: NodeCompileResult = {
        _wgsl,
        _pipeline,
        _meshBGL,
        _nodeUboSize,
        _nodeUboOffsets,
        _nodeUboBinding,
        _textureBindings,
        _morphBindings,
        _envBindings,
        _shadowBindings,
        _usesClipPlanes: state.usesClipPlanes,
        _usesMeshAttributeFlags: state.usesMeshAttributeExists,
        _esmShadowParamsBinding,
        _geometryGpBinding,
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
