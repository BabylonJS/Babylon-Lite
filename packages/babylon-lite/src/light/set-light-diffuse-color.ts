import type { LightBase } from "./types.js";

/** Update a light's diffuse RGB color and invalidate its shared lights UBO entry. */
export function setLightDiffuseColor(light: LightBase & { diffuse: [number, number, number] }, color: readonly [number, number, number]): void {
    if (!Number.isFinite(color[0]) || !Number.isFinite(color[1]) || !Number.isFinite(color[2])) {
        throw new Error(`setLightDiffuseColor: expected finite RGB components, got ${color.join(",")}`);
    }
    if (light.diffuse[0] === color[0] && light.diffuse[1] === color[1] && light.diffuse[2] === color[2]) {
        return;
    }
    light.diffuse[0] = color[0];
    light.diffuse[1] = color[1];
    light.diffuse[2] = color[2];
    light._bumpLightVersion?.();
}
