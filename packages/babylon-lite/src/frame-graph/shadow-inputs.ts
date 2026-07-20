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

/**
 * Cap the cascades a caster mesh renders into: the mesh casts only into cascade layers `0..maxCascade`
 * (0 = the nearest). Lets a scene keep small casters out of the far cascades, where their shadows are
 * sub-texel anyway — each excluded layer saves that caster's draw + pipeline switch per frame.
 *
 * Unset (the default) casts into every cascade. Pass `Infinity` to restore that.
 * The cap is read when a generator's caster set is (re)supplied through
 * {@link setShadowTaskCasterMeshes}; to change it for an already-registered caster, re-supply the
 * caster list (a new array) afterwards. Non-cascaded (single-map) generators ignore the cap.
 */
export function setShadowCasterMaxCascade(mesh: Mesh, maxCascade: number): void {
    if (maxCascade !== Infinity && (!Number.isInteger(maxCascade) || maxCascade < 0)) {
        throw new RangeError("setShadowCasterMaxCascade requires a non-negative integer or Infinity");
    }
    mesh._shadowMaxCascade = maxCascade === Infinity ? undefined : maxCascade;
}

/** @internal Cascade cap for a caster mesh (see {@link setShadowCasterMaxCascade}); Infinity when unset. */
export function _getShadowCasterMaxCascade(mesh: Mesh): number {
    return mesh._shadowMaxCascade ?? Infinity;
}

/** @internal */
export function _setShadowTaskInputPreloader(preloader: (shadowGenerator: ShadowGenerator, casterMeshes: readonly Mesh[]) => Promise<void>): void {
    shadowTaskInputPreloader = preloader;
}
