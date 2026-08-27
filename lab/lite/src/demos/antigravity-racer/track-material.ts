/**
 * Antigravity Racer — the track's deformation material.
 *
 * This is the port of the source playground's node material (snippet 01HFES#76):
 * the track mesh is a *straight*, undeformed 256-segment extrusion sitting at
 * the origin, and the vertex shader bends it onto the spline every frame by
 * reading one orthonormal frame per segment row.
 *
 * The original encoded those frames in a 4×256 RGBA32F texture sampled at
 * u = .125/.375/.625/.875 (the four texel centres) and v = (undeformedZ + .5)/256
 * (the row's texel centre) with LINEAR/REPEAT filtering. Because every sample
 * lands exactly on a texel centre, that filtered fetch degenerates to a plain
 * lookup — so Lite stores the very same four columns per row in a read-only
 * storage buffer and indexes it directly. Same math, same result, no float-texture
 * filtering requirement, and `upload()` can re-upload the frames in place while
 * the editor drags a control point (no buffer/bind-group churn).
 *
 * Column layout per row, matching the original texture exactly:
 *   c0 = (m0, m4,  m8,  0)  → world-matrix row 0
 *   c1 = (m1, m5,  m9,  0)  → world-matrix row 1
 *   c2 = (m2, m6,  m10, 0)  → world-matrix row 2
 *   c3 = (m12, m13, m14, 1) → segment origin
 *
 * The surface look is the original node material's, texture for texture: the
 * straight/curved road sheets, the emissive decal sheet and the boost chevron
 * are Patrick Ryan's artwork, extracted losslessly from the snippet's embedded
 * data URIs and redistributed here with his permission (see
 * `lab/public/antigravity-racer/track/CREDITS.txt`). The fragment stage below
 * reproduces the graph's compositing exactly — same UV construction, same
 * brightness banding, same lane masks, same `2·E + D + A` sum.
 */

import type { EngineContext, ShaderMaterial, StorageBuffer, Texture2D } from "babylon-lite";
import { createShaderMaterial, createStorageBuffer, disposeStorageBuffer, setShaderStorageBuffer, setShaderTexture, setShaderVector3, updateStorageBuffer } from "babylon-lite";

import { RING_COUNT } from "./constants.js";

/** Floats per segment row in the frame buffer: four vec4 columns. */
export const FLOATS_PER_FRAME = 16;

/** The four road sheets the node material samples, in the roles it gives them. */
export interface TrackTextures {
    /** 2048×512 RGB straight-track diffuse. */
    readonly straight: Texture2D;
    /** 2048×512 RGBA curved / hazard-track diffuse. */
    readonly curve: Texture2D;
    /** 2048×512 RGB emissive decal sheet. */
    readonly emissive: Texture2D;
    /** 256×256 RGBA boost-lane chevron. */
    readonly boost: Texture2D;
}

export interface TrackMaterial {
    readonly material: ShaderMaterial;
    /** vec4 columns c0..c3 for every segment row (`RING_COUNT * 16` floats). */
    readonly frameData: Float32Array;
    /** Per-row (curveFlag, boostRight, boostLeft, 0). */
    readonly infoData: Float32Array;
    /** Push the current `frameData` / `infoData` to the GPU (call after a track rebuild). */
    upload(): void;
    dispose(): void;
}

function vertexSource(): string {
    return `struct VertexOutput {
@builtin(position) position: vec4<f32>,
@location(0) worldNormal: vec3<f32>,
@location(1) undeformed: vec2<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
var out: VertexOutput;
// One frame per segment row; the loop closes by wrapping the last row back to the first.
let row = u32(input.position.z + 0.5) % ${RING_COUNT}u;
let base = row * 4u;
let r0 = normalize(trackFrames[base].xyz);
let r1 = normalize(trackFrames[base + 1u].xyz);
let r2 = normalize(trackFrames[base + 2u].xyz);
let origin = trackFrames[base + 3u].xyz;
let local = vec3<f32>(input.position.x, input.position.y, 0.0);
let worldPosition = vec3<f32>(dot(r0, local), dot(r1, local), dot(r2, local)) + origin;
out.position = shaderSystem.viewProjection * vec4<f32>(worldPosition, 1.0);
out.worldNormal = normalize(vec3<f32>(dot(r0, input.normal), dot(r1, input.normal), dot(r2, input.normal)));
out.undeformed = vec2<f32>(input.position.x, input.position.z);
return out;
}`;
}

function fragmentSource(): string {
    return `struct VertexOutput {
@builtin(position) position: vec4<f32>,
@location(0) worldNormal: vec3<f32>,
@location(1) undeformed: vec2<f32>,
};
// Per-row track info, linearly interpolated along the loop exactly like the
// original's LINEAR-filtered 1x256 info texture.
fn sampleInfo(z: f32) -> vec4<f32> {
let i0 = i32(floor(z));
let t = z - floor(z);
let a = trackInfo[u32((i0 + ${RING_COUNT}) % ${RING_COUNT})];
let b = trackInfo[u32((i0 + 1 + ${RING_COUNT}) % ${RING_COUNT})];
return mix(a, b, t);
}
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
let x = input.undeformed.x;
let z = input.undeformed.y;
let info = sampleInfo(z);
// The graph's UVs. The three 2048x512 sheets are authored across the deck (u)
// and repeat once per segment (v); their vScale = -1 is folded into the -z here.
let roadUv = vec2<f32>(0.5 - 0.11 * x, -z);
let boostUv = vec2<f32>(0.5 * (x + 1.0), -0.5 * (z + 1.0));
let straight = textureSample(roadStraight, roadStraightSampler, roadUv).rgb;
let curved = textureSample(roadCurve, roadCurveSampler, roadUv).rgb;
let emission = textureSample(roadEmissive, roadEmissiveSampler, roadUv).rgb;
let arrow = textureSample(boostArrow, boostArrowSampler, boostUv);
// Deck: alternating light/dark rows, blended from the straight sheet to the
// hazard-striped one by the row's curvature flag.
let band = smoothstep(0.5, 0.51, fract(0.5 * z));
let brightness = mix(0.6, 0.7, band);
let road = brightness * mix(straight, curved, info.r);
// Boost lanes: the periodic band across the deck (|sin(.8x)| >= .7), restricted
// to one half of it and enabled by that half's lane flag. info.g drives the +x
// lane and info.b the -x lane, the same sides the simulation tests (touchBoost).
let maskBase = abs(sin(0.8 * x)) - 0.2;
let lanePos = step(0.01, info.g) * step(0.5, step(0.0, x) * maskBase);
let laneNeg = step(0.01, info.b) * step(0.5, step(0.0, -x) * maskBase);
let boostMask = arrow.a * max(lanePos, laneNeg);
// The chevron is stamped emissively over a blacked-out deck, and the emissive
// decal sheet is punched out wherever the chevron is opaque.
let emissive = emission * (1.0 - arrow.a);
let diffuseColor = mix(road, vec3<f32>(0.0), boostMask);
let n = normalize(input.worldNormal);
let l = normalize(shaderUniforms.sunDir);
// Two-sided: the loop is driven upside-down for part of every lap.
let ndl = abs(dot(n, l));
let irradiance = shaderUniforms.ambientColor + shaderUniforms.sunColor * ndl;
return vec4<f32>(2.0 * emissive + diffuseColor * irradiance + arrow.rgb * boostMask, 1.0);
}`;
}

/** Build the track's deformation material plus the GPU buffers that feed it. */
export function createTrackMaterial(engine: EngineContext, textures: TrackTextures): TrackMaterial {
    const frameData = new Float32Array(RING_COUNT * FLOATS_PER_FRAME);
    const infoData = new Float32Array(RING_COUNT * 4);

    const material = createShaderMaterial({
        name: "antigrav-track",
        vertexSource: vertexSource(),
        fragmentSource: fragmentSource(),
        attributes: ["position", "normal"],
        uniforms: [
            "viewProjection",
            { name: "sunDir", type: "vec3<f32>", defaultValue: [0.4, 0.85, 0.35] },
            { name: "sunColor", type: "vec3<f32>", defaultValue: [1, 0.97, 0.9] },
            { name: "ambientColor", type: "vec3<f32>", defaultValue: [0.32, 0.36, 0.5] },
        ],
        samplers: ["roadStraight", "roadCurve", "roadEmissive", "boostArrow"],
        storageBuffers: [
            { name: "trackFrames", type: "array<vec4<f32>>" },
            { name: "trackInfo", type: "array<vec4<f32>>" },
        ],
        backFaceCulling: false,
    });
    // Explicit writes so the values survive Lite's default-vs-set uniform bookkeeping.
    setShaderVector3(material, "sunDir", [0.4, 0.85, 0.35]);
    setShaderVector3(material, "sunColor", [1, 0.97, 0.9]);
    setShaderVector3(material, "ambientColor", [0.32, 0.36, 0.5]);

    setShaderTexture(material, "roadStraight", textures.straight);
    setShaderTexture(material, "roadCurve", textures.curve);
    setShaderTexture(material, "roadEmissive", textures.emissive);
    setShaderTexture(material, "boostArrow", textures.boost);

    const frameBuffer: StorageBuffer = createStorageBuffer(engine, frameData, "antigrav-track-frames");
    const infoBuffer: StorageBuffer = createStorageBuffer(engine, infoData, "antigrav-track-info");
    setShaderStorageBuffer(material, "trackFrames", frameBuffer);
    setShaderStorageBuffer(material, "trackInfo", infoBuffer);

    let disposed = false;
    return {
        material,
        frameData,
        infoData,
        upload(): void {
            if (disposed) {
                return;
            }
            updateStorageBuffer(engine, frameBuffer, frameData);
            updateStorageBuffer(engine, infoBuffer, infoData);
        },
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            disposeStorageBuffer(frameBuffer);
            disposeStorageBuffer(infoBuffer);
        },
    };
}
