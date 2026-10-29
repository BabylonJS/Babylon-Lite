/**
 * Right-handed engine seams, each checked against the Babylon.js right-handed behaviour it ports.
 *
 * Like right-handed-system.test.ts, this file mocks `#coordinate-system` with the `babylon-lite-rh`
 * variant; vitest isolates test files, so every other unit test keeps the left-handed engine.
 */
import { describe, expect, it, vi } from "vitest";

import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera";
import { buildPbrMrHelperCore } from "../../../packages/babylon-lite/src/material/node/blocks/pbr-mr-helper-core";
import { buildPbrMrHelperFull } from "../../../packages/babylon-lite/src/material/node/blocks/pbr-mr-helper-full";
import { makeBillboardWgsl } from "../../../packages/babylon-lite/src/sprite/billboard-pipeline";
import { makeCustomBillboardWgsl } from "../../../packages/babylon-lite/src/sprite/billboard-custom-shader";
import { _toRightHandedShaderSystemUniforms } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import type { NodePbrMrHelperRequest } from "../../../packages/babylon-lite/src/material/node/node-types";
import { parseBabylonCamera } from "../../../packages/babylon-lite/src/loader-babylon/parse-camera";
import { computeLocalBasis } from "../../../packages/babylon-lite/src/camera/geospatial-camera";
import { buildLightViewMatrix } from "../../../packages/babylon-lite/src/shadow/shadow-base";
import { buildLightViewMatrixInto } from "../../../packages/babylon-lite/src/shadow/csm-shadow-task-hooks";
import { copyXrRigidMatrixToWorld, setXrPoseToWorld } from "../../../packages/babylon-lite/src/xr/xr-coordinates";
import { createLinearDepthMaterial } from "../../../packages/babylon-lite/src/render/linear-depth-material";
import { _toCubeSpaceSun } from "../../../packages/babylon-lite/src/loader-env/procedural-sky-environment";
import { resolvePointerAccessor } from "../../../packages/babylon-lite/src/flow-graph/gltf/path-converter";
import type { PointerResolveContext } from "../../../packages/babylon-lite/src/flow-graph/gltf/path-converter";

vi.mock("../../../packages/babylon-lite/src/engine/coordinate-system", () => import("../../../packages/babylon-lite/src/engine/coordinate-system-rh"));

type V3 = { x: number; y: number; z: number };
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const normalize = (a: V3): V3 => {
    const l = Math.hypot(a.x, a.y, a.z);
    return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const expectV3Close = (actual: V3, expected: V3): void => {
    expect(actual.x).toBeCloseTo(expected.x, 6);
    expect(actual.y).toBeCloseTo(expected.y, 6);
    expect(actual.z).toBeCloseTo(expected.z, 6);
};

/** Column-major 4x4 product `a·b`. */
function mul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
    const out = new Array<number>(16).fill(0);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            for (let k = 0; k < 4; k++) {
                out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
            }
        }
    }
    return out;
}

/** Determinant of the upper-left 3x3 of a column-major 4x4. */
function det3(m: ArrayLike<number>): number {
    return m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
}

describe("right-handed helpers", () => {
    it("turns a look-at camera world into Babylon.js's right-handed one (X and Z columns negated)", () => {
        // Looking down +Z: the left-handed basis is the identity; the right-handed one looks down its local -Z.
        const w = Array.from(createFreeCamera({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 10 }).worldMatrix as unknown as ArrayLike<number>);
        [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 1, 2, 3, 1].forEach((v, i) => expect(w[i]).toBeCloseTo(v, 6));
    });

    it("negates Z after every inlined environment rotation of the node-material PBR helpers", () => {
        const off = { key: "", useEnv: true, useClearcoat: false, useSheen: false, useRefraction: false, useSubsurface: false, useAnisotropy: false };
        const request: NodePbrMrHelperRequest = {
            ...off,
            useIridescence: false,
            useShAlbedoScaling: false,
            useCcBump: false,
            useCcTint: false,
            useSpecularAA: false,
            remapClearcoatF0: false,
        };
        for (const out of [buildPbrMrHelperCore(request), buildPbrMrHelperFull({ ...request, useClearcoat: true, useSheen: true })]) {
            expect(out).toMatch(/\w+\.x\*sinA-\w+\.z\*cosA/);
            expect(out).not.toMatch(/-\w+\.x\s*\*\s*sinA\s*\+/);
        }
    });

    it("mirrors the billboard texture horizontally, built-in and custom shaders alike", () => {
        for (const code of [makeBillboardWgsl("facing", "transparent", false), makeCustomBillboardWgsl("facing", [], "return vec4f(1.0);")]) {
            expect(code).toContain("mix(in.a,in.b,vec2f(1.0-q.x,q.y))");
            expect(code).not.toMatch(/mix\(in\.a,\s*in\.b,\s*q\)/);
        }
    });

    it("hands ShaderMaterial Babylon.js's right-handed view, worldView and projection, and keeps their products", () => {
        // Engine view = Sz·V_RH and projection = P_RH·Sz: the conversion must recover V_RH and P_RH.
        const vRh = [0.8, 0.1, -0.6, 0, -0.2, 0.97, 0.1, 0, 0.6, 0.2, 0.8, 0, 1, -2, -9, 1];
        const pRh = [1.2, 0, 0, 0, 0, 1.8, 0, 0, 0, 0, -1.001, -1, 0, 0, -0.2, 0];
        const sz = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
        const data = new Float32Array(48);
        data.set(mul(sz, vRh), 0);
        data.set(mul(pRh, sz), 16);
        data.set(mul(mul(pRh, sz), mul(sz, vRh)), 32);
        _toRightHandedShaderSystemUniforms(data, [
            ["view", 0],
            ["projection", 64],
            ["viewProjection", 128],
        ]);
        const close = (actual: ArrayLike<number>, expected: number[]): void => expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 5));
        close(data.subarray(0, 16), vRh);
        close(data.subarray(16, 32), pRh);
        close(data.subarray(32, 48), mul(pRh, vRh));
    });
});

describe("right-handed seams", () => {
    it(".babylon camera looks down its local -Z, like Babylon.js's right-handed FreeCamera", () => {
        const straight = parseBabylonCamera({ position: [1, 2, 3] });
        // Identity rotation in a right-handed scene: camera world is the identity orientation.
        const w = straight.worldMatrix as unknown as ArrayLike<number>;
        expect(w[8]).toBeCloseTo(0, 6);
        expect(w[10]).toBeCloseTo(1, 6);
        const yawed = parseBabylonCamera({ position: [0, 0, 0], rotation: [0, Math.PI / 2, 0] });
        // A +90° yaw turns -Z forward towards -X (Babylon.js: forward = R·(0, 0, -1)).
        const yw = yawed.worldMatrix as unknown as ArrayLike<number>;
        expect(-yw[8]!).toBeCloseTo(-1, 6);
        expect(-yw[10]!).toBeCloseTo(0, 6);
    });

    it("geospatial local basis swaps the cross products like ComputeLocalBasisToRefs(useRightHandedSystem)", () => {
        const pos = { x: 3, y: 4, z: -2 };
        const east = { x: 0, y: 0, z: 0 };
        const north = { x: 0, y: 0, z: 0 };
        const up = { x: 0, y: 0, z: 0 };
        computeLocalBasis(pos, east, north, up);
        const bjsUp = normalize(pos);
        const bjsEast = normalize(cross({ x: 0, y: 0, z: 1 }, bjsUp));
        const bjsNorth = normalize(cross(bjsUp, bjsEast));
        expectV3Close(up, bjsUp);
        expectV3Close(east, bjsEast);
        expectV3Close(north, bjsNorth);
    });

    it("mirrors the light X axis in both shadow light-view builders", () => {
        const single = buildLightViewMatrix(0.3, -1, 0.2, 1, 5, -2);
        const cascaded = new Float32Array(16);
        buildLightViewMatrixInto(cascaded, 0.3, -1, 0.2, 1, 5, -2);
        expect(det3(single)).toBeCloseTo(-1, 5);
        for (let i = 0; i < 16; i++) {
            expect(cascaded[i]).toBeCloseTo(single[i]!, 6);
        }
    });

    it("keeps WebXR poses verbatim (WebXR is right-handed)", () => {
        const source = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        const out = new Float32Array(16) as unknown as Parameters<typeof copyXrRigidMatrixToWorld>[0];
        copyXrRigidMatrixToWorld(out, source);
        expect(Array.from(out as unknown as Float32Array)).toEqual(source);
        const position = {
            x: 0,
            y: 0,
            z: 0,
            set(x: number, y: number, z: number) {
                Object.assign(this, { x, y, z });
            },
        };
        const rotationQuaternion = {
            x: 0,
            y: 0,
            z: 0,
            w: 0,
            set(x: number, y: number, z: number, w: number) {
                Object.assign(this, { x, y, z, w });
            },
        };
        setXrPoseToWorld(
            { position, rotationQuaternion } as unknown as Parameters<typeof setXrPoseToWorld>[0],
            {
                position: { x: 1, y: 2, z: 3, w: 1 },
                orientation: { x: 0.1, y: 0.2, z: 0.3, w: 0.9 },
            } as unknown as XRRigidTransform
        );
        expect([position.x, position.y, position.z]).toEqual([1, 2, 3]);
        expect([rotationQuaternion.x, rotationQuaternion.y, rotationQuaternion.z, rotationQuaternion.w]).toEqual([0.1, 0.2, 0.3, 0.9]);
    });

    it("linear depth reads Babylon.js's right-handed view Z (negative in front)", () => {
        expect(String(createLinearDepthMaterial().vertexSource)).toMatch(/viewZ\s*=\s*-viewPos\.z/);
    });

    it("generates the procedural sky cube around the Z-mirrored sun (the cube is sampled with Z negated)", () => {
        const options = { sunDirection: [0.2, 0.5, 0.8] as const, luminance: 1, turbidity: 10, rayleigh: 2, mieCoefficient: 0.005, mieDirectionalG: 0.8 };
        const cube = _toCubeSpaceSun(options);
        expect(cube.sunDirection).toEqual([0.2, 0.5, -0.8]);
        expect(options.sunDirection).toEqual([0.2, 0.5, 0.8]);
        expect(cube.turbidity).toBe(10);
    });

    it("KHR_interactivity activeCamera returns the camera pose untouched, like Babylon.js's right-handed scene", () => {
        // A camera at (1, 2, 3) turned 90° about Y (column-major world).
        const c = Math.SQRT1_2;
        const worldMatrix = Float32Array.from([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 2, 3, 1]);
        const ctx = { nodeMap: [], scene: { camera: { worldMatrix, ortho: false } } } as unknown as PointerResolveContext;
        const position = resolvePointerAccessor("/extensions/KHR_interactivity/activeCamera/position", ctx)!.get() as V3;
        expect([position.x, position.y, position.z]).toEqual([1, 2, 3]);
        const rotation = resolvePointerAccessor("/extensions/KHR_interactivity/activeCamera/rotation", ctx)!.get() as V3 & { w: number };
        expect(Math.abs(rotation.y)).toBeCloseTo(c, 5);
        expect(Math.sign(rotation.y) * Math.sign(rotation.w)).toBe(1);
        expect(rotation.x).toBeCloseTo(0, 6);
        expect(rotation.z).toBeCloseTo(0, 6);
    });
});
