/** CubeTexture — loads 6 face images into a GPU cube texture with mipmaps. */
import { getTrilinearSampler } from "../resource/samplers.js";
import { generateMipmaps } from "./generate-mipmaps.js";
import { mipLevelCount } from "./mip-count.js";
import type { EngineContextInternal } from "../engine/engine.js";

type CubeResult = { texture: GPUTexture; view: GPUTextureView; sampler: GPUSampler };
let _cc: WeakMap<GPUDevice, Map<string, Promise<CubeResult>>> | null = null;

export function loadCubeTexture(engine: EngineContextInternal, baseUrl: string, ext = ".jpg"): Promise<CubeResult> {
    const device = engine.device;
    if (!_cc) {
        _cc = new WeakMap();
    }
    let dc = _cc.get(device);
    if (!dc) {
        dc = new Map();
        _cc.set(device, dc);
    }
    const key = `${baseUrl}\0${ext}`;
    const hit = dc.get(key);
    if (hit) {
        return hit;
    }
    const p = (async () => {
        const bitmaps = await Promise.all(
            ["_px", "_nx", "_py", "_ny", "_pz", "_nz"].map(async (s) => {
                const r = await fetch(`${baseUrl}${s}${ext}`);
                if (!r.ok) {
                    throw new Error(`Cube face load failed: ${baseUrl}${s}${ext}`);
                }
                return createImageBitmap(await r.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
            })
        );
        const sz = bitmaps[0]!.width;
        const tex = device.createTexture({
            size: [sz, sz, 6],
            format: "rgba8unorm",
            dimension: "2d",
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
            mipLevelCount: mipLevelCount(sz, sz),
        });
        for (let i = 0; i < 6; i++) {
            device.queue.copyExternalImageToTexture({ source: bitmaps[i]! }, { texture: tex, origin: [0, 0, i], premultipliedAlpha: false }, [sz, sz, 1]);
            bitmaps[i]!.close();
            generateMipmaps(engine, tex, i);
        }
        return {
            texture: tex,
            view: tex.createView({ dimension: "cube", format: "rgba8unorm" }),
            sampler: getTrilinearSampler(engine),
        };
    })();
    dc.set(key, p);
    p.catch(() => dc!.delete(key));
    return p;
}
