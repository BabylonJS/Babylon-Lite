import { describe, expect, it, vi } from "vitest";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { PhysicsBody, PhysicsConstraint } from "../../../packages/babylon-lite/src/physics/havok";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
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
    const body = { node: createTransformNode("body") } as PhysicsBody;
    function constraint(): PhysicsConstraint {
        const c: PhysicsConstraint = {
            _hkConstraint: {},
            _isDisposed: false,
            bodyA: body,
            bodyB: body,
            type: PhysicsConstraintType.BALL_AND_SOCKET,
            options: {},
        };
        (world._constraints ??= []).push(c);
        return c;
    }
    return { hknp, scene, world, viewer, constraint };
}

describe("physics constraint viewer", () => {
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
        expect(scene._beforeRender).not.toContain(viewer._update);
    });
});
