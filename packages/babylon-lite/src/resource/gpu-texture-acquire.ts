import { getTextureReferenceStore } from "./texture-reference-store.js";

/** Increment ownership of one GPU texture allocation. */
export function acquireGPUTexture(texture: GPUTexture): void {
    const references = getTextureReferenceStore();
    references.set(texture, (references.get(texture) ?? 0) + 1);
}
