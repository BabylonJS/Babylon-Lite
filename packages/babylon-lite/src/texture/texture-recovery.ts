import { U8 } from "../engine/typed-arrays.js";
import { TU } from "../engine/gpu-flags.js";
import type { EngineContext } from "../engine/engine.js";
import type { Texture2D, Texture2DOptions, Texture2DRecoverySource } from "./texture-2d.js";
import { getOrCreateSampler, acquireTexture, _isTextureReleased, _textureOwners } from "../resource/gpu-pool.js";
import { getBilinearSampler } from "../resource/samplers.js";

/** The wrapper that rebuilt each recovery source and the device it rebuilt for, so any other
 *  wrapper sharing that source adopts its result instead of building a second copy. */
let _rebuiltOn: WeakMap<Texture2DRecoverySource, { device: GPUDevice; tex: Texture2D; done: Promise<void> }> | null = null;

/** Each texture rebuilt during the current recovery and the ownership its outgoing GPUTexture
 *  held, carried onto the replacement by `settleRebuiltTextureOwnership` once the per-context
 *  handlers have run. Null between recoveries. */
let _pendingOwnership: [Texture2D, number][] | null = null;

/**
 * Rebuilds a single Texture2D after a WebGPU device loss from the pure recovery
 * data stamped on `tex._recoverySource`.
 *
 * This module is reached only through a lazy `await import()` on the recovery
 * path in device-lost-recovery, so the always-bundled recovery orchestrator
 * carries none of the per-kind texture rebuild logic (url/solid/dynamic/bitmap)
 * statically. A scene that enables device-lost recovery pays for this code only
 * if an actual device loss occurs, and the dynamic-texture rebuild remains in a
 * further on-demand chunk so recovery scenes that never create a dynamic texture
 * never load it.
 */
export async function rebuildTexture2D(engine: EngineContext, tex: Texture2D): Promise<void> {
    const source = tex._recoverySource;
    if (!source) {
        return;
    }
    // A texture every owner has released is already destroyed. Rebuilding it would allocate a
    // replacement and hand a live texture back to a wrapper the application has finished with —
    // and for the kinds recovery re-owns, take a reference nothing will ever release. This asks
    // only whether the texture is gone, which holds for every kind: a texture nothing ever owned
    // is not released, it simply has no owner.
    if (_isTextureReleased(tex)) {
        return;
    }
    // Several wrappers can share one source. The tracked set and the per-kind reachability walks
    // both reach the same texture (a material texture also used by a sprite layer), and
    // `cloneTexture2D` deliberately hands out extra wrappers over a single upload. Rebuilding each
    // one would allocate a duplicate GPUTexture, orphan the first and re-fetch url sources over
    // the network once per wrapper, so only the first wrapper visited for a given device rebuilds
    // and the rest adopt its result.
    _rebuiltOn ??= new WeakMap();
    const rebuilt = _rebuiltOn.get(source);
    if (rebuilt?.device === engine._device) {
        if (rebuilt.tex !== tex) {
            // Wrappers are rebuilt concurrently, so a sibling can arrive while this source's
            // rebuild is still in flight; adopting early would hand out the lost device's texture.
            await rebuilt.done;
            adoptRebuiltTexture(engine, tex, rebuilt.tex);
        }
        return;
    }
    // Read before the rebuild replaces the handle: this is the outgoing texture's ownership.
    const owners = _textureOwners(tex);
    // Recorded before the first await so a wrapper visited while this rebuild is still running
    // finds it and waits, rather than starting a second one.
    const done = rebuildFromSource(engine, tex, source);
    _rebuiltOn.set(source, { device: engine._device, tex, done });
    await done;
    // Queue that ownership to be carried onto the replacement, which starts unowned. Without it the
    // first consumer to bind and then unbind a rebuilt texture destroys it while the application
    // still holds the wrapper. Carrying it HERE would be wrong: recovery re-establishes part of the
    // pre-loss ownership itself — `rebuildSceneGpu` discards a mesh's queued texture releases and
    // re-acquires as it rebuilds the bind groups, and the dynamic-texture rebuild re-takes its own
    // reference — so adding the full pre-loss count on top double-counts exactly those. The texture
    // would then be permanently over-owned: final disposal never reaches zero, so it is never
    // destroyed and `_isTextureReleased` never reports it released, silently disabling
    // released-texture detection on a later loss. Kinds whose creator never acquired have no
    // ownership to carry. Wrappers that adopt queue none either, exactly as `cloneTexture2D` takes
    // none at creation: they share the references held for the texture they now point at.
    if (owners > 0) {
        (_pendingOwnership ??= []).push([tex, owners]);
    }
}

/**
 * Carries onto each rebuilt texture the ownership its outgoing GPUTexture held, after every
 * per-context recovery handler has re-established the references it owns.
 *
 * Deferring to here is what makes the count correct: whatever is still missing once the handlers
 * have run is by definition a reference recovery did NOT re-establish — the creator's, and any
 * extra one a derived family holds, since `cloneTexture2D` leaves that pairing to the caller and
 * restoring only one would let the next release destroy a texture a sibling still points at. It is
 * a top-up rather than an outright `acquireTexture` so a handler that already re-took its own
 * reference is counted rather than doubled.
 * @internal
 */
export function settleRebuiltTextureOwnership(): void {
    const pending = _pendingOwnership;
    _pendingOwnership = null;
    if (!pending) {
        return;
    }
    for (const [tex, owners] of pending) {
        for (let held = _textureOwners(tex); held < owners; held++) {
            acquireTexture(tex);
        }
    }
}

/**
 * Points `tex` at the GPU texture already rebuilt for the source it shares with `rebuilt`.
 *
 * Sharing one upload across wrappers is the whole point of `cloneTexture2D`, so copying the
 * handles across is both the correct result and the cheap one — the alternative duplicates an
 * identical image in VRAM and re-fetches url sources. A wrapper carrying its own sampler keeps it;
 * one that shared the rebuilt wrapper's takes the rebuilt one rather than a second sampler
 * equivalent to it.
 */
function adoptRebuiltTexture(engine: EngineContext, tex: Texture2D, rebuilt: Texture2D): void {
    // Read before the handles are overwritten: the lookup is keyed on the sampler `tex` still has.
    const sampler = recoverCapturedSampler(engine, tex) ?? rebuilt.sampler;
    tex.texture = rebuilt.texture;
    tex.view = rebuilt.view;
    tex.width = rebuilt.width;
    tex.height = rebuilt.height;
    tex.sampler = sampler;
}

/**
 * Rebuilds the sampler `tex` was captured with on the current device, or returns undefined when
 * nothing was captured for it and the caller's default applies.
 *
 * Samplers are captured by descriptor rather than by object, so a texture that asked for
 * non-default wrap/filter — the glTF sampler path builds exactly such a wrapper — gets that back
 * instead of silently falling to the default. The result is re-registered so the same resolution
 * survives a later loss.
 */
function recoverCapturedSampler(engine: EngineContext, tex: Texture2D): GPUSampler | undefined {
    const descriptors = engine._deviceLostRecovery?._samplerDescriptors;
    const desc = descriptors?.get(tex.sampler);
    if (!desc) {
        return undefined;
    }
    // `samplerKey` does not include lodMaxClamp, so a clamped sampler would take an unclamped
    // sampler's slot in the dedupe cache.
    const sampler = desc.lodMaxClamp === 0 ? engine._device.createSampler(desc) : getOrCreateSampler(engine, desc);
    descriptors!.set(sampler, desc);
    return sampler;
}

async function rebuildFromSource(engine: EngineContext, tex: Texture2D, source: Texture2DRecoverySource): Promise<void> {
    if (source.kind === "url") {
        const rebuilt = await rebuildUrlTexture2D(engine, source.url, source.opts);
        tex.texture = rebuilt.texture;
        tex.view = rebuilt.view;
        tex.sampler = rebuilt.sampler;
        tex.width = rebuilt.width;
        tex.height = rebuilt.height;
        tex._recoverySource = source;
        return;
    }
    if (source.kind === "solid") {
        const texture = engine._device.createTexture({ size: { width: 1, height: 1 }, format: "rgba8unorm", usage: TU.TEXTURE_BINDING | TU.COPY_DST });
        const data = new U8(source.rgba.map((v) => Math.round(v * 255)));
        engine._device.queue.writeTexture({ texture }, data, { bytesPerRow: 4, rowsPerImage: 1 }, { width: 1, height: 1 });
        tex.texture = texture;
        tex.view = texture.createView();
        tex.sampler = getBilinearSampler(engine);
        tex.width = 1;
        tex.height = 1;
        return;
    }
    if (source.kind === "dynamic") {
        // Keep the dynamic-texture rebuild in a further on-demand chunk so a
        // recovery scene that never creates a dynamic texture never loads it.
        const { rebuildDynamicTexture2D } = await import("./dynamic-texture-recovery.js");
        await rebuildDynamicTexture2D(engine, tex);
        return;
    }
    if (source.kind === "pixels") {
        const options = source.options;
        const texture = engine._device.createTexture({
            size: { width: source.width, height: source.height },
            format: options.srgb ? "rgba8unorm-srgb" : "rgba8unorm",
            usage: TU.TEXTURE_BINDING | TU.COPY_DST,
        });
        engine._device.queue.writeTexture(
            { texture },
            source.data as Uint8Array<ArrayBuffer>,
            { bytesPerRow: source.width * 4, rowsPerImage: source.height },
            { width: source.width, height: source.height }
        );
        tex.texture = texture;
        tex.view = texture.createView();
        tex.sampler = getOrCreateSampler(engine, {
            addressModeU: options.addressModeU ?? "clamp-to-edge",
            addressModeV: options.addressModeV ?? "clamp-to-edge",
            minFilter: options.minFilter ?? "nearest",
            magFilter: options.magFilter ?? "nearest",
        });
        tex.width = source.width;
        tex.height = source.height;
        return;
    }
    if (source.kind === "render") {
        const texture = engine._device.createTexture({
            size: { width: source.width, height: source.height },
            format: source.format,
            usage: TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT | TU.COPY_DST,
        });
        tex.texture = texture;
        tex.view = texture.createView();
        tex.sampler = getOrCreateSampler(engine, source.samplerDesc);
        tex.width = source.width;
        tex.height = source.height;
        return;
    }
    const width = source.bitmap?.width ?? 1;
    const height = source.bitmap?.height ?? 1;
    const format: GPUTextureFormat = source.srgb ? "rgba8unorm-srgb" : "rgba8unorm";
    const mipLevelCount = source.mipMaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
    const texture = engine._device.createTexture({
        size: { width, height },
        format,
        mipLevelCount,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.COPY_SRC | TU.RENDER_ATTACHMENT,
    });
    if (source.bitmap) {
        engine._device.queue.copyExternalImageToTexture({ source: source.bitmap }, { texture, premultipliedAlpha: false }, { width, height });
        if (source.mipMaps && mipLevelCount > 1) {
            const { generateMipmaps } = await import("./generate-mipmaps.js");
            generateMipmaps(engine, texture);
        }
    } else {
        engine._device.queue.writeTexture({ texture }, (source.fallback ?? new U8([255, 255, 255, 255])) as Uint8Array<ArrayBuffer>, { bytesPerRow: 4 }, { width: 1, height: 1 });
    }
    tex.texture = texture;
    tex.view = texture.createView();
    tex.sampler =
        recoverCapturedSampler(engine, tex) ??
        getOrCreateSampler(engine, {
            addressModeU: "repeat",
            addressModeV: "repeat",
            minFilter: "linear",
            magFilter: "linear",
            mipmapFilter: "linear",
            maxAnisotropy: 4,
        });
    tex.width = width;
    tex.height = height;
}

async function rebuildUrlTexture2D(engine: EngineContext, url: string, opts: Texture2DOptions): Promise<Texture2D> {
    const mipMaps = opts.mipMaps ?? true;
    const addressModeU = opts.addressModeU ?? "repeat";
    const addressModeV = opts.addressModeV ?? "repeat";
    const invertY = opts.invertY ?? true;
    const srgb = opts.srgb ?? false;
    const premultiplyAlpha = opts.premultiplyAlpha ?? false;
    const format: GPUTextureFormat = srgb ? "rgba8unorm-srgb" : "rgba8unorm";

    const response = await fetch(url);
    const blob = await response.blob();
    const imageBitmap = await createImageBitmap(blob, {
        premultiplyAlpha: premultiplyAlpha ? "premultiply" : "none",
        colorSpaceConversion: "none",
    });

    const width = imageBitmap.width;
    const height = imageBitmap.height;
    const mipLevelCount = mipMaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
    const texture = engine._device.createTexture({
        size: { width, height },
        format,
        mipLevelCount,
        usage: TU.TEXTURE_BINDING | TU.COPY_DST | TU.RENDER_ATTACHMENT,
    });
    engine._device.queue.copyExternalImageToTexture({ source: imageBitmap, flipY: invertY }, { texture, premultipliedAlpha: premultiplyAlpha }, { width, height });
    imageBitmap.close();

    if (mipMaps && mipLevelCount > 1) {
        const { generateMipmaps } = await import("./generate-mipmaps.js");
        generateMipmaps(engine, texture);
    }

    const minF = opts.minFilter ?? "linear";
    const magF = opts.magFilter ?? "linear";
    const mipF: GPUMipmapFilterMode = mipMaps ? "linear" : "nearest";
    const allLinear = minF === "linear" && magF === "linear" && mipF === "linear";
    const sampler = getOrCreateSampler(engine, {
        addressModeU,
        addressModeV,
        minFilter: minF,
        magFilter: magF,
        mipmapFilter: mipF,
        maxAnisotropy: allLinear ? 4 : 1,
    });

    return { texture, view: texture.createView(), sampler, width, height };
}
