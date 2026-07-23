import { F32, U32, U8 } from "../engine/typed-arrays.js";
import { TU, BU } from "../engine/gpu-flags.js";
import type { SceneContext } from "../scene/scene.js";
import type { Mesh } from "../mesh/mesh.js";
import type { PickingInfo } from "./picking-info.js";
import type { EngineContext } from "../engine/engine.js";
import type { PickContributor, PickSource, PickPassContext } from "./pick-contributor.js";
import { createEmptyPickingInfo } from "./picking-info.js";
import { createPickingRay } from "./ray.js";
import { mat4Invert } from "../math/mat4-invert.js";
import { getPickingSceneBGL } from "./picking-scene-bgl.js";
import { getViewProjectionMatrix, getCameraPosition } from "../camera/camera.js";
import { resolveCameraViewport } from "../camera/viewport.js";
import { createEmptyUniformBuffer, createMappedBuffer, createUniformBuffer } from "../resource/gpu-buffers.js";

/** Existing regular-mesh vertex buffers a pick-discard rule can project into `PickDiscardInput.vertexData`. */
export type PickVertexDataAttribute = "normal" | "uv" | "uv2" | "tangent" | "color";

// ─── Scratch arrays — allocated once, reused across all picks ──────
const _pickVP = new F32(20);
const PICK_MESH_UBO_BYTES = 80;
const _uboScratch = new ArrayBuffer(PICK_MESH_UBO_BYTES);
const _uboF32 = new F32(_uboScratch);
const _uboU32 = new U32(_uboScratch);
const _uboView = new U8(_uboScratch);

/** GPU-based picker — pure state. Use pickAsync() and disposePicker() standalone functions. */
export interface GpuPicker {
    /** @internal Whether the public detailed-picking feature is enabled for this picker. */
    _detailedPicking: boolean;
    /** @internal Device that owns the picker's current GPU resources. */
    _device: GPUDevice | null;
    /** @internal */
    _scene: SceneContext;
    /** @internal 1×1 render targets (lazily created). */
    _rt: PickTargets1x1 | null;
    /** @internal Reusable scene UBO (80 bytes: pick VP + original framebuffer fragment coordinate). */
    _sceneUbo: GPUBuffer | null;
    /** @internal Reusable scene bind group. */
    _sceneBG: GPUBindGroup | null;
    /** @internal Contributor built per pick source (once per picker) and cached, so each contributor's
     *  GPU pick resources live in its closure and dispose generically — the picker never names an
     *  entity type. */
    _contributors: Map<PickSource, PickContributor> | null;
    /** @internal Tail of the serialized pick queue for this picker — see pickAsync(). */
    _pending: Promise<void> | null;
}

interface PickTargets1x1 {
    colorTex: GPUTexture;
    colorView: GPUTextureView;
    depthColorTex: GPUTexture;
    depthColorView: GPUTextureView;
    detail: PickDetailTarget1x1 | null;
    depthTex: GPUTexture;
    depthView: GPUTextureView;
    colorStaging: GPUBuffer;
    depthStaging: GPUBuffer;
}

interface PickDetailTarget1x1 {
    texture: GPUTexture;
    view: GPUTextureView;
    staging: GPUBuffer;
}

/** Create a GPU picker bound to the given scene. */
export function createGpuPicker(scene: SceneContext): GpuPicker {
    return {
        _detailedPicking: false,
        _device: null,
        _scene: scene,
        _rt: null,
        _sceneUbo: null,
        _sceneBG: null,
        _contributors: null,
        _pending: null,
    };
}

function ensurePickerDevice(engine: EngineContext, picker: GpuPicker): void {
    if (picker._device === engine._device) {
        return;
    }
    if (picker._device) {
        disposePicker(picker);
    }
    picker._device = engine._device;
}

function ensureTargets(engine: EngineContext, picker: GpuPicker): PickTargets1x1 {
    const device = engine._device;
    if (picker._rt) {
        return picker._rt;
    }
    const colorTex = device.createTexture({ label: "pick-color", size: [1, 1], format: "rgba8unorm", usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC });
    const depthColorTex = device.createTexture({
        label: "pick-depth-color",
        size: [1, 1],
        format: "r32float",
        usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC,
    });
    const depthTex = device.createTexture({ label: "pick-depth", size: [1, 1], format: "depth24plus", usage: TU.RENDER_ATTACHMENT });
    picker._rt = {
        colorTex,
        colorView: colorTex.createView(),
        depthColorTex,
        depthColorView: depthColorTex.createView(),
        detail: null,
        depthTex,
        depthView: depthTex.createView(),
        colorStaging: device.createBuffer({ label: "pick-color-staging", size: 256, usage: BU.COPY_DST | BU.MAP_READ }),
        depthStaging: device.createBuffer({ label: "pick-depth-staging", size: 256, usage: BU.COPY_DST | BU.MAP_READ }),
    };
    return picker._rt;
}

function ensureSceneUbo(engine: EngineContext, picker: GpuPicker): GPUBuffer {
    const device = engine._device;
    if (!picker._sceneUbo) {
        picker._sceneUbo = createEmptyUniformBuffer(engine, 80, "pick-scene-ubo");
        const sceneBGL = getPickingSceneBGL(engine);
        picker._sceneBG = device.createBindGroup({ label: "pick-scene-bg", layout: sceneBGL, entries: [{ binding: 0, resource: { buffer: picker._sceneUbo } }] });
    }
    return picker._sceneUbo;
}

/** Compute a VP matrix zoomed to an exact sample coordinate on a W×H canvas.
 *  Renders to a 1×1 target — only fragments at the picked pixel survive. */
function computePickVP(out: Float32Array, vp: Float32Array, sampleX: number, sampleY: number, w: number, h: number): void {
    const ndcX = (2 * sampleX) / w - 1;
    const ndcY = 1 - (2 * sampleY) / h;
    // pickVP = pickMatrix * VP (sparse multiply, see derivation in comments)
    for (let c = 0; c < 4; c++) {
        const base = c * 4;
        const w3 = vp[base + 3]!;
        out[base] = w * (vp[base]! - ndcX * w3);
        out[base + 1] = h * (vp[base + 1]! - ndcY * w3);
        out[base + 2] = vp[base + 2]!;
        out[base + 3] = w3;
    }
}

/** Options for {@link pickAsync}. */
export interface PickOptions {
    /** Restrict the pick to a subset of the scene's meshes — return `true` for a mesh that may be picked,
     *  `false` to ignore it entirely (it neither occludes nor is returned). Lets a caller provide its
     *  "list of pickables" so decorative meshes (grass, foliage, particles, …) can't swallow a pick of a
     *  structure behind/around them. When omitted, every mesh is pickable (previous behaviour). A supplied
     *  mesh filter also excludes non-mesh contributors: the predicate cannot admit them, and letting them draw
     *  would make a mesh-targeted pass neither isolated nor deterministic. Applied once while building the
     *  candidate list used by both id assignment and resolution, so ids stay consistent. */
    filter?: (mesh: Mesh) => boolean;
    /** Exclude selected visible identities while picking the surface behind them (for direct manipulation).
     *  A mesh-only identity omits the regular mesh or all of its thin instances. A thin-instance index or
     *  contiguous range discards that identity in the same GPU pass; no repick or CPU proxy is involved. */
    ignore?: PickIgnore | readonly PickIgnore[];
    /** Optional GPU fragment-discard extension for app-specific pick removal.
     *
     *  `wgsl` is injected into the regular and thin-instance picking shaders and must define:
     *
     *  `fn shouldDiscardPick(input: PickDiscardInput) -> bool`
     *
     *  The input exposes only generic picker data: `worldPos`, `fragmentCoord` (the selected pixel
     *  centre in the original backing framebuffer), `pickId`, `thinInstanceIndex`,
     *  `hasThinInstance`, and `instanceExtras` (the
     *  original thin-instance matrix w lanes, zero for non-instanced meshes), and optional regular-mesh
     *  `vertexData` selected by the discard rule. Storage entries are uploaded and bound by Lite for the
     *  current pick only. They are fragment-visible by default and vertex-visible when explicitly marked. */
    discard?: PickDiscardRule;
    /** Dev-only diagnostics: logs the pick ray, pixel, pick id/depth and resolved mesh. */
    debugLabel?: string;
}

export interface PickIgnore {
    readonly mesh: Mesh;
    readonly thinInstanceIndex?: number;
    readonly thinInstanceRange?: { readonly start: number; readonly count: number };
}

/**
 * Optional GPU-side discard rule for {@link pickAsync}.
 *
 * This lets apps remove pick hits with custom WGSL while keeping the main scene
 * render untouched. The WGSL must define
 * `fn shouldDiscardPick(input: PickDiscardInput) -> bool`.
 */
export interface PickDiscardRule {
    /** Stable cache key for the generated picking pipeline set. Change it when the WGSL or layout changes. */
    readonly key: string;
    /** WGSL source that defines `shouldDiscardPick(input: PickDiscardInput) -> bool`. */
    readonly wgsl: string;
    /** Optional WGSL source that defines `fn adjustPickWorld(input: PickWorldInput) -> vec3f`.
     *  Use it to mirror a visible material's vertex displacement in the GPU pick pass. The hook runs before
     *  projection and fragment discard for regular and thin-instanced meshes. `PickWorldInput` exposes the base
     *  world/local position, affine basis and origin, spare thin-instance matrix lanes, instance identity, and the
     *  optional selected regular-mesh vertex attribute. Omit for identity projection. */
    readonly worldAdjustWgsl?: string;
    /** Optional typed-array storage inputs exposed to WGSL at group 2. */
    readonly storage?: readonly PickDiscardStorage[];
    /** Optional existing regular-mesh attribute forwarded flat as a padded `PickDiscardInput.vertexData` vec4.
     *  Values come from the mesh's source attribute buffer (not skin/morph-deformed). Meshes without the
     *  requested buffer and all thin instances receive zero. */
    readonly vertexData?: PickVertexDataAttribute;
}

/** Storage data for a pick discard/world-adjust rule. Lite injects the WGSL declaration and owns the GPU buffer upload. */
export interface PickDiscardStorage {
    /** WGSL variable name declared at `@group(2) @binding(index)`; must be unique within the rule. */
    readonly name: string;
    /** WGSL storage type, for example `array<vec4<f32>>`. */
    readonly type: string;
    /** Also expose this binding to `worldAdjustWgsl` in the vertex stage. Omit for fragment-only discard data. */
    readonly vertex?: boolean;
    /** Per-mesh data for the current pick. Return `null` to draw that mesh with the default picker. */
    readonly data: (mesh: Mesh) => ArrayBufferView | null | undefined;
}

function createPickDiscardBindGroup(engine: EngineContext, layout: GPUBindGroupLayout, discard: PickDiscardRule, mesh: Mesh, tempBuffers: GPUBuffer[]): GPUBindGroup | null {
    const storage = discard.storage;
    if (!storage || storage.length === 0) {
        return null;
    }
    const entries: GPUBindGroupEntry[] = [];
    for (let i = 0; i < storage.length; i++) {
        const data = storage[i]!.data(mesh);
        if (!data) {
            return null;
        }
        const buffer = createMappedBuffer(engine, data, BU.STORAGE, "pick-discard-storage");
        tempBuffers.push(buffer);
        entries.push({ binding: i, resource: { buffer } });
    }
    const device = engine._device;
    return device.createBindGroup({
        label: `pick-discard-${discard.key}-bg`,
        layout,
        entries,
    });
}

/** Pick the mesh at CSS-space canvas coordinates, matching Babylon.js Scene.pick. Returns a PickingInfo.
 *  Does the actual GPU render + readback for one pick — call `pickAsync` (below) instead; it serializes
 *  concurrent calls on the same picker so their shared 1×1 staging buffers never race. */
async function pickAsyncImpl(picker: GpuPicker, x: number, y: number, options?: PickOptions): Promise<PickingInfo> {
    const scene = picker._scene;
    const pickFilter = options?.filter ?? null;
    const pickDiscard = options?.discard ?? null;
    const ignored = options?.ignore;
    const debugLabel = options?.debugLabel;
    const engine = scene.surface.engine;
    if (!scene.camera) {
        return createEmptyPickingInfo();
    }
    ensurePickerDevice(engine, picker);
    const device = engine._device;
    const detailed = picker._detailedPicking;

    // Resolve every lazy dependency before opening a command encoder. Awaiting while a render pass is
    // still unsubmitted lets the main frame resize and retire mesh buffers that the pick pass already
    // captured; the eventual pick submission then references destroyed geometry.
    const preparedContributors: { source: PickSource; contributor: PickContributor }[] = [];
    if (!pickFilter && scene._pickSources.length > 0) {
        const sources = scene._pickSources.slice();
        for (const source of sources) {
            let contributor = picker._contributors?.get(source);
            if (!contributor) {
                const pipeline = await source.load();
                if (!scene._pickSources.includes(source)) {
                    continue;
                }
                contributor = pipeline.createPickContributor(source.entity);
                (picker._contributors ??= new Map()).set(source, contributor);
            }
            preparedContributors.push({ source, contributor });
        }
    }

    let needsDeformedGeometry = false;
    let needsAdvancedPipeline = !!pickDiscard?.worldAdjustWgsl || !!pickDiscard?.vertexData || !!pickDiscard?.storage?.some((storage) => storage.vertex);
    let candidates: { readonly mesh: Mesh; readonly ignore: PickIgnore | null }[];
    if (ignored) {
        const prepared = (await import("./picking-ignore.js")).prepareIgnoredCandidates(scene.meshes, ignored, pickFilter, needsAdvancedPipeline);
        candidates = prepared.candidates;
        needsDeformedGeometry = prepared.deformed;
        needsAdvancedPipeline = prepared.advanced;
    } else {
        candidates = [];
        for (const mesh of scene.meshes) {
            if (mesh.pickable !== false && (!pickFilter || pickFilter(mesh))) {
                candidates.push({ mesh, ignore: null });
                needsDeformedGeometry ||= !!(mesh.morphTargets || mesh.skeleton) && !!mesh._cpuPositions;
                needsAdvancedPipeline ||= !!mesh.vat || !!mesh.thinInstances || !!mesh._gpu._vbLayout?._p;
            }
        }
    }

    const deformedGeometry = needsDeformedGeometry ? await import("./deformed-geometry.js") : null;
    const detailedPicking = detailed ? await import("./detailed-picking.js") : null;
    const debug = debugLabel ? await import("./picking-debug.js") : null;
    const advancedDraw = needsAdvancedPipeline ? await (await import("./picking-advanced-draw.js")).prepareAdvancedDraw(engine, candidates) : null;
    const pipelineApi = advancedDraw ? null : detailed ? await import("./picking-detailed-pipeline.js") : await import("./picking-pipeline.js");
    if (engine._device !== device) {
        return pickAsyncImpl(picker, x, y, options);
    }

    // Pick coordinates are relative to the scene's own surface canvas, not the engine's
    // primary canvas — they differ when the scene renders into an auxiliary surface.
    const canvas = scene.surface.canvas;
    const camera = scene.camera;
    if (!camera) {
        return createEmptyPickingInfo();
    }

    const backingWidth = canvas.width;
    const backingHeight = canvas.height;
    const clientWidth = ("clientWidth" in canvas ? canvas.clientWidth : 0) || backingWidth;
    const clientHeight = ("clientHeight" in canvas ? canvas.clientHeight : 0) || backingHeight;
    const scaleX = backingWidth / clientWidth;
    const scaleY = backingHeight / clientHeight;
    const pickX = x * scaleX;
    const pickY = y * scaleY;
    const viewport = resolveCameraViewport(camera, backingWidth, backingHeight);
    const w = viewport.width;
    const h = viewport.height;
    if (w === 0 || h === 0) {
        return createEmptyPickingInfo();
    }

    if (pickX < viewport.x || pickY < viewport.y || pickX >= viewport.x + viewport.width || pickY >= viewport.y + viewport.height) {
        return createEmptyPickingInfo();
    }

    const px = Math.max(0, Math.min(Math.floor(pickX - viewport.x), w - 1));
    const py = Math.max(0, Math.min(Math.floor(pickY - viewport.y), h - 1));
    const sampleX = pickX - viewport.x;
    const sampleY = pickY - viewport.y;
    const pixelCenterX = px + 0.5;
    const pixelCenterY = py + 0.5;
    const aspect = w / h;
    const vp = getViewProjectionMatrix(camera, aspect);
    const pickRay = detailed || debugLabel ? createPickingRay(sampleX, sampleY, vp, w, h) : null;
    const debugInput = debug ? [x, y, pickX, pickY, px, py, backingWidth, backingHeight, clientWidth, clientHeight, viewport.x, viewport.y, viewport.width, viewport.height] : null;

    // ── Compute pick-zoomed VP (renders single pixel to 1×1 target) ──
    computePickVP(_pickVP, vp as unknown as Float32Array, sampleX, sampleY, w, h);
    // The pick renders into a 1x1 target, whose fragment position is always (0.5, 0.5). Preserve the
    // selected pixel's coordinate in the original backing framebuffer so consumer discard rules can
    // reproduce screen-space dithering exactly. Include the camera viewport origin because visible
    // material fragment coordinates are surface-wide, while px/py above are viewport-local.
    _pickVP[16] = viewport.x + pixelCenterX;
    _pickVP[17] = viewport.y + pixelCenterY;

    const rt = ensureTargets(engine, picker);
    const detailTarget = detailed ? detailedPicking!.ensureDetailTarget(engine, rt) : null;
    const sceneUbo = ensureSceneUbo(engine, picker);
    device.queue.writeBuffer(sceneUbo, 0, _pickVP);

    // ── Assign pick IDs (array-based, no Map for miss case) ──────────
    let nextId = 1;

    // ── Render pass (1×1 target) ─────────────────────────────────────
    const encoder = device.createCommandEncoder({ label: "pick" });
    const colorAttachments: GPURenderPassColorAttachment[] = [
        { view: rt.colorView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" },
        { view: rt.depthColorView, clearValue: { r: 1, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" },
    ];
    if (detailTarget) {
        colorAttachments.push({ view: detailTarget.view, clearValue: { r: 0xffffffff, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" });
    }
    const pass = encoder.beginRenderPass({
        colorAttachments,
        depthStencilAttachment: { view: rt.depthView, depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "discard" },
    });

    const tempBuffers: GPUBuffer[] = [];
    const detailedPositions = detailed ? new Map<Mesh, Float32Array>() : null;
    const detailedNormals = detailed ? new Map<Mesh, Float32Array>() : null;
    let meshRanges: import("./picking-advanced-draw.js").AdvancedMeshRange[];
    if (advancedDraw) {
        const result = advancedDraw.draw(pass, picker._sceneBG!, nextId, pickDiscard, detailed, deformedGeometry, detailedPicking, tempBuffers, detailedPositions, detailedNormals);
        nextId = result.nextId;
        meshRanges = result.ranges;
    } else {
        const defaults = pipelineApi!.getPickingPipelineSet(engine);
        const discarded = pickDiscard ? pipelineApi!.getPickingPipelineSet(engine, pickDiscard) : null;
        meshRanges = [];
        for (const { mesh } of candidates) {
            const gpu = mesh._gpu;
            let position = gpu.positionBuffer;
            let pickPositions: Float32Array | undefined;
            if (deformedGeometry && (mesh.morphTargets || mesh.skeleton)) {
                const positions = deformedGeometry.computeDeformedPositions(mesh);
                if (positions) {
                    position = createMappedBuffer(engine, positions, BU.VERTEX, "pick-deformed-position");
                    tempBuffers.push(position);
                    pickPositions = positions;
                }
            } else if (detailed) {
                pickPositions = mesh._cpuPositions;
            }
            if (detailedPositions && pickPositions) {
                detailedPositions.set(mesh, pickPositions);
            }
            if (detailedNormals && mesh._cpuNormals) {
                detailedNormals.set(mesh, mesh._cpuNormals);
            }
            const discardBG = pickDiscard && discarded?.discardBGL ? createPickDiscardBindGroup(engine, discarded.discardBGL, pickDiscard, mesh, tempBuffers) : null;
            const set = discarded && (!discarded.discardBGL || discardBG) ? discarded : defaults;
            _uboF32.set(mesh.worldMatrix, 0);
            _uboU32[16] = nextId;
            const ubo = createUniformBuffer(engine, _uboView, "pick-mesh-ubo");
            tempBuffers.push(ubo);
            pass.setPipeline(set.regularPipeline);
            pass.setBindGroup(0, picker._sceneBG!);
            pass.setBindGroup(
                1,
                device.createBindGroup({
                    layout: set.regularPipeline.getBindGroupLayout(1),
                    entries: [{ binding: 0, resource: { buffer: ubo } }],
                })
            );
            if (discardBG) {
                pass.setBindGroup(2, discardBG);
            }
            pass.setVertexBuffer(0, position);
            pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
            pass.drawIndexed(gpu.indexCount);
            meshRanges.push({
                base: nextId++,
                count: 1,
                mesh,
                thin: false,
                world: detailedPicking ? detailedPicking.copyDetailedWorldMatrix(mesh.worldMatrix) : null,
                thinVersion: 0,
                worldAdjusted: false,
            });
        }
    }

    // ── Pick contributors (optional entity types) ───────────────────
    // Meshes above own ids 1..M. Each registered contributor (a GS mesh, a billboard system, …)
    // then draws into the SAME pass against the SAME depth target — so contributor entities
    // depth-sort against meshes and each other (an occluded one loses the pick) — and owns a
    // contiguous id range [base, next). The picker names no entity type: the per-type draw,
    // resolve, resources, and view math all live in the contributor's own (lazily imported)
    // module, so a scene with no contributors fetches zero contributor pick bytes.
    const contribRanges: { base: number; count: number; contributor: PickContributor }[] = [];
    if (preparedContributors.length > 0) {
        const pickCtx: PickPassContext = { picker, pass, engine, scene, camera, sceneBG: picker._sceneBG!, px: sampleX, py: sampleY, w, h, detailed };
        for (const { source, contributor } of preparedContributors) {
            if (!scene._pickSources.includes(source)) {
                continue;
            }
            const base = nextId;
            nextId = contributor.draw(pickCtx, base);
            if (nextId > base) {
                contribRanges.push({ base, count: nextId - base, contributor });
            }
        }
    }
    pass.end();

    // ── Readback (both 1×1 — trivially small) ────────────────────────
    encoder.copyTextureToBuffer({ texture: rt.colorTex }, { buffer: rt.colorStaging, bytesPerRow: 256 }, { width: 1, height: 1 });
    encoder.copyTextureToBuffer({ texture: rt.depthColorTex }, { buffer: rt.depthStaging, bytesPerRow: 256 }, { width: 1, height: 1 });
    if (detailTarget) {
        detailedPicking!.copyDetailTarget(encoder, detailTarget);
    }
    device.queue.submit([encoder.finish()]);

    let pickId: number;
    let depth: number;
    let primitiveIndex = -1;
    let localPoint: [number, number, number] | null = null;
    try {
        const maps: Promise<void>[] = [rt.colorStaging.mapAsync(GPUMapMode.READ), rt.depthStaging.mapAsync(GPUMapMode.READ)];
        const detailRead = detailTarget ? detailedPicking!.readDetailTarget(detailTarget) : null;
        if (detailRead) {
            maps.push(detailRead.then(() => undefined));
        }
        await Promise.all(maps);

        const colorData = new U8(rt.colorStaging.getMappedRange());
        pickId = (colorData[0]! << 16) | (colorData[1]! << 8) | colorData[2]!;
        depth = new F32(rt.depthStaging.getMappedRange())[0]!;
        if (detailRead) {
            ({ primitiveIndex, localPoint } = await detailRead);
        }
        rt.colorStaging.unmap();
        rt.depthStaging.unmap();
    } finally {
        for (let i = 0; i < tempBuffers.length; i++) {
            tempBuffers[i]!.destroy();
        }
    }

    // ── Resolve pick ID to mesh ──────────────────────────────────────
    if (pickId === 0) {
        if (debug) {
            debug.tracePick(debugLabel!, debugInput!, pickRay, pickId, depth, false);
        }
        return createEmptyPickingInfo();
    }
    let hitMesh: Mesh | null = null;
    let hitRange: (typeof meshRanges)[number] | null = null;
    let hitThinIdx = -1;
    for (let i = 0; i < meshRanges.length; i++) {
        const range = meshRanges[i]!;
        if (pickId >= range.base && pickId < range.base + range.count) {
            hitMesh = range.mesh;
            hitRange = range;
            hitThinIdx = range.thin ? pickId - range.base : -1;
            break;
        }
    }
    // Contributor resolve: meshes own ids 1..M, so any unresolved id belongs to a contributor.
    // Find the owning contributor by its id range (a numeric compare, no entity-type knowledge).
    let hitContributor: PickContributor | null = null;
    let contribLocalId = -1;
    if (!hitMesh) {
        for (let ri = 0; ri < contribRanges.length; ri++) {
            const r = contribRanges[ri]!;
            if (pickId >= r.base && pickId < r.base + r.count) {
                hitContributor = r.contributor;
                contribLocalId = pickId - r.base;
                break;
            }
        }
    }
    if (!hitMesh && !hitContributor) {
        if (debug) {
            debug.tracePick(debugLabel!, debugInput!, pickRay, pickId, depth, false, true);
        }
        return createEmptyPickingInfo();
    }

    const info = createEmptyPickingInfo();
    info.hit = true;
    info.pickedMesh = hitMesh;
    info.thinInstanceIndex = hitThinIdx;
    info.ray = detailed ? pickRay : null;

    // Reconstruct world position from depth (using original full-res VP)
    const invVP = mat4Invert(vp);
    if (invVP) {
        const ndcX = (2 * sampleX) / w - 1;
        const ndcY = 1 - (2 * sampleY) / h;
        const wx = invVP[0]! * ndcX + invVP[4]! * ndcY + invVP[8]! * depth + invVP[12]!;
        const wy = invVP[1]! * ndcX + invVP[5]! * ndcY + invVP[9]! * depth + invVP[13]!;
        const wz = invVP[2]! * ndcX + invVP[6]! * ndcY + invVP[10]! * depth + invVP[14]!;
        const ww = invVP[3]! * ndcX + invVP[7]! * ndcY + invVP[11]! * depth + invVP[15]!;
        const invW = 1 / ww;
        info.pickedPoint = [wx * invW, wy * invW, wz * invW];

        const origin = detailed && pickRay ? { x: pickRay.origin[0], y: pickRay.origin[1], z: pickRay.origin[2] } : getCameraPosition(camera);
        const dx = info.pickedPoint[0] - origin.x;
        const dy = info.pickedPoint[1] - origin.y;
        const dz = info.pickedPoint[2] - origin.z;
        info.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    if (hitContributor) {
        // The contributor attaches its own payload (GS sets pickedMesh; a billboard sets _spritePick).
        // pickedPoint/distance were reconstructed above from the shared pick depth.
        hitContributor.resolve(info, contribLocalId);
    } else if (hitMesh && hitRange?.world && localPoint && primitiveIndex >= 0) {
        const thinStateStable = !hitRange.thin || hitMesh.thinInstances?._version === hitRange.thinVersion;
        if (thinStateStable) {
            const positions = detailedPositions?.get(hitMesh);
            const world = detailedPicking!.detailedWorldMatrix(hitRange.world, hitMesh, hitThinIdx);
            detailedPicking!.populateDetailedMeshInfo(info, hitMesh, primitiveIndex, localPoint, positions, detailedNormals?.get(hitMesh), world, !hitRange.worldAdjusted);
        }
    }

    if (debug) {
        debug.tracePick(debugLabel!, debugInput!, info.ray ?? pickRay, pickId, depth, true, false, hitMesh ? (hitMesh.name ?? "(unnamed)") : "(contributor)", hitThinIdx, info);
    }

    return info;
}

/**
 * Pick the mesh at CSS-space canvas coordinates, matching Babylon.js Scene.pick. Returns a PickingInfo.
 *
 * A picker's 1×1 readback targets (`PickTargets1x1.colorStaging`/`depthStaging`) are lazily created ONCE
 * and reused for every pick — cheap, but it means two overlapping `pickAsync` calls on the SAME picker
 * race `mapAsync` on those shared buffers ("Buffer already has an outstanding map pending", since a
 * GPUBuffer allows only one pending map at a time). This is easy to trigger from a consumer: e.g. a
 * cursor-following hover preview that GPU-picks on every pointermove, racing a pick fired by a click that
 * lands before the hover's pick has unmapped. Queue concurrent calls per-picker instead of rejecting: each
 * pick's full map/unmap cycle completes before the next one starts.
 */
export function pickAsync(picker: GpuPicker, x: number, y: number, options?: PickOptions): Promise<PickingInfo> {
    const prior = picker._pending ?? Promise.resolve();
    const run = prior.then(
        () => pickAsyncImpl(picker, x, y, options),
        () => pickAsyncImpl(picker, x, y, options) // a prior pick's rejection must not wedge the queue for this caller
    );
    // Swallow so a rejection here doesn't propagate into the NEXT caller's chain (each caller gets its own
    // `run` promise and observes the real rejection via the returned promise, not via `_pending`).
    picker._pending = run.then(
        () => undefined,
        () => undefined
    );
    return run;
}

/** Dispose GPU resources owned by this picker. */
export function disposePicker(picker: GpuPicker): void {
    if (picker._rt) {
        for (const resource of [
            picker._rt.colorTex,
            picker._rt.depthColorTex,
            picker._rt.detail?.texture,
            picker._rt.depthTex,
            picker._rt.colorStaging,
            picker._rt.depthStaging,
            picker._rt.detail?.staging,
        ]) {
            resource?.destroy();
        }
        picker._rt = null;
    }
    picker._sceneUbo?.destroy();
    picker._sceneUbo = null;
    picker._sceneBG = null;
    if (picker._contributors) {
        for (const contributor of picker._contributors.values()) {
            contributor.dispose?.();
        }
        picker._contributors = null;
    }
    picker._device = null;
}
