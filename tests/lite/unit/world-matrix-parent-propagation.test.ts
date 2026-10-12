import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { createSceneNode, createSceneNodeFromMatrix } from "../../../packages/babylon-lite/src/scene/scene-node";
import { createFreeCamera } from "../../../packages/babylon-lite/src/camera/free-camera";
import {
    _markLocalMatrixDirty,
    _markWorldMatrixDirty,
    attachWorldMatrixState,
    composeTrsLocalMatrix,
    createWorldMatrixState,
} from "../../../packages/babylon-lite/src/scene/world-matrix-state";
import { setParent } from "../../../packages/babylon-lite/src/scene/set-parent";
import * as allocator from "../../../packages/babylon-lite/src/math/_matrix-allocator";
import * as composition from "../../../packages/babylon-lite/src/math/compose-mat4-into-buffer";
import { allocateF64Mat4 } from "../../../packages/babylon-lite/src/math/_mat4-storage-f64";
import { composeMat4 } from "../../../packages/babylon-lite/src/math/compose-mat4";
import { multiplyMat4 } from "../../../packages/babylon-lite/src/math/multiply-mat4";
import type { IWorldMatrixProvider } from "../../../packages/babylon-lite/src/scene/parentable";

describe("world matrix parent propagation", () => {
    it("bumps a child's worldMatrixVersion when an ancestor's transform changes", () => {
        const parent = createSceneNode("parent");
        const child = createSceneNode("child");
        child.parent = parent;

        // Establish baseline versions (simulates a per-frame consumer that
        // gates UBO uploads on worldMatrixVersion and only reads worldMatrix
        // when the version changed).
        const v0 = child.worldMatrixVersion;

        // Animate ONLY the parent — nothing reads the child's worldMatrix.
        parent.rotation.y = Math.PI / 2;

        const v1 = child.worldMatrixVersion;
        expect(v1).not.toBe(v0);

        // Stable once nothing changes again.
        expect(child.worldMatrixVersion).toBe(v1);
    });

    describe.each(["F32", "F64"])("local/world matrix separation (%s)", (precision) => {
        beforeEach(() => {
            allocator._resetMatrixAllocatorForTests();
            if (precision === "F64") {
                allocator._setHpmAllocator(allocateF64Mat4);
            }
        });

        afterEach(() => {
            vi.restoreAllMocks();
            allocator._resetMatrixAllocatorForTests();
        });

        describe("compatibility", () => {
            it("preserves the identity fast path when returning from nonidentity TRS, including signed zero", () => {
                const node = createSceneNode("identity", -0);
                const assertLocal = () => {
                    expect(Array.from(node.worldMatrix)).toEqual(Array.from(composeTrsLocalMatrix(node.position, node.rotationQuaternion, node.scaling)));
                };
                assertLocal();
                node.position.set(1, 2, 3);
                node.rotationQuaternion.set(0, Math.SQRT1_2, 0, Math.SQRT1_2);
                node.scaling.set(-2, 3, 4);
                assertLocal();
                node.position.set(-0, -0, -0);
                node.rotationQuaternion.set(-0, -0, -0, 1);
                node.scaling.set(1, 1, 1);
                assertLocal();
            });

            it("matches fresh composition for local TRS edits and ancestor-only movement", () => {
                const parent = createSceneNode("parent", 4_637_862, 2, 3);
                const child = createSceneNode("child", 0.01, 5, 7);
                child.parent = parent;
                const assertWorld = () => {
                    const expected = multiplyMat4(
                        composeTrsLocalMatrix(parent.position, parent.rotationQuaternion, parent.scaling),
                        composeTrsLocalMatrix(child.position, child.rotationQuaternion, child.scaling)
                    );
                    expect(Array.from(child.worldMatrix)).toEqual(Array.from(expected));
                    expect(child.worldMatrix).toBeInstanceOf(precision === "F64" ? Float64Array : Float32Array);
                    expect(parent.worldMatrix).toBeInstanceOf(precision === "F64" ? Float64Array : Float32Array);
                };
                assertWorld();
                const before = child.worldMatrix[12]!;
                parent.position.x += 0.01;
                assertWorld();
                if (precision === "F64") {
                    expect(child.worldMatrix[12]! - before).toBeCloseTo(0.01, 6);
                } else {
                    expect(child.worldMatrix[12]).toBe(before);
                }
                child.position.set(2, -3, 5);
                assertWorld();
                child.rotationQuaternion.set(0, Math.SQRT1_2, 0, Math.SQRT1_2);
                assertWorld();
                child.scaling.set(-2, 0.5, 3);
                assertWorld();
                parent.rotation.z = 0.7;
                assertWorld();
            });

            it("propagates every ancestor write through unread intermediates", () => {
                const root = createSceneNode("root", 1);
                const mid = createSceneNode("mid", 2);
                const leaf = createSceneNode("leaf", 3);
                mid.parent = root;
                leaf.parent = mid;
                let version = leaf.worldMatrixVersion;
                for (let i = 1; i <= 5; i++) {
                    root.position.x = i + 10;
                    expect(leaf.worldMatrixVersion).toBeGreaterThan(version);
                    version = leaf.worldMatrixVersion;
                }
                expect(leaf.worldMatrix[12]).toBe(20);
                root.position.x = 20;
                expect(leaf.worldMatrix[12]).toBe(25);
            });

            it("polls a direct foreign parent on matrix and version reads", () => {
                const foreign = { worldMatrix: composeMat4(10, 0, 0, 0, 0, 0, 1, 1, 1, 1), worldMatrixVersion: 0 };
                const child = createSceneNode("child", 2);
                const leaf = createSceneNode("leaf", 3);
                child.parent = foreign;
                leaf.parent = child;
                expect(child.worldMatrix[12]).toBe(12);
                expect(leaf.worldMatrix[12]).toBe(15);
                const childVersion = child.worldMatrixVersion;
                const leafVersion = leaf.worldMatrixVersion;
                foreign.worldMatrix = composeMat4(20, 0, 0, 0, 0, 0, 1, 1, 1, 1);
                foreign.worldMatrixVersion++;
                expect(child.worldMatrixVersion).toBeGreaterThan(childVersion);
                expect(leaf.worldMatrixVersion).toBeGreaterThan(leafVersion);
                expect(leaf.worldMatrix[12]).toBe(25);
                const stableVersion = child.worldMatrixVersion;
                expect(child.worldMatrixVersion).toBe(stableVersion);
                foreign.worldMatrix = composeMat4(30, 0, 0, 0, 0, 0, 1, 1, 1, 1);
                foreign.worldMatrixVersion++;
                expect(child.worldMatrix[12]).toBe(32);
                expect(leaf.worldMatrix[12]).toBe(35);
                child.parent = null;
                const detachedVersion = child.worldMatrixVersion;
                foreign.worldMatrixVersion++;
                expect(child.worldMatrixVersion).toBe(detachedVersion);
                expect(leaf.worldMatrix[12]).toBe(5);
            });

            it("recomposes explicit local invalidation without a TRS write", () => {
                let x = 1;
                const state = createWorldMatrixState(() => composeMat4(x, 0, 0, 0, 0, 0, 1, 1, 1, 1));
                const host: IWorldMatrixProvider = {
                    get worldMatrix() {
                        return state.getWorldMatrix();
                    },
                    get worldMatrixVersion() {
                        return state.getWorldMatrixVersion();
                    },
                };
                attachWorldMatrixState(host, state);
                const child = createSceneNode("child", 2);
                child.parent = host;
                expect(child.worldMatrix[12]).toBe(3);
                const version = child.worldMatrixVersion;
                x = 10;
                _markLocalMatrixDirty(host);
                expect(child.worldMatrixVersion).toBeGreaterThan(version);
                expect(child.worldMatrix[12]).toBe(12);
            });

            it("preserves raw matrices, locked writes and the setParent hand-off", () => {
                const raw = composeMat4(7, 8, 9, 0, 0, 0, 1, -1, 2, 3);
                const snapshot = Array.from(raw);
                const node = createSceneNodeFromMatrix("raw", raw);
                expect(node.worldMatrix).toBe(raw);
                const version = node.worldMatrixVersion;
                node.position.x = 99;
                expect(node.worldMatrixVersion).toBe(version);
                expect(Array.from(node.worldMatrix)).toEqual(snapshot);
                const parent = createSceneNode("parent", 10);
                node.parent = parent;
                expect(node.worldMatrix[12]).toBe(17);
                parent.position.x = 20;
                expect(node.worldMatrix[12]).toBe(27);
                expect(Array.from(raw)).toEqual(snapshot);
                const world = Array.from(node.worldMatrix);
                setParent(node, null);
                expect(Array.from(node.worldMatrix)).toEqual(world);
                node.position.x = 30;
                expect(node.worldMatrix[12]).toBe(30);
                expect(Array.from(raw)).toEqual(snapshot);
            });

            it("keeps allocating math factories fresh for identity and nonidentity transforms", () => {
                const position = { x: 0, y: 0, z: 0 };
                const rotation = { x: 0, y: 0, z: 0, w: 1 };
                const scale = { x: 1, y: 1, z: 1 };
                for (const x of [0, 2]) {
                    position.x = x;
                    const a = composeTrsLocalMatrix(position, rotation, scale);
                    const b = composeTrsLocalMatrix(position, rotation, scale);
                    const c = composeMat4(x, 0, 0, 0, 0, 0, 1, 1, 1, 1);
                    const d = composeMat4(x, 0, 0, 0, 0, 0, 1, 1, 1, 1);
                    expect(a).not.toBe(b);
                    expect(c).not.toBe(d);
                    expect(Array.from(a)).toEqual(Array.from(b));
                    expect(Array.from(c)).toEqual(Array.from(d));
                    expect(a).toBeInstanceOf(precision === "F64" ? Float64Array : Float32Array);
                }
            });
        });

        describe("optimization assertions", () => {
            it("retains local transforms during world-only host invalidation", () => {
                const local = vi.fn(() => composeMat4(3, 0, 0, 0, 0, 0, 1, 1, 1, 1));
                const state = createWorldMatrixState(local);
                const host: IWorldMatrixProvider = {
                    get worldMatrix() {
                        return state.getWorldMatrix();
                    },
                    get worldMatrixVersion() {
                        return state.getWorldMatrixVersion();
                    },
                };
                attachWorldMatrixState(host, state);
                const child = createSceneNode("child", 2);
                child.parent = host;
                expect(child.worldMatrix[12]).toBe(5);
                for (let i = 0; i < 2; i++) {
                    const version = child.worldMatrixVersion;
                    _markWorldMatrixDirty(host);
                    expect(child.worldMatrixVersion).toBeGreaterThan(version);
                }
                expect(child.worldMatrix[12]).toBe(5);
                expect(local).toHaveBeenCalledTimes(1);
            });

            it("calls a local factory only on local changes, not parent movement or reparenting", () => {
                const local = vi.fn(() => composeMat4(3, 0, 0, 0, 0, 0, 1, 1, 1, 1));
                const state = createWorldMatrixState(local);
                const parent = createSceneNode("parent", 10);
                state.parent = parent;
                expect(state.getWorldMatrix()[12]).toBe(13);
                parent.position.x = 20;
                expect(state.getWorldMatrix()[12]).toBe(23);
                state.parent = createSceneNode("other", 30);
                expect(state.getWorldMatrix()[12]).toBe(33);
                state.parent = null;
                expect(state.getWorldMatrix()[12]).toBe(3);
                expect(local).toHaveBeenCalledTimes(1);
                state.markLocalDirty();
                state.getWorldMatrix();
                expect(local).toHaveBeenCalledTimes(2);
            });

            it("reuses local storage on every root edit without allocating matrices", () => {
                const node = createSceneNode("node", 1);
                const matrix = node.worldMatrix;
                const allocations = vi.spyOn(allocator, "allocateMat4");
                for (let i = 2; i <= 5; i++) {
                    node.position.x = i;
                    expect(node.worldMatrix[12]).toBe(i);
                    expect(node.worldMatrix).toBe(matrix);
                }
                expect(allocations).not.toHaveBeenCalled();
            });

            it("composes only the moving node and allocates nothing in a warmed hierarchy", () => {
                const root = createSceneNode("root", 1);
                const mid = createSceneNode("mid", 2);
                const leaf = createSceneNode("leaf", 3);
                mid.parent = root;
                leaf.parent = mid;
                expect(leaf.worldMatrix[12]).toBe(6);
                const allocations = vi.spyOn(allocator, "allocateMat4");
                const compositions = vi.spyOn(composition, "composeMat4IntoBuffer");
                for (let i = 1; i <= 5; i++) {
                    root.position.x = i + 10;
                    expect(leaf.worldMatrix[12]).toBe(i + 15);
                }
                expect.soft(compositions).toHaveBeenCalledTimes(5);
                expect.soft(allocations).not.toHaveBeenCalled();
                compositions.mockClear();
                leaf.position.x = 4;
                expect(leaf.worldMatrix[12]).toBe(21);
                expect(compositions).toHaveBeenCalledTimes(1);
                expect(allocations).not.toHaveBeenCalled();
            });

            it("reuses the local composition when polling a moving foreign parent", () => {
                const foreign = { worldMatrix: composeMat4(10, 0, 0, 0, 0, 0, 1, 1, 1, 1), worldMatrixVersion: 0 };
                const local = vi.fn(() => composeMat4(3, 0, 0, 0, 0, 0, 1, 1, 1, 1));
                const state = createWorldMatrixState(local);
                state.parent = foreign;
                expect(state.getWorldMatrix()[12]).toBe(13);
                foreign.worldMatrix = composeMat4(20, 0, 0, 0, 0, 0, 1, 1, 1, 1);
                foreign.worldMatrixVersion++;
                expect(state.getWorldMatrix()[12]).toBe(23);
                expect(local).toHaveBeenCalledTimes(1);
            });
        });
    });

    it("propagates an ancestor change through a multi-level hierarchy", () => {
        const root = createSceneNode("root");
        const mid = createSceneNode("mid");
        const leaf = createSceneNode("leaf");
        mid.parent = root;
        leaf.parent = mid;

        const v0 = leaf.worldMatrixVersion;

        root.position.set(5, 0, 0);

        const v1 = leaf.worldMatrixVersion;
        expect(v1).not.toBe(v0);

        // The leaf's world matrix reflects the ancestor translation.
        expect(leaf.worldMatrix[12]).toBeCloseTo(5);
    });

    it("does not bump the version on repeated reads when nothing changes", () => {
        const parent = createSceneNode("parent");
        const child = createSceneNode("child");
        child.parent = parent;

        const v0 = child.worldMatrixVersion;
        expect(child.worldMatrixVersion).toBe(v0);
        expect(child.worldMatrixVersion).toBe(v0);
    });

    it("propagates an ancestor change through a static intermediate node", () => {
        // root → mid (never animated) → leaf (never animated). Animating only the
        // root must still surface on the leaf's version even though the
        // intermediate node's own local transform never changed.
        const root = createSceneNode("root");
        const mid = createSceneNode("mid");
        const leaf = createSceneNode("leaf");
        mid.parent = root;
        leaf.parent = mid;

        const midV0 = mid.worldMatrixVersion;
        const leafV0 = leaf.worldMatrixVersion;

        root.rotation.y = 1.0;

        expect(mid.worldMatrixVersion).not.toBe(midV0);
        expect(leaf.worldMatrixVersion).not.toBe(leafV0);
    });

    it("bumps the leaf version on EVERY ancestor move (no stale skips)", () => {
        // A consumer that only reads versions (never worldMatrix) must observe a
        // fresh version on each successive ancestor move, frame after frame.
        const root = createSceneNode("root");
        const leaf = createSceneNode("leaf");
        leaf.parent = root;

        let prev = leaf.worldMatrixVersion;
        for (let i = 1; i <= 5; i++) {
            root.position.set(i, 0, 0);
            const next = leaf.worldMatrixVersion;
            expect(next).not.toBe(prev);
            prev = next;
        }
    });

    it("reparenting bumps the version and reflects the new parent transform", () => {
        const a = createSceneNode("a");
        const b = createSceneNode("b");
        const child = createSceneNode("child");
        a.position.set(10, 0, 0);
        b.position.set(0, 20, 0);

        child.parent = a;
        expect(child.worldMatrix[12]).toBeCloseTo(10);
        const vA = child.worldMatrixVersion;

        child.parent = b;
        expect(child.worldMatrixVersion).not.toBe(vA);
        expect(child.worldMatrix[12]).toBeCloseTo(0);
        expect(child.worldMatrix[13]).toBeCloseTo(20);

        // After detaching, a former parent's motion no longer affects the child.
        child.parent = null;
        const vDetached = child.worldMatrixVersion;
        b.position.set(0, 99, 0);
        expect(child.worldMatrixVersion).toBe(vDetached);
    });

    it("propagates a camera-parented chain to a leaf with no per-frame reader", () => {
        // camera → mid (pure transform, never read) → leaf. Moving the camera must
        // surface on the leaf even though nothing reads the intermediate node.
        const camera = createFreeCamera({ x: 0, y: 0, z: -10 } as never, { x: 0, y: 0, z: 0 } as never);
        const mid = createSceneNode("mid");
        const leaf = createSceneNode("leaf");
        mid.parent = camera;
        leaf.parent = mid;

        const leafV0 = leaf.worldMatrixVersion;
        camera.position.set(5, 0, -10);
        expect(leaf.worldMatrixVersion).not.toBe(leafV0);
    });
});
