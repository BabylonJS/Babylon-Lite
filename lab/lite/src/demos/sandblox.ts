/**
 * Sandblox — Babylon Lite demo.
 *
 * A blocky character on a stud-textured 512×512 ground plate under a blue
 * skybox (TropicalSunnyDay, Apache 2.0 — from the BabylonJS playground CDN).
 * WASD movement, jumping, third-person ArcRotateCamera, procedural limb
 * animations, and build-tool editing — all driven purely by the public
 * Babylon Lite API.
 *
 * World model: everything except the character and skybox is a `Part` in the
 * `Workspace`, rendered as thin instances of one shared box.
 */

import { addToScene, createEngine, createSceneContext, enableMaterialPlugins, registerSceneWithShadowSupport, startEngine } from "babylon-lite";

import { Handles } from "./sandblox/adornments/handles.js";
import { SelectionBox } from "./sandblox/adornments/selection-box.js";
import { buildCharacter } from "./sandblox/character.js";
import { Dragger } from "./sandblox/dragger.js";
import { Mouse } from "./sandblox/mouse.js";
import { createSounds } from "./sandblox/sounds.js";
import { CloneTool } from "./sandblox/tools/clone-tool.js";
import { DeleteTool } from "./sandblox/tools/delete-tool.js";
import { MoveTool } from "./sandblox/tools/move-tool.js";
import { PaintTool } from "./sandblox/tools/paint-tool.js";
import { ResizeTool } from "./sandblox/tools/resize-tool.js";
import { ToolManager } from "./sandblox/tools/tool-manager.js";
import { createLeaderboard } from "./sandblox/leaderboard.js";
import { buildLighting, setShadowCasters } from "./sandblox/lighting.js";
import { createMapIoUi } from "./sandblox/map-io-ui.js";
import { demoAssetUrl } from "./demo-asset-url.js";
import { Part } from "./sandblox/part.js";
import { Persistence } from "./sandblox/persistence.js";
import { SPAWN } from "./sandblox/physics-controller.js";
import { loadWorld } from "./sandblox/world-io.js";
import { createPartRenderer } from "./sandblox/part-renderer.js";
import { PlayerController } from "./sandblox/player-controller.js";
import { Toolbar } from "./sandblox/toolbar.js";
import { loadWorldSkybox } from "./sandblox/world.js";
import { Workspace } from "./sandblox/workspace.js";

/** Ground-plate green. Part colors live in the map JSON. */
const BASEPLATE_COLOR: [number, number, number] = [0.45, 1.0, 0.45];

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    canvas.tabIndex = 0;

    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.58, g: 0.79, b: 0.98, a: 1.0 };

    // Directional sun with PCF shadows + hemispheric ambient fill
    const lighting = buildLighting(engine);
    for (const light of lighting.lights) {
        addToScene(scene, light);
    }

    await loadWorldSkybox(scene);

    // ── Workspace + shared Part renderer ─────────────────────────────────
    const workspace = new Workspace<Part>();
    const partRenderer = await createPartRenderer(engine, scene);
    addToScene(scene, partRenderer.mesh);
    addToScene(scene, partRenderer.receiverMesh);
    addToScene(scene, partRenderer.wedgeMesh);

    // Ground plate: a locked Part, top surface at y = 0. Receiver-only so its
    // 512-stud AABB doesn't degrade the shadow-map fit.
    new Part(partRenderer, workspace, {
        size: [512, 16, 512],
        position: { x: 0, y: -8, z: 0 },
        color: BASEPLATE_COLOR,
        locked: true,
        castShadows: false,
    });

    // Saved world, or the bundled default map on first/fresh boot.
    // Map invariant: part faces align to integer world coordinates.
    Persistence.consumeFreshFlag();
    const spawnPart = (options: ConstructorParameters<typeof Part>[2]): Part => new Part(partRenderer, workspace, options);
    const persistence = new Persistence(workspace, spawnPart);
    if (!persistence.hydrate()) {
        const mapUrl = demoAssetUrl("./sandblox/default-map.json", import.meta.url);
        const res = await fetch(mapUrl);
        if (!res.ok) throw new Error(`Failed to fetch default map ${mapUrl}: ${res.status}`);
        loadWorld(await res.json(), spawnPart);
    }
    persistence.start();

    // Export/import map JSON for local iteration.
    createMapIoUi(workspace, spawnPart);

    // ── Character ────────────────────────────────────────────────────────
    const character = buildCharacter(engine);
    character.root.position.set(SPAWN.x, SPAWN.y, SPAWN.z);
    addToScene(scene, character.root);
    for (const mesh of character.allMeshes) {
        addToScene(scene, mesh);
    }

    // Character + dynamic parts cast shadows
    setShadowCasters(lighting.shadowGenerator, [...character.allMeshes, partRenderer.mesh, partRenderer.wedgeMesh]);
    enableMaterialPlugins(scene);

    // ── Build tools: mouse, adornments, dragger, tools, toolbar ──────────
    const mouse = new Mouse(workspace, scene, canvas);
    const selectionBox = new SelectionBox(engine, scene);
    const handles = new Handles(engine, scene, mouse, canvas); // Handles register before tools so handle grabs win.
    const dragger = new Dragger(workspace, mouse);
    const sounds = createSounds();
    const toolCtx = { workspace, mouse, dragger, selectionBox, sounds };
    const toolManager = new ToolManager({
        move: new MoveTool(toolCtx),
        clone: new CloneTool(toolCtx),
        delete: new DeleteTool(toolCtx),
        resize: new ResizeTool(toolCtx, handles),
        paint: new PaintTool(toolCtx),
    });
    new Toolbar({ onToolChange: toolManager.onToolChange });
    createLeaderboard();

    // Player controller — collides with the live Workspace part set
    new PlayerController(canvas, character, scene, () => workspace.parts, sounds);

    // Optional test hook for E2E interaction specs (and live debugging): read-only
    // access to world state. Enabled only with `?test=1`.
    if (new URLSearchParams(window.location.search).get("test") === "1") {
        (window as unknown as Record<string, unknown>).__sandbloxTest = { workspace, mouse, selectionBox, handles, dragger, character, spawn: spawnPart, sounds };
    }

    await registerSceneWithShadowSupport(scene);
    await startEngine(engine);

    canvas.dataset.ready = "true";
    canvas.focus();
}

main().catch((err: unknown) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
    const pre = document.createElement("pre");
    pre.style.cssText = "position:fixed;inset:0;margin:0;padding:16px;color:#0f0;background:#000;font:14px monospace;white-space:pre-wrap;z-index:9999;";
    pre.textContent = `${String(err)}\n\n${err && (err as Error).stack ? (err as Error).stack : ""}`;
    document.body.appendChild(pre);
});
