// Scene 149: Babylon.js PowerPlant glb rendered through the frame-graph geometry
// renderer task, where EVERY original material is replaced by a NodeMaterial. The
// geometry data comes from the new node-material geometry-output path (the
// `GeometryTextureOutputBlock` terminal, Lite's analogue of BJS
// `PrePassOutputBlock`).
//
// ONE generic node-material graph (scene149-nme.ts) is instantiated once per
// original PowerPlant material; only that instance's albedo texture is swapped,
// then the original meshes are re-pointed at the node material.
//
// SEVEN geometry impostors are displayed on a single bottom strip: viewNormal,
// worldNormal, worldPosition, reflectivity, localPosition, viewDepth,
// screenspaceDepth. albedo / irradiance / normalizedViewDepth / linearVelocity are
// NOT displayed: BJS's PrePassOutputBlock has no faithful equivalent for them, so
// they cannot be parity-compared. emitColor (real-colour target) is intentionally NOT used — the
// node geometry path does not implement the extra colour attachment.

import {
    addTask,
    addTaskAtStart,
    addToScene,
    attachControl,
    createCopyToTextureTask,
    createDefaultCamera,
    createEngine,
    createGeometryRendererTask,
    createRenderTarget,
    createRenderTask,
    createSceneContext,
    createSolidTexture2D,
    GeometryTextureType,
    loadGltf,
    loadNodeBlockEmitterWithGeometry,
    parseNodeMaterialFromSnippet,
    registerScene,
    startEngine,
} from "babylon-lite";
import type { AssetContainer, Material, Mesh, Texture2D } from "babylon-lite";
import { SCENE149_NME_JSON } from "../shared/scene149-nme.js";

const POWERPLANT_URL = "https://assets.babylonjs.com/meshes/PowerPlant/powerplant.glb";

/** Flatten every renderable mesh out of a loaded asset container's node tree. */
function collectMeshes(container: AssetContainer): Mesh[] {
    const out: Mesh[] = [];
    const stack: unknown[] = [...container.entities];
    while (stack.length > 0) {
        const node = stack.pop() as { _gpu?: unknown; material?: unknown; children?: unknown[] } | undefined;
        if (!node) {
            continue;
        }
        if ("_gpu" in node && "material" in node) {
            out.push(node as unknown as Mesh);
        }
        if (node.children?.length) {
            stack.push(...node.children);
        }
    }
    return out;
}

/** Read the albedo (base-color) texture from an original glTF material, falling
 *  back to a solid texture built from its base-color factor when none exists. */
function resolveAlbedo(engine: Parameters<typeof createSolidTexture2D>[0], mat: Material): Texture2D {
    const m = mat as {
        baseColorTexture?: Texture2D;
        baseColorFactor?: readonly number[];
        diffuseTexture?: Texture2D;
        diffuseColor?: readonly number[];
    };
    if (m.baseColorTexture) {
        return m.baseColorTexture;
    }
    if (m.diffuseTexture) {
        return m.diffuseTexture;
    }
    const c = m.baseColorFactor ?? m.diffuseColor ?? [0.8, 0.8, 0.8];
    return createSolidTexture2D(engine, c[0] ?? 0.8, c[1] ?? 0.8, c[2] ?? 0.8, 1);
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, {
        // Two MRTs at up to 7 attachments each exceed the default 32-byte-per-sample limit.
        requiredLimits: { maxColorAttachmentBytesPerSample: 64 },
    });
    const scene = createSceneContext(engine, { defaultRenderTask: false });

    const loaded = await loadGltf(engine, POWERPLANT_URL);

    // Replace every original material with an instance of the generic node-material
    // graph BEFORE addToScene — addToScene registers a deferred renderable builder
    // keyed by each mesh's material `_buildGroup` at add time, so the material must
    // already be the node material when the mesh is admitted.
    const byMaterial = new Map<Material, Mesh[]>();
    for (const mesh of collectMeshes(loaded)) {
        const mat = mesh.material;
        if (!mat) {
            continue;
        }
        let list = byMaterial.get(mat);
        if (!list) {
            list = [];
            byMaterial.set(mat, list);
        }
        list.push(mesh);
    }
    for (const [origMat, meshes] of byMaterial) {
        const nodeMat = await parseNodeMaterialFromSnippet(engine, "", { json: SCENE149_NME_JSON, blockLoader: loadNodeBlockEmitterWithGeometry });
        nodeMat.inputs.albedo!.texture = resolveAlbedo(engine, origMat);
        for (const mesh of meshes) {
            mesh.material = nodeMat;
        }
    }
    canvas.dataset.materialCount = String(byMaterial.size);

    addToScene(scene, loaded);

    // Auto-frame the camera to the model bounds, then apply the playground's orbit
    // angles (matches Scene 147/148's PowerPlant placement).
    const camera = createDefaultCamera(scene);
    camera.alpha = -3.12;
    camera.beta = 1.3;
    camera.radius = 75.63;
    scene.camera = camera;
    attachControl(camera, canvas, scene);

    const samples = engine.msaaSamples as 1 | 4;

    // Intermediate offscreen target — main scene + impostor strip composite here.
    const intermediateTarget = createRenderTarget({
        lbl: "scene149-intermediate",
        format: engine.format,
        dFormat: "depth24plus-stencil8",
        samples: samples,
        size: engine,
    });
    const ssIntermediate = createRenderTarget({
        lbl: "scene149-ss-intermediate",
        format: engine.format,
        samples: 1,
        size: engine,
    });
    const scRT = engine.scRT;
    const sceneTask = createRenderTask(
        {
            name: "scene149-scene",
            rt: intermediateTarget,
            clrColor: scene.clearColor,
            clr: true,
        },
        engine,
        scene
    );

    // Geometry renderer tasks — split into two so we stay under the WebGPU
    // per-pass color-attachment cap (8). Task A holds 7 attachments, task B
    // holds the remaining 4. Each owns its own depth. No targetTexture: the
    // node geometry path does not emit the real (lit) colour attachment.
    const geomTaskA = createGeometryRendererTask(
        {
            name: "scene149-geom-a",
            samples,
            textureDescriptions: [
                { type: GeometryTextureType.IRRADIANCE },
                { type: GeometryTextureType.WORLD_POSITION },
                { type: GeometryTextureType.NORMALIZED_VIEW_DEPTH },
                { type: GeometryTextureType.VIEW_NORMAL },
                { type: GeometryTextureType.WORLD_NORMAL },
                { type: GeometryTextureType.REFLECTIVITY },
                { type: GeometryTextureType.ALBEDO },
            ],
        },
        engine,
        scene
    );
    const geomTaskB = createGeometryRendererTask(
        {
            name: "scene149-geom-b",
            samples,
            textureDescriptions: [
                { type: GeometryTextureType.LOCAL_POSITION },
                { type: GeometryTextureType.VIEW_DEPTH, format: "r16float" },
                { type: GeometryTextureType.SCREENSPACE_DEPTH },
                { type: GeometryTextureType.LINEAR_VELOCITY },
            ],
        },
        engine,
        scene
    );

    addTaskAtStart(scene, sceneTask);
    addTask(scene, geomTaskA);
    addTask(scene, geomTaskB);

    // Seven displayed geometry impostors on a single bottom strip (albedo / irradiance /
    // normalizedViewDepth / linearVelocity are intentionally NOT displayed — BJS's
    // PrePassOutputBlock has no faithful equivalent for them, so they cannot be
    // parity-compared). Laid out IDENTICALLY to the BJS reference so tile rectangles line up.
    const impostors = [
        { name: "viewNormal", source: geomTaskA.geometryViewNormalTexture! },
        { name: "worldNormal", source: geomTaskA.geometryWorldNormalTexture! },
        { name: "worldPosition", source: geomTaskA.geometryWorldPositionTexture! },
        { name: "reflectivity", source: geomTaskA.geometryReflectivityTexture! },
        { name: "localPosition", source: geomTaskB.geometryLocalPositionTexture! },
        { name: "viewDepth", source: geomTaskB.geometryViewDepthTexture! },
        { name: "screenspaceDepth", source: geomTaskB.geometryScreenspaceDepthTexture! },
    ];
    const placeStrip = (strip: { name: string; source: typeof intermediateTarget }[], y: number) => {
        const tileW = 1 / strip.length;
        for (let i = 0; i < strip.length; i++) {
            const entry = strip[i]!;
            addTask(
                scene,
                createCopyToTextureTask(
                    {
                        name: `scene149-impostor-${entry.name}`,
                        sourceTexture: entry.source,
                        targetTexture: intermediateTarget,
                        viewport: { x: i * tileW, y, width: tileW, height: 0.15 },
                    },
                    engine,
                    scene
                )
            );
        }
    };
    placeStrip(impostors, 0);

    if (samples > 1) {
        addTask(
            scene,
            createCopyToTextureTask(
                {
                    name: "scene149-resolve",
                    sourceTexture: intermediateTarget,
                    resolveTexture: ssIntermediate,
                },
                engine,
                scene
            )
        );
    }
    addTask(
        scene,
        createCopyToTextureTask(
            {
                name: "scene149-to-swap",
                sourceTexture: samples > 1 ? ssIntermediate : intermediateTarget,
                targetTexture: scRT,
            },
            engine,
            scene
        )
    );

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
