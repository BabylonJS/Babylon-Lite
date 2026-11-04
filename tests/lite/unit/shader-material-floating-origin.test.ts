/**
 * ShaderMaterial must honour the floating origin.
 *
 * The bug this exists for: `standard`, `pbr` and `node` renderables all rebase
 * their mesh world matrix onto the camera before upload (via
 * `engine._makePackMeshWorld`), but the ShaderMaterial writers read
 * `mesh.worldMatrix` raw. Under `useFloatingOrigin` the view matrix carries no
 * translation — `getViewMatrix` forces it to zero and expects the mesh pack to
 * have established the eye-relative frame — so an un-rebased mesh is drawn as
 * though the camera sat at the world origin. Its position and apparent size
 * then depend only on where it IS, never on where the viewer is.
 *
 * What that looked like: flying toward a planet, the distance readout counting
 * down, the terrain LOD subdividing correctly — and the planet not growing by a
 * single pixel. The game knew the distance; the renderer did not.
 *
 * It survived every existing test because nothing asserted that a ShaderMaterial
 * mesh's clip-space position depends on the camera's. `floating-origin-upload`
 * covers the packer and the view matrix in isolation; both were fine. The gap
 * was the one renderable family that never called the packer.
 *
 * So the assertions below are framed as approach, not as pack format: move the
 * camera toward a fixed mesh and require what you would see to change. That is
 * the property that was broken, and it fails on the pre-fix writer.
 *
 * LineMaterial is a ShaderMaterial under the skin, so orbit/guide lines were
 * hit by exactly the same defect.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { _setHpmAllocator, _resetMatrixAllocatorForTests } from "../../../packages/babylon-lite/src/math/_matrix-allocator";
import { allocateF64Mat4 } from "../../../packages/babylon-lite/src/math/_mat4-storage-f64";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera";
import { getViewMatrix, getViewProjectionMatrix } from "../../../packages/babylon-lite/src/camera/camera";
import type { Camera } from "../../../packages/babylon-lite/src/camera/camera";
import { _defaultShaderSystemUniformWriter, _shaderWorldMatrix } from "../../../packages/babylon-lite/src/material/shader/shader-renderable";
import { createShaderMaterial, type ShaderSystemUniformName } from "../../../packages/babylon-lite/src/material/shader/shader-material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { UboSpec } from "../../../packages/babylon-lite/src/shader/fragment-types";
import { packMat4IntoF32WithOffset } from "../../../packages/babylon-lite/src/large-world/pack-mat4-with-offset";
import { wgsl } from "../../../packages/babylon-lite/src/shader/wgsl";

/** The numbers from the actual bug report: a 75,977 m planet approached from
 *  4,561 km down to 304 km. The disc should go from ~1.9° across to ~28°. */
const FAR_DISTANCE = 4_561_405;
const NEAR_DISTANCE = 303_913;
/** Somewhere far from the world origin, which is the whole point of LWR — at
 *  the origin the bug is invisible because relative and absolute agree. */
const PLANET_X = 4_600_000;

/** A mesh is only ever read for `worldMatrix` here, so this is the whole
 *  surface the writers touch. F64-backed to match `useHighPrecisionMatrix`. */
function meshAt(x: number, y: number, z: number): Mesh {
    const world = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
    return { worldMatrix: world, worldMatrixVersion: 1 } as unknown as Mesh;
}

/** A camera looking down +X toward the planet, wired for floating origin the way
 *  `scene-core` wires the active scene camera on an LWR engine. `worldMatrix` is
 *  a lazy getter, so there is nothing to flush. */
function cameraAt(x: number, floatingOrigin: boolean): Camera {
    const camera = createFreeCamera({ x, y: 0, z: 0 }, { x: x + 1, y: 0, z: 0 });
    camera.nearPlane = 100;
    camera.farPlane = 100_000_000;
    if (floatingOrigin) {
        camera._useFloatingOrigin = true;
    }
    return camera;
}

function shaderMaterial(uniforms: readonly ShaderSystemUniformName[]) {
    return createShaderMaterial({
        vertexSource: wgsl`@vertex fn mainVertex() -> @builtin(position) vec4f { return vec4f(); }`,
        fragmentSource: wgsl`@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(); }`,
        attributes: ["position"],
        uniforms: [...uniforms],
    });
}

/** Lay every requested uniform out back to back, 16 floats each except the
 *  vec3/vec2 tail cases, which are the last thing written so overlap cannot
 *  occur. Mirrors what the real UBO spec produces closely enough for the
 *  writers, which only ever consult `_offsets`. */
function specFor(names: readonly ShaderSystemUniformName[]): { spec: UboSpec; offsets: Map<string, number> } {
    const offsets = new Map<string, number>();
    let byte = 0;
    for (const name of names) {
        offsets.set(name, byte);
        byte += 64;
    }
    return { spec: { _offsets: offsets } as unknown as UboSpec, offsets };
}

/** Run the shipping writer and hand back a reader keyed by uniform name. */
function writeUniforms(names: readonly ShaderSystemUniformName[], mesh: Mesh, camera: Camera): (name: string) => Float32Array {
    const material = shaderMaterial(names);
    const { spec, offsets } = specFor(names);
    const data = new Float32Array(names.length * 16);
    _defaultShaderSystemUniformWriter(data, spec, material, mesh, camera, 1600, 900);
    return (name: string) => data.subarray(offsets.get(name)! / 4, offsets.get(name)! / 4 + 16);
}

/** Project a mesh-local point to normalized device coordinates through the
 *  uniforms the shader would receive. This is "what ends up on screen", which
 *  is the level the bug was visible at. */
function projectToNdc(worldViewProjection: Float32Array, x: number, y: number, z: number): { x: number; y: number; w: number } {
    const m = worldViewProjection;
    const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    return { x: cx / cw, y: cy / cw, w: cw };
}

describe("ShaderMaterial under floating origin", () => {
    beforeAll(() => _setHpmAllocator(allocateF64Mat4));
    afterAll(() => _resetMatrixAllocatorForTests());

    it("rebases the mesh world translation onto the camera", () => {
        const mesh = meshAt(PLANET_X, 0, 0);
        const camera = cameraAt(PLANET_X - FAR_DISTANCE, true);
        const world = _shaderWorldMatrix(mesh, camera);

        expect(world[12]).toBeCloseTo(FAR_DISTANCE, 0);
        expect(world[13]).toBe(0);
        expect(world[14]).toBe(0);
        // The rotation/scale block is carried through untouched.
        expect([...world.subarray(0, 12)]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
        expect(world[15]).toBe(1);
    });

    it("leaves the world matrix alone when floating origin is off — control", () => {
        // Without this, a fix that simply zeroed the translation would pass the
        // test above while breaking every non-LWR scene.
        const mesh = meshAt(PLANET_X, 0, 0);
        const camera = cameraAt(PLANET_X - FAR_DISTANCE, false);
        const world = _shaderWorldMatrix(mesh, camera);

        expect(world[12]).toBe(PLANET_X);
        expect(world[12]).not.toBe(FAR_DISTANCE);
    });

    it("brings a mesh closer as the camera approaches it — the reported bug", () => {
        // The regression proper. Pre-fix, `world` was the mesh's absolute
        // translation and `view` had no translation, so both of these were
        // byte-identical and the planet hung at a fixed apparent distance
        // forever.
        const mesh = meshAt(PLANET_X, 0, 0);
        const far = writeUniforms(["worldViewProjection"], mesh, cameraAt(PLANET_X - FAR_DISTANCE, true))("worldViewProjection");
        const near = writeUniforms(["worldViewProjection"], mesh, cameraAt(PLANET_X - NEAR_DISTANCE, true))("worldViewProjection");

        const farW = projectToNdc(far, 0, 0, 0).w;
        const nearW = projectToNdc(near, 0, 0, 0).w;

        // `w` after a perspective projection is the view-space depth: it must
        // track the real distance, which shrank by ~15x.
        expect(farW).toBeGreaterThan(0);
        expect(nearW).toBeGreaterThan(0);
        expect(nearW).toBeLessThan(farW);
        expect(farW / nearW).toBeCloseTo(FAR_DISTANCE / NEAR_DISTANCE, 1);
    });

    it("grows a mesh on screen as the camera approaches it", () => {
        // The same fact stated the way the user saw it: a 75,977 m radius body
        // should go from a 1.9-degree speck to filling half the view. Measured
        // as the NDC span of a point offset one radius off-axis.
        const RADIUS = 75_977;
        const mesh = meshAt(PLANET_X, 0, 0);
        const far = writeUniforms(["worldViewProjection"], mesh, cameraAt(PLANET_X - FAR_DISTANCE, true))("worldViewProjection");
        const near = writeUniforms(["worldViewProjection"], mesh, cameraAt(PLANET_X - NEAR_DISTANCE, true))("worldViewProjection");

        const farSpan = Math.abs(projectToNdc(far, 0, RADIUS, 0).y - projectToNdc(far, 0, 0, 0).y);
        const nearSpan = Math.abs(projectToNdc(near, 0, RADIUS, 0).y - projectToNdc(near, 0, 0, 0).y);

        expect(nearSpan / farSpan).toBeCloseTo(FAR_DISTANCE / NEAR_DISTANCE, 1);
        expect(nearSpan).toBeGreaterThan(farSpan * 10);
    });

    it("keeps world, worldView and worldViewProjection in one frame", () => {
        // All three derive from the same matrix, so a fix applied to only one
        // of them would tear geometry apart between passes that use different
        // uniforms.
        const mesh = meshAt(PLANET_X, 0, 200_000);
        const camera = cameraAt(PLANET_X - NEAR_DISTANCE, true);
        const read = writeUniforms(["world", "worldView", "worldViewProjection"], mesh, camera);

        const world = read("world");
        expect(world[12]).toBeCloseTo(NEAR_DISTANCE, 0);
        expect(world[14]).toBeCloseTo(200_000, 0);

        // worldView = view * world, and view has no translation under FO, so
        // the composed translation must equal view's rotation applied to the
        // rebased world translation — not to the absolute one.
        const view = getViewMatrix(camera) as unknown as Float32Array;
        const wv = read("worldView");
        const expectedX = view[0]! * world[12]! + view[4]! * world[13]! + view[8]! * world[14]!;
        expect(wv[12]).toBeCloseTo(expectedX, 0);
        expect(Math.hypot(wv[12]!, wv[13]!, wv[14]!)).toBeLessThan(PLANET_X / 2);

        // And the same for the projected form.
        const vp = getViewProjectionMatrix(camera, 16 / 9) as unknown as Float32Array;
        const wvp = read("worldViewProjection");
        const expectedW = vp[3]! * world[12]! + vp[7]! * world[13]! + vp[11]! * world[14]! + vp[15]!;
        expect(wvp[15]).toBeCloseTo(expectedW, 0);
    });

    it("puts the eye at the origin, where the rebased geometry expects it", () => {
        // `_packSceneUniforms` already zeroes `vEyePosition` under FO. A
        // ShaderMaterial reporting the ABSOLUTE camera position alongside
        // camera-relative geometry would put lighting and view vectors in a
        // different frame from the surface they shade.
        const mesh = meshAt(PLANET_X, 0, 0);
        const read = writeUniforms(["cameraPosition"], mesh, cameraAt(PLANET_X - FAR_DISTANCE, true));
        expect([...read("cameraPosition").subarray(0, 3)]).toEqual([0, 0, 0]);

        const plain = writeUniforms(["cameraPosition"], mesh, cameraAt(PLANET_X - FAR_DISTANCE, false));
        expect(plain("cameraPosition")[0]).toBeCloseTo(PLANET_X - FAR_DISTANCE, 0);
    });

    it("recovers sub-metre offsets that an F32 world matrix would swallow", () => {
        // Why the subtraction happens here and not in the shader: at 4.6e6 the
        // F32 ULP is ~0.5 m, so a metre-scale detail is already gone by the
        // time an absolute world matrix reaches the GPU. Subtracting in F64
        // first leaves a small number that F32 holds exactly.
        const DELTA = 0.25;
        const mesh = meshAt(PLANET_X + DELTA, 0, 0);
        const camera = cameraAt(PLANET_X, true);
        const world = _shaderWorldMatrix(mesh, camera);

        expect(world[12]).toBe(DELTA);
        // Non-vacuity: the same value stored absolutely into F32 loses it.
        const absolute = new Float32Array(1);
        absolute[0] = PLANET_X + DELTA;
        expect(absolute[0] - PLANET_X).not.toBe(DELTA);
    });

    describe("out-param", () => {
        // `_shaderWorldMatrix` is exported and exercised directly (above), so its
        // no-`out` return value aliases module-scratch state that the NEXT call
        // overwrites. The optional `out` param lets a caller — this test file
        // included, see the parity block below — hold two results at once.

        it("writes into the caller's buffer under floating origin, leaving the module scratch untouched", () => {
            const mesh = meshAt(PLANET_X, 0, 0);
            const camera = cameraAt(PLANET_X - FAR_DISTANCE, true);
            const out = new Float32Array(16);

            const returned = _shaderWorldMatrix(mesh, camera, out);

            expect(returned).toBe(out);
            expect(out[12]).toBeCloseTo(FAR_DISTANCE, 0);
            expect(out[13]).toBe(0);
            expect(out[14]).toBe(0);
        });

        it("does not alias a previous no-out call's result", () => {
            // The footgun the out-param removes: two back-to-back no-out calls
            // under FO both return the SAME shared buffer, so the first result is
            // silently overwritten by the second. Passing distinct `out` buffers
            // keeps both results alive and independent.
            const meshA = meshAt(PLANET_X, 0, 0);
            const meshB = meshAt(PLANET_X, 0, 500_000);
            const camera = cameraAt(PLANET_X - FAR_DISTANCE, true);
            const outA = new Float32Array(16);
            const outB = new Float32Array(16);

            _shaderWorldMatrix(meshA, camera, outA);
            _shaderWorldMatrix(meshB, camera, outB);

            expect(outA[14]).toBe(0);
            expect(outB[14]).toBeCloseTo(500_000, 0);
            expect(outA[14]).not.toBe(outB[14]);
        });

        it("also writes into the caller's buffer when floating origin is off", () => {
            // `out`, when given, always means "the answer is here" — it must not
            // silently fall back to returning `mesh.worldMatrix` by reference just
            // because there was nothing to rebase.
            const mesh = meshAt(PLANET_X, 0, 0);
            const camera = cameraAt(PLANET_X - FAR_DISTANCE, false);
            const out = new Float32Array(16);

            const returned = _shaderWorldMatrix(mesh, camera, out);

            expect(returned).toBe(out);
            expect(returned).not.toBe(mesh.worldMatrix);
            expect(out[12]).toBe(PLANET_X);
        });

        it("stays copy-free when out is omitted — no-out call returns mesh.worldMatrix by reference when FO is off", () => {
            const mesh = meshAt(PLANET_X, 0, 0);
            const camera = cameraAt(PLANET_X - FAR_DISTANCE, false);

            expect(_shaderWorldMatrix(mesh, camera)).toBe(mesh.worldMatrix);
        });
    });

    describe("parity with the mesh-world UBO packer (packMat4IntoF32WithOffset)", () => {
        // The bug this whole file exists for was exactly this divergence: the
        // mesh-world packer (`standard`/`pbr`/`node` renderables, via
        // `makePackMeshWorld`) rebased onto the camera, and the ShaderMaterial
        // writers did not. Every test above proves ShaderMaterial is
        // self-consistent; none of them prove it AGREES with the other packer for
        // the same mesh. This does.
        //
        // Format check before asserting equality: both take a 16-float column-major
        // mat4 (mesh.worldMatrix, F64- or F32-backed), subtract the camera's world
        // translation from columns [12..14] in JS-number (F64) precision, and store
        // the result as F32 — `packMat4IntoF32WithOffset`'s `mat`/`offsetX..Z`
        // contract is byte-for-byte the same operation `_shaderWorldMatrix` performs
        // inline. There is no legitimate layout or precision difference between the
        // two paths for a single, non-slab matrix, so the assertion below is
        // byte-identical equality, not a tolerance-based approximation.
        it("produces the byte-identical world matrix the mesh-world packer would produce for the same mesh and camera", () => {
            const mesh = meshAt(PLANET_X, 0, 321_000);
            const camera = cameraAt(PLANET_X - NEAR_DISTANCE, true);

            const shaderWorld = _shaderWorldMatrix(mesh, camera, new Float32Array(16));

            const cw = camera.worldMatrix;
            const packedWorld = new Float32Array(16);
            packMat4IntoF32WithOffset(packedWorld, mesh.worldMatrix, 0, 0, cw[12]!, cw[13]!, cw[14]!);

            expect([...shaderWorld]).toEqual([...packedWorld]);
        });

        it("FAILS this same comparison against the pre-fix behaviour (mesh.worldMatrix read raw)", () => {
            // Documents what the parity assertion above actually guards: the
            // pre-fix ShaderMaterial writers read `mesh.worldMatrix` raw, with no
            // rebasing at all. That raw matrix must NOT match the mesh-world
            // packer's camera-relative output — if it did, this whole bug would
            // never have been visible. This is the regression the maintainer asked
            // to be locked: re-introducing the bug (deleting the subtraction in
            // `_shaderWorldMatrix`) must fail the assertion above, and this test
            // is the non-vacuity check proving the comparison has teeth.
            const mesh = meshAt(PLANET_X, 0, 321_000);
            const camera = cameraAt(PLANET_X - NEAR_DISTANCE, true);

            const preFixWorld = mesh.worldMatrix as unknown as Float32Array;

            const cw = camera.worldMatrix;
            const packedWorld = new Float32Array(16);
            packMat4IntoF32WithOffset(packedWorld, mesh.worldMatrix, 0, 0, cw[12]!, cw[13]!, cw[14]!);

            expect([...preFixWorld]).not.toEqual([...packedWorld]);
        });
    });

    // The cached writer (`enableShaderMaterialUniformCaching`) is a second
    // implementation of this same contract and had the identical defect. It is
    // covered in `shader-material-uniform-caching.test.ts`, which already owns
    // the module-mock scaffolding needed to capture the installed writer.
});
