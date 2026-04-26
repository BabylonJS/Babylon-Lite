/** Directional light extension — WGSL snippets + UBO writer.
 *  Tree-shakable: only loaded when a directional light is used with a render pipeline. */

import type { LightExtension, LightBase } from "./types.js";
import { _setLightExtension } from "./extension-registry.js";

interface DirectionalLightData {
    direction: { x: number; y: number; z: number };
    intensity: number;
    diffuse: [number, number, number];
}

const directionalLightExtension: LightExtension = {
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
        // lightDirection @ 36 (vec4: dir.xyz, intensity), lightDiffuseColor @ 40
        data[36] = d.direction.x;
        data[37] = d.direction.y;
        data[38] = d.direction.z;
        data[39] = d.intensity;
        data[40] = d.diffuse[0];
        data[41] = d.diffuse[1];
        data[42] = d.diffuse[2];
    },
};

export function registerDirectionalLightExtension(): void {
    _setLightExtension(directionalLightExtension);
}
