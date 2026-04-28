/** Directional PBR light extension — WGSL snippets + UBO writer.
 *  Tree-shakable: only loaded when a directional light is used with PBR. */

import type { PbrLightExtension, LightBase } from "./types.js";
import { _setPbrLightExtension } from "../material/pbr/pbr-flags.js";
import { SCENE_UBO_OFFSETS } from "../shader/scene-uniforms-fields.js";

interface DirectionalLightData {
    direction: { x: number; y: number; z: number };
    intensity: number;
    diffuse: [number, number, number];
}

const directionalPbrExtension: PbrLightExtension = {
    tag: "directional",

    emitLightVector(): string {
        return `let L = normalize(-scene.lightDirection);
let NdotL = max(dot(N, L), 0.0);
let lightAtten = 1.0;\n`;
    },

    emitDirectDiffuse(): string {
        return `var directDiffuse = surfaceAlbedo * (1.0 / PI) * NdotL * lightColor * material.directIntensity;\n`;
    },

    emitGeometricAA(): string {
        return "";
    },

    writeSceneUbo(data: Float32Array, light: LightBase): void {
        const d = light as unknown as DirectionalLightData;
        const oDir = SCENE_UBO_OFFSETS.lightDirection;
        const oDiff = SCENE_UBO_OFFSETS.lightDiffuseColor;
        data[oDir] = d.direction.x;
        data[oDir + 1] = d.direction.y;
        data[oDir + 2] = d.direction.z;
        data[SCENE_UBO_OFFSETS.lightIntensity] = d.intensity;
        data[oDiff] = d.diffuse[0];
        data[oDiff + 1] = d.diffuse[1];
        data[oDiff + 2] = d.diffuse[2];
    },
};

export function registerDirectionalPbrLight(): void {
    _setPbrLightExtension(directionalPbrExtension);
}
