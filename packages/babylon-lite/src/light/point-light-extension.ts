/** Point light extension — WGSL snippets + UBO writer.
 *  Tree-shakable: only loaded when a point light is used with a render pipeline. */

import type { LightExtension, LightBase } from "./types.js";
import { _setLightExtension } from "./extension-registry.js";

interface PointLightData {
    position: { x: number; y: number; z: number };
    intensity: number;
    diffuse: [number, number, number];
    range: number;
}

const pointLightExtension: LightExtension = {
    tag: "point",

    emitLightVector(): string {
        return `let lightToFrag = scene.lightPosition - input.worldPos;
let lightDist2 = dot(lightToFrag, lightToFrag);
let L = normalize(lightToFrag);
let NdotL = max(dot(N, L), 0.0);
let lightAtten = 1.0 / max(lightDist2, 0.0001);\n`;
    },

    emitDirectDiffuse(): string {
        return `var directDiffuse = surfaceAlbedo * (1.0 / PI) * NdotL * lightColor * lightAtten * material.directIntensity;\n`;
    },

    emitGeometricAA(): string {
        return "";
    },

    writeSceneUbo(data: Float32Array, light: LightBase): void {
        const p = light as unknown as PointLightData;
        // lightIntensity @ 39, lightDiffuseColor @ 40, lightPosition @ 48, lightRange @ 51
        data[39] = p.intensity;
        data[40] = p.diffuse[0] ?? 1;
        data[41] = p.diffuse[1] ?? 1;
        data[42] = p.diffuse[2] ?? 1;
        data[48] = p.position.x;
        data[49] = p.position.y;
        data[50] = p.position.z;
        data[51] = p.range;
    },
};

export function registerPointLightExtension(): void {
    _setLightExtension(pointLightExtension);
}
