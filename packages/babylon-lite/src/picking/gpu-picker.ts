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

/** GPU-based picker that renders mesh IDs to an offscreen texture. */
export interface GpuPicker {
    pickAsync(x: number, y: number): Promise<PickingInfo>;
    /** Optional hook for detailed picking (Phase 2). */
    _detailedPick: ((info: PickingInfo, ray: { origin: [number, number, number]; direction: [number, number, number]; length: number }) => void) | null;
    dispose(): void;
}

interface PickRenderTargets {
    colorTexture: GPUTexture;
    colorView: GPUTextureView;
    depthTexture: GPUTexture;
    depthView: GPUTextureView;
    colorStaging: GPUBuffer;
    depthStaging: GPUBuffer;
    width: number;
    height: number;
}

/** Create a GPU picker bound to the given scene. */
export function createGpuPicker(scene: SceneContext): GpuPicker {
    const engine = scene.engine as EngineContextInternal;
    const device = engine.device;
    const canvas = engine.canvas;

    let targets: PickRenderTargets | null = null;

    function ensureTargets(w: number, h: number): PickRenderTargets {
        if (targets && targets.width === w && targets.height === h) {
            return targets;
        }
        if (targets) {
            destroyTargets(targets);
        }
        const colorTexture = device.createTexture({
            label: "pick-color",
            size: [w, h],
            format: "rgba8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        const depthTexture = device.createTexture({
            label: "pick-depth",
            size: [w, h],
            format: "depth32float",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        const colorStaging = device.createBuffer({
            label: "pick-color-staging",
            size: 256,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const depthStaging = device.createBuffer({
            label: "pick-depth-staging",
            size: 256,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        targets = {
            colorTexture,
            colorView: colorTexture.createView(),
            depthTexture,
            depthView: depthTexture.createView(),
            colorStaging,
            depthStaging,
            width: w,
            height: h,
        };
        return targets;
    }

    function destroyTargets(t: PickRenderTargets): void {
        t.colorTexture.destroy();
        t.depthTexture.destroy();
        t.colorStaging.destroy();
        t.depthStaging.destroy();
    }

    const picker: GpuPicker = {
        _detailedPick: null,

        async pickAsync(x: number, y: number): Promise<PickingInfo> {
            const camera = scene.camera;
            if (!camera) {
                return createEmptyPickingInfo();
            }

            const w = canvas.width;
            const h = canvas.height;
            if (w === 0 || h === 0) {
                return createEmptyPickingInfo();
            }

            // Clamp pick coordinates to canvas bounds
            const px = Math.max(0, Math.min(Math.floor(x), w - 1));
            const py = Math.max(0, Math.min(Math.floor(y), h - 1));

            const rt = ensureTargets(w, h);
            const aspect = w / h;
            const vp = getViewProjectionMatrix(camera, aspect);

            // ── Assign pick IDs ──────────────────────────────────
            type PickEntry = { mesh: Mesh; thinInstanceIndex: number };
            const idMap = new Map<number, PickEntry>();
            let nextId = 1; // 0 = background/miss

            const meshIds: { mesh: Mesh; baseId: number; isThin: boolean; instanceCount: number }[] = [];

            for (const mesh of scene.meshes) {
                const ti = mesh.thinInstances;
                if (ti && ti.count > 0 && ti._gpuBuffer) {
                    const baseId = nextId;
                    for (let i = 0; i < ti.count; i++) {
                        idMap.set(nextId, { mesh, thinInstanceIndex: i });
                        nextId++;
                    }
                    meshIds.push({ mesh, baseId, isThin: true, instanceCount: ti.count });
                } else {
                    idMap.set(nextId, { mesh, thinInstanceIndex: -1 });
                    meshIds.push({ mesh, baseId: nextId, isThin: false, instanceCount: 1 });
                    nextId++;
                }
            }

            // ── Create scene UBO (viewProjection) ────────────────
            const sceneUbo = device.createBuffer({
                label: "pick-scene-ubo",
                size: 64,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(sceneUbo, 0, new Float32Array(vp));

            const sceneBGL = getPickingSceneBGL(device);
            const sceneBG = device.createBindGroup({
                label: "pick-scene-bg",
                layout: sceneBGL,
                entries: [{ binding: 0, resource: { buffer: sceneUbo } }],
            });

            // ── Render pick pass ─────────────────────────────────
            const encoder = device.createCommandEncoder({ label: "pick-encoder" });
            const pass = encoder.beginRenderPass({
                label: "pick-pass",
                colorAttachments: [
                    {
                        view: rt.colorView,
                        clearValue: { r: 0, g: 0, b: 0, a: 0 },
                        loadOp: "clear",
                        storeOp: "store",
                    },
                ],
                depthStencilAttachment: {
                    view: rt.depthView,
                    depthClearValue: 1.0,
                    depthLoadOp: "clear",
                    depthStoreOp: "store",
                },
            });

            const regularPipeline = getPickingPipeline(device);
            const tiPipeline = getPickingTIPipeline(device);
            const meshBGL = getPickingMeshBGL(device);
            const tiMeshBGL = getPickingTIMeshBGL(device);

            const tempBuffers: GPUBuffer[] = [];

            for (const entry of meshIds) {
                const gpu = (entry.mesh as MeshInternal)._gpu;

                if (entry.isThin) {
                    const ti = entry.mesh.thinInstances!;
                    // Per-mesh UBO: baseMeshPickId (u32, padded to 16 bytes)
                    const tiUbo = device.createBuffer({
                        label: "pick-ti-mesh-ubo",
                        size: 16,
                        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                    });
                    const tiUboData = new Uint32Array(4);
                    tiUboData[0] = entry.baseId;
                    device.queue.writeBuffer(tiUbo, 0, tiUboData);
                    tempBuffers.push(tiUbo);

                    const bg = device.createBindGroup({
                        label: "pick-ti-mesh-bg",
                        layout: tiMeshBGL,
                        entries: [
                            { binding: 0, resource: { buffer: tiUbo } },
                            { binding: 1, resource: { buffer: ti._gpuBuffer! } },
                        ],
                    });

                    pass.setPipeline(tiPipeline);
                    pass.setBindGroup(0, sceneBG);
                    pass.setBindGroup(1, bg);
                    pass.setVertexBuffer(0, gpu.positionBuffer);
                    pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
                    pass.drawIndexed(gpu.indexCount, ti.count);
                } else {
                    // Per-mesh UBO: world (64 bytes) + pickId (4 bytes) → 80 bytes (16-aligned)
                    const meshUbo = device.createBuffer({
                        label: "pick-mesh-ubo",
                        size: 80,
                        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                    });
                    const uboData = new ArrayBuffer(80);
                    new Float32Array(uboData, 0, 16).set(entry.mesh.worldMatrix);
                    new Uint32Array(uboData, 64, 1)[0] = entry.baseId;
                    device.queue.writeBuffer(meshUbo, 0, new Uint8Array(uboData));
                    tempBuffers.push(meshUbo);

                    const bg = device.createBindGroup({
                        label: "pick-mesh-bg",
                        layout: meshBGL,
                        entries: [{ binding: 0, resource: { buffer: meshUbo } }],
                    });

                    pass.setPipeline(regularPipeline);
                    pass.setBindGroup(0, sceneBG);
                    pass.setBindGroup(1, bg);
                    pass.setVertexBuffer(0, gpu.positionBuffer);
                    pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
                    pass.drawIndexed(gpu.indexCount);
                }
            }

            pass.end();

            // ── Readback 1 pixel ─────────────────────────────────
            encoder.copyTextureToBuffer({ texture: rt.colorTexture, origin: { x: px, y: py } }, { buffer: rt.colorStaging, bytesPerRow: 256 }, { width: 1, height: 1 });
            encoder.copyTextureToBuffer({ texture: rt.depthTexture, origin: { x: px, y: py } }, { buffer: rt.depthStaging, bytesPerRow: 256 }, { width: 1, height: 1 });

            device.queue.submit([encoder.finish()]);

            // ── Map and decode ───────────────────────────────────
            await Promise.all([rt.colorStaging.mapAsync(GPUMapMode.READ), rt.depthStaging.mapAsync(GPUMapMode.READ)]);

            const colorData = new Uint8Array(rt.colorStaging.getMappedRange());
            const r = colorData[0]!;
            const g = colorData[1]!;
            const b = colorData[2]!;
            const pickId = (r << 16) | (g << 8) | b;

            const depthData = new Float32Array(rt.depthStaging.getMappedRange());
            const depth = depthData[0]!;

            rt.colorStaging.unmap();
            rt.depthStaging.unmap();

            // Destroy temp UBOs
            sceneUbo.destroy();
            for (const buf of tempBuffers) {
                buf.destroy();
            }

            // ── Build PickingInfo ────────────────────────────────
            const entry = idMap.get(pickId);
            if (!entry || pickId === 0) {
                return createEmptyPickingInfo();
            }

            const info = createEmptyPickingInfo();
            info.hit = true;
            info.pickedMesh = entry.mesh;
            info.thinInstanceIndex = entry.thinInstanceIndex;

            // Reconstruct world position from depth
            const invVP = mat4Invert(vp);
            if (invVP) {
                const ndcX = (2 * px) / w - 1;
                const ndcY = 1 - (2 * py) / h;
                const wx = invVP[0]! * ndcX + invVP[4]! * ndcY + invVP[8]! * depth + invVP[12]!;
                const wy = invVP[1]! * ndcX + invVP[5]! * ndcY + invVP[9]! * depth + invVP[13]!;
                const wz = invVP[2]! * ndcX + invVP[6]! * ndcY + invVP[10]! * depth + invVP[14]!;
                const ww = invVP[3]! * ndcX + invVP[7]! * ndcY + invVP[11]! * depth + invVP[15]!;
                const invW = 1 / ww;
                const worldX = wx * invW;
                const worldY = wy * invW;
                const worldZ = wz * invW;
                info.pickedPoint = [worldX, worldY, worldZ];

                const camPos = getCameraPosition(camera);
                const dx = worldX - camPos.x;
                const dy = worldY - camPos.y;
                const dz = worldZ - camPos.z;
                info.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            }

            // Phase 2 hook
            if (picker._detailedPick) {
                const ray = createPickingRay(px, py, vp, w, h);
                if (ray) {
                    picker._detailedPick(info, ray);
                }
            }

            return info;
        },

        dispose(): void {
            if (targets) {
                destroyTargets(targets);
                targets = null;
            }
        },
    };

    return picker;
}
