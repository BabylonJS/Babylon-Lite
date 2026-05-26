/** Create a 1×1 solid-color texture for flat-color PBR materials.
 *  Avoids loading an image — just writes 4 bytes to a tiny GPU texture. */

import type { Texture2D } from "./texture-2d.js";
import type { EngineContext } from "../engine/engine.js";
import type { EngineContextInternal } from "../engine/engine.js";
import { getBilinearSampler } from "../resource/samplers.js";

export function createSolidTexture2D(engine: EngineContext, r: number, g: number, b: number, a: number = 1.0): Texture2D {
    const eng = engine as EngineContextInternal;
    const device = eng.device;
    const texture = device.createTexture({
        size: { width: 1, height: 1 },
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    const data = new Uint8Array([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), Math.round(a * 255)]);
    device.queue.writeTexture({ texture }, data, { bytesPerRow: 4, rowsPerImage: 1 }, { width: 1, height: 1 });

    const sampler = getBilinearSampler(eng);

    const tex: Texture2D = { texture, view: texture.createView(), sampler, width: 1, height: 1 };
    eng._dlr?.s(tex, r, g, b, a);
    return tex;
}
