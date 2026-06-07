/**
 * CSM Receiver Registry — lazy wiring of the Standard-material CSM receiver fragment.
 *
 * The Standard shadow fragment (`std-shadow-fragment`) is bundled by every
 * ESM/PCF shadow scene. To keep the cascaded-shadow receiver WGSL out of those
 * bundles, the CSM generator module registers its receiver factory here at
 * generator-creation time (only CSM scenes import the generator), and
 * `std-shadow-fragment` looks it up lazily when it encounters a `"csm"` slot.
 *
 * Zero module-level side effects — safe for tree-shaking. The slot holds `null`
 * until a CSM generator is created.
 */

import type { ShaderFragment } from "../shader/fragment-types.js";

type StdCsmReceiverFactory = (slots: { lightIndex: number }[]) => ShaderFragment;

let _stdFactory: StdCsmReceiverFactory | null = null;

/** Register the Standard-material CSM receiver fragment factory. Called by the CSM generator. */
export function setCsmStdReceiverFactory(f: StdCsmReceiverFactory): void {
    _stdFactory = f;
}

/** Get the registered Standard-material CSM receiver fragment factory, or `null` if no CSM generator was created. */
export function getCsmStdReceiverFactory(): StdCsmReceiverFactory | null {
    return _stdFactory;
}

type PbrCsmReceiverFactory = (slots: { lightIndex: number }[]) => ShaderFragment;

let _pbrFactory: PbrCsmReceiverFactory | null = null;

/** Register the PBR-material CSM receiver fragment factory. Called by the CSM generator. */
export function setCsmPbrReceiverFactory(f: PbrCsmReceiverFactory): void {
    _pbrFactory = f;
}

/** Get the registered PBR-material CSM receiver fragment factory, or `null` if no CSM generator was created. */
export function getCsmPbrReceiverFactory(): PbrCsmReceiverFactory | null {
    return _pbrFactory;
}
