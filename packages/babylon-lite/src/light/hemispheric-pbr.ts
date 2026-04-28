/** Hemispheric PBR light extension — WGSL snippets + UBO writer.
 *  Tree-shakable: only loaded when a hemispheric light is used with PBR. */

import type { PbrLightExtension, LightBase } from "./types.js";
import { _setPbrLightExtension } from "../material/pbr/pbr-flags.js";
import { SCENE_UBO_OFFSETS } from "../shader/scene-uniforms-fields.js";

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
        const oDir = SCENE_UBO_OFFSETS.lightDirection;
        const oDiff = SCENE_UBO_OFFSETS.lightDiffuseColor;
        const oGround = SCENE_UBO_OFFSETS.lightGroundColor;
        data[oDir] = h.direction.x;
        data[oDir + 1] = h.direction.y;
        data[oDir + 2] = h.direction.z;
        data[SCENE_UBO_OFFSETS.lightIntensity] = h.intensity;
        data[oDiff] = h.diffuseColor[0];
        data[oDiff + 1] = h.diffuseColor[1];
        data[oDiff + 2] = h.diffuseColor[2];
        data[oGround] = h.groundColor[0];
        data[oGround + 1] = h.groundColor[1];
        data[oGround + 2] = h.groundColor[2];
    },
};

export function registerHemisphericPbrLight(): void {
    _setPbrLightExtension(hemisphericPbrExtension);
}
