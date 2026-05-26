import type { Mesh } from "../mesh/mesh.js";
import type { ShadowGenerator } from "../shadow/shadow-generator.js";

let shadowTaskInputs: WeakMap<ShadowGenerator, readonly Mesh[]> | null = null;
let shadowTaskInputPreloader: ((shadowGenerator: ShadowGenerator, casterMeshes: readonly Mesh[]) => Promise<void>) | null = null;

function getShadowTaskInputs(): WeakMap<ShadowGenerator, readonly Mesh[]> {
    shadowTaskInputs ??= new WeakMap<ShadowGenerator, readonly Mesh[]>();
    return shadowTaskInputs;
}

/** Register scene-owned shadow caster inputs for a generator. */
export function setShadowTaskCasterMeshes(shadowGenerator: ShadowGenerator, casterMeshes: readonly Mesh[]): void {
    getShadowTaskInputs().set(shadowGenerator, casterMeshes);
    if (shadowTaskInputPreloader) {
        void shadowTaskInputPreloader(shadowGenerator, casterMeshes);
    }
}

/** @internal */
export function _getShadowTaskCasterMeshes(shadowGenerator: ShadowGenerator): readonly Mesh[] | undefined {
    return shadowTaskInputs?.get(shadowGenerator);
}

/** @internal */
export function _setShadowTaskInputPreloader(preloader: (shadowGenerator: ShadowGenerator, casterMeshes: readonly Mesh[]) => Promise<void>): void {
    shadowTaskInputPreloader = preloader;
}
