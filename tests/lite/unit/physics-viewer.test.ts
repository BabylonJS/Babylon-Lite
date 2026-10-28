import { describe, expect, it, vi } from "vitest";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { PhysicsBody, PhysicsConstraint } from "../../../packages/babylon-lite/src/physics/havok";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import { onSceneChange } from "../../../packages/babylon-lite/src/scene/scene-change";
import { createHavokWorld, disposePhysics, releasePhysicsConstraint, PhysicsConstraintType } from "../../../packages/babylon-lite/src/physics/havok";
import {
    createPhysicsViewer,
    disposePhysicsViewer,
    getPhysicsConstraintDebug,
    hidePhysicsConstraint,
    showPhysicsConstraint,
} from "../../../packages/babylon-lite/src/physics/physics-viewer";

function setup() {
    const hknp = {
        HP_World_Create: vi.fn(() => [0, {}]),
        HP_World_SetGravity: vi.fn(),
        HP_World_Release: vi.fn(),
        HP_Constraint_SetEnabled: vi.fn(),
        HP_Constraint_Release: vi.fn(),
    };
    const scene = {
        surface: {
            engine: {
                _retirements: null,
                _device: {
                    createBuffer: ({ size }: { size: number }) => ({
                        getMappedRange: () => new ArrayBuffer(size),
                        unmap: vi.fn(),
                        destroy: vi.fn(),
                    }),
                    queue: { writeBuffer: vi.fn() },
                },
            },
        },
        meshes: [],
        lights: [],
        shadowGenerators: [],
        _beforeRender: [],
        _disposables: [],
        _renderables: [],
        _materialSwapQueue: [],
        _groups: new Map(),
        _meshDisposables: new Map(),
        _deferredBuilders: [],
        _renderableVersion: 0,
        _frameGraph: { _tasks: [] },
    } as unknown as SceneContext;
    const world = createHavokWorld(scene, hknp);
    const viewer = createPhysicsViewer(scene, world);
    const body = { node: createTransformNode("body"), _world: world } as unknown as PhysicsBody;
    function constraint(bodyA: PhysicsBody = body, options: PhysicsConstraint["options"] = {}): PhysicsConstraint {
        const c: PhysicsConstraint = {
            _hkConstraint: {},
            _isDisposed: false,
            bodyA,
            bodyB: body,
            type: PhysicsConstraintType.BALL_AND_SOCKET,
            options,
        };
        (world._constraints ??= []).push(c);
        return c;
    }
    return { hknp, scene, world, viewer, constraint };
}

describe("physics constraint viewer", () => {
    function anchorA(viewer: ReturnType<typeof setup>["viewer"]): number[] {
        // First line is constraintAxisAX; its first endpoint is the pivotA anchor.
        return Array.from(viewer._constraintLines[0]!.positions.subarray(0, 3));
    }

    it("places anchors in the unscaled rigid frame of a scaled body without native calls", () => {
        const { viewer, world, hknp, constraint } = setup();
        const scaled = { node: createTransformNode("scaled", 5, 0, 0, 0, 0, 0, 1, 2, 0.03, 1), _world: world } as unknown as PhysicsBody;
        const calls = Object.values(hknp).reduce((n, fn) => n + fn.mock.calls.length, 0);
        showPhysicsConstraint(viewer, getPhysicsConstraintDebug(constraint(scaled, { pivotA: { x: 1, y: 0, z: 0 } })));
        const [x, y, z] = anchorA(viewer);
        expect(x).toBeCloseTo(6);
        expect(y).toBeCloseTo(0);
        expect(z).toBeCloseTo(0);
        expect(Object.values(hknp).reduce((n, fn) => n + fn.mock.calls.length, 0)).toBe(calls);
    });

    it("places thin-body anchors at instance 0's rigid pose", () => {
        const { viewer, world, constraint } = setup();
        // Instance 0: 90° about Z, uniform scale 3, translated (0, 2, 0); carrier translated (10, 0, 0).
        const matrices = new Float32Array(32);
        matrices.set([0, 3, 0, 0, -3, 0, 0, 0, 0, 0, 3, 0, 0, 2, 0, 1]);
        const carrier = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1]);
        const thinWorld = { ...world, _thin: { count: () => 2 } };
        const thin = { node: { worldMatrix: carrier, thinInstances: { matrices, count: 2 } }, _world: thinWorld } as unknown as PhysicsBody;
        showPhysicsConstraint(viewer, getPhysicsConstraintDebug(constraint(thin, { pivotA: { x: 1, y: 0, z: 0 } })));
        const [x, y, z] = anchorA(viewer);
        expect(x).toBeCloseTo(10);
        expect(y).toBeCloseTo(3);
        expect(z).toBeCloseTo(0);
    });

    it("hides exactly one group including arrowheads, preserves other groups, and rejects duplicate shows", () => {
        const { viewer, scene, constraint } = setup();
        const a = getPhysicsConstraintDebug(constraint());
        const b = getPhysicsConstraintDebug(constraint());
        const shown = showPhysicsConstraint(viewer, a);
        expect(shown.length).toBeGreaterThan(0);
        const groupA = [...viewer._constraintMeshes];
        const count = scene.meshes.length;
        expect(showPhysicsConstraint(viewer, a)).toEqual([]);
        expect(scene.meshes).toHaveLength(count);
        showPhysicsConstraint(viewer, b);
        const groupB = [...viewer._constraintGroups[1]!];
        const linesB = viewer._constraintLines.filter((entry) => groupB.includes(entry.mesh));
        const disksB = viewer._constraintDisks.filter((entry) => groupB.includes(entry.mesh));
        const arrowsB = viewer._constraintArrowheads.filter((entry) => groupB.includes(entry.mesh));
        expect(linesB.length).toBeGreaterThan(0);
        expect(disksB.length).toBeGreaterThan(0);
        expect(arrowsB.length).toBeGreaterThan(0);
        expect(hidePhysicsConstraint(viewer, a)).toBe(true);
        expect(hidePhysicsConstraint(viewer, a)).toBe(false);
        expect(viewer._constraintMeshes).toEqual(groupB);
        expect(scene.meshes).toEqual(groupB);
        for (const mesh of groupA) {
            expect(scene.meshes).not.toContain(mesh);
        }
        expect(viewer._constraintLines).toEqual(linesB);
        expect(viewer._constraintDisks).toEqual(disksB);
        expect(viewer._constraintArrowheads).toEqual(arrowsB);
        expect(viewer._constraintKeys).toEqual([b]);
        expect(scene._beforeRender).toContain(viewer._update);
        expect(hidePhysicsConstraint(viewer, b)).toBe(true);
        expect(scene.meshes).toEqual([]);
        expect(viewer._constraintGroups).toEqual([]);
        expect(viewer._constraintKeys).toEqual([]);
        expect(viewer._constraintLines).toEqual([]);
        expect(viewer._constraintDisks).toEqual([]);
        expect(viewer._constraintArrowheads).toEqual([]);
        expect(scene._beforeRender).not.toContain(viewer._update);
    });

    it.each(["release", "dispose"] as const)("hides safely after native %s without further native calls", (action) => {
        const { viewer, world, hknp, constraint } = setup();
        const c = constraint();
        showPhysicsConstraint(viewer, getPhysicsConstraintDebug(c));
        if (action === "release") {
            releasePhysicsConstraint(world, c);
        } else {
            disposePhysics(world);
        }
        for (const spy of Object.values(hknp)) {
            spy.mockClear();
        }
        expect(hidePhysicsConstraint(viewer, getPhysicsConstraintDebug(c))).toBe(true);
        for (const spy of Object.values(hknp)) {
            expect(spy).not.toHaveBeenCalled();
        }
    });

    it("defers scene-change listeners until a shown constraint is fully registered", () => {
        const { viewer, scene, constraint } = setup();
        const a = getPhysicsConstraintDebug(constraint());
        const b = getPhysicsConstraintDebug(constraint());
        let reentered = false;
        const off = onSceneChange(scene, () => {
            if (reentered) {
                return;
            }
            reentered = true;
            expect(showPhysicsConstraint(viewer, a)).toEqual([]);
            showPhysicsConstraint(viewer, b);
        });
        const groupA = showPhysicsConstraint(viewer, a);
        off();
        expect(viewer._constraintKeys).toEqual([a, b]);
        const groupB = viewer._constraintGroups[1]!;
        expect(viewer._constraintGroups[0]!.some((mesh) => groupB.includes(mesh))).toBe(false);
        expect(groupA.every((mesh) => viewer._constraintGroups[0]!.includes(mesh))).toBe(true);
        expect(hidePhysicsConstraint(viewer, a)).toBe(true);
        expect(scene.meshes).toEqual(groupB);
        expect(viewer._constraintMeshes).toEqual(groupB);
    });

    it("keeps bookkeeping consistent when a listener re-enters hide", () => {
        const { viewer, scene, constraint } = setup();
        const a = getPhysicsConstraintDebug(constraint());
        const b = getPhysicsConstraintDebug(constraint());
        showPhysicsConstraint(viewer, a);
        showPhysicsConstraint(viewer, b);
        const groupB = [...viewer._constraintGroups[1]!];
        const reentrantResults: boolean[] = [];
        const off = onSceneChange(scene, (event) => {
            if (event.type === "removed") {
                reentrantResults.push(hidePhysicsConstraint(viewer, a));
            }
        });
        expect(hidePhysicsConstraint(viewer, a)).toBe(true);
        off();
        expect(reentrantResults.length).toBeGreaterThan(0);
        expect(reentrantResults.every((result) => !result)).toBe(true);
        expect(viewer._constraintKeys).toEqual([b]);
        expect(viewer._constraintGroups).toEqual([groupB]);
        expect(viewer._constraintMeshes).toEqual(groupB);
        expect(scene.meshes).toEqual(groupB);
    });

    it("clears every group and update entry on viewer disposal", () => {
        const { viewer, scene, constraint } = setup();
        showPhysicsConstraint(viewer, getPhysicsConstraintDebug(constraint()));
        showPhysicsConstraint(viewer, getPhysicsConstraintDebug(constraint()));
        disposePhysicsViewer(viewer);
        expect(scene.meshes).toEqual([]);
        expect(viewer._constraintMeshes).toEqual([]);
        expect(viewer._constraintKeys).toEqual([]);
        expect(viewer._constraintGroups).toEqual([]);
        expect(viewer._constraintLines).toEqual([]);
        expect(viewer._constraintDisks).toEqual([]);
        expect(viewer._constraintArrowheads).toEqual([]);
    });

    it("removes every mesh when a listener re-enters hide during viewer disposal", () => {
        const { viewer, scene, constraint } = setup();
        const a = getPhysicsConstraintDebug(constraint());
        const b = getPhysicsConstraintDebug(constraint());
        showPhysicsConstraint(viewer, a);
        showPhysicsConstraint(viewer, b);
        const reentrantResults: boolean[] = [];
        const off = onSceneChange(scene, (event) => {
            if (event.type === "removed") {
                reentrantResults.push(hidePhysicsConstraint(viewer, a), hidePhysicsConstraint(viewer, b));
            }
        });
        disposePhysicsViewer(viewer);
        off();
        expect(reentrantResults.length).toBeGreaterThan(0);
        expect(reentrantResults.every((result) => !result)).toBe(true);
        expect(scene.meshes).toEqual([]);
        expect(viewer._constraintMeshes).toEqual([]);
        expect(viewer._constraintKeys).toEqual([]);
        expect(viewer._constraintGroups).toEqual([]);
        expect(scene._beforeRender).not.toContain(viewer._update);
    });
});
