import type { LightBase } from "./types.js";

/** Update a light's intensity and invalidate its shared lights UBO entry. */
export function setLightIntensity(light: LightBase & { intensity: number }, intensity: number): void {
    if (!Number.isFinite(intensity)) {
        throw new Error(`setLightIntensity: expected a finite intensity, got ${intensity}`);
    }
    if (light.intensity === intensity) {
        return;
    }
    light.intensity = intensity;
    light._bumpLightVersion?.();
}
