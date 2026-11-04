import type { BindingKind } from "../fragment-types.js";
import { wgsl, type WgslSource } from "../wgsl.js";

/** Describes one shadow-casting light for a receiver generator. */
export interface ShadowLightSlot {
    lightIndex: number;
    shadowType: "esm" | "pcf" | "csm";
}

/** @internal Algorithm-owned sampling metadata and WGSL generation. */
export interface ShadowAlgorithm {
    readonly shadowTexture: Extract<BindingKind, { _kind: "texture" }>;
    readonly shadowSamplerName: "shadowSamp" | "shadowComp";
    readonly shadowSampler: Extract<BindingKind, { _kind: "sampler" }> & { readonly _samplerType: "sampler" | "sampler_comparison" };
    shadowFragmentLine(lightIndex: number, suffix: string, factors?: "shadowFactors" | "_sf"): WgslSource;
    shadowHelper(suffix: string, projection: WgslSource): WgslSource;
}

/** @internal Algorithms available after asynchronous receiver preparation. */
export interface PreparedShadowAlgorithms {
    readonly esm: ShadowAlgorithm | undefined;
    readonly pcf: ShadowAlgorithm | undefined;
}

/** @internal Prepare only algorithms requested by the supplied light slots. */
export async function loadShadowAlgorithms(shadowLights: readonly ShadowLightSlot[]): Promise<PreparedShadowAlgorithms> {
    let needsEsm = false;
    let needsPcf = false;
    for (const slot of shadowLights) {
        needsEsm ||= slot.shadowType === "esm";
        needsPcf ||= slot.shadowType === "pcf";
    }
    const [esm, pcf] = await Promise.all([needsEsm ? import("./shadow-fragment-esm.js") : null, needsPcf ? import("./shadow-fragment-pcf.js") : null]);
    return { esm: esm?.shadowAlgorithm, pcf: pcf?.shadowAlgorithm };
}

/** @internal Identical projection and frustum rejection used by fallback receivers. */
export function shadowProjectionCode(): WgslSource {
    return wgsl`let clipSpace = posFromLight.xyz / posFromLight.w;
let uv = vec2<f32>(0.5 * clipSpace.x + 0.5, 0.5 - 0.5 * clipSpace.y);
if (depthMetric < 0.0 || depthMetric > 1.0 || uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }`;
}
