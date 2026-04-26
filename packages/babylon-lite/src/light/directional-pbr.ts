/** Directional PBR light extension — WGSL snippets + UBO writer.
 *  Tree-shakable: only loaded when a directional light is used with PBR. */

import type { PbrLightExtension, LightBase } from "./types.js";
import { _setPbrLightExtension } from "../material/pbr/pbr-flags.js";

interface DirectionalLightData {
    direction: { x: number; y: number; z: number };
    intensity: number;
    diffuse: [number, number, number];
}

const directionalPbrExtension: PbrLightExtension = {
    tag: "directional",

    pbrSceneUboFields: [
        { name: "lightDirection", type: "vec3<f32>" },
        { name: "lightIntensity", type: "f32" },
        { name: "lightDiffuseColor", type: "vec3<f32>" },
        { name: "_pad1", type: "f32" },
        { name: "lightGroundColor", type: "vec3<f32>" },
    ],

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

    writeSceneUbo(data: Float32Array, o: number, light: LightBase): void {
        const d = light as unknown as DirectionalLightData;
        data[o] = d.direction.x;
        data[o + 1] = d.direction.y;
        data[o + 2] = d.direction.z;
        data[o + 3] = d.intensity;
        data[o + 4] = d.diffuse[0];
        data[o + 5] = d.diffuse[1];
        data[o + 6] = d.diffuse[2];
    },
};

export function registerDirectionalPbrLight(): void {
    _setPbrLightExtension(directionalPbrExtension);
}
