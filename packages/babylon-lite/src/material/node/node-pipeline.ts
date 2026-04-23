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
import type { NodeBuildState } from "./node-types.js";

// ─── Shared WGSL preamble ───────────────────────────────────────────
//
//  Matches Lite's scene UBO layout (see `standard-material.ts:1-12`). This is
//  the single source of truth NME uses to reference scene-provided values; if
//  the Standard scene UBO changes shape, update both in lockstep.

const WGSL_SCENE_STRUCT = `struct SceneU {
    viewProjection: mat4x4<f32>,
    view: mat4x4<f32>,
    vEyePosition: vec4<f32>,
    vFogInfos: vec4<f32>,
    vFogColor: vec4<f32>,
};
@group(0) @binding(0) var<uniform> sceneU: SceneU;`;

const WGSL_MESH_STRUCT = `struct MeshU {
    world: mat4x4<f32>,
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
    /** The resolved bind-group slot (within group 1) for the node UBO. `null` if no uniforms. */
    readonly nodeUboBinding: number | null;
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
}

export function compileNodePipeline(state: NodeBuildState, vertexBody: string, fragmentBody: string, opts: CompileOpts): NodeCompileResult {
    const { engine, format, msaaSamples } = opts;
    const device = engine.device;

    // Binding layout for group 1:
    //   slot 0 = mesh UBO (world matrix)
    //   slot 1 = node UBO (if nodeUboFields non-empty)
    //   slot N,N+1 = texture + sampler (paired)
    const nodeUboBinding = state.nodeUboFields.length > 0 ? 1 : null;
    const nodeUbo = buildNodeUbo(state, 1);
    const nodeUboSize = nodeUbo?.size ?? 0;
    const nodeUboOffsets: ReadonlyMap<string, number> = nodeUbo?.offsets ?? new Map<string, number>();

    // Compose WGSL (node UBO struct inserted conditionally between mesh + VertexIn).
    const vertexIn = buildVertexIn(state);
    const vertexOut = buildVertexOut(state);
    const wgslParts: string[] = [
        "// Auto-generated by NodeMaterial — DO NOT EDIT",
        WGSL_SCENE_STRUCT,
        WGSL_MESH_STRUCT,
    ];
    if (nodeUbo) {
        wgslParts.push(nodeUbo.struct);
    }
    wgslParts.push(vertexIn);
    wgslParts.push(vertexOut);

    wgslParts.push(
        `@vertex\nfn vs_main(in: VertexIn) -> VertexOut {\n` +
            `    var out: VertexOut;\n` +
            `    var ${SENTINEL_VTX_OUTPUT}: vec4<f32> = vec4<f32>(0.0, 0.0, 0.0, 1.0);\n` +
            `${indent(vertexBody)}\n` +
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
    const wgsl = wgslParts.join("\n\n");

    const cacheKey = `${wgsl}|${format}|${msaaSamples}|${opts.backFaceCulling !== false ? "bfc" : "nobfc"}`;
    const cache = getCache(engine);
    const existing = cache.get(cacheKey);
    if (existing) {
        return existing;
    }

    const sceneBGL = getSceneBindGroupLayout(engine);

    // group 1 BGL
    const meshBglEntries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ];
    if (nodeUboBinding !== null) {
        meshBglEntries.push({ binding: nodeUboBinding, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } });
    }
    // (Texture entries would go here in scene 62+.)
    const meshBGL = device.createBindGroupLayout({ label: "node-mesh", entries: meshBglEntries });

    // Vertex buffers: one GPUVertexBufferLayout per declared attribute, each at location=i.
    const vertexBuffers: GPUVertexBufferLayout[] = state.vertexAttributes.map((a, i) => ({
        arrayStride: a.arrayStride,
        stepMode: a.stepMode ?? "vertex",
        attributes: [{ format: a.gpuFormat, offset: a.offset ?? 0, shaderLocation: i }],
    }));

    const shaderModule = device.createShaderModule({ label: "node-material", code: wgsl });

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
        }),
        vertex: { module: shaderModule, entryPoint: "vs_main", buffers: vertexBuffers },
        fragment: { module: shaderModule, entryPoint: "fs_main", targets: [{ format }] },
    });

    const result: NodeCompileResult = {
        wgsl,
        pipeline,
        sceneBGL,
        meshBGL,
        nodeUboSize,
        nodeUboOffsets,
        nodeUboBinding,
    };
    cache.set(cacheKey, result);
    return result;
}
