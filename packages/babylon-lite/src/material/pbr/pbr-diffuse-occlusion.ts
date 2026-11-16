import type { WgslSource } from "../../shader/wgsl.js";

/** @internal An unused modifier stays null and folds into the original IBL expression. */
export let pbrDiffuseOcclusion: ((index: number, features: number, features2: number) => WgslSource | null) | null = null;

/** @internal Kept outside the lazy fragment's namespace exports so unused enablers disappear. */
export function installPbrDiffuseOcclusion(modifier: NonNullable<typeof pbrDiffuseOcclusion>): void {
    pbrDiffuseOcclusion = modifier;
}
