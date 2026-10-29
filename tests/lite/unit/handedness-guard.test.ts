/**
 * Handedness guard — keeps the right-handed build (docs/lite/architecture/61-right-handed-system.md)
 * from silently rotting while every scene, test and golden keeps exercising the left-handed default.
 *
 * 1. Every engine file holding handedness-sensitive code (a pipeline `frontFace`, a left-handed
 *    matrix builder, the glTF RH→LH root mirror, a derivative-based tangent frame) must either import
 *    the `#coordinate-system` seam or sit in `HANDEDNESS_EXEMPT` with the reason it needs none. New
 *    code therefore cannot assume left-handedness without someone deciding, in review, what it does
 *    in a right-handed engine.
 * 2. Every right-handed twin scene (`"rightHanded": true` in scene-config.json) must stay a pure
 *    re-run of its left-handed source — Lite wrapper and Babylon.js reference both import the source
 *    unchanged — so updating the left-handed scene updates its twin, and CI's impact selection runs
 *    the twin whenever the source or the engine code it bundles changes.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const SRC = join(ROOT, "packages/babylon-lite/src");
const LAB = join(ROOT, "lab/lite");

/** Files with handedness-sensitive code that deliberately do not import `#coordinate-system`. */
const HANDEDNESS_EXEMPT: Record<string, string> = {
    "camera/orthographic.ts": "projection only: Babylon.js's right-handed ortho projection is the left-handed one times Sz, which camera.ts folds into the view matrix",
    "camera/geospatial-camera.ts": "not ported yet: listed under 'Not covered yet' in doc 61",
    "loader-usd/usd-material-plugin.ts": "USD loader: not ported to the right-handed build, listed under 'Not covered yet' in doc 61",
    "loader-gltf/gltf-feature-primitive.ts": "winding from the world determinant; the PBR pipelines apply the right-handed flip on top of it",
    "material/node/blocks/perturb-normal.ts": "node-material normal frame: Babylon.js's PerturbNormalBlock flips only on its invertX/invertY options, never with the handedness",
    "material/node/blocks/pbr-mr-helper-full.ts": "node-material anisotropy frame: like PerturbNormalBlock, Babylon.js does not flip it with the handedness",
    "shader/wgsl-helpers.ts": "Standard bump frame: Babylon.js flips it only with invertNormalMapX/Y, which only its glTF loader ties to the handedness",
    "text/_gpu/text-pipeline.ts": "cullMode none: winding cannot change what is drawn",
};

/** Handedness-sensitive code, matched with comments stripped. */
const MARKERS: [name: string, pattern: RegExp][] = [
    ["pipeline frontFace", /\bfrontFace\b/],
    ["left-handed matrix builder", /\bimport\s[^;]*?\sfrom\s+"[./]*\/math\/[\w-]*-lh[\w-]*\.js"/],
    ["glTF RH→LH root mirror", /\bRH_TO_LH\w*|F32\(\[\s*-1\s*,\s*0\s*,\s*0\s*,\s*0\s*,/],
    ["derivative tangent frame", /cross\(\s*\w*dp2/i],
];

const SEAM_IMPORT = /from\s+"#coordinate-system"/;

function listTs(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? listTs(path) : name.endsWith(".ts") ? [path] : [];
    });
}

function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

const sources = listTs(SRC).map((path) => {
    const text = readFileSync(path, "utf8");
    return { rel: relative(SRC, path).replace(/\\/g, "/"), text, code: stripComments(text) };
});

function markersOf(code: string): string[] {
    return MARKERS.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
}

const FIX_HINT =
    'Handedness-sensitive code must import `_rightHanded` from "#coordinate-system" and handle the right-handed case ' +
    "(and cover it with a right-handed twin scene), or be added to HANDEDNESS_EXEMPT in this test with the reason it needs " +
    "no seam. See docs/lite/architecture/61-right-handed-system.md.";

describe("handedness guard: engine sources", () => {
    it("every handedness-sensitive file imports #coordinate-system or is exempt", () => {
        const offenders = sources
            .filter((s) => !SEAM_IMPORT.test(s.code) && !(s.rel in HANDEDNESS_EXEMPT))
            .map((s) => ({ file: s.rel, markers: markersOf(s.code) }))
            .filter((s) => s.markers.length > 0 && !s.file.startsWith("math/") && !s.file.startsWith("engine/coordinate-system"))
            .map((s) => `${s.file} (${s.markers.join(", ")})`);
        expect(offenders, FIX_HINT).toEqual([]);
    });

    it("exemptions are not stale", () => {
        const stale = Object.keys(HANDEDNESS_EXEMPT).flatMap((rel) => {
            const source = sources.find((s) => s.rel === rel);
            if (!source) {
                return [`${rel}: file no longer exists`];
            }
            if (SEAM_IMPORT.test(source.code)) {
                return [`${rel}: now imports #coordinate-system, drop the exemption`];
            }
            return markersOf(source.code).length ? [] : [`${rel}: no handedness-sensitive code left, drop the exemption`];
        });
        expect(stale).toEqual([]);
    });

    it("the seam is imported only through the #coordinate-system specifier", () => {
        // A relative import would bypass the package `imports` map and pin one variant into every build.
        const relativeImports = sources.filter((s) => /from\s+"[./]+[\w/-]*coordinate-system(-rh)?(\.js)?"/.test(s.code)).map((s) => s.rel);
        expect(relativeImports).toEqual([]);
    });
});

interface SceneEntry {
    id: number;
    slug: string;
    rightHanded?: boolean;
}

const scenes = JSON.parse(readFileSync(join(ROOT, "scene-config.json"), "utf8")) as SceneEntry[];
const twins = scenes.filter((s) => s.rightHanded);
const TWIN_HINT =
    "A right-handed twin must stay a pure re-run of its left-handed source: lab/lite/src/lite/sceneN.ts imports only the " +
    'source scene, and lab/lite/src/bjs/sceneN.ts imports only "./right-handed-twin" then the source reference.';

function importsOf(path: string): string[] {
    return [...stripComments(readFileSync(path, "utf8")).matchAll(/^\s*import\s+"([^"]+)";\s*$/gm)].map((m) => m[1]!);
}

function nonImportCode(path: string): string {
    return stripComments(readFileSync(path, "utf8"))
        .replace(/^\s*import\s+"[^"]+";\s*$/gm, "")
        .trim();
}

describe("handedness guard: right-handed twin scenes", () => {
    it("there are right-handed twins", () => {
        expect(twins.length).toBeGreaterThan(0);
    });

    it.each(twins.map((t) => [t.id, t] as const))("scene %i re-runs its left-handed source unchanged", (_id, twin) => {
        const litePath = join(LAB, `src/lite/scene${twin.id}.ts`);
        const liteImports = importsOf(litePath);
        expect(liteImports, TWIN_HINT).toHaveLength(1);
        expect(nonImportCode(litePath), TWIN_HINT).toBe("");
        const sourceId = Number(/^\.\/scene(\d+)$/.exec(liteImports[0]!)?.[1]);
        const source = scenes.find((s) => s.id === sourceId);
        expect(source, `scene ${twin.id} must import an existing scene`).toBeDefined();
        expect(source!.rightHanded, `scene ${twin.id}'s source must be a left-handed scene`).toBeFalsy();

        const bjsPath = join(LAB, `src/bjs/scene${twin.id}.ts`);
        if (existsSync(join(LAB, `src/bjs/scene${sourceId}.ts`))) {
            expect(importsOf(bjsPath), TWIN_HINT).toEqual(["./right-handed-twin", `./scene${sourceId}`]);
            expect(nonImportCode(bjsPath), TWIN_HINT).toBe("");
        }

        expect(existsSync(join(ROOT, `tests/lite/parity/scenes/${twin.slug}.spec.ts`)), `scene ${twin.id} needs its parity spec`).toBe(true);
    });
});
