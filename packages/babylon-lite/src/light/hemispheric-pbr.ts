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
        return `let nDfdx = dpdx(N);
let nDfdy = dpdy(N);
let slopeSquare = max(dot(nDfdx, nDfdx), dot(nDfdy, nDfdy));
let directRoughness = max(roughness, pow(saturate(slopeSquare), 0.333));
directAlphaG = directRoughness * directRoughness + 0.0005;\n`;
    },

    writeSceneUbo(data: Float32Array, light: LightBase): void {
        const h = light as unknown as HemisphericLightData;
        // SCENE_UBO float offsets: lightDirection=36, lightIntensity=39,
        // lightDiffuseColor=40, lightGroundColor=44.
        data[36] = h.direction.x;
        data[37] = h.direction.y;
        data[38] = h.direction.z;
        data[39] = h.intensity;
        data[40] = h.diffuseColor[0];
        data[41] = h.diffuseColor[1];
        data[42] = h.diffuseColor[2];
        data[44] = h.groundColor[0];
        data[45] = h.groundColor[1];
        data[46] = h.groundColor[2];
    },
};

export function registerHemisphericPbrLight(): void {
    _setPbrLightExtension(hemisphericPbrExtension);
}
