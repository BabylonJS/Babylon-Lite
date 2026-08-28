/**
 * Fidelity tests for the Antigravity Racer track port: the spline sampling, the
 * segment frames, the procedural track piece and the road-artwork wiring must
 * reproduce the source playground (snippet WVPVWL#0 + node material 01HFES#76)
 * exactly.
 */

// This file's demo imports resolve to the REAL `babylon-lite` package source
// (lab/node_modules/babylon-lite is a workspace symlink, so a `vi.mock` written
// from tests/ never matches it). That is fine and preferable here: every
// function under test is either pure math or plain material bookkeeping, and the
// only device call `createTrackMaterial` makes is stubbed by `stubEngine()`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { addVec3 } from "../../../packages/babylon-lite/src/math/add-vec3";
import { subVec3 } from "../../../packages/babylon-lite/src/math/sub-vec3";
import { scaleVec3 } from "../../../packages/babylon-lite/src/math/scale-vec3";
import { dotVec3 } from "../../../packages/babylon-lite/src/math/dot-vec3";
import { crossVec3 } from "../../../packages/babylon-lite/src/math/cross-vec3";
import { normalizeVec3 as normalizeVec3Object } from "../../../packages/babylon-lite/src/math/normalize-vec3-object";

// The demo module reaches the engine only to upload GPU resources; the math under
// test is pure, so the real vector helpers are wired through and everything that
// touches the device is stubbed.
vi.mock("babylon-lite", () => ({
    addVec3,
    subVec3,
    scaleVec3,
    dotVec3,
    crossVec3,
    normalizeVec3Object,
    addToScene: vi.fn(),
    createMeshFromData: vi.fn(),
    createShaderMaterial: vi.fn(),
    createStorageBuffer: vi.fn(),
    disposeStorageBuffer: vi.fn(),
    getCsmReceiverTexture: vi.fn(),
    onCsmReceiverUpdate: vi.fn(),
    setShaderStorageBuffer: vi.fn(),
    setShaderTexture: vi.fn(),
    setShaderVector3: vi.fn(),
    setShadowCasterMaterial: vi.fn(),
    updateStorageBuffer: vi.fn(),
}));

interface TrackModule {
    buildTrackFrames: (points: readonly { x: number; y: number; z: number }[]) => {
        frames: {
            pos: { x: number; y: number; z: number };
            dir: { x: number; y: number; z: number };
            up: { x: number; y: number; z: number };
            right: { x: number; y: number; z: number };
        }[];
        curveRatios: number[];
    };
    computeTrackRatios: (points: readonly { x: number; y: number; z: number }[]) => { length: number; lengthPerRow: number; ratios: number[] };
    buildTrackPiece: () => { positions: Float32Array; normals: Float32Array; indices: Uint32Array };
}

interface TrackMaterialModule {
    createTrackMaterial: (
        engine: unknown,
        textures: Record<string, unknown>,
        shadowGenerator: unknown
    ) => {
        material: {
            vertexSource: string;
            fragmentSource: string;
            samplerDecls: { name: string }[];
            storageBufferDecls: { name: string }[];
            _textureSlots: Map<string, { current: unknown }>;
            _storageBufferSlots: Map<string, { current: unknown }>;
            _shadowCasterMaterial?: unknown;
        };
        casterMaterial: {
            vertexSource: string;
            samplerDecls: { name: string }[];
            storageBufferDecls: { name: string }[];
            _storageBufferSlots: Map<string, { current: unknown }>;
        };
        frameData: Float32Array;
        infoData: Float32Array;
        upload(): void;
        dispose(): void;
    };
    CSM_RECEIVER_VEC4S: number;
}

/** Minimal engine stand-in: `createStorageBuffer` is the only device call `createTrackMaterial` makes. */
function stubEngine(): unknown {
    return {
        _device: {
            createBuffer: (desc: { size: number }) => ({
                getMappedRange: () => new ArrayBuffer(desc.size),
                unmap: () => {},
                destroy: () => {},
            }),
            queue: { writeBuffer: () => {} },
        },
    };
}

/** A cascaded-shadow generator stand-in — enough for the receiver seam, no device required. */
function stubCsmGenerator(): Record<string, unknown> {
    return {
        _shadowType: "csm",
        _depthTexture: { width: 1024, height: 1024, createView: () => ({}), destroy: () => {} },
        _depthSampler: {},
    };
}

// Non-literal import so the tests TypeScript project does not recursively
// typecheck the rest of the demo (mirrors racer-vehicle.test.ts).
const trackModulePath = "../../../lab/lite/src/demos/antigravity-racer/track.js";
const constantsPath = "../../../lab/lite/src/demos/antigravity-racer/constants.js";
const trackMaterialPath = "../../../lab/lite/src/demos/antigravity-racer/track-material.js";
const { buildTrackFrames, computeTrackRatios, buildTrackPiece } = (await import(trackModulePath)) as TrackModule;
const { createTrackMaterial, CSM_RECEIVER_VEC4S } = (await import(trackMaterialPath)) as TrackMaterialModule;
const { DEFAULT_CONTROL_POINTS, RING_COUNT, TRACK_CROSS_SECTION, TRACK_CROSS_NORMALS } = (await import(constantsPath)) as {
    DEFAULT_CONTROL_POINTS: readonly { x: number; y: number; z: number }[];
    RING_COUNT: number;
    TRACK_CROSS_SECTION: readonly (readonly [number, number])[];
    TRACK_CROSS_NORMALS: readonly (readonly [number, number, number])[];
};

describe("antigravity racer track spline", () => {
    it("reproduces the playground's track length and per-row spacing", () => {
        const { length, lengthPerRow, ratios } = computeTrackRatios(DEFAULT_CONTROL_POINTS);
        expect(length).toBeCloseTo(407.3498753202372, 9);
        expect(lengthPerRow).toBeCloseTo(1.5912104504696765, 9);
        expect(ratios.length).toBeGreaterThanOrEqual(RING_COUNT);
    });

    it("builds 256 orthonormal segment frames whose origin is the previous sample", () => {
        const { frames, curveRatios } = buildTrackFrames(DEFAULT_CONTROL_POINTS);
        expect(frames).toHaveLength(256);
        expect(curveRatios).toHaveLength(256);
        for (const f of frames) {
            expect(dotVec3(f.right, f.up)).toBeCloseTo(0, 6);
            expect(dotVec3(f.right, f.dir)).toBeCloseTo(0, 6);
            expect(dotVec3(f.up, f.dir)).toBeCloseTo(0, 6);
            expect(Math.hypot(f.dir.x, f.dir.y, f.dir.z)).toBeCloseTo(1, 6);
        }
        // Each frame's forward axis points at the NEXT frame's origin, which is what makes
        // origin == "previous sample" observable.
        for (let i = 0; i < frames.length; i++) {
            const a = frames[i]!;
            const b = frames[(i + 1) % frames.length]!;
            const delta = subVec3(b.pos, a.pos);
            const len = Math.hypot(delta.x, delta.y, delta.z);
            expect(dotVec3(a.dir, delta) / len).toBeCloseTo(1, 6);
        }
    });

    it("keeps the loop closed", () => {
        const { frames } = buildTrackFrames(DEFAULT_CONTROL_POINTS);
        const first = frames[0]!.pos;
        const last = frames[frames.length - 1]!.pos;
        expect(Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z)).toBeLessThan(4);
    });
});

describe("antigravity racer track piece", () => {
    it("has the playground's exact vertex/index counts", () => {
        const { positions, normals, indices } = buildTrackPiece();
        expect(positions.length / 3).toBe(10240);
        expect(normals.length / 3).toBe(10240);
        expect(indices.length).toBe(15360);
        expect(indices.length / 3).toBe(5120);
    });

    it("duplicates the 20-point cross-section at z = i and z = i + 1", () => {
        const { positions, normals } = buildTrackPiece();
        for (const seg of [0, 1, 137, 255]) {
            for (let row = 0; row < 2; row++) {
                for (let k = 0; k < TRACK_CROSS_SECTION.length; k++) {
                    const v = (seg * 40 + row * 20 + k) * 3;
                    expect(positions[v]).toBe(TRACK_CROSS_SECTION[k]![0]);
                    expect(positions[v + 1]).toBe(TRACK_CROSS_SECTION[k]![1]);
                    expect(positions[v + 2]).toBe(seg + row);
                    expect(normals[v]).toBe(TRACK_CROSS_NORMALS[k]![0]);
                    expect(normals[v + 1]).toBe(TRACK_CROSS_NORMALS[k]![1]);
                    expect(normals[v + 2]).toBe(TRACK_CROSS_NORMALS[k]![2]);
                }
            }
        }
    });

    it("emits the playground's 60-index strip per segment", () => {
        const { indices } = buildTrackPiece();
        const expected: number[] = [];
        for (let index = 0; index < 19; index += 2) {
            expected.push(index, index + 1, index + 20, index + 1, index + 21, index + 20);
        }
        expect(Array.from(indices.slice(0, 60))).toEqual(expected);
        // The next segment repeats the same pattern shifted by 40 vertices.
        expect(Array.from(indices.slice(60, 120))).toEqual(expected.map((i) => i + 40));
    });
});

// ── Road artwork ────────────────────────────────────────────────────────────
// The four sheets are Patrick Ryan's, extracted byte-for-byte from the embedded
// data URIs of node material 01HFES#76 and committed under the demo's asset
// folder with his permission. Their exact size/format is load-bearing: the
// fragment shader's UV construction assumes the 2048x512 across-the-deck layout,
// and the boost/curve sheets must carry an alpha channel.
const ART_DIR = resolve(__dirname, "../../../lab/public/antigravity-racer/track");

/** PNG colour types: 2 = truecolour (RGB), 6 = truecolour + alpha (RGBA). */
const EXPECTED_ART = [
    { file: "road-straight.png", width: 2048, height: 512, colorType: 2, bytes: 783426 },
    { file: "road-curve.png", width: 2048, height: 512, colorType: 6, bytes: 1271377 },
    { file: "road-emissive.png", width: 2048, height: 512, colorType: 2, bytes: 4142 },
    { file: "boost-arrow.png", width: 256, height: 256, colorType: 6, bytes: 33191 },
] as const;

describe("antigravity racer road artwork", () => {
    it.each(EXPECTED_ART)("$file is an $width x $height 8-bit PNG of colour type $colorType", ({ file, width, height, colorType, bytes }) => {
        const png = readFileSync(resolve(ART_DIR, file));
        expect(png.length).toBe(bytes);
        // PNG signature + IHDR: width/height/bit depth/colour type live at fixed offsets.
        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
        expect(png.readUInt32BE(16)).toBe(width);
        expect(png.readUInt32BE(20)).toBe(height);
        expect(png.readUInt8(24)).toBe(8);
        expect(png.readUInt8(25)).toBe(colorType);
    });

    it("ships a credits file naming the author and the granted rights", () => {
        const credits = readFileSync(resolve(ART_DIR, "CREDITS.txt"), "utf8");
        expect(credits).toContain("Patrick Ryan");
        expect(credits).toContain("redistribute");
        expect(credits).toContain("01HFES#76");
    });
});

// ── Track material ──────────────────────────────────────────────────────────
describe("antigravity racer track material", () => {
    const textures = { straight: { id: "S" }, curve: { id: "C" }, emissive: { id: "E" }, boost: { id: "B" } };

    it("binds the four road sheets and composites them exactly like the node material", () => {
        const built = createTrackMaterial(stubEngine(), textures, stubCsmGenerator());
        const material = built.material;

        expect(material.samplerDecls.map((s) => s.name)).toEqual(["roadStraight", "roadCurve", "roadEmissive", "boostArrow", "csmShadow"]);
        expect(material._textureSlots.get("roadStraight")!.current).toBe(textures.straight);
        expect(material._textureSlots.get("roadCurve")!.current).toBe(textures.curve);
        expect(material._textureSlots.get("roadEmissive")!.current).toBe(textures.emissive);
        expect(material._textureSlots.get("boostArrow")!.current).toBe(textures.boost);

        const frag = material.fragmentSource;
        // UV construction (the sheets' vScale = -1 folded into the -z / -0.5 terms).
        expect(frag).toContain("let roadUv = vec2<f32>(0.5 - 0.11 * x, -z);");
        expect(frag).toContain("let boostUv = vec2<f32>(0.5 * (x + 1.0), -0.5 * (z + 1.0));");
        // Deck brightness banding and the straight → curved blend on trackInfo.r.
        expect(frag).toContain("let band = smoothstep(0.5, 0.51, fract(0.5 * z));");
        expect(frag).toContain("let brightness = mix(0.6, 0.7, band);");
        expect(frag).toContain("let road = brightness * mix(straight, curved, info.r);");
        // Boost lane mask: |sin(.8x)| - .2 >= .5, per side, gated by the lane flags.
        expect(frag).toContain("let maskBase = abs(sin(0.8 * x)) - 0.2;");
        expect(frag).toContain("let lanePos = step(0.01, info.g) * step(0.5, step(0.0, x) * maskBase);");
        expect(frag).toContain("let laneNeg = step(0.01, info.b) * step(0.5, step(0.0, -x) * maskBase);");
        expect(frag).toContain("let boostMask = arrow.a * max(lanePos, laneNeg);");
        // Compositing: emissive punched out by the chevron, black deck under it, 2E + D + A.
        expect(frag).toContain("let emissive = emission * (1.0 - arrow.a);");
        expect(frag).toContain("let diffuseColor = mix(road, vec3<f32>(0.0), boostMask);");
        expect(frag).toContain("return vec4<f32>(2.0 * emissive + diffuseColor * irradiance + arrow.rgb * boostMask, 1.0);");
        // The storage-buffer vertex deformation is untouched by the artwork port.
        expect(material.storageBufferDecls.map((b) => b.name)).toEqual(["trackFrames", "trackInfo", "csmReceiver"]);
        expect(material.vertexSource).toContain("out.undeformed = vec2<f32>(input.position.x, input.position.z);");

        built.dispose();
    });

    it("receives cascaded shadows through the public CSM seam", () => {
        const built = createTrackMaterial(stubEngine(), textures, stubCsmGenerator());
        const frag = built.material.fragmentSource;
        expect(built.material.samplerDecls.find((s) => s.name === "csmShadow")).toMatchObject({
            sampleType: "depth",
            viewDimension: "2d-array",
            comparison: true,
        });
        // Cascade select + 5x5 PCF + cascade blend, mirroring csm-shadow-fragment-core.
        expect(frag).toContain("let viewZ = (shaderSystem.view * vec4<f32>(input.worldPos, 1.0)).z;");
        expect(frag).toContain("let shadow = computeShadowCSM(vec4<f32>(input.worldPos, 1.0), viewZ);");
        expect(frag).toContain("let irradiance = shaderUniforms.ambientColor + shaderUniforms.sunColor * ndl * shadow;");
        expect(frag).toContain("textureSampleCompareLevel(csmShadow, csmShadowSampler,");
        expect(frag).toContain("sh /= 144.0;");
        expect(frag).toContain("let depthRef = clamp(clipSpace.z, 0.0, 0.99999994);");
        expect(CSM_RECEIVER_VEC4S).toBe(20);
        built.dispose();
    });

    it("casts through a sampler-free twin that shares the SAME frame buffer", () => {
        const built = createTrackMaterial(stubEngine(), textures, stubCsmGenerator());
        // The caster is wired through the public setShadowCasterMaterial seam.
        expect(built.material._shadowCasterMaterial).toBe(built.casterMaterial);
        // Sampler-free: nothing in the caster's bind group can alias the cascade array it renders into.
        expect(built.casterMaterial.samplerDecls).toEqual([]);
        expect(built.casterMaterial.storageBufferDecls.map((b) => b.name)).toEqual(["trackFrames"]);
        // Same vertex deformation, same GPU buffer → an editor rebuild moves road and shadow together.
        expect(built.casterMaterial.vertexSource).toBe(built.material.vertexSource);
        expect(built.casterMaterial._storageBufferSlots.get("trackFrames")!.current).toBe(built.material._storageBufferSlots.get("trackFrames")!.current);
        built.dispose();
    });
});
