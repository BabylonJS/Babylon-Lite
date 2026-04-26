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

    pbrSceneUboFields: [
        { name: "lightPosition", type: "vec3<f32>" },
        { name: "lightIntensity", type: "f32" },
        { name: "lightDiffuseColor", type: "vec3<f32>" },
        { name: "lightRange", type: "f32" },
        { name: "_pointPad", type: "vec3<f32>" },
    ],

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

    writeSceneUbo(data: Float32Array, o: number, light: LightBase): void {
        const p = light as unknown as PointLightData;
        data[o] = p.position.x;
        data[o + 1] = p.position.y;
        data[o + 2] = p.position.z;
        data[o + 3] = p.intensity;
        data[o + 4] = p.diffuse[0] ?? 1;
        data[o + 5] = p.diffuse[1] ?? 1;
        data[o + 6] = p.diffuse[2] ?? 1;
        data[o + 7] = p.range;
    },
};

export function registerPointPbrLight(): void {
    _setPbrLightExtension(pointPbrExtension);
}
