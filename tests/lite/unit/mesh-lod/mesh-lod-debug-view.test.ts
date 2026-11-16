import { describe, expect, it } from "vitest";
import {
    meshLoDClusterDebugAttr,
    meshLoDDebugModeCode,
    meshLoDPageRequestCode,
    meshLoDPageResidencyCode,
} from "../../../../packages/babylon-lite/src/material/pbr/pbr-mesh-lod-debug.js";
import type { MeshLoDPageState } from "../../../../packages/babylon-lite/src/mesh-lod/mesh-lod-runtime.js";

describe("meshLoDDebugModeCode", () => {
    it("maps every debug view to a stable mode code (0 = off)", () => {
        expect(meshLoDDebugModeCode("none")).toBe(0);
        expect(meshLoDDebugModeCode("meshlet-id")).toBe(1);
        expect(meshLoDDebugModeCode("lod-depth")).toBe(2);
        expect(meshLoDDebugModeCode("selected-group")).toBe(3);
        expect(meshLoDDebugModeCode("page-residency")).toBe(4);
        expect(meshLoDDebugModeCode("requested-pages")).toBe(5);
        expect(meshLoDDebugModeCode("meshlet-cone")).toBe(6);
    });
});

describe("meshLoDPageResidencyCode", () => {
    it("prioritizes terminal failure, then pinned, then resident, else unavailable", () => {
        expect(meshLoDPageResidencyCode(true, "terminal-failed")).toBe(3); // failure wins over pinned
        expect(meshLoDPageResidencyCode(false, "terminal-failed")).toBe(3);
        expect(meshLoDPageResidencyCode(true, "gpu-resident")).toBe(2); // yellow pinned
        expect(meshLoDPageResidencyCode(false, "gpu-resident")).toBe(1); // green resident
        expect(meshLoDPageResidencyCode(false, "fetching")).toBe(0); // gray unavailable
        expect(meshLoDPageResidencyCode(false, "unrequested")).toBe(0);
    });
});

describe("meshLoDPageRequestCode", () => {
    it("flags in-flight transitions orange and on-demand-resident cyan", () => {
        const inFlight: MeshLoDPageState[] = ["queued", "fetching", "retry-wait", "received", "decoding", "cpu-resident", "uploading", "evicting"];
        for (const state of inFlight) {
            expect(meshLoDPageRequestCode(false, state)).toBe(2);
        }
        expect(meshLoDPageRequestCode(false, "gpu-resident")).toBe(1); // streamed on demand
        expect(meshLoDPageRequestCode(true, "gpu-resident")).toBe(0); // pinned coarse = normal
        expect(meshLoDPageRequestCode(false, "unrequested")).toBe(0);
        expect(meshLoDPageRequestCode(false, "terminal-failed")).toBe(0);
    });
});

describe("meshLoDClusterDebugAttr", () => {
    it("selects the attribute matching the active mode", () => {
        // groupId=7, depth=3, residency=1, request=2
        expect(meshLoDClusterDebugAttr(1, 7, 3, 1, 2)).toBe(0); // meshlet-id uses clusterId (separate word)
        expect(meshLoDClusterDebugAttr(2, 7, 3, 1, 2)).toBe(3); // lod-depth
        expect(meshLoDClusterDebugAttr(3, 7, 3, 1, 2)).toBe(7); // selected-group
        expect(meshLoDClusterDebugAttr(4, 7, 3, 1, 2)).toBe(1); // page-residency
        expect(meshLoDClusterDebugAttr(5, 7, 3, 1, 2)).toBe(2); // requested-pages
        expect(meshLoDClusterDebugAttr(0, 7, 3, 1, 2)).toBe(0); // off
    });
});
