import { _setSharedTextureCloneHook, type Texture2D } from "./texture-2d.js";

type AttachmentGeneration = Pick<Texture2D, "texture" | "view" | "width" | "height">;

interface TextureBacking {
    current: AttachmentGeneration;
}

let backings: WeakMap<Texture2D, TextureBacking> | null = null;

function bindProperty<K extends keyof AttachmentGeneration>(facade: Texture2D, backing: TextureBacking, key: K): void {
    Object.defineProperty(facade, key, {
        enumerable: true,
        configurable: true,
        get: () => backing.current[key],
        set: (value: AttachmentGeneration[K]) => {
            backing.current[key] = value;
        },
    });
}

function bindBacking(facade: Texture2D, backing: TextureBacking): void {
    for (const key of ["texture", "view", "width", "height"] as const) {
        bindProperty(facade, backing, key);
    }
    backings!.set(facade, backing);
}

/** @internal Opt a replaceable facade and its future clones into shared attachment generations. */
export function _shareTextureBacking(facade: Texture2D): void {
    if (!backings) {
        backings = new WeakMap();
        _setSharedTextureCloneHook((base, derived) => {
            const backing = backings!.get(base);
            if (backing) {
                bindBacking(derived, backing);
            }
        });
    }
    if (!backings.has(facade)) {
        bindBacking(facade, { current: { texture: facade.texture, view: facade.view, width: facade.width, height: facade.height } });
    }
}

/** @internal Publish one replacement allocation to all related wrappers. */
export function _replaceTextureBacking(facade: Texture2D, texture: GPUTexture, view: GPUTextureView, width: number, height: number): void {
    const backing = backings?.get(facade);
    if (!backing) {
        throw new Error("Replaceable texture facade has no shared backing.");
    }
    backing.current = { texture, view, width, height };
}
