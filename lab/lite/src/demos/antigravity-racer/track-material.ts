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
 * data URIs and redistributed here with his permission. The fragment stage below
 * reproduces the graph's compositing exactly — same UV construction, same
 * brightness banding, same lane masks, same `2·E + D + A` sum — and, like the
 * original graph's `Light` block, it receives the directional light's shadows.
 *
 * SHADOWS. The original node material got shadow reception from its `Light` block
 * and shadow casting from a `ShadowDepthWrapper` that reused its vertex
 * deformation. Here:
 *
 *  - Receiving: the cascade array + the 80-float receiver payload are bound
 *    through the public `getCsmReceiverTexture` / `onCsmReceiverUpdate` seam and
 *    sampled with the engine's cascade-select + 5×5 PCF math. Those resources
 *    belong to ONE generator, whose cascades are fit to ONE camera — which is why
 *    split-screen builds one track material per pane instead of sharing this one
 *    (see `world.ts`).
 *  - Casting: a ShaderMaterial casts through a depth-only view of ITSELF, which
 *    shares its bind group — so this material cannot cast while it also samples
 *    the cascade array it would be rendering into. Instead the track owns a
 *    second, sampler-free material with the SAME vertex source and the SAME
 *    `trackFrames` buffer, wired via the public `setShadowCasterMaterial`. Both
 *    observe a track rebuild because they share that GPU buffer, so editing a
 *    control point moves the road and its shadow in the same frame, with no
 *    duplicate geometry anywhere.
 */

import type { EngineContext, ShaderMaterial, ShadowGenerator, StorageBuffer, Texture2D } from "babylon-lite";
import {
    createShaderMaterial,
    createStorageBuffer,
    disposeStorageBuffer,
    getCsmReceiverTexture,
    onCsmReceiverUpdate,
    setShaderStorageBuffer,
    setShaderTexture,
    setShaderVector3,
    setShadowCasterMaterial,
    updateStorageBuffer,
} from "babylon-lite";

import { RING_COUNT, SHADOW_CASCADES } from "./constants.js";

/** Floats per segment row in the frame buffer: four vec4 columns. */
export const FLOATS_PER_FRAME = 16;

/** `vec4`s in the CSM receiver payload: 4 cascade matrices + viewFrustumZ + frustumLengths + shadowsInfo + csmParams. */
export const CSM_RECEIVER_VEC4S = 20;

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
    /** Sampler-free twin used for the shadow-caster pass (same vertex stage, same frame buffer). */
    readonly casterMaterial: ShaderMaterial;
    /** vec4 columns c0..c3 for every segment row (`RING_COUNT * 16` floats). */
    readonly frameData: Float32Array;
    /** Per-row (curveFlag, boostRight, boostLeft, 0). */
    readonly infoData: Float32Array;
    /** Push the current `frameData` / `infoData` to the GPU (call after a track rebuild). */
    upload(): void;
    dispose(): void;
}

/** The deformation, shared by the visible material and its shadow-caster twin. */
function vertexSource(): string {
    return `struct VertexOutput {
@builtin(position) position: vec4<f32>,
@location(0) worldNormal: vec3<f32>,
@location(1) undeformed: vec2<f32>,
@location(2) worldPos: vec3<f32>,
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
out.worldPos = worldPosition;
return out;
}`;
}

/** Cascade select + 5×5 PCF, mirroring `shader/fragments/csm-shadow-fragment-core.ts` exactly. */
function csmReceiverWgsl(): string {
    return `fn csmMatrix(layer: i32) -> mat4x4<f32> {
let b = u32(layer) * 4u;
return mat4x4<f32>(csmReceiver[b], csmReceiver[b + 1u], csmReceiver[b + 2u], csmReceiver[b + 3u]);
}
fn csmFallOff(value: f32, clipSpace: vec2<f32>, frustumEdgeFalloff: f32) -> f32 {
let mask = smoothstep(1.0 - frustumEdgeFalloff, 1.00000012, clamp(dot(clipSpace, clipSpace), 0.0, 1.0));
return mix(value, 1.0, mask);
}
fn csmSample(layer: i32, worldPos: vec4<f32>) -> f32 {
let shadowsInfo = csmReceiver[18u];
let posFromLight = csmMatrix(layer) * worldPos;
let clipSpace = posFromLight.xyz / posFromLight.w;
let uv = vec2<f32>(0.5 * clipSpace.x + 0.5, 0.5 - 0.5 * clipSpace.y);
let depthRef = clamp(clipSpace.z, 0.0, 0.99999994);
let mapSz = shadowsInfo.y;
let invMapSz = shadowsInfo.z;
var tc = uv * mapSz + 0.5;
let st = fract(tc);
let base = (floor(tc) - 0.5) * invMapSz;
let uvw0 = 4.0 - 3.0 * st;
let uvw1 = vec2<f32>(7.0);
let uvw2 = 1.0 + 3.0 * st;
let u = vec3<f32>((3.0 - 2.0 * st.x) / uvw0.x - 2.0, (3.0 + st.x) / uvw1.x, st.x / uvw2.x + 2.0) * invMapSz;
let v = vec3<f32>((3.0 - 2.0 * st.y) / uvw0.y - 2.0, (3.0 + st.y) / uvw1.y, st.y / uvw2.y + 2.0) * invMapSz;
var sh = 0.0;
sh += uvw0.x * uvw0.y * textureSampleCompareLevel(csmShadow, csmShadowSampler, base + vec2<f32>(u[0], v[0]), layer, depthRef);
sh += uvw1.x * uvw0.y * textureSampleCompareLevel(csmShadow, csmShadowSampler, base + vec2<f32>(u[1], v[0]), layer, depthRef);
sh += uvw2.x * uvw0.y * textureSampleCompareLevel(csmShadow, csmShadowSampler, base + vec2<f32>(u[2], v[0]), layer, depthRef);
sh += uvw0.x * uvw1.y * textureSampleCompareLevel(csmShadow, csmShadowSampler, base + vec2<f32>(u[0], v[1]), layer, depthRef);
sh += uvw1.x * uvw1.y * textureSampleCompareLevel(csmShadow, csmShadowSampler, base + vec2<f32>(u[1], v[1]), layer, depthRef);
sh += uvw2.x * uvw1.y * textureSampleCompareLevel(csmShadow, csmShadowSampler, base + vec2<f32>(u[2], v[1]), layer, depthRef);
sh += uvw0.x * uvw2.y * textureSampleCompareLevel(csmShadow, csmShadowSampler, base + vec2<f32>(u[0], v[2]), layer, depthRef);
sh += uvw1.x * uvw2.y * textureSampleCompareLevel(csmShadow, csmShadowSampler, base + vec2<f32>(u[1], v[2]), layer, depthRef);
sh += uvw2.x * uvw2.y * textureSampleCompareLevel(csmShadow, csmShadowSampler, base + vec2<f32>(u[2], v[2]), layer, depthRef);
sh /= 144.0;
sh = mix(shadowsInfo.x, 1.0, sh);
return csmFallOff(sh, clipSpace.xy, shadowsInfo.w);
}
fn computeShadowCSM(worldPos: vec4<f32>, viewZ: f32) -> f32 {
let viewFrustumZ = csmReceiver[16u];
let frustumLengths = csmReceiver[17u];
let csmParams = csmReceiver[19u];
let nCascades = ${SHADOW_CASCADES};
var idx = -1;
var diff = 0.0;
for (var i = 0; i < nCascades; i = i + 1) {
diff = viewFrustumZ[i] - viewZ;
if (diff >= 0.0) { idx = i; break; }
}
if (idx < 0) { idx = nCascades - 1; }
var shadow = csmSample(idx, worldPos);
let diffRatio = clamp(diff / frustumLengths[idx], 0.0, 1.0) * csmParams.y;
if (idx < nCascades - 1 && diffRatio < 1.0) {
shadow = mix(csmSample(idx + 1, worldPos), shadow, diffRatio);
}
return shadow;
}`;
}

function fragmentSource(): string {
    return `struct VertexOutput {
@builtin(position) position: vec4<f32>,
@location(0) worldNormal: vec3<f32>,
@location(1) undeformed: vec2<f32>,
@location(2) worldPos: vec3<f32>,
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
${csmReceiverWgsl()}
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
let viewZ = (shaderSystem.view * vec4<f32>(input.worldPos, 1.0)).z;
let shadow = computeShadowCSM(vec4<f32>(input.worldPos, 1.0), viewZ);
let irradiance = shaderUniforms.ambientColor + shaderUniforms.sunColor * ndl * shadow;
return vec4<f32>(2.0 * emissive + diffuseColor * irradiance + arrow.rgb * boostMask, 1.0);
}`;
}

/** Never compiled: the depth-only shadow target has no colour attachment, so the caster's fragment
 *  stage is dropped. It exists only because `createShaderMaterial` requires a fragment source. */
function casterFragmentSource(): string {
    return `struct VertexOutput {
@builtin(position) position: vec4<f32>,
@location(0) worldNormal: vec3<f32>,
@location(1) undeformed: vec2<f32>,
@location(2) worldPos: vec3<f32>,
};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
return vec4<f32>(0.0, 0.0, 0.0, 1.0);
}`;
}

/** Sun direction (TOWARDS the light): the negation of the playground's directional light direction (-1, -2, -1). */
const SUN_TOWARDS: [number, number, number] = [0.4082482904638631, 0.8164965809277261, 0.4082482904638631];
const SUN_COLOR: [number, number, number] = [1, 0.97, 0.9];
const AMBIENT_COLOR: [number, number, number] = [0.32, 0.36, 0.5];

/** Build the track's deformation material, its shadow-caster twin, and the GPU buffers that feed them. */
export function createTrackMaterial(engine: EngineContext, textures: TrackTextures, shadowGenerator: ShadowGenerator): TrackMaterial {
    const frameData = new Float32Array(RING_COUNT * FLOATS_PER_FRAME);
    const infoData = new Float32Array(RING_COUNT * 4);
    const csmData = new Float32Array(CSM_RECEIVER_VEC4S * 4);

    const material = createShaderMaterial({
        name: "antigrav-track",
        vertexSource: vertexSource(),
        fragmentSource: fragmentSource(),
        attributes: ["position", "normal"],
        uniforms: [
            "viewProjection",
            "view",
            { name: "sunDir", type: "vec3<f32>", defaultValue: SUN_TOWARDS },
            { name: "sunColor", type: "vec3<f32>", defaultValue: SUN_COLOR },
            { name: "ambientColor", type: "vec3<f32>", defaultValue: AMBIENT_COLOR },
        ],
        samplers: ["roadStraight", "roadCurve", "roadEmissive", "boostArrow", { name: "csmShadow", sampleType: "depth", viewDimension: "2d-array", comparison: true }],
        storageBuffers: [
            { name: "trackFrames", type: "array<vec4<f32>>" },
            { name: "trackInfo", type: "array<vec4<f32>>" },
            { name: "csmReceiver", type: "array<vec4<f32>>" },
        ],
        backFaceCulling: false,
    });
    // Explicit writes so the values survive Lite's default-vs-set uniform bookkeeping.
    setShaderVector3(material, "sunDir", SUN_TOWARDS);
    setShaderVector3(material, "sunColor", SUN_COLOR);
    setShaderVector3(material, "ambientColor", AMBIENT_COLOR);

    setShaderTexture(material, "roadStraight", textures.straight);
    setShaderTexture(material, "roadCurve", textures.curve);
    setShaderTexture(material, "roadEmissive", textures.emissive);
    setShaderTexture(material, "boostArrow", textures.boost);
    setShaderTexture(material, "csmShadow", getCsmReceiverTexture(shadowGenerator));

    const frameBuffer: StorageBuffer = createStorageBuffer(engine, frameData, "antigrav-track-frames");
    const infoBuffer: StorageBuffer = createStorageBuffer(engine, infoData, "antigrav-track-info");
    const csmBuffer: StorageBuffer = createStorageBuffer(engine, csmData, "antigrav-track-csm");
    setShaderStorageBuffer(material, "trackFrames", frameBuffer);
    setShaderStorageBuffer(material, "trackInfo", infoBuffer);
    setShaderStorageBuffer(material, "csmReceiver", csmBuffer);

    // Mirror the cascade transforms INSIDE the receiver callback: reading them from onBeforeRender
    // would sample the previous frame's cascades and make the road's shadows swim while the camera moves.
    let disposed = false;
    const stopReceiver = onCsmReceiverUpdate(shadowGenerator, (data) => {
        if (disposed) {
            return;
        }
        csmData.set(data);
        updateStorageBuffer(engine, csmBuffer, csmData);
    });

    const casterMaterial = createShaderMaterial({
        name: "antigrav-track-caster",
        vertexSource: vertexSource(),
        fragmentSource: casterFragmentSource(),
        attributes: ["position", "normal"],
        uniforms: ["viewProjection"],
        storageBuffers: [{ name: "trackFrames", type: "array<vec4<f32>>" }],
        backFaceCulling: false,
    });
    // The SAME GPU buffer: a track rebuild moves the road and its shadow together.
    setShaderStorageBuffer(casterMaterial, "trackFrames", frameBuffer);
    setShadowCasterMaterial(material, casterMaterial);

    return {
        material,
        casterMaterial,
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
            stopReceiver();
            disposeStorageBuffer(frameBuffer);
            disposeStorageBuffer(infoBuffer);
            disposeStorageBuffer(csmBuffer);
        },
    };
}
