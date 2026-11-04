import { describe, expect, it } from "vitest";

import {
    CreateDefaultMeshBlendRadiusDefinitions,
    FrameGraphMeshBlendingTask,
    MeshBlendingPostProcess,
    MeshBlendingRadiusClass,
    Mesh,
    NodeRenderGraphMeshBlendingPostProcessBlock,
    PackMeshBlendingTag,
    RegisterMeshBlendingPostProcessBlock,
    ThinMeshBlendingPostProcess,
    UnpackMeshBlendingTag,
} from "../src/index";
import { LiteCompatError } from "../src/error";

describe("mesh-blending compatibility surface", () => {
    it("forwards packed tag encoding and decoding to Lite", () => {
        expect(PackMeshBlendingTag(17, MeshBlendingRadiusClass.Large)).toBe(145);
        expect(UnpackMeshBlendingTag(145)).toEqual({ groupId: 17, radiusClass: MeshBlendingRadiusClass.Large });
        expect(PackMeshBlendingTag(0, MeshBlendingRadiusClass.ExtraLarge)).toBe(0);
        expect(() => PackMeshBlendingTag(64, MeshBlendingRadiusClass.Small)).toThrow(RangeError);
        expect(() => UnpackMeshBlendingTag(64)).toThrow(RangeError);
    });

    it("forwards Babylon.js default radius definitions to Lite", () => {
        const definitions = CreateDefaultMeshBlendRadiusDefinitions();
        expect(definitions).toEqual([
            { worldRadius: 0.06, minimumProjectedRadius: 1.5 },
            { worldRadius: 0.1, minimumProjectedRadius: 3 },
            { worldRadius: 0.2, minimumProjectedRadius: 3 },
            { worldRadius: 0.3, minimumProjectedRadius: 5 },
        ]);
        expect(Object.isFrozen(definitions)).toBe(true);
        definitions[0].worldRadius = 0.5;
        definitions[0].minimumProjectedRadius = 4;
        expect(definitions[0]).toEqual({ worldRadius: 0.5, minimumProjectedRadius: 4 });
        expect(() => {
            definitions[0].worldRadius = -1;
        }).toThrow(RangeError);
        expect(() => {
            definitions[0].minimumProjectedRadius = Number.POSITIVE_INFINITY;
        }).toThrow(RangeError);
    });

    it("stores valid mesh tags and rejects invalid packed values", () => {
        const mesh = new Mesh("mesh", { name: "mesh" } as never);
        expect(mesh.meshBlendingTag).toBe(0);
        mesh.meshBlendingTag = PackMeshBlendingTag(17, MeshBlendingRadiusClass.Large);
        expect(mesh.meshBlendingTag).toBe(145);
        expect(() => {
            mesh.meshBlendingTag = 64;
        }).toThrow(RangeError);
    });

    it.each([
        ["ThinMeshBlendingPostProcess", () => new ThinMeshBlendingPostProcess()],
        ["MeshBlendingPostProcess", () => new MeshBlendingPostProcess()],
        ["FrameGraphMeshBlendingTask", () => new FrameGraphMeshBlendingTask()],
        ["NodeRenderGraphMeshBlendingPostProcessBlock", () => new NodeRenderGraphMeshBlendingPostProcessBlock()],
        ["RegisterMeshBlendingPostProcessBlock", () => RegisterMeshBlendingPostProcessBlock()],
    ])("%s reports the frame-graph structural blocker", (name, invoke) => {
        expect(invoke).toThrow(LiteCompatError);
        expect(invoke).toThrow(new RegExp(name));
    });
});
