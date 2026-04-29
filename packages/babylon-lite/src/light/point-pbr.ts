/** Point-light PBR extension — WGSL snippets + UBO writer.
 *  Tree-shakable: only loaded when a point light is used with PBR. */

import type { PbrLightExtension, LightBase } from "./types.js";
import { _setPbrLightExtension } from "../material/pbr/pbr-flags.js";

interface PointLightData {
    position: { x: number; y: number; z: number };
    intensity: number;
    diffuse: [number, number, number];
    range: number;
}

const pointPbrExtension: PbrLightExtension = {
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
        // SCENE_UBO float offsets: lightIntensity=39, lightDiffuseColor=40,
        // lightRange=43, lightPosition=48.
        data[48] = p.position.x;
        data[49] = p.position.y;
        data[50] = p.position.z;
        data[39] = p.intensity;
        data[40] = p.diffuse[0] ?? 1;
        data[41] = p.diffuse[1] ?? 1;
        data[42] = p.diffuse[2] ?? 1;
        data[43] = p.range;
    },
};

export function registerPointPbrLight(): void {
    _setPbrLightExtension(pointPbrExtension);
}
