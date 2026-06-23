import { describe, expect, it } from "vitest";
import { breakingApiLines } from "../../../scripts/report-api-changes";

function apiDiff(removed: string, added: string): string {
    return ["diff --git a/target.api.md b/current.api.md", "--- a/target.api.md", "+++ b/current.api.md", "@@", `-${removed}`, `+${added}`].join("\n");
}

describe("API report breaking-change classifier", () => {
    it("treats trailing optional function parameters as additive", () => {
        const diff = apiDiff("export declare function createMesh(name: string): Mesh;", "export declare function createMesh(name: string, options?: MeshOptions): Mesh;");

        expect(breakingApiLines(diff)).toEqual([]);
    });

    it("treats trailing rest parameters as additive", () => {
        const diff = apiDiff("export declare function setDefines(name: string): void;", "export declare function setDefines(name: string, ...defines: string[]): void;");

        expect(breakingApiLines(diff)).toEqual([]);
    });

    it("flags added required function parameters as breaking", () => {
        const diff = apiDiff("export declare function createMesh(name: string): Mesh;", "export declare function createMesh(name: string, options: MeshOptions): Mesh;");

        expect(breakingApiLines(diff)).toEqual(["export declare function createMesh(name: string): Mesh;"]);
    });

    it("flags parameter type changes as breaking", () => {
        const diff = apiDiff("export declare function setColor(color: string): void;", "export declare function setColor(color: Color3): void;");

        expect(breakingApiLines(diff)).toEqual(["export declare function setColor(color: string): void;"]);
    });

    it("flags return type changes as breaking", () => {
        const diff = apiDiff("export declare function createMesh(name: string): Mesh;", "export declare function createMesh(name: string): Promise<Mesh>;");

        expect(breakingApiLines(diff)).toEqual(["export declare function createMesh(name: string): Mesh;"]);
    });

    it("treats a const literal widening to its primitive base as additive", () => {
        const diff = apiDiff('export const VERSION = "0.1.0";', "export const VERSION: string;");

        expect(breakingApiLines(diff)).toEqual([]);
    });

    it("treats numeric and boolean const literal widening as additive", () => {
        expect(breakingApiLines(apiDiff("export const MAX = 100;", "export const MAX: number;"))).toEqual([]);
        expect(breakingApiLines(apiDiff("export const ENABLED = true;", "export const ENABLED: boolean;"))).toEqual([]);
    });

    it("flags a const widening to an unrelated type as breaking", () => {
        const diff = apiDiff('export const VERSION = "0.1.0";', "export const VERSION: number;");

        expect(breakingApiLines(diff)).toEqual(['export const VERSION = "0.1.0";']);
    });

    it("flags a renamed const as breaking", () => {
        const diff = apiDiff('export const VERSION = "0.1.0";', "export const REVISION: string;");

        expect(breakingApiLines(diff)).toEqual(['export const VERSION = "0.1.0";']);
    });

    it("treats a TypedArray gaining its TS 5.7 buffer type argument as additive", () => {
        expect(breakingApiLines(apiDiff("readonly weights: Float32Array;", "readonly weights: Float32Array<ArrayBuffer>;"))).toEqual([]);
        expect(breakingApiLines(apiDiff("readonly weights: Float32Array<ArrayBuffer>;", "readonly weights: Float32Array;"))).toEqual([]);
    });

    it("treats TypedArray buffer-argument changes inside composite types as additive", () => {
        const diff = apiDiff(
            "readonly targets: readonly { positions: Float32Array; normals: Float32Array | null }[];",
            "readonly targets: readonly { positions: Float32Array<ArrayBuffer>; normals: Float32Array<ArrayBuffer> | null }[];"
        );

        expect(breakingApiLines(diff)).toEqual([]);
    });

    it("still flags a genuine TypedArray element-type change as breaking", () => {
        const diff = apiDiff("readonly weights: Float32Array<ArrayBuffer>;", "readonly weights: Float64Array<ArrayBuffer>;");

        expect(breakingApiLines(diff)).toEqual(["readonly weights: Float32Array<ArrayBuffer>;"]);
    });

    it("still flags a non-default backing-buffer change as breaking", () => {
        const diff = apiDiff("readonly weights: Float32Array<ArrayBuffer>;", "readonly weights: Float32Array<SharedArrayBuffer>;");

        expect(breakingApiLines(diff)).toEqual(["readonly weights: Float32Array<ArrayBuffer>;"]);
    });

    it("does not flag purely added API lines", () => {
        const diff = [
            "diff --git a/target.api.md b/current.api.md",
            "--- a/target.api.md",
            "+++ b/current.api.md",
            "@@",
            "+export declare function createMesh(name: string): Mesh;",
        ].join("\n");

        expect(breakingApiLines(diff)).toEqual([]);
    });
});
