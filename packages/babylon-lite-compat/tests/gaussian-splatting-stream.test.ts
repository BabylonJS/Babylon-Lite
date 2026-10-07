import { describe, expect, it } from "vitest";

import { LiteCompatError } from "../src/error";
import {
    AddGaussianSplattingStreamPart,
    AddGaussianSplattingStreamPartAsync,
    GaussianSplattingStream,
    GaussianSplattingPartProxyMesh,
} from "../src/meshes/gaussian-splatting-stream";
import type { Scene } from "../src/scene/scene";

const metadata = {
    lodLevels: 2,
    filenames: ["coarse/meta.json", "fine/meta.json"],
    tree: {
        bound: { min: [0, 0, 0], max: [1, 1, 1] },
        lods: {
            0: { file: 1, offset: 0, count: 20 },
            1: { file: 0, offset: 0, count: 10 },
        },
    },
};

describe("GaussianSplattingStream structural stubs", () => {
    it("recognizes the BJS metadata shape without starting the unsupported stream", () => {
        expect(GaussianSplattingStream.IsLODMetadata(metadata)).toBe(true);
        expect(GaussianSplattingStream.IsLODMetadata({ ...metadata, lodLevels: Number.NaN })).toBe(true);
        expect(GaussianSplattingStream.IsLODMetadata({ ...metadata, lodLevels: 1.5 })).toBe(true);
        expect(GaussianSplattingStream.IsLODMetadata({ filenames: [] })).toBe(false);
    });

    it("names the parsed-metadata, budget, transform, and lifecycle blocker", () => {
        expect(() => new GaussianSplattingStream("stream", metadata, "https://assets.example/", {} as Scene)).toThrow(LiteCompatError);
        expect(() => new GaussianSplattingStream("stream", metadata, "https://assets.example/", {} as Scene)).toThrow(/HTTP\(S\) manifest URL/);
    });

    it("keeps compound-stream surfaces importable with a named structural blocker", async () => {
        expect(() => new GaussianSplattingPartProxyMesh("part", null, {} as never, 0, {} as never, 10, 0)).toThrow(/compound-mesh atlas/);
        expect(() => AddGaussianSplattingStreamPart({} as never, "part", metadata, "/")).toThrow(/compound-mesh atlas/);
        await expect(AddGaussianSplattingStreamPartAsync({} as never, "part", metadata, "/")).rejects.toThrow(/compound-mesh atlas/);
    });
});
