/** Point-light PBR extension — WGSL snippets + UBO writer.
 *  Tree-shakable: only loaded when a point light is used with PBR. */

import type { PbrLightExtension, LightBase } from "./types.js";
import { _setPbrLightExtension } from "../material/pbr/pbr-flags.js";
import { SCENE_UBO_OFFSETS } from "../shader/scene-uniforms-fields.js";

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
        const oPos = SCENE_UBO_OFFSETS.lightPosition;
        const oDiff = SCENE_UBO_OFFSETS.lightDiffuseColor;
        data[oPos] = p.position.x;
        data[oPos + 1] = p.position.y;
        data[oPos + 2] = p.position.z;
        data[SCENE_UBO_OFFSETS.lightIntensity] = p.intensity;
        data[oDiff] = p.diffuse[0] ?? 1;
        data[oDiff + 1] = p.diffuse[1] ?? 1;
        data[oDiff + 2] = p.diffuse[2] ?? 1;
        data[SCENE_UBO_OFFSETS.lightRange] = p.range;
    },
};

export function registerPointPbrLight(): void {
    _setPbrLightExtension(pointPbrExtension);
}
