import type { SceneContext } from "../scene/scene.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { LightBase } from "./types.js";
import type { RectAreaLight } from "./rect-area-light.js";
import { MAX_LIGHTS } from "./types.js";
import { BU, TU } from "../engine/gpu-flags.js";
import { acquireTexture } from "../resource/texture-acquire.js";
import { releaseTexture } from "../resource/texture-release.js";
import { getOrCreateSampler } from "../resource/texture-sampler-pool.js";
import { validateAreaLightImage } from "./area-light-image.js";

interface Snapshot {
    capacity: number;
    lights: LightBase[];
    images: (Texture2D | null)[];
}
interface Allocation {
    device: GPUDevice;
    texture: Texture2D;
    mapping: GPUBuffer;
    sources: Texture2D[];
    snapshot: Snapshot;
    owners: number;
}
interface Owner {
    id: number;
    disposed: boolean;
    allocation?: Allocation;
    pending?: Promise<void>;
}
let registry: Map<number, Owner> | null = null;
let owners: WeakMap<SceneContext, Owner> | null = null;
let nextId = 0;

function snapshot(scene: SceneContext): Snapshot {
    const capacity = MAX_LIGHTS;
    const lights: LightBase[] = [];
    const images: (Texture2D | null)[] = [];
    for (const light of scene.lights) {
        if (lights.length === capacity) {
            break;
        }
        if (light._writeLightUbo) {
            lights.push(light);
            images.push(light.lightType === "rectArea" ? (light as RectAreaLight).emissionTexture : null);
        }
    }
    return { capacity, lights, images };
}

function same(a: Snapshot, b: Snapshot): boolean {
    return a.capacity === b.capacity && a.lights.length === b.lights.length && a.lights.every((light, i) => light === b.lights[i] && a.images[i] === b.images[i]);
}

function release(allocation: Allocation): void {
    if (--allocation.owners === 0) {
        releaseTexture(allocation.texture);
        allocation.mapping.destroy();
        allocation.sources.forEach(releaseTexture);
    }
}

/** @internal Keep existing bound generations valid; only drop the scene's snapshot ownership. */
export function clearAreaLightEmission(scene: SceneContext): void {
    const owner = owners?.get(scene);
    if (owner?.allocation) {
        release(owner.allocation);
        owner.allocation = undefined;
    }
}

/** @internal Build scene-local array layers and a packed-slot map before material composition. */
export async function prepareAreaLightEmission(scene: SceneContext): Promise<number | undefined> {
    if (scene._z) {
        throw new Error("RectAreaLight: scene was disposed before emission preparation");
    }
    const byScene = (owners ??= new WeakMap());
    let owner = byScene.get(scene);
    if (!owner) {
        owner = { id: ++nextId, disposed: false };
        byScene.set(scene, owner);
        (registry ??= new Map()).set(owner.id, owner);
        const state = owner;
        scene._disposables.push(() => {
            state.disposed = true;
            clearAreaLightEmission(scene);
            registry?.delete(state.id);
            byScene.delete(scene);
        });
    }
    if (owner.pending) {
        await owner.pending;
        return prepareAreaLightEmission(scene);
    }
    const engine = scene.surface.engine;
    const device = engine._device;
    const state = owner;
    const selected = snapshot(scene);
    if (state.allocation?.device === device && same(state.allocation.snapshot, selected)) {
        return state.id;
    }
    if (!selected.images.some(Boolean)) {
        clearAreaLightEmission(scene);
        return undefined;
    }
    const request = (async (): Promise<void> => {
        const sources: Texture2D[] = [];
        const slots = new Uint32Array(Math.ceil(selected.capacity / 4) * 4);
        const layers = new Map<GPUTexture, number>();
        for (let i = 0; i < selected.images.length; i++) {
            const image = selected.images[i];
            if (image) {
                validateAreaLightImage(image, device);
                let layer = layers.get(image.texture);
                if (layer === undefined) {
                    layer = sources.length;
                    layers.set(image.texture, layer);
                    sources.push(image);
                }
                slots[i] = layer + 1;
            }
        }
        if (sources.length > device.limits.maxTextureArrayLayers) {
            throw new Error("RectAreaLight: emission image count exceeds the device texture-array layer limit");
        }
        let texture: Texture2D | undefined;
        let raw: GPUTexture | undefined;
        let mapping: GPUBuffer | undefined;
        let scoped = false;
        sources.forEach(acquireTexture);
        try {
            device.pushErrorScope("validation");
            scoped = true;
            const gpu = (raw = device.createTexture({
                label: "rect-area-emission-array",
                size: [1024, 1024, sources.length],
                format: "rgba8unorm",
                mipLevelCount: 11,
                usage: TU.COPY_DST | TU.TEXTURE_BINDING,
            }));
            texture = {
                texture: gpu,
                view: gpu.createView({ dimension: "2d-array" }),
                sampler: getOrCreateSampler(engine, {
                    addressModeU: "clamp-to-edge",
                    addressModeV: "clamp-to-edge",
                    minFilter: "linear",
                    magFilter: "linear",
                    mipmapFilter: "linear",
                }),
                width: 1024,
                height: 1024,
            };
            acquireTexture(texture);
            raw = undefined;
            mapping = device.createBuffer({ label: "rect-area-emission-slots", size: slots.byteLength, usage: BU.UNIFORM | BU.COPY_DST });
            device.queue.writeBuffer(mapping, 0, slots);
            const encoder = device.createCommandEncoder();
            for (let layer = 0; layer < sources.length; layer++) {
                for (let mip = 0; mip < 11; mip++) {
                    const size = 1024 >> mip;
                    encoder.copyTextureToTexture({ texture: sources[layer]!.texture, mipLevel: mip }, { texture: gpu, mipLevel: mip, origin: [0, 0, layer] }, [size, size, 1]);
                }
            }
            device.queue.submit([encoder.finish()]);
            const validation = device.popErrorScope();
            scoped = false;
            const error = await validation;
            if (error) {
                throw new Error(`RectAreaLight: emission array upload failed: ${error.message}`);
            }
            if (scene._z || state.disposed) {
                throw new Error("RectAreaLight: scene was disposed during emission preparation");
            }
            if (engine._device !== device) {
                throw new Error("RectAreaLight: device changed during emission preparation; preprocess on the current engine");
            }
            if (!same(selected, snapshot(scene))) {
                throw new Error("RectAreaLight: emission capacity/assignments/topology changed during preparation; enable and rebuild again");
            }
            const allocation: Allocation = { device, texture, mapping, sources, snapshot: selected, owners: 1 };
            clearAreaLightEmission(scene);
            state.allocation = allocation;
            texture = undefined;
            mapping = undefined;
        } catch (error) {
            sources.forEach(releaseTexture);
            throw error;
        } finally {
            if (scoped) {
                void device.popErrorScope().catch(() => {});
            }
            if (texture) {
                releaseTexture(texture);
            }
            mapping?.destroy();
            raw?.destroy();
        }
    })();
    state.pending = request;
    try {
        await request;
        return state.id;
    } finally {
        state.pending = undefined;
    }
}

/** @internal Scalar ID resolves the scene snapshot; binding generations acquire independent owners. */
export function bindAreaLightEmission(id: number | undefined, device: GPUDevice, entries: GPUBindGroupEntry[], binding: number, disposers: (() => void)[] | undefined): number {
    const allocation = id === undefined ? undefined : registry?.get(id)?.allocation;
    if (!allocation || allocation.device !== device || !disposers) {
        throw new Error("RectAreaLight: prepare the owning scene's emission resources and rebuild its material groups before binding");
    }
    if (allocation.snapshot.capacity !== MAX_LIGHTS) {
        throw new Error("RectAreaLight: emission light capacity changed; enable and rebuild again before binding");
    }
    if (!disposers.some((dispose) => dispose === allocationRelease(allocation))) {
        allocation.owners++;
        disposers.push(allocationRelease(allocation));
    }
    entries.push(
        { binding: binding++, resource: allocation.texture.view },
        { binding: binding++, resource: allocation.texture.sampler },
        { binding: binding++, resource: { buffer: allocation.mapping } }
    );
    return binding;
}

interface BindingAllocation extends Allocation {
    dispose?: () => void;
}
function allocationRelease(allocation: BindingAllocation): () => void {
    return (allocation.dispose ??= () => release(allocation));
}
