import { describe, expect, it } from "vitest";

import { MeshBuilder, NullEngine, Scene, TransformNode } from "../src/index";

/**
 * `node.parent = x` keeps the local transform and only relinks the node. Lite's own `setParent` (and the
 * loader and `cloneTransformNode`) also record the node in its parent's `children`, and `removeFromScene`
 * walks that list. These run on a real `NullEngine` scene so Lite's `setParent` and `removeFromScene` are
 * the real ones.
 */
function startedScene(): Scene {
    const engine = new NullEngine();
    (engine._lite as unknown as { _device: GPUDevice })._device = {
        createBuffer: ({ size }: GPUBufferDescriptor) => {
            const mapped = new ArrayBuffer(Number(size));
            return { getMappedRange: () => mapped, unmap: () => undefined, destroy: () => undefined } as unknown as GPUBuffer;
        },
    } as unknown as GPUDevice;
    const scene = new Scene(engine);
    (scene as unknown as { _flushPendingAdds(): void })._flushPendingAdds();
    return scene;
}

const liteChildren = (node: TransformNode): unknown[] => (node as unknown as { _node: { children: unknown[] } })._node.children;
const liteMeshes = (scene: Scene): unknown[] => (scene._lite as unknown as { meshes: unknown[] }).meshes;

describe("node.parent = … releases the previous Lite parent", () => {
    it("removes the node from the previous Lite parent's children and keeps its local transform", () => {
        const scene = startedScene();
        const first = new TransformNode("first", scene);
        const second = new TransformNode("second", scene);
        const box = MeshBuilder.CreateBox("box", {}, scene);
        box.setParent(first);
        box.position.set(1, 2, 3);

        box.parent = second;

        expect(liteChildren(first)).not.toContain(box._lite);
        expect(box._lite.parent).toBe((second as unknown as { _node: unknown })._node);
        expect([box._lite.position.x, box._lite.position.y, box._lite.position.z]).toEqual([1, 2, 3]);
    });

    it("keeps a reparented mesh in the scene when its previous parent is disposed", () => {
        const scene = startedScene();
        const first = new TransformNode("first", scene);
        const second = new TransformNode("second", scene);
        const box = MeshBuilder.CreateBox("box", {}, scene);
        box.setParent(first);
        box.parent = second;

        first.dispose();

        expect(box._lite.parent).toBe((second as unknown as { _node: unknown })._node);
        expect(liteMeshes(scene)).toContain(box._lite);
    });

    it("releases the previous Lite parent when the parent is cleared", () => {
        const scene = startedScene();
        const first = new TransformNode("first", scene);
        const box = MeshBuilder.CreateBox("box", {}, scene);
        box.setParent(first);

        box.parent = null;
        first.dispose();

        expect(box._lite.parent).toBeNull();
        expect(liteMeshes(scene)).toContain(box._lite);
    });
});
