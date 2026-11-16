import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { TU } from "../engine/gpu-flags.js";
import { acquireTexture } from "../resource/texture-acquire.js";
import { releaseTexture } from "../resource/texture-release.js";
import { getOrCreateSampler } from "../resource/texture-sampler-pool.js";

const LTC_URL = "https://assets.babylonjs.com/core/areaLights/areaLightsLTC.bin";
type LtcPixels = [Uint16Array<ArrayBuffer>, Uint16Array<ArrayBuffer>];
interface LtcAllocation {
    textures: [Texture2D, Texture2D];
    owners: number;
    ready: Promise<void>;
}
interface LtcOwner {
    disposed: boolean;
    device?: GPUDevice;
    allocation?: LtcAllocation;
    pending?: Promise<void>;
}

let pixelsRequest: Promise<LtcPixels> | null = null;
let allocations: WeakMap<GPUDevice, LtcAllocation> | null = null;
let owners: WeakMap<SceneContext, LtcOwner> | null = null;

/** @internal Scene hooks run only for scenes which explicitly acquired these resources. */
export function hasAreaLightLtcOwner(scene: SceneContext): boolean {
    return owners?.has(scene) ?? false;
}

/** @internal Decode the exact interleaved little-endian half-float tables without changing their bits. */
export function decodeAreaLightLtc(payload: ArrayBuffer): LtcPixels {
    if (payload.byteLength !== 65536) {
        throw new Error(`RectAreaLight: LTC payload must contain 65536 bytes, got ${payload.byteLength}`);
    }
    const view = new DataView(payload);
    const a = new Uint16Array(16384);
    const b = new Uint16Array(16384);
    for (let i = 0; i < 4096; i++) {
        for (let c = 0; c < 4; c++) {
            a[i * 4 + c] = view.getUint16(i * 16 + c * 2, true);
            b[i * 4 + c] = view.getUint16(i * 16 + 8 + c * 2, true);
        }
    }
    return [a, b];
}

function loadPixels(): Promise<LtcPixels> {
    if (!pixelsRequest) {
        const request = fetch(LTC_URL)
            .then(async (response) => {
                if (!response.ok) {
                    throw new Error(`RectAreaLight: LTC request failed (${response.status}) at ${LTC_URL}`);
                }
                return decodeAreaLightLtc(await response.arrayBuffer());
            })
            .catch((error: unknown) => {
                if (pixelsRequest === request) {
                    pixelsRequest = null;
                }
                throw error;
            });
        pixelsRequest = request;
    }
    return pixelsRequest;
}

function releaseOwner(owner: LtcOwner): void {
    const allocation = owner.allocation;
    if (!allocation) {
        return;
    }
    releaseTexture(allocation.textures[0]);
    releaseTexture(allocation.textures[1]);
    if (--allocation.owners === 0 && owner.device) {
        allocations?.delete(owner.device);
    }
    owner.allocation = undefined;
    owner.device = undefined;
}

function upload(engine: EngineContext, pixels: LtcPixels): LtcAllocation {
    const device = engine._device;
    const created: GPUTexture[] = [];
    device.pushErrorScope("validation");
    try {
        const sampler = getOrCreateSampler(engine, { minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
        const make = (data: Uint16Array<ArrayBuffer>, name: string): Texture2D => {
            const texture = device.createTexture({ label: name, size: [64, 64], format: "rgba16float", mipLevelCount: 1, usage: TU.TEXTURE_BINDING | TU.COPY_DST });
            created.push(texture);
            device.queue.writeTexture({ texture }, data, { bytesPerRow: 512, rowsPerImage: 64 }, [64, 64]);
            return { texture, view: texture.createView(), sampler, width: 64, height: 64 };
        };
        const textures: [Texture2D, Texture2D] = [make(pixels[0], "rect-area-ltc1"), make(pixels[1], "rect-area-ltc2")];
        return {
            textures,
            owners: 0,
            ready: device.popErrorScope().then((error) => {
                if (error) {
                    throw new Error(`RectAreaLight: LTC GPU upload failed: ${error.message}`);
                }
            }),
        };
    } catch (error) {
        for (const texture of created) {
            texture.destroy();
        }
        void device.popErrorScope().catch(() => {});
        throw error;
    }
}

/** @internal Prepare scene-owned LUT resources, retrying failures and replacing stale-device allocations. */
export function prepareAreaLightLtc(scene: SceneContext): Promise<void> {
    if (scene._z) {
        return Promise.reject(new Error("RectAreaLight: scene was disposed before LTC preparation"));
    }
    const registry = (owners ??= new WeakMap());
    let owner = registry.get(scene);
    if (!owner) {
        owner = { disposed: false };
        registry.set(scene, owner);
        const state = owner;
        scene._disposables.push(() => {
            state.disposed = true;
            releaseOwner(state);
        });
    }
    if (owner.disposed) {
        return Promise.reject(new Error("RectAreaLight: scene was disposed before LTC preparation completed"));
    }
    if (owner.pending) {
        return owner.pending;
    }
    const engine = scene.surface.engine;
    if (owner.device === engine._device && owner.allocation) {
        return Promise.resolve();
    }
    const state = owner;
    const request = loadPixels()
        .then(async (pixels) => {
            if (state.disposed || scene._z) {
                throw new Error("RectAreaLight: scene was disposed while loading LTC data");
            }
            releaseOwner(state);
            const device = engine._device;
            const cache = (allocations ??= new WeakMap());
            let allocation = cache.get(device);
            if (!allocation) {
                allocation = upload(engine, pixels);
                cache.set(device, allocation);
            }
            acquireTexture(allocation.textures[0]);
            acquireTexture(allocation.textures[1]);
            allocation.owners++;
            state.device = device;
            state.allocation = allocation;
            try {
                await allocation.ready;
                if (state.disposed || scene._z) {
                    throw new Error("RectAreaLight: scene was disposed during LTC upload");
                }
                if (engine._device !== device) {
                    releaseOwner(state);
                    state.pending = undefined;
                    await prepareAreaLightLtc(scene);
                }
            } catch (error) {
                releaseOwner(state);
                throw error;
            }
        })
        .finally(() => {
            state.pending = undefined;
        });
    state.pending = request;
    return request;
}

/** @internal Material binding entries follow the shared LTC fragment declaration order. */
export function bindAreaLightLtc(engine: EngineContext, entries: GPUBindGroupEntry[], binding: number): number {
    const allocation = allocations?.get(engine._device);
    if (!allocation || allocation.owners === 0) {
        throw new Error("RectAreaLight: await enableRectAreaLights(scene) and prepare material groups on the current device before rendering");
    }
    for (const texture of allocation.textures) {
        entries.push({ binding: binding++, resource: texture.view }, { binding: binding++, resource: texture.sampler });
    }
    return binding;
}
