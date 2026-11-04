import { describe, expect, it } from "vitest";

import { LiteCompatError } from "../src/error";
import {
    AddGaussianSplattingStreamPart,
    AddGaussianSplattingStreamPartAsync,
    GaussianSplattingStream,
    GaussianSplattingPartProxyMesh,
} from "../src/meshes/gaussian-splatting-stream";
import type { Scene } from "../src/scene/scene";
import type {
    IGaussianSplattingStreamOptions,
    IGaussianSplattingStreamRangePack,
    IGaussianSplattingStreamRangeResidencyStats,
    IGaussianSplattingStreamSourceRange,
} from "../src/meshes/gaussian-splatting-stream";

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

    it("exposes the range-residency option and diagnostics shapes", () => {
        const source: IGaussianSplattingStreamSourceRange = { file: 1, offset: 2, count: 3 };
        const dataFile = { shape: [3, 3], dtype: "uint8", files: ["data.webp"] };
        const pack: IGaussianSplattingStreamRangePack = {
            sogData: { version: 2, means: dataFile, scales: dataFile, quats: dataFile, sh0: dataFile },
            subRootUrl: "/split/",
        };
        const options: IGaussianSplattingStreamOptions = {
            rangeResidency: true,
            rangePack: (requested) => (requested === source ? pack : null),
        };
        const stats: IGaussianSplattingStreamRangeResidencyStats = {
            enabled: true,
            pages: 1,
            sourcePackLoads: 1,
            sourcePackReuses: 0,
            splitPackLoads: 1,
            cachedSourceSplats: 3,
        };

        expect(options.rangePack?.(source, pack.sogData)).toBe(pack);
        expect(stats.cachedSourceSplats).toBe(3);
    });

    it("keeps range-residency members importable with the stream lifecycle blocker", () => {
        const stream = Object.create(GaussianSplattingStream.prototype) as GaussianSplattingStream;

        expect(() => stream.getSourceRange(2)).toThrow(/stream-construction contract/);
        expect(() => stream.isSplitPage(2)).toThrow(/stream-construction contract/);
        expect(() => stream.cancelRangeLoads([2], [1])).toThrow(/stream-construction contract/);
        expect(() => stream.rangeResidencyStats).toThrow(/stream-construction contract/);
    });
});
