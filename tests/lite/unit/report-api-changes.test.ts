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
