export interface Example {
    id: string;
    label: string;
    code: string;
    /** Optional multi-file project. When present, `code` is the entry file's content. */
    files?: Record<string, string>;
    entry?: string;
}

// Larger examples (some with inline WGSL) live as real source files under
// `playground/examples/` and are imported verbatim via Vite's `?raw`, which keeps
// their backtick template literals intact and the files editor-friendly.
import TORUS_STATES from "../examples/torus-states.ts?raw";
import NEON_RIBBONS from "../examples/neon-ribbons.ts?raw";
import MOSQUITO_AMBER from "../examples/mosquito-amber.ts?raw";
import HAVOK_PHYSICS from "../examples/havok-physics.ts?raw";

const BOOMBOX = `import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createDefaultCamera,
    loadEnvironment,
    loadGltf,
    createHemisphericLight,
    attachControl,
    registerScene,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    addToScene(scene, await loadGltf(engine, "https://playground.babylonjs.com/scenes/BoomBox.glb"));
    await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
        groundTextureUrl: "https://assets.babylonjs.com/core/environments/backgroundGround.png",
        skyboxUrl: "https://assets.babylonjs.com/core/environments/backgroundSkybox.dds",
        skyboxSize: 1000,
        brdfUrl: "/brdf-lut.png",
    });

    const camera = createDefaultCamera(scene);
    camera.alpha = 1.77538207638442;
    attachControl(camera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    await registerScene(scene);
    await startEngine(engine);
}

main().catch((err) => console.error(err));
`;

const PRIMITIVES = `import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createGround,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, 1.1, 6, { x: 0, y: 0.5, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    const box = createBox(engine, 1);
    box.position.set(0, 0.5, 0);
    const boxMat = createStandardMaterial();
    boxMat.diffuseColor = [0.85, 0.34, 0.2];
    box.material = boxMat;
    addToScene(scene, box);

    const ground = createGround(engine, { width: 8, height: 8 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.2, 0.23, 0.27];
    ground.material = groundMat;
    addToScene(scene, ground);

    await registerScene(scene);
    await startEngine(engine);
}

main().catch((err) => console.error(err));
`;

// Multi-file example: the entry wires up the engine and delegates scene building to
// a sibling module imported with a relative path. esbuild bundles them at run time.
const MULTIFILE_INDEX = `import { createEngine, createSceneContext, attachControl, registerScene, startEngine } from "@babylonjs/lite";
import { buildScene } from "./scene";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const camera = buildScene(engine, scene);
    attachControl(camera, canvas, scene);

    await registerScene(scene);
    await startEngine(engine);
}

main().catch((err) => console.error(err));
`;

const MULTIFILE_SCENE = `import {
    addToScene,
    createArcRotateCamera,
    createBox,
    createGround,
    createHemisphericLight,
    createStandardMaterial,
    type EngineContext,
    type SceneContext,
} from "@babylonjs/lite";

export function buildScene(engine: EngineContext, scene: SceneContext) {
    scene.clearColor = { r: 0.05, g: 0.06, b: 0.09, a: 1 };

    const camera = createArcRotateCamera(-Math.PI / 2, 1.1, 6, { x: 0, y: 0.5, z: 0 });
    scene.camera = camera;

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    const box = createBox(engine, 1);
    box.position.set(0, 0.5, 0);
    const boxMat = createStandardMaterial();
    boxMat.diffuseColor = [0.85, 0.34, 0.2];
    box.material = boxMat;
    addToScene(scene, box);

    const ground = createGround(engine, { width: 8, height: 8 });
    const groundMat = createStandardMaterial();
    groundMat.diffuseColor = [0.2, 0.23, 0.27];
    ground.material = groundMat;
    addToScene(scene, ground);

    return camera;
}
`;

export const EXAMPLES: Example[] = [
    { id: "boombox", label: "glTF — BoomBox (PBR + environment)", code: BOOMBOX },
    { id: "primitives", label: "Primitives — box + ground", code: PRIMITIVES },
    {
        id: "multifile",
        label: "Multi-file — index + scene module",
        code: MULTIFILE_INDEX,
        files: { "index.ts": MULTIFILE_INDEX, "scene.ts": MULTIFILE_SCENE },
        entry: "index.ts",
    },
    { id: "mosquito-amber", label: "glTF — Mosquito in Amber (transmission)", code: MOSQUITO_AMBER },
    { id: "havok-physics", label: "Physics — Havok wrecking ball", code: HAVOK_PHYSICS },
    { id: "torus-states", label: "Shader — Torus States (raymarch + bloom)", code: TORUS_STATES },
    { id: "neon-ribbons", label: "Shader — Neon Ribbons (fullscreen effect)", code: NEON_RIBBONS },
];

export const DEFAULT_SNIPPET = EXAMPLES[0]!.code;

// Minimal starting point for the "New" button — a single light + camera and one box,
// enough to render immediately and give a clean slate to build from.
const STARTER = `import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createEngine,
    createHemisphericLight,
    createSceneContext,
    registerScene,
    startEngine,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    const camera = createArcRotateCamera(-Math.PI / 2, 1.1, 5, { x: 0, y: 0, z: 0 });
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    const box = createBox(engine, 1);
    addToScene(scene, box);

    await registerScene(scene);
    await startEngine(engine);
}

main().catch((err) => console.error(err));
`;

/** Resolve an example to a multi-file project (single-file examples get one `index.ts`). */
export function projectFor(example: Example): { files: Record<string, string>; entry: string } {
    if (example.files && example.entry) {
        return { files: { ...example.files }, entry: example.entry };
    }
    return { files: { "index.ts": example.code }, entry: "index.ts" };
}

export const DEFAULT_PROJECT = projectFor(EXAMPLES[0]!);

/** Blank-slate project loaded by the "New" button. */
export const STARTER_PROJECT: { files: Record<string, string>; entry: string } = { files: { "index.ts": STARTER }, entry: "index.ts" };
