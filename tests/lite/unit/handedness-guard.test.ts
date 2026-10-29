/**
 * Handedness guard — keeps the right-handed build (docs/lite/architecture/61-right-handed-system.md)
 * from silently rotting while every scene, test and golden keeps exercising the left-handed default.
 *
 * 1. Every engine file holding handedness-sensitive code (a pipeline `frontFace`, a left-handed
 *    matrix builder, the glTF RH→LH root mirror, a derivative-based tangent frame, a screen-space
 *    normal cross product) must either import
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
    "material/pbr/fragments/anisotropy-fragment.ts":
        "a right-handed build reverses both cotangent-frame axes together, and the anisotropic lobe and bent normal are quadratic in them (dot², length, cross·cross): no visible change",
    "material/pbr/fragments/flat-normal-wgsl.ts":
        "the derivative face normal is re-oriented toward the viewer right after the cross product, so its sign never depends on the handedness",
    "material/node/blocks/perturb-normal.ts": "node-material normal frame: Babylon.js's PerturbNormalBlock flips only on its invertX/invertY options, never with the handedness",
    "shader/wgsl-helpers.ts": "Standard bump frame: Babylon.js flips it only with invertNormalMapX/Y, which only its glTF loader ties to the handedness",
    "text/_gpu/text-pipeline.ts": "cullMode none: winding cannot change what is drawn",
};

/** Handedness-sensitive code, matched with comments stripped. */
const MARKERS: [name: string, pattern: RegExp][] = [
    ["pipeline frontFace", /\bfrontFace\b/],
    ["left-handed matrix builder", /\bimport\s[^;]*?\sfrom\s+"[./]*\/math\/[\w-]*-lh[\w-]*\.js"/],
    ["glTF RH→LH root mirror", /\bRH_TO_LH\w*|F32\(\[\s*-1\s*,\s*0\s*,\s*0\s*,\s*0\s*,/],
    ["derivative tangent frame", /cross\(\s*\w*dp2/i],
    ["screen-space normal cross product", /cross\(\s*(dpd[xy]\w*\(|p[HV]\s*,)/],
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

/**
 * Twins whose source Babylon.js renders wrongly when right-handed: their reference stays the
 * left-handed source's, since a right-handed twin must look exactly like its source.
 */
const BJS_RH_BROKEN: Record<number, string> = {
    342: "Babylon.js 9.28 lights EXT_lights_image_based wrongly in a right-handed scene (white dielectrics turn black)",
};

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
            const shim = twin.id in BJS_RH_BROKEN ? [] : ["./right-handed-twin"];
            expect(importsOf(bjsPath), TWIN_HINT).toEqual([...shim, `./scene${sourceId}`]);
            expect(nonImportCode(bjsPath), TWIN_HINT).toBe("");
        }

        expect(existsSync(join(ROOT, `tests/lite/parity/scenes/${twin.slug}.spec.ts`)), `scene ${twin.id} needs its parity spec`).toBe(true);
    });
});

/**
 * Seam files whose right-handed branch no right-handed unit test imports, with the twin scenes whose
 * golden comparison renders that branch. Unit-tested files (any `right-handed-*.test.ts` importing the
 * module) need no entry.
 */
const RH_TWIN_COVERAGE: Record<string, number[]> = {
    "gizmo/camera-gizmo.ts": [339],
    "loader-gltf/gltf-feature-camera.ts": [328],
    "loader-gltf/gltf-feature-primitive.ts": [346],
    "loader-gltf/gltf-feature-registry.ts": [322, 324, 326, 343, 347],
    "loader-gltf/gltf-parser.ts": [322, 324, 326, 343, 347],
    "loader-gltf/load-gltf.ts": [322, 324, 326, 343, 347],
    "material/node/blocks/input-block.ts": [334, 335],
    "material/node/node-geometry-renderable.ts": [346],
    "material/node/node-pipeline.ts": [334, 335],
    "material/pbr/background-ground.ts": [323, 324],
    "material/pbr/fragments/clearcoat-fragment.ts": [324],
    "material/pbr/pbr-geometry-renderable.ts": [322, 323, 324],
    "material/pbr/pbr-pipeline.ts": [322, 323, 324],
    "material/shader/shader-pipeline.ts": [336],
    "material/standard/standard-geometry-renderable.ts": [321, 325],
    "material/standard/standard-pipeline.ts": [321, 325],
    "material/standard/std-mirrored-support.ts": [331],
    "mesh/csg2.ts": [341],
    "render/scene-helpers.ts": [321],
    "skeleton/skeleton-updater.ts": [322, 326],
};

/**
 * Seam files covered by neither a unit test nor a twin scene: only the drift snapshot
 * (right-handed-drift.test.ts) stops their left-handed branch from changing alone. Each entry is
 * a known gap, kept short on purpose — add a pair test or a twin and remove it.
 */
const RH_DRIFT_ONLY: Record<string, string> = {
    "animation/weighted-gltf-mixer.ts": "animation-blending root: the same ROOT_TRANSFORM as skeleton-pose.ts, which is pair-tested",
    "loader-usd/usd-materialize.ts": "USD root axis conversion: no USD scene has a right-handed twin yet",
    "material/pbr/pbr-mesh-lod-renderable.ts": "pipeline frontFace only; the mesh-LoD WGSL it compiles is pair-tested",
    "physics/havok.ts": "mesh-shape triangle order: needs the Havok wasm runtime",
    "xr/xr-controller-models.ts": "needs a WebXR session",
    "xr/xr-hand-mesh.ts": "needs a WebXR session",
    "xr/xr-pointer.ts": "needs a WebXR session",
    "xr/xr-teleport.ts": "needs a WebXR session",
};

const RH_TESTS = readdirSync(join(ROOT, "tests/lite/unit"))
    .filter((name) => /^right-handed-.*\.test\.ts$/.test(name))
    .map((name) => readFileSync(join(ROOT, "tests/lite/unit", name), "utf8"))
    .join("\n");

/** True when a right-handed unit test imports the module (`${SRC}path` or a relative `/src/path`). */
function unitTested(rel: string): boolean {
    const module = rel.replace(/\.ts$/, "");
    return RH_TESTS.includes(`}${module}\``) || RH_TESTS.includes(`/src/${module}"`) || RH_TESTS.includes(`/src/${module}.js"`);
}

const seamFiles = sources.filter((s) => SEAM_IMPORT.test(s.code) && !s.rel.startsWith("engine/coordinate-system")).map((s) => s.rel);
const COVERAGE_HINT =
    "Every file importing #coordinate-system needs its right-handed branch exercised: a pair test in " +
    "right-handed-pairs.test.ts (preferred: same input through both builds, assert the documented relation), a seam " +
    "test, or a right-handed twin scene listed in RH_TWIN_COVERAGE. RH_DRIFT_ONLY is for known gaps only.";

describe("handedness guard: right-handed coverage", () => {
    it("every seam file is unit-tested, rendered by a twin, or a declared gap", () => {
        const uncovered = seamFiles.filter((rel) => !unitTested(rel) && !(rel in RH_TWIN_COVERAGE) && !(rel in RH_DRIFT_ONLY));
        expect(uncovered, COVERAGE_HINT).toEqual([]);
    });

    it("coverage entries are not stale", () => {
        const stale = [...Object.keys(RH_TWIN_COVERAGE), ...Object.keys(RH_DRIFT_ONLY)].flatMap((rel) => {
            if (!seamFiles.includes(rel)) {
                return [`${rel}: no longer imports #coordinate-system`];
            }
            if (rel in RH_DRIFT_ONLY && (unitTested(rel) || rel in RH_TWIN_COVERAGE)) {
                return [`${rel}: now covered, drop it from RH_DRIFT_ONLY`];
            }
            return [];
        });
        expect(stale).toEqual([]);
    });

    it("twin coverage names right-handed twins", () => {
        const twinIds = new Set(twins.map((t) => t.id));
        const unknown = Object.entries(RH_TWIN_COVERAGE).flatMap(([rel, ids]) =>
            ids.length ? ids.filter((id) => !twinIds.has(id)).map((id) => `${rel}: ${id}`) : [`${rel}: no scene`]
        );
        expect(unknown).toEqual([]);
    });
});
