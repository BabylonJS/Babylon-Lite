import { describe, it, expect, vi } from "vitest";

// Stub only the GPU-touching bits (mesh creation + scene attach/dispose). The ray
// cast, the pure visual math, and the hover/select edge detection run for real.
function fakeMesh() {
    const vec = (x: number, y: number, z: number, w?: number) => ({
        x,
        y,
        z,
        w,
        set(nx: number, ny: number, nz: number, nw?: number) {
            this.x = nx;
            this.y = ny;
            this.z = nz;
            if (nw !== undefined) this.w = nw;
        },
    });
    return {
        name: "",
        material: null as unknown,
        pickable: undefined as boolean | undefined,
        receiveShadows: false,
        visible: false,
        position: vec(0, 0, 0),
        scaling: vec(1, 1, 1),
        rotationQuaternion: vec(0, 0, 0, 1),
    };
}

vi.mock("../../../../packages/babylon-lite/src/mesh/mesh-factories", () => ({
    createBox: vi.fn(() => fakeMesh()),
    createSphere: vi.fn(() => fakeMesh()),
    createTorus: vi.fn(() => fakeMesh()),
}));
vi.mock("../../../../packages/babylon-lite/src/scene/scene-core", () => ({ addToScene: vi.fn() }));
vi.mock("../../../../packages/babylon-lite/src/scene/scene-remove", () => ({ removeFromScene: vi.fn() }));
const { disposeMeshGpu } = vi.hoisted(() => ({ disposeMeshGpu: vi.fn() }));
vi.mock("../../../../packages/babylon-lite/src/mesh/mesh-dispose", () => ({ disposeMeshGpu }));

import { createXrPointer, updateXrPointer, disposeXrPointer, computePointerVisual, pointerSelection } from "../../../../packages/babylon-lite/src/xr/xr-pointer";
import type { XrPointer } from "../../../../packages/babylon-lite/src/xr/xr-pointer";
import type { XrSessionContext } from "../../../../packages/babylon-lite/src/xr/xr-session";
import type { Mesh } from "../../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine";
import type { XrInputManager, XrInputSource } from "../../../../packages/babylon-lite/src/xr/xr-input";
import { mat4Compose } from "../../../../packages/babylon-lite/src/math/mat4-compose";

const UNIT_CUBE = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]);

function targetBox(z: number): Mesh {
    return { name: "target", pickable: undefined, _cpuPositions: UNIT_CUBE, worldMatrix: mat4Compose(0, 0, z, 0, 0, 0, 1, 1, 1, 1) } as unknown as Mesh;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function makeSource(matrix: Float32Array, tracked = true): XrInputSource {
    return {
        source: {} as XRInputSource,
        handedness: "right",
        targetRayMode: "tracked-pointer",
        targetRayMatrix: matrix,
        targetRayTracked: tracked,
        gripMatrix: IDENTITY,
        gripTracked: false,
        selecting: false,
        squeezing: false,
        gamepad: null,
    } as unknown as XrInputSource;
}

function makeInput(sources: XrInputSource[]): XrInputManager {
    return { inputSources: sources } as unknown as XrInputManager;
}

function unitOf(pointer: XrPointer, src: XrInputSource) {
    return (pointer as unknown as { _units: Map<unknown, { laser: ReturnType<typeof fakeMesh>; cursor: ReturnType<typeof fakeMesh> }> })._units.get(
        (src as unknown as { source: unknown }).source
    )!;
}

describe("computePointerVisual", () => {
    it("stretches the beam to the hit and places the cursor there", () => {
        const v = computePointerVisual([0, 0, 0], [0, 0, -1], 4, 10);
        expect(v.hit).toBe(true);
        expect(v.beamLength).toBeCloseTo(4, 5);
        expect(v.laserPosition[2]).toBeCloseTo(-2, 5); // centre of the beam
        expect(v.cursorPosition[2]).toBeCloseTo(-4, 5);
    });

    it("uses the full length and reports a miss when there is no hit", () => {
        const v = computePointerVisual([0, 0, 0], [0, 0, -1], -1, 10);
        expect(v.hit).toBe(false);
        expect(v.beamLength).toBeCloseTo(10, 5);
        expect(v.laserPosition[2]).toBeCloseTo(-5, 5);
    });
});

describe("updateXrPointer", () => {
    it("shows the laser + cursor and fires hover start when the ray hits a mesh", () => {
        const onHoverStart = vi.fn();
        const scene = { meshes: [targetBox(-5)] } as unknown as SceneContext; // in front along −Z, entry at 4
        const pointer = createXrPointer({} as EngineContext, scene, { onHoverStart });
        const src = makeSource(IDENTITY);

        updateXrPointer(pointer, makeInput([src]));

        expect(onHoverStart).toHaveBeenCalledTimes(1);
        const unit = unitOf(pointer, src);
        expect(unit.laser.visible).toBe(true);
        expect(unit.cursor.visible).toBe(true);
        expect(unit.laser.pickable).toBe(false); // must never pick itself
        expect(unit.cursor.pickable).toBe(false);
        // Ring sits at the hit (z=-4) nudged slightly off the surface toward the
        // controller (+Z) by 0.008*sqrt(distance) so it doesn't z-fight the face.
        expect(unit.cursor.position.z).toBeCloseTo(-4 + 0.008 * Math.sqrt(4), 5);
        expect(unit.laser.scaling.z).toBeCloseTo(4, 5);
    });

    it("hides the cursor and fires no hover when the ray misses", () => {
        const onHoverStart = vi.fn();
        const scene = { meshes: [targetBox(5)] } as unknown as SceneContext; // behind the −Z ray
        const pointer = createXrPointer({} as EngineContext, scene, { onHoverStart });
        const src = makeSource(IDENTITY);

        updateXrPointer(pointer, makeInput([src]));

        expect(onHoverStart).not.toHaveBeenCalled();
        const unit = unitOf(pointer, src);
        expect(unit.laser.visible).toBe(true);
        expect(unit.cursor.visible).toBe(false);
    });

    it("fires onSelect once on the trigger rising edge while hovering", () => {
        const onSelect = vi.fn();
        const scene = { meshes: [targetBox(-5)] } as unknown as SceneContext;
        const pointer = createXrPointer({} as EngineContext, scene, { onSelect });
        const src = makeSource(IDENTITY);

        updateXrPointer(pointer, makeInput([src])); // not selecting
        expect(onSelect).not.toHaveBeenCalled();

        (src as unknown as { selecting: boolean }).selecting = true;
        updateXrPointer(pointer, makeInput([src])); // rising edge
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect((onSelect.mock.calls[0]![0] as Mesh).name).toBe("target");

        updateXrPointer(pointer, makeInput([src])); // still held — no repeat
        expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("fires hover end when the ray leaves the mesh", () => {
        const onHoverEnd = vi.fn();
        const scene = { meshes: [targetBox(-5)] } as unknown as SceneContext;
        const pointer = createXrPointer({} as EngineContext, scene, { onHoverEnd });
        const src = makeSource(IDENTITY);

        updateXrPointer(pointer, makeInput([src])); // hovering
        (src as unknown as { targetRayTracked: boolean }).targetRayTracked = false;
        updateXrPointer(pointer, makeInput([src])); // lost tracking

        expect(onHoverEnd).toHaveBeenCalledTimes(1);
        const unit = unitOf(pointer, src);
        expect(unit.laser.visible).toBe(false);
    });

    it("disposes visuals for a source that disconnects", () => {
        disposeMeshGpu.mockClear();
        const scene = { meshes: [targetBox(-5)] } as unknown as SceneContext;
        const pointer = createXrPointer({} as EngineContext, scene);
        const src = makeSource(IDENTITY);

        updateXrPointer(pointer, makeInput([src]));
        expect((pointer as unknown as { _units: Map<unknown, unknown> })._units.size).toBe(1);

        updateXrPointer(pointer, makeInput([])); // source gone
        expect((pointer as unknown as { _units: Map<unknown, unknown> })._units.size).toBe(0);
        expect(disposeMeshGpu).toHaveBeenCalledTimes(2); // laser + cursor
    });

    it("disposeXrPointer tears down all remaining visuals", () => {
        disposeMeshGpu.mockClear();
        const scene = { meshes: [targetBox(-5)] } as unknown as SceneContext;
        const pointer = createXrPointer({} as EngineContext, scene);
        updateXrPointer(pointer, makeInput([makeSource(IDENTITY)]));
        disposeXrPointer(pointer);
        expect(disposeMeshGpu).toHaveBeenCalledTimes(2);
        expect((pointer as unknown as { _units: Map<unknown, unknown> })._units.size).toBe(0);
    });
});

describe("pointerSelection feature", () => {
    function makeCtx(input: XrInputManager | null): XrSessionContext {
        return {
            engine: {} as EngineContext,
            scene: { meshes: [targetBox(-5)] } as unknown as SceneContext,
            input,
        } as unknown as XrSessionContext;
    }

    it("throws when created without input tracking", () => {
        const spec = pointerSelection();
        expect(() => spec.create(makeCtx(null))).toThrow(/requires XR input/);
    });

    it("needs no native session feature", () => {
        expect(pointerSelection().sessionFeatures).toBeUndefined();
    });

    it("creates a pointer on create, casts rays on update, and tears down on dispose", () => {
        disposeMeshGpu.mockClear();
        const onSelect = vi.fn();
        const src = makeSource(IDENTITY);
        const handle = pointerSelection({ onSelect }).create(makeCtx(makeInput([src])));

        // update drives a real ray cast: the laser + cursor appear for the tracked source.
        handle.update!({} as XRFrame, 0);
        (src as unknown as { selecting: boolean }).selecting = true;
        handle.update!({} as XRFrame, 16);
        expect(onSelect).toHaveBeenCalledTimes(1);

        handle.dispose!();
        expect(disposeMeshGpu).toHaveBeenCalledTimes(2); // laser + cursor
    });
});
