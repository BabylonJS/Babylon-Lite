/** Hemispheric PBR light extension — WGSL snippets + UBO writer.
 *  Tree-shakable: only loaded when a hemispheric light is used with PBR. */

import type { PbrLightExtension, LightBase } from "./types.js";
import { _setPbrLightExtension } from "../material/pbr/pbr-flags.js";

interface HemisphericLightData {
    direction: { x: number; y: number; z: number };
    intensity: number;
    diffuseColor: [number, number, number];
    groundColor: [number, number, number];
}

const hemisphericPbrExtension: PbrLightExtension = {
    tag: "hemispheric",

    pbrSceneUboFields: [
        { name: "lightDirection", type: "vec3<f32>" },
        { name: "lightIntensity", type: "f32" },
        { name: "lightDiffuseColor", type: "vec3<f32>" },
        { name: "_pad1", type: "f32" },
        { name: "lightGroundColor", type: "vec3<f32>" },
    ],

    emitLightVector(): string {
        return `let L = normalize(scene.lightDirection);
let NdotL = dot(N, L) * 0.5 + 0.5;
let lightAtten = 1.0;\n`;
    },

    emitDirectDiffuse(): string {
        return `let groundColor = scene.lightGroundColor * scene.lightIntensity;
let hemiDiffuse = mix(groundColor, lightColor, NdotL);
var directDiffuse = hemiDiffuse * surfaceAlbedo * material.directIntensity;\n`;
    },

    emitGeometricAA(): string {
        // Direct specular uses max(roughness, pow(slopeSquare, 0.333)) for alphaG.
        // IBL AA (alphaG += sqrt(slopeSquare) * 0.75) is now emitted globally.
        return `let nDfdx = dpdx(N);
let nDfdy = dpdy(N);
let slopeSquare = max(dot(nDfdx, nDfdx), dot(nDfdy, nDfdy));
let directRoughness = max(roughness, pow(saturate(slopeSquare), 0.333));
directAlphaG = directRoughness * directRoughness + 0.0005;\n`;
    },

    writeSceneUbo(data: Float32Array, o: number, light: LightBase): void {
        const h = light as unknown as HemisphericLightData;
        data[o] = h.direction.x;
        data[o + 1] = h.direction.y;
        data[o + 2] = h.direction.z;
        data[o + 3] = h.intensity;
        data[o + 4] = h.diffuseColor[0];
        data[o + 5] = h.diffuseColor[1];
        data[o + 6] = h.diffuseColor[2];
        data[o + 8] = h.groundColor[0];
        data[o + 9] = h.groundColor[1];
        data[o + 10] = h.groundColor[2];
    },
};

export function registerHemisphericPbrLight(): void {
    _setPbrLightExtension(hemisphericPbrExtension);
}
