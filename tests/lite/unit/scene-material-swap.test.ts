import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { processMaterialSwaps } from "../../../packages/babylon-lite/src/scene/scene-material-swap";

describe("scene material swap", () => {
    it("replaces every old renderable for the mesh before retiring its GPU resources", () => {
        const retirements: Array<() => void> = [];
        const disposeOld = vi.fn();
        const mesh = {} as Mesh;
        const oldMain = { mesh, order: 100 } as Renderable;
        const oldDuplicate = { mesh, order: 101 } as Renderable;
        const other = { mesh: {} as Mesh, order: 50 } as Renderable;
        const replacement = { mesh, order: 75 } as Renderable;
        const material = {
            _buildGroup: {
                _rebuildSingle: vi.fn(() => replacement),
            },
        } as unknown as Material;
        mesh.material = material;
        const engine = {
            _retirements: retirements,
        } as unknown as EngineContext;
        const scene = {
            surface: { engine },
            _materialSwapQueue: [mesh],
            _meshDisposables: new Map([[mesh, [disposeOld]]]),
            _renderables: [other, oldMain, oldDuplicate],
            _renderableVersion: 4,
            _materialEpoch: 2,
        } as unknown as SceneContext;

        processMaterialSwaps(scene);

        expect(scene._renderables).toEqual([other, replacement]);
        expect(scene._renderables.filter((renderable) => renderable.mesh === mesh)).toEqual([replacement]);
        expect(disposeOld).not.toHaveBeenCalled();
        expect(retirements).toHaveLength(1);
    });
});
