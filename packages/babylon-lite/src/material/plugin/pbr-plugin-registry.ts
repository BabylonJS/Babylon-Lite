import type { PbrExt } from "../pbr/pbr-flags.js";
import type { ShaderFragment } from "../../shader/fragment-types.js";

let indexToFragment: ShaderFragment[] | null = null;
let counter = 0;
let activeExtension: PbrExt | undefined;

/** @internal Allocate a stable, collision-free identity shared by all PBR plugin bridges. */
export function _allocatePbrPluginIndex(): number {
    return ++counter;
}

/** @internal Store a fragment under its allocated cross-bridge identity. */
export function _registerPbrPluginFragment(index: number, fragment: ShaderFragment): void {
    (indexToFragment ??= [])[index] = fragment;
}

/** @internal Resolve fragments created by either PBR plugin bridge. */
export function _getPbrPluginFragment(index: number): ShaderFragment | undefined {
    return indexToFragment?.[index];
}

/** @internal Preserve an opt-in PBR plugin bridge across later registration and reconciliation. */
export function _setActivePbrPluginExt(extension: PbrExt): void {
    activeExtension = extension;
}

/** @internal Return the active opt-in bridge, or the ordinary bridge before an override is installed. */
export function _getActivePbrPluginExt(fallback: PbrExt): PbrExt {
    return activeExtension ?? fallback;
}
