import type { SceneContext } from "../scene/scene.js";
import type { Mesh } from "../mesh/mesh.js";
import type { MeshInternal } from "../mesh/mesh.js";
import type { PickingInfo } from "./picking-info.js";
import type { EngineContextInternal } from "../engine/engine.js";
import { createEmptyPickingInfo } from "./picking-info.js";
import { createPickingRay } from "./ray.js";
import { mat4Invert } from "../math/mat4.js";
import { getPickingPipeline, getPickingTIPipeline, getPickingSceneBGL, getPickingMeshBGL, getPickingTIMeshBGL } from "./picking-pipeline.js";
import { getViewProjectionMatrix, getCameraPosition } from "../camera/camera.js";

// ─── Scratch arrays — allocated once, reused across all picks ──────
const _pickVP = new Float32Array(16);
const _uboScratch = new ArrayBuffer(80);
const _uboF32 = new Float32Array(_uboScratch, 0, 16);
const _uboU32 = new Uint32Array(_uboScratch, 64, 1);
const _uboView = new Uint8Array(_uboScratch);
const _tiUboScratch = new Uint32Array(4);

/** GPU-based picker — pure state. Use pickAsync() and disposePicker() standalone functions. */
export interface GpuPicker {
    /** Optional hook for detailed picking (Phase 2). */
    _detailedPick: ((info: PickingInfo, ray: { origin: [number, number, number]; direction: [number, number, number]; length: number }) => void) | null;
    /** @internal */
    _scene: SceneContext;
    /** @internal 1×1 render targets (lazily created). */
    _rt: PickTargets1x1 | null;
    /** @internal Reusable scene UBO (64 bytes). */
    _sceneUbo: GPUBuffer | null;
    /** @internal Reusable scene bind group. */
    _sceneBG: GPUBindGroup | null;
}

interface PickTargets1x1 {
    colorTex: GPUTexture;
    colorView: GPUTextureView;
    depthColorTex: GPUTexture;
    depthColorView: GPUTextureView;
    depthTex: GPUTexture;
    depthView: GPUTextureView;
    colorStaging: GPUBuffer;
    depthStaging: GPUBuffer;
}

/** Create a GPU picker bound to the given scene. */
export function createGpuPicker(scene: SceneContext): GpuPicker {
    return {
        _detailedPick: null,
        _scene: scene,
        _rt: null,
        _sceneUbo: null,
        _sceneBG: null,
    };
}

function ensureTargets(engine: EngineContextInternal, picker: GpuPicker): PickTargets1x1 {
    const device = engine.device;
    if (picker._rt) {
        return picker._rt;
    }
    const colorTex = device.createTexture({ label: "pick-color", size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const depthColorTex = device.createTexture({
        label: "pick-depth-color",
        size: [1, 1],
        format: "r32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const depthTex = device.createTexture({ label: "pick-depth", size: [1, 1], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    picker._rt = {
        colorTex,
        colorView: colorTex.createView(),
        depthColorTex,
        depthColorView: depthColorTex.createView(),
        depthTex,
        depthView: depthTex.createView(),
        colorStaging: device.createBuffer({ label: "pick-color-staging", size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        depthStaging: device.createBuffer({ label: "pick-depth-staging", size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    };
    return picker._rt;
}

function ensureSceneUbo(engine: EngineContextInternal, picker: GpuPicker): GPUBuffer {
    const device = engine.device;
    if (!picker._sceneUbo) {
        picker._sceneUbo = device.createBuffer({ label: "pick-scene-ubo", size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const sceneBGL = getPickingSceneBGL(engine);
        picker._sceneBG = device.createBindGroup({ label: "pick-scene-bg", layout: sceneBGL, entries: [{ binding: 0, resource: { buffer: picker._sceneUbo } }] });
    }
    return picker._sceneUbo;
}

/** Compute a VP matrix zoomed to a single pixel at (px, py) on a W×H canvas.
 *  Renders to a 1×1 target — only fragments at the picked pixel survive. */
function computePickVP(out: Float32Array, vp: Float32Array, px: number, py: number, w: number, h: number): void {
    const ndcX = (2 * (px + 0.5)) / w - 1;
    const ndcY = 1 - (2 * (py + 0.5)) / h;
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

/** Pick the mesh at (x, y) canvas coordinates. Returns a PickingInfo. */
export async function pickAsync(picker: GpuPicker, x: number, y: number): Promise<PickingInfo> {
    const scene = picker._scene;
    const engine = scene.engine as EngineContextInternal;
    const device = engine.device;
    const canvas = engine.canvas;
    const camera = scene.camera;
    if (!camera) {
        return createEmptyPickingInfo();
    }

    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) {
        return createEmptyPickingInfo();
    }

    const px = Math.max(0, Math.min(Math.floor(x), w - 1));
    const py = Math.max(0, Math.min(Math.floor(y), h - 1));
    const aspect = w / h;
    const vp = getViewProjectionMatrix(camera, aspect);

    // ── Compute pick-zoomed VP (renders single pixel to 1×1 target) ──
    computePickVP(_pickVP, vp as Float32Array, px, py, w, h);

    const rt = ensureTargets(engine, picker);
    const sceneUbo = ensureSceneUbo(engine, picker);
    device.queue.writeBuffer(sceneUbo, 0, _pickVP);

    // ── Assign pick IDs (array-based, no Map for miss case) ──────────
    const meshes = scene.meshes;
    const meshCount = meshes.length;
    let nextId = 1;

    // ── Render pass (1×1 target) ─────────────────────────────────────
    const encoder = device.createCommandEncoder({ label: "pick" });
    const pass = encoder.beginRenderPass({
        colorAttachments: [
            { view: rt.colorView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" },
            { view: rt.depthColorView, clearValue: { r: 1, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" },
        ],
        depthStencilAttachment: { view: rt.depthView, depthClearValue: 1.0, depthLoadOp: "clear", depthStoreOp: "discard" },
    });

    const regularPipeline = getPickingPipeline(engine);
    const tiPipeline = getPickingTIPipeline(engine);
    const meshBGL = getPickingMeshBGL(engine);
    const tiMeshBGL = getPickingTIMeshBGL(engine);

    const tempBuffers: GPUBuffer[] = [];

    for (let mi = 0; mi < meshCount; mi++) {
        const mesh = meshes[mi]!;
        const gpu = (mesh as MeshInternal)._gpu;
        const ti = mesh.thinInstances;

        if (ti && ti.count > 0 && ti._gpuBuffer) {
            _tiUboScratch[0] = nextId;
            const tiUbo = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            device.queue.writeBuffer(tiUbo, 0, _tiUboScratch);
            tempBuffers.push(tiUbo);

            pass.setPipeline(tiPipeline);
            pass.setBindGroup(0, picker._sceneBG!);
            pass.setBindGroup(
                1,
                device.createBindGroup({
                    layout: tiMeshBGL,
                    entries: [
                        { binding: 0, resource: { buffer: tiUbo } },
                        { binding: 1, resource: { buffer: ti._gpuBuffer } },
                    ],
                })
            );
            pass.setVertexBuffer(0, gpu.positionBuffer);
            pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
            pass.drawIndexed(gpu.indexCount, ti.count);
            nextId += ti.count;
        } else {
            _uboF32.set(mesh.worldMatrix);
            _uboU32[0] = nextId;
            const meshUbo = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            device.queue.writeBuffer(meshUbo, 0, _uboView);
            tempBuffers.push(meshUbo);

            pass.setPipeline(regularPipeline);
            pass.setBindGroup(0, picker._sceneBG!);
            pass.setBindGroup(1, device.createBindGroup({ layout: meshBGL, entries: [{ binding: 0, resource: { buffer: meshUbo } }] }));
            pass.setVertexBuffer(0, gpu.positionBuffer);
            pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
            pass.drawIndexed(gpu.indexCount);
            nextId++;
        }
    }
    pass.end();

    // ── Readback (both 1×1 — trivially small) ────────────────────────
    encoder.copyTextureToBuffer({ texture: rt.colorTex }, { buffer: rt.colorStaging, bytesPerRow: 256 }, { width: 1, height: 1 });
    encoder.copyTextureToBuffer({ texture: rt.depthColorTex }, { buffer: rt.depthStaging, bytesPerRow: 256 }, { width: 1, height: 1 });
    device.queue.submit([encoder.finish()]);

    await Promise.all([rt.colorStaging.mapAsync(GPUMapMode.READ), rt.depthStaging.mapAsync(GPUMapMode.READ)]);

    const colorData = new Uint8Array(rt.colorStaging.getMappedRange());
    const pickId = (colorData[0]! << 16) | (colorData[1]! << 8) | colorData[2]!;
    const depth = new Float32Array(rt.depthStaging.getMappedRange())[0]!;
    rt.colorStaging.unmap();
    rt.depthStaging.unmap();

    // Destroy temp per-mesh UBOs
    for (let i = 0; i < tempBuffers.length; i++) {
        tempBuffers[i]!.destroy();
    }

    // ── Resolve pick ID to mesh ──────────────────────────────────────
    if (pickId === 0) {
        return createEmptyPickingInfo();
    }
    let hitMesh: Mesh | null = null;
    let hitThinIdx = -1;
    let scanId = 1;
    for (let mi = 0; mi < meshCount; mi++) {
        const mesh = meshes[mi]!;
        const ti = mesh.thinInstances;
        if (ti && ti.count > 0 && ti._gpuBuffer) {
            if (pickId >= scanId && pickId < scanId + ti.count) {
                hitMesh = mesh;
                hitThinIdx = pickId - scanId;
                break;
            }
            scanId += ti.count;
        } else {
            if (pickId === scanId) {
                hitMesh = mesh;
                break;
            }
            scanId++;
        }
    }
    if (!hitMesh) {
        return createEmptyPickingInfo();
    }

    const info = createEmptyPickingInfo();
    info.hit = true;
    info.pickedMesh = hitMesh;
    info.thinInstanceIndex = hitThinIdx;

    // Reconstruct world position from depth (using original full-res VP)
    const invVP = mat4Invert(vp);
    if (invVP) {
        const ndcX = (2 * px) / w - 1;
        const ndcY = 1 - (2 * py) / h;
        const wx = invVP[0]! * ndcX + invVP[4]! * ndcY + invVP[8]! * depth + invVP[12]!;
        const wy = invVP[1]! * ndcX + invVP[5]! * ndcY + invVP[9]! * depth + invVP[13]!;
        const wz = invVP[2]! * ndcX + invVP[6]! * ndcY + invVP[10]! * depth + invVP[14]!;
        const ww = invVP[3]! * ndcX + invVP[7]! * ndcY + invVP[11]! * depth + invVP[15]!;
        const invW = 1 / ww;
        info.pickedPoint = [wx * invW, wy * invW, wz * invW];

        const camPos = getCameraPosition(camera);
        const dx = info.pickedPoint[0] - camPos.x;
        const dy = info.pickedPoint[1] - camPos.y;
        const dz = info.pickedPoint[2] - camPos.z;
        info.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    if (picker._detailedPick) {
        const ray = createPickingRay(px, py, vp, w, h);
        if (ray) {
            picker._detailedPick(info, ray);
        }
    }

    return info;
}

/** Dispose GPU resources owned by this picker. */
export function disposePicker(picker: GpuPicker): void {
    if (picker._rt) {
        picker._rt.colorTex.destroy();
        picker._rt.depthColorTex.destroy();
        picker._rt.depthTex.destroy();
        picker._rt.colorStaging.destroy();
        picker._rt.depthStaging.destroy();
        picker._rt = null;
    }
    if (picker._sceneUbo) {
        picker._sceneUbo.destroy();
        picker._sceneUbo = null;
        picker._sceneBG = null;
    }
}
