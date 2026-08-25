/** CubeTexture — loads 6 face images into a GPU cube texture with mipmaps. */
import { TU } from "../engine/gpu-flags.js";
import { getTrilinearSampler } from "../resource/samplers.js";
import { generateMipmaps } from "./generate-mipmaps.js";
import { mipLevelCount } from "./mip-count.js";
import type { EngineContext } from "../engine/engine.js";

declare const cubeTextureBrand: unique symbol;

/** A loaded cube texture, exposed without leaking its WebGPU handles. This is the
 *  public cube handle returned by {@link loadCubeTexture}; pass it straight to
 *  `setStandardReflectionCubeTexture()` or `loadSkybox()`.
 *
 *  The opaque nominal brand keeps a plain `Texture2D` from satisfying a cube slot:
 *  `Texture2D` is structurally `{ texture, view, sampler, ... }`, so without the
 *  brand it would compile against a cube parameter and then fail WebGPU validation
 *  at bind-group creation (a `2d` view bound to a `texture_cube` binding). */
export interface CubeTexture {
    /** Opaque nominal brand. */
    readonly [cubeTextureBrand]: true;
    /** @internal */
    readonly _texture: GPUTexture;
    /** @internal */
    readonly _view: GPUTextureView;
    /** @internal */
    readonly _sampler: GPUSampler;
}

let _cc: WeakMap<GPUDevice, Map<string, Promise<CubeTexture>>> | null = null;

/** Load the six cube faces under `baseUrl` (`_px`/`_nx`/`_py`/`_ny`/`_pz`/`_nz` + `ext`)
 *  into a mipmapped GPU cube texture. Results are cached per device by base URL + ext,
 *  so repeated calls share one promise. */
export function loadCubeTexture(engine: EngineContext, baseUrl: string, ext = ".jpg"): Promise<CubeTexture> {
    const device = engine._device;
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
            usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.RENDER_ATTACHMENT,
            mipLevelCount: mipLevelCount(sz, sz),
        });
        for (let i = 0; i < 6; i++) {
            device.queue.copyExternalImageToTexture({ source: bitmaps[i]! }, { texture: tex, origin: [0, 0, i], premultipliedAlpha: false }, [sz, sz, 1]);
            bitmaps[i]!.close();
            generateMipmaps(engine, tex, i);
        }
        return {
            _texture: tex,
            _view: tex.createView({ dimension: "cube", format: "rgba8unorm" }),
            _sampler: getTrilinearSampler(engine),
        } as CubeTexture;
    })();
    dc.set(key, p);
    p.catch(() => dc!.delete(key));
    return p;
}
