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

    it("treats a parameter widening to a union superset as additive", () => {
        const diff = apiDiff(
            "export declare function removeFromScene(scene: SceneContext, mesh: Mesh): void;",
            "export declare function removeFromScene(scene: SceneContext, entity: Mesh | LightBase | Camera): void;"
        );

        expect(breakingApiLines(diff)).toEqual([]);
    });

    it("treats a non-union parameter widening into a union as additive", () => {
        const diff = apiDiff("export declare function add(entity: Mesh): void;", "export declare function add(entity: Mesh | LightBase): void;");

        expect(breakingApiLines(diff)).toEqual([]);
    });

    it("flags a parameter union that drops the original type as breaking", () => {
        const diff = apiDiff("export declare function add(entity: Mesh): void;", "export declare function add(entity: LightBase | Camera): void;");

        expect(breakingApiLines(diff)).toEqual(["export declare function add(entity: Mesh): void;"]);
    });

    it("flags a pure parameter rename (no widening) as breaking", () => {
        const diff = apiDiff("export declare function add(mesh: Mesh): void;", "export declare function add(entity: Mesh): void;");

        expect(breakingApiLines(diff)).toEqual(["export declare function add(mesh: Mesh): void;"]);
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

    it("treats a union type alias gaining members as additive", () => {
        const diff = apiDiff(
            'export type ShaderAttributeName = "position" | "normal" | "uv" | "uv2" | "tangent" | "color";',
            'export type ShaderAttributeName = "position" | "normal" | "uv" | "uv2" | "tangent" | "color" | "joints" | "weights" | "joints1" | "weights1";'
        );

        expect(breakingApiLines(diff)).toEqual([]);
    });

    it("treats a `declare type` union gaining members as additive", () => {
        const diff = apiDiff('export declare type Mode = "a" | "b";', 'export declare type Mode = "a" | "b" | "c";');

        expect(breakingApiLines(diff)).toEqual([]);
    });

    it("flags a union that drops a member as breaking", () => {
        const removed = 'export type Mode = "a" | "b" | "c";';
        const diff = apiDiff(removed, 'export type Mode = "a" | "b";');

        expect(breakingApiLines(diff)).toEqual([removed]);
    });

    it("flags a union that renames a member as breaking", () => {
        const removed = 'export type Mode = "a" | "b";';
        const diff = apiDiff(removed, 'export type Mode = "a" | "c";');

        expect(breakingApiLines(diff)).toEqual([removed]);
    });

    it("flags a renamed union alias as breaking even when it gains members", () => {
        const removed = 'export type Mode = "a" | "b";';
        const diff = apiDiff(removed, 'export type Kind = "a" | "b" | "c";');

        expect(breakingApiLines(diff)).toEqual([removed]);
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

    it("treats overloads collapsed into one widened union signature as additive", () => {
        const diff = [
            "diff --git a/target.api.md b/current.api.md",
            "--- a/target.api.md",
            "+++ b/current.api.md",
            "@@",
            "-export function loadGltf(engine: EngineContext, url: string): Promise<AssetContainer>;",
            "-export function loadGltf(engine: EngineContext, data: ArrayBuffer | Blob): Promise<AssetContainer>;",
            "+export function loadGltf(engine: EngineContext, source: string | ArrayBuffer | Blob): Promise<AssetContainer>;",
        ].join("\n");

        expect(breakingApiLines(diff)).toEqual([]);
    });

    it("treats a widened single parameter type as additive", () => {
        const diff = apiDiff("export declare function setColor(color: string): void;", "export declare function setColor(color: string | Color3): void;");

        expect(breakingApiLines(diff)).toEqual([]);
    });

    it("flags a narrowed parameter union as breaking", () => {
        const removed = "export declare function setColor(color: string | Color3): void;";
        const diff = apiDiff(removed, "export declare function setColor(color: string): void;");

        expect(breakingApiLines(diff)).toEqual([removed]);
    });

    it("does not treat a widened optional parameter as matching a required one", () => {
        const removed = "export declare function setColor(color: string): void;";
        const diff = apiDiff(removed, "export declare function setColor(color?: string | Color3): void;");

        expect(breakingApiLines(diff)).toEqual([removed]);
    });
});

/**
 * A parameter's interface type may be swapped for one that only adds OPTIONAL members —
 * usually via `extends`. TypeScript is structural, so existing callers keep compiling.
 * Proving that needs the full `.api.md`: the inherited members typically live in a base
 * type that pre-dates the PR and therefore never shows up in the diff.
 */
function apiReport(...declarations: string[]): string {
    return ['## API Report File for "@babylonjs/lite"', "", "```ts", ...declarations, "```", ""].join("\n");
}

describe("API report interface-substitution classifier", () => {
    const baseOptions = ["export interface TextureArrayOptions {", "    mipMaps?: boolean;", "    srgb?: boolean;", "}"].join("\n");
    const uploadOptions = ["export interface ArrayLayerUploadOptions {", "    invertY?: boolean;", "    premultiplyAlpha?: boolean;", "}"].join("\n");
    const removed = "export declare function createTexture2DArrayFromUrls(engine: EngineContext, urls: readonly string[], options?: TextureArrayOptions): Promise<Texture2DArray>;";
    const added =
        "export declare function createTexture2DArrayFromUrls(engine: EngineContext, urls: readonly string[], options?: TextureArrayFromUrlsOptions): Promise<Texture2DArray>;";

    it("treats a parameter interface that only adds optional members as additive", () => {
        const report = apiReport(baseOptions, uploadOptions, "export interface TextureArrayFromUrlsOptions extends TextureArrayOptions, ArrayLayerUploadOptions {}");

        expect(breakingApiLines(apiDiff(removed, added), report)).toEqual([]);
    });

    it("resolves optional members inherited through a multi-level extends chain", () => {
        const report = apiReport(
            baseOptions,
            uploadOptions,
            "export interface MidOptions extends TextureArrayOptions {}",
            "export interface TextureArrayFromUrlsOptions extends MidOptions, ArrayLayerUploadOptions {}"
        );

        expect(breakingApiLines(apiDiff(removed, added), report)).toEqual([]);
    });

    it("flags a parameter interface that adds a required member as breaking", () => {
        const report = apiReport(baseOptions, "export interface TextureArrayFromUrlsOptions extends TextureArrayOptions {", "    invertY: boolean;", "}");

        expect(breakingApiLines(apiDiff(removed, added), report)).toEqual([removed]);
    });

    it("flags a parameter interface that drops an inherited member as breaking", () => {
        const report = apiReport(baseOptions, "export interface TextureArrayFromUrlsOptions {", "    mipMaps?: boolean;", "    invertY?: boolean;", "}");

        expect(breakingApiLines(apiDiff(removed, added), report)).toEqual([removed]);
    });

    it("flags a parameter interface that re-types a shared member as breaking", () => {
        const report = apiReport(baseOptions, "export interface TextureArrayFromUrlsOptions {", "    mipMaps?: number;", "    srgb?: boolean;", "}");

        expect(breakingApiLines(apiDiff(removed, added), report)).toEqual([removed]);
    });

    it("stays breaking when a base type cannot be resolved from the report", () => {
        const report = apiReport(baseOptions, "export interface TextureArrayFromUrlsOptions extends TextureArrayOptions, SomeExternalOptions {}");

        expect(breakingApiLines(apiDiff(removed, added), report)).toEqual([removed]);
    });

    it("stays breaking when no report is supplied", () => {
        expect(breakingApiLines(apiDiff(removed, added))).toEqual([removed]);
    });

    it("stays breaking for generic interfaces, which are never indexed", () => {
        const report = apiReport(baseOptions, "export interface TextureArrayFromUrlsOptions<T> extends TextureArrayOptions {}");

        expect(breakingApiLines(apiDiff(removed, added), report)).toEqual([removed]);
    });

    it("does not let an interface substitution excuse an unrelated parameter change", () => {
        const report = apiReport(baseOptions, uploadOptions, "export interface TextureArrayFromUrlsOptions extends TextureArrayOptions, ArrayLayerUploadOptions {}");
        const removedTwo = "export declare function load(source: string, options?: TextureArrayOptions): void;";
        const addedTwo = "export declare function load(source: Color3, options?: TextureArrayFromUrlsOptions): void;";

        expect(breakingApiLines(apiDiff(removedTwo, addedTwo), report)).toEqual([removedTwo]);
    });

    it("clears the exact lines API Extractor emitted for the 2D-array URL loader", () => {
        // Verbatim from the report that tripped the gate, including API Extractor's
        // `export function` (not `export declare function`) and the tuple parameter.
        const report = apiReport(
            "// @public",
            "export interface TextureArrayOptions {",
            "    mipMaps?: boolean;",
            "    srgb?: boolean;",
            "    addressModeU?: GPUAddressMode;",
            "    addressModeV?: GPUAddressMode;",
            "    minFilter?: GPUFilterMode;",
            "    magFilter?: GPUFilterMode;",
            "}",
            "",
            "// @public",
            "export interface ArrayLayerUploadOptions {",
            "    invertY?: boolean;",
            "    premultiplyAlpha?: boolean;",
            "}",
            "",
            "// @public",
            "export interface TextureArrayFromUrlsOptions extends TextureArrayOptions, ArrayLayerUploadOptions {}"
        );
        const removedReal =
            "export function createTexture2DArrayFromUrls(engine: EngineContext, urls: readonly [string, ...string[]], options?: TextureArrayOptions): Promise<Texture2DArray>;";
        const addedReal =
            "export function createTexture2DArrayFromUrls(engine: EngineContext, urls: readonly [string, ...string[]], options?: TextureArrayFromUrlsOptions): Promise<Texture2DArray>;";

        expect(breakingApiLines(apiDiff(removedReal, addedReal), report)).toEqual([]);
    });
});
