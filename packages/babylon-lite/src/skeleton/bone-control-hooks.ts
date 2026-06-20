/** Bone-control integration hooks.
 *
 *  Bone control is opt-in (see `enableBoneControl`). To keep skinned scenes that
 *  DON'T use it near byte-identical to a build without it, the always-fetched
 *  skeleton/animation chunk references bone control only through these two
 *  null-by-default hooks:
 *
 *    • `_boneBuilder` — invoked by the glTF skeleton feature's per-asset hook to
 *      build the public `Skeleton[]` handles + eager-bake runtime. Null ⇒ no
 *      handles and `AssetContainer.skeletons` stays undefined.
 *    • `_boneApplier` — invoked once per frame by the animation tick to write the
 *      user's bone overrides into the working TRS before channel evaluation. Null
 *      ⇒ the tick does nothing extra.
 *
 *  `enableBoneControl()` installs both (pulling the implementation + public setters
 *  into the bundle). Until then the tree-shaker folds the whole bone-control
 *  implementation away. */

import type { GltfLoadCtx } from "../loader-gltf/gltf-feature.js";
import type { AssetContainer } from "../asset-container.js";
import type { Mesh } from "../mesh/mesh.js";
import type { BoneOverride } from "./bone-control.js";

/** @internal Builds public skeleton handles + eager-bake runtime from a load ctx. */
export type BoneBuilder = (ctx: GltfLoadCtx, meshes: Mesh[], overrides: Map<number, BoneOverride>) => Promise<Pick<AssetContainer, "skeletons">>;
/** @internal Writes the masked override TRS into `currentTRS` (per-frame, pre-channels). */
export type BoneApplier = (overrides: ReadonlyMap<number, BoneOverride>, currentTRS: Float32Array, numNodes: number) => void;

/** @internal */
export let _boneBuilder: BoneBuilder | null = null;
/** @internal */
export let _boneApplier: BoneApplier | null = null;

/** @internal Install the bone-control implementation. Called by `enableBoneControl`. */
export function _installBoneControl(builder: BoneBuilder, applier: BoneApplier): void {
    _boneBuilder = builder;
    _boneApplier = applier;
}
