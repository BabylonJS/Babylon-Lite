import type { EngineContextInternal } from "../../engine/engine.js";
import type { SceneContextInternal } from "../../scene/scene.js";
import type { PbrExt } from "./pbr-flags.js";
import type { PbrMaterialProps } from "./pbr-material.js";

export async function registerPbrRefraction(scene: SceneContextInternal, engine: EngineContextInternal, register: (ext: PbrExt) => void): Promise<void> {
    // Load the per-RGB chromatic-dispersion sample WGSL only when a material in the
    // scene actually uses KHR_materials_dispersion, so its 3-ray code chunk is fetched
    // solely by dispersion scenes and never weighs on other transmission scenes. The
    // string is injected into the refraction fragment (no shared module mutation).
    let dispersionSampleWgsl: string | undefined;
    for (const mesh of scene.meshes) {
        const refr = (mesh.material as PbrMaterialProps | undefined)?.subsurface?.refraction;
        if (refr?.dispersion) {
            dispersionSampleWgsl = (await import("./fragments/refraction-dispersion-wgsl.js")).DISPERSION_SAMPLE_WGSL;
            break;
        }
    }
    const mod = await import("./pbr-transmission-ext.js");
    mod.registerPbrTransmission(scene, engine, register, dispersionSampleWgsl);
}
