/** Node Material geometry-MRT renderable factory.
 *
 *  Builds a {@link Renderable} that draws a single mesh through a
 *  {@link createNodeGeometryMaterialView} into the geometry renderer task's
 *  multi-attachment render target. Parallel to
 *  `standard-geometry-renderable.ts` / `pbr-geometry-renderable.ts` but for the
 *  NodeMaterial family.
 *
 *  The geometry shader is produced by **re-walking** the parsed graph from the
 *  `GeometryTextureOutputBlock` terminal (instead of `FragmentOutputBlock`).
 *  That second `emitGraph` pass fills `state._geometryInputs` with the WGSL
 *  expression for every connected geometry input; this module turns those into
 *  the per-attachment `FragmentOutput` writes (falling back to the engine
 *  default for unconnected attachments) and feeds them to
 *  {@link compileNodePipeline} via its `_mrtOutput` option.
 *
 *  This module is imported only by {@link createNodeGeometryMaterialView}, which
 *  the geometry renderer task dynamic-imports — node scenes that never use the
 *  geometry renderer pay zero bytes for it.
 */

import { F32 } from "../../engine/typed-arrays.js";
import { BU, SS } from "../../engine/gpu-flags.js";
import type { EngineContext } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import { targetSignatureKey } from "../../engine/render-target.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshGroupBuilder, Renderable } from "../../render/renderable.js";
import { writeMeshLightSelection } from "../../render/lights-ubo.js";
import { MAX_LIGHTS } from "../../light/types.js";
import { packMat4IntoF32 } from "../../math/pack-mat4-into-f32.js";
import type { SceneContext } from "../../scene/scene-core.js";
import type { Material } from "../material.js";
import { GeometryTextureType } from "../../frame-graph/geometry-types.js";
import type { NodeExpr, NodeBuildState, NodeGraph } from "./node-types.js";
import { emitGraph } from "./node-emitter.js";
import { findBlockByClassName } from "./node-parser.js";
import { compileNodePipeline, type NodeCompileResult, type MrtOutputOpts } from "./node-pipeline.js";
import type { NodeMaterial } from "./node-material.js";
import { sanitize, bjsTypeToNodeType, floatCount, extractDefault } from "./node-material.js";
import { getAttrBuffer, writeAttributeFlags } from "./node-renderable.js";
import type { NodeGeometryMaterialView } from "./node-geometry-view.js";

/** Singleton {@link MeshGroupBuilder} that node geometry views point at via their
 *  overridden `_buildGroup`. The async builder body is unreachable — geometry
 *  views are dispatched per-mesh via the geometry renderer task which calls
 *  `_rebuildSingle` directly. */
export const nodeGeometryGroupBuilder: MeshGroupBuilder = (async () => {
    throw new Error("node-geometry view does not support scene group building");
}) as MeshGroupBuilder;
nodeGeometryGroupBuilder._rebuildSingle = (scene: SceneContext, mesh: Mesh, materialOverride?: Material): Renderable => {
    const view = (materialOverride ?? mesh.material) as NodeGeometryMaterialView;
    return buildNodeGeometryRenderable(scene, mesh, view);
};
nodeGeometryGroupBuilder._materialFamily = "node";

/** Shared per-view geometry resources, computed once and cached on the view. */
interface NodeGeometryViewResources {
    readonly _vertexWgsl: string;
    readonly _fragmentWgsl: string;
    readonly _geomState: NodeBuildState;
    readonly _struct: string;
    /** Fully-assembled fs_main return body (`var out…; return out;`), indented
     *  one level with a trailing newline — ready to splice straight into the
     *  node pipeline's `fs_main` (no WGSL assembly leaks into node-pipeline.ts). */
    readonly _fsReturn: string;
    readonly _needsGpUbo: boolean;
    readonly _attrNames: readonly string[];
    /** Per-target-signature compile (pipeline + BGL). */
    readonly _compileBySig: Map<string, NodeCompileResult>;
    /** Shared node UBO (one per material, format-independent). Allocated on first compile. */
    _nodeUBO: GPUBuffer | null;
    _nodeUBOReady: boolean;
}

const ZERO = (wg: string): string => `vec4<f32>(0.0, 0.0, 0.0, ${wg})`;

/** Build the per-attachment WGSL write for one geometry texture type, reading a
 *  connected graph input when present and falling back to the engine default. */
function geomWrite(type: GeometryTextureType, inputs: Map<GeometryTextureType, NodeExpr>, gpRef: { needsGp: boolean }): string {
    const wg = "1.0"; // opaque node materials: writeGeometryInfo gate is always 1.
    const v = inputs.get(type);
    const wp = inputs.get(GeometryTextureType.WORLD_POSITION);
    switch (type) {
        case GeometryTextureType.WORLD_POSITION:
            return v ? `vec4<f32>(${v.expr}, ${wg})` : ZERO(wg);
        case GeometryTextureType.LOCAL_POSITION:
            return v ? `vec4<f32>(${v.expr}, ${wg})` : ZERO(wg);
        case GeometryTextureType.WORLD_NORMAL:
            return v ? `vec4<f32>(normalize(${v.expr}) * 0.5 + vec3<f32>(0.5), ${wg})` : ZERO(wg);
        case GeometryTextureType.VIEW_NORMAL:
            return v ? `vec4<f32>(normalize(${v.expr}), ${wg})` : ZERO(wg);
        case GeometryTextureType.REFLECTIVITY:
            // Stored as vec4 — vec4(rgb, a) * writeGeometryInfo.
            return v ? `(${v.expr}) * ${wg}` : ZERO(wg);
        case GeometryTextureType.ALBEDO:
            return v ? `vec4<f32>(${v.expr}, ${wg})` : ZERO(wg);
        case GeometryTextureType.IRRADIANCE:
            return v ? `vec4<f32>(${v.expr}, ${wg})` : ZERO(wg);
        case GeometryTextureType.SCREENSPACE_DEPTH:
            return v ? `vec4<f32>(${v.expr}, 0.0, 0.0, ${wg})` : `vec4<f32>(in.position.z, 0.0, 0.0, ${wg})`;
        case GeometryTextureType.VIEW_DEPTH:
            if (v) {
                return `vec4<f32>(${v.expr}, 0.0, 0.0, ${wg})`;
            }
            return wp ? `vec4<f32>((scene.view * vec4<f32>(${wp.expr}, 1.0)).z, 0.0, 0.0, ${wg})` : ZERO(wg);
        case GeometryTextureType.NORMALIZED_VIEW_DEPTH:
            if (v) {
                return `vec4<f32>(${v.expr}, 0.0, 0.0, ${wg})`;
            }
            if (wp) {
                gpRef.needsGp = true;
                return `vec4<f32>(((scene.view * vec4<f32>(${wp.expr}, 1.0)).z - nmeGeom.cameraNearFar.x) / (nmeGeom.cameraNearFar.y - nmeGeom.cameraNearFar.x), 0.0, 0.0, ${wg})`;
            }
            return ZERO(wg);
        case GeometryTextureType.LINEAR_VELOCITY:
            // Stored as vec3 — node materials do not compute velocity, default 0.
            return v ? `vec4<f32>(${v.expr}, ${wg})` : ZERO(wg);
    }
}

/** Re-emit the graph from the GeometryTextureOutputBlock terminal and build the
 *  shared geometry resources (WGSL bodies + FragmentOutput struct + writes). */
function ensureGeometryResources(view: NodeGeometryMaterialView): NodeGeometryViewResources {
    const cached = view._geometry as NodeGeometryViewResources | undefined;
    if (cached) {
        return cached;
    }
    const source = view.source as NodeMaterial;
    const graph = source._graph;
    const geomRoot = findBlockByClassName(graph, "GeometryTextureOutputBlock");
    if (!geomRoot) {
        throw new Error("NodeMaterial geometry view: graph has no GeometryTextureOutputBlock");
    }
    const vertRoot = findBlockByClassName(graph, "VertexOutputBlock");
    const { vertexWgsl, fragmentWgsl, state } = emitGraph(
        graph,
        source._emitters as Map<string, import("./node-types.js").BlockEmitter>,
        geomRoot.id,
        vertRoot ? vertRoot.id : null,
        [],
        {
            hasSkeleton: source._hasSkeleton,
            hasInstances: source._hasInstances,
        }
    );
    if (state.usesMorphTargets || state.usesEnv || state.shadowLights.length > 0) {
        throw new Error("NodeMaterial geometry view: morph / env / shadow inputs are not supported in the geometry pass");
    }

    const inputs = state._geometryInputs ?? new Map<GeometryTextureType, NodeExpr>();
    const attachments = view._geometryAttachments;
    const gpRef = { needsGp: false };
    const structLines = attachments.map((_, i) => `@location(${i}) f${i}: vec4<f32>,`);
    const struct = `struct FragmentOutput {\n${structLines.join("\n")}\n};`;
    const writeLines = attachments.map((type, i) => `out.f${i} = ${geomWrite(type, inputs, gpRef)};`);
    // Pre-indent the full return body here (one level + trailing newline) so the
    // node pipeline just splices the string — no geometry WGSL assembly in the
    // always-loaded compileNodePipeline.
    const fsReturn = ["var out: FragmentOutput;", ...writeLines, "return out;"].map((l) => `    ${l}`).join("\n") + "\n";

    const res: NodeGeometryViewResources = {
        _vertexWgsl: vertexWgsl,
        _fragmentWgsl: fragmentWgsl,
        _geomState: state,
        _struct: struct,
        _fsReturn: fsReturn,
        _needsGpUbo: gpRef.needsGp,
        _attrNames: state.vertexAttributes.map((a) => a._name),
        _compileBySig: new Map(),
        _nodeUBO: null,
        _nodeUBOReady: false,
    };
    Object.defineProperty(view, "_geometry", { value: res, enumerable: false, configurable: true });
    return res;
}

/** Compile (or fetch cached) the geometry MRT pipeline for a target signature. */
function ensureGeometryCompile(view: NodeGeometryMaterialView, res: NodeGeometryViewResources, engine: EngineContext, sig: RenderTargetSignature): NodeCompileResult {
    const key = targetSignatureKey(sig);
    const cached = res._compileBySig.get(key);
    if (cached) {
        return cached;
    }
    const source = view.source as NodeMaterial;
    const colorFormats = (sig as RenderTargetSignature & { _colorFormats?: readonly GPUTextureFormat[] })._colorFormats ?? (sig._colorFormat ? [sig._colorFormat] : []);
    if (colorFormats.length === 0) {
        throw new Error("node-geometry: render target has no color attachments");
    }
    const cullMode: GPUCullMode = source._graph.backFaceCulling ? (view._reverseCulling ? "front" : "back") : "none";
    // All geometry-specific WGSL object-literals + the MRT pipeline descriptor
    // live here (lazy module). compileNodePipeline only splices strings + calls
    // these callbacks, so non-geometry node scenes bundle none of it.
    const mrtOutput: MrtOutputOpts = {
        _struct: res._struct,
        _fsReturnType: " -> FragmentOutput",
        _fsReturn: res._fsReturn,
        _cacheKey: `3|mrt:${colorFormats.join()}:${cullMode}`,
        _needsGpUbo: res._needsGpUbo,
        _buildGeomUbo: (binding) => ({
            _wgsl: `struct NmeGeomParams { previousViewProjection: mat4x4<f32>, cameraNearFar: vec4<f32> };\n@group(1) @binding(${binding}) var<uniform> nmeGeom: NmeGeomParams;`,
            _bglEntry: { binding, visibility: SS.FRAGMENT, buffer: { type: "uniform" } },
        }),
        // Geometry MRT renders upright into offscreen targets (the task packs an
        // un-flipped scene UBO), matching the Standard/PBR geometry renderables.
        _buildPipeline: (device, a) =>
            device.createRenderPipeline({
                label: "node-material-geometry",
                layout: device.createPipelineLayout({ bindGroupLayouts: [a._sceneBGL, a._meshBGL] }),
                vertex: { module: a._shaderModule, entryPoint: "vs_main", buffers: a._vertexBuffers },
                fragment: { module: a._shaderModule, entryPoint: "fs_main", targets: colorFormats.map((f) => ({ format: f })) },
                depthStencil: { format: a._depthFormat, depthCompare: a._depthCompare, depthWriteEnabled: true },
                multisample: { count: a._msaaSamples },
                primitive: { topology: "triangle-list", cullMode, frontFace: "ccw" },
            }),
    };
    const compile = compileNodePipeline(res._geomState, res._vertexWgsl, res._fragmentWgsl, {
        _engine: engine,
        _format: engine.format,
        _depthStencilFormat: sig._depthStencilFormat,
        _depthCompare: sig._depthCompare ?? "greater-equal",
        _msaaSamples: sig._sampleCount,
        _backFaceCulling: source._graph.backFaceCulling,
        _alphaMode: 0,
        _mrtOutput: mrtOutput,
    });
    res._compileBySig.set(key, compile);
    return compile;
}

/** Resolve the default uniform value (as a Float32Array) for the InputBlock
 *  whose sanitized name matches `sanitizedName`. Used by {@link ensureGeometryNodeUBO}
 *  for uniforms that only appear in the geometry re-emit — e.g. a constant
 *  reflectivity colour referenced solely by the GeometryTextureOutputBlock
 *  terminal and therefore absent from the colour pass's `_uniformValues`.
 *  Returns null when no matching scalar/vector uniform InputBlock exists. Lives
 *  here (not in the always-loaded `node-material.ts`) so non-geometry node
 *  scenes pay zero bytes for it; the tiny helpers it calls (`sanitize`,
 *  `bjsTypeToNodeType`, `floatCount`, `extractDefault`) are already retained by
 *  the always-loaded UBO writer and merely re-exported. */
function extractNodeUniformDefault(graph: NodeGraph, sanitizedName: string): Float32Array | null {
    for (const block of graph.blocks.values()) {
        if (block.className !== "InputBlock") {
            continue;
        }
        if (sanitize(block.name || `input${block.id}`) !== sanitizedName) {
            continue;
        }
        const type = bjsTypeToNodeType((block.serialized["type"] as number | undefined) ?? 0x10);
        if (type === "mat4f") {
            return null;
        }
        const values = new F32(floatCount(type));
        values.set(extractDefault(block.serialized["value"], type));
        return values;
    }
    return null;
}

/** Build / refresh the shared geometry node UBO (constants + live uniform overlays). */
function ensureGeometryNodeUBO(res: NodeGeometryViewResources, compile: NodeCompileResult, engine: EngineContext, source: NodeMaterial): GPUBuffer | null {
    if (res._nodeUBOReady) {
        return res._nodeUBO;
    }
    res._nodeUBOReady = true;
    if (compile._nodeUboBinding === null || compile._nodeUboSize === 0) {
        return null;
    }
    const scratch = new F32(compile._nodeUboSize / 4);
    for (const [name, offsetBytes] of compile._nodeUboOffsets) {
        const live = source._uniformValues.get(name);
        if (live) {
            scratch.set(live._values, offsetBytes >> 2);
            continue;
        }
        const def = extractNodeUniformDefault(source._graph, name);
        if (def) {
            scratch.set(def, offsetBytes >> 2);
        }
    }
    const ubo = engine._device.createBuffer({ label: "node-geom-ubo", size: compile._nodeUboSize, usage: BU.UNIFORM | BU.COPY_DST });
    engine._device.queue.writeBuffer(ubo, 0, scratch);
    res._nodeUBO = ubo;
    return ubo;
}

function buildGeometryBindGroup(
    engine: EngineContext,
    source: NodeMaterial,
    compile: NodeCompileResult,
    meshUBO: GPUBuffer,
    nodeUBO: GPUBuffer | null,
    view: NodeGeometryMaterialView
): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: meshUBO } }];
    if (nodeUBO && compile._nodeUboBinding !== null) {
        entries.push({ binding: compile._nodeUboBinding, resource: { buffer: nodeUBO } });
    }
    for (const tb of compile._textureBindings) {
        const tex = source._textureSlots.get(tb._name)?.current;
        if (!tex) {
            throw new Error(`NodeMaterial geometry view: texture binding "${tb._name}" not set. Provide it via material.inputs["${tb._name}"].texture before the first render.`);
        }
        entries.push({ binding: tb._texBinding, resource: tex.view }, { binding: tb._sampBinding, resource: tex.sampler });
    }
    if (compile._geometryGpBinding !== null) {
        if (!view._gpUBO) {
            throw new Error("NodeMaterial geometry view: NORMALIZED_VIEW_DEPTH requested but no geometry-params UBO was provided by the task.");
        }
        entries.push({ binding: compile._geometryGpBinding, resource: { buffer: view._gpUBO } });
    }
    return engine._device.createBindGroup({ label: "node-geom-bg", layout: compile._meshBGL, entries });
}

/** Build a {@link Renderable} for one mesh drawn through a NodeMaterial geometry view. */
export function buildNodeGeometryRenderable(scene: SceneContext, mesh: Mesh, view: NodeGeometryMaterialView): Renderable {
    const engine = scene.engine as EngineContext;
    const device = engine._device;
    const source = view.source as NodeMaterial;
    const res = ensureGeometryResources(view);

    // Per-mesh UBO: world (64B) + receivesShadow (vec4) + light count/indices.
    const meshUboBytes = (96 + 16 * Math.ceil(MAX_LIGHTS / 4) + 15) & ~15;
    const meshUBO = device.createBuffer({ label: "node-geom-mesh-ubo", size: meshUboBytes, usage: BU.UNIFORM | BU.COPY_DST });
    const meshScratch = new F32(meshUboBytes / 4);
    const packMeshWorld = engine._makePackMeshWorld?.(scene) ?? packMat4IntoF32;

    let needsAttrFlags = false;
    const writeMesh = (): void => {
        packMeshWorld(meshScratch, mesh.worldMatrix, 0, 0);
        meshScratch[16] = mesh.receiveShadows ? 1 : 0;
        if (needsAttrFlags) {
            writeAttributeFlags(mesh, meshScratch);
        }
        writeMeshLightSelection(mesh, scene.lights, meshScratch.subarray(4));
        device.queue.writeBuffer(meshUBO, 0, meshScratch as Float32Array<ArrayBuffer>);
    };

    let bindGroup: GPUBindGroup | null = null;
    let lastWorldVersion = -1;
    let lastLightsCount = -1;

    const sortCenter: [number, number, number] = [mesh.worldMatrix[12]!, mesh.worldMatrix[13]!, mesh.worldMatrix[14]!];

    const r: Renderable = {
        order: mesh.renderOrder ?? 100,
        isTransparent: false,
        mesh,
        bind(eng: EngineContext, sig: RenderTargetSignature) {
            const compile = ensureGeometryCompile(view, res, eng as EngineContext, sig);
            needsAttrFlags = compile._usesMeshAttributeFlags;
            const nodeUBO = ensureGeometryNodeUBO(res, compile, eng as EngineContext, source);
            bindGroup = buildGeometryBindGroup(eng as EngineContext, source, compile, meshUBO, nodeUBO, view);

            const update = (): void => {
                if (mesh.worldMatrixVersion !== lastWorldVersion || scene.lights.length !== lastLightsCount) {
                    writeMesh();
                    sortCenter[0] = mesh.worldMatrix[12]!;
                    sortCenter[1] = mesh.worldMatrix[13]!;
                    sortCenter[2] = mesh.worldMatrix[14]!;
                    lastWorldVersion = mesh.worldMatrixVersion;
                    lastLightsCount = scene.lights.length;
                }
            };
            const draw = (pass: GPURenderPassEncoder | GPURenderBundleEncoder): number => {
                if (mesh.visible === false) {
                    return 0;
                }
                const g = mesh._gpu;
                for (let i = 0; i < res._attrNames.length; i++) {
                    pass.setVertexBuffer(i, getAttrBuffer(engine, g, res._attrNames[i]!));
                }
                pass.setIndexBuffer(g.indexBuffer, g.indexFormat);
                pass.setBindGroup(1, bindGroup!);
                pass.drawIndexed(g.indexCount);
                return 1;
            };
            return { renderable: r, pipeline: compile._pipeline, update, draw };
        },
    };
    r._worldCenter = sortCenter;
    return r;
}
