/**
 * Antigravity Racer — top-level game orchestration.
 *
 * Owns the engine, the persistent input system, the persistent world resources,
 * the main menu, and mode switching. The playground's five modes are preserved
 * exactly:
 *
 *   Edit Track     initEditing(scene)
 *   Test Track     initPlay(scene, 1, 1)   1 human, no AI
 *   1P Race        initPlay(scene, 8, 1)   1 human + 7 AI
 *   2P split Race  initPlay(scene, 8, 2)   2 humans + 6 AI
 *   Demo           initPlay(scene, 8, 0)   8 AI + the attract camera
 *
 * Test Track / 1P / 2P split / Demo (and the menu's attract background) all run through ONE
 * `buildRace`, which drives its scene through the shared `driveFixedStep` loop: a 60 Hz accumulator
 * that ticks the simulation AND the cameras with the original's per-tick constants. Edit Track has no
 * simulation to fix-step, so it is not a `buildRace` variant: `buildEditor` drives the spline/HUD/gizmo
 * editing through its own variable-delta `onBeforeRender` tick instead.
 *
 * Lifetime, mirroring the playground's single long-lived scene: the engine, the
 * input system, the models and the world (terrain, boulders, track, cascades —
 * see `world.ts`) are built ONCE and live for the page. A mode owns only its
 * scenes, cameras, HUD and ship grid, and disposes exactly those on teardown, so
 * switching modes neither leaks GPU memory nor rebuilds the world.
 */

import type { EngineContext, SceneContext, SurfaceContext } from "babylon-lite";
import {
    createEngine,
    createSceneContext,
    createSurface,
    disposeScene,
    disposeSurface,
    enableSurfaceResizeObserver,
    onBeforeRender,
    registerSceneWithShadowSupport,
    startEngine,
} from "babylon-lite";

import { createInputSystem, type InputSystem } from "./input.js";
import { createMainMenu, type MainMenu } from "./menu.js";
import { createRaceHud, createEditorHud, type RaceHud, type EditorHud } from "./hud.js";
import { loadRacerAssets, type RacerAssets } from "./assets.js";
import { addWorldToScene, createRacerWorlds, setWorldCasters, SPACE_CLEAR_COLOR, type RacerWorlds, type RenderWorld } from "./world.js";
import { spawnGrid, type Grid } from "./spawn.js";
import { ChaseCamera, DemoCamera } from "./camera-rig.js";
import { createTrackEditor, type TrackEditor } from "./editor.js";
import type { ShipControls } from "./simulation.js";
import { loadRacerEnvironment } from "./environment.js";
import { FIXED_DT, MAX_STEPS_PER_FRAME, TICK_TIME, TOTAL_SHIP_COUNT } from "./constants.js";

interface RunningMode {
    dispose(): void;
}

const NO_CONTROLS: ShipControls = { left: false, right: false, accelerate: false };

/**
 * Drive one scene's fixed 60 Hz simulation clock.
 *
 * `frame` runs once per rendered frame (input polling, pause handling) and returns `false` to skip
 * stepping — the accumulator is then dropped so a long pause cannot burst on resume. `step` runs the
 * simulation and the cameras with the original's per-tick constants; `simTime` is the playground's
 * `time`, advanced by its rounded `0.0166` rather than by the exact step duration.
 */
function driveFixedStep(scene: SceneContext, frame: (deltaMs: number) => boolean, step: (simTime: number) => void): () => void {
    let simTime = 0;
    let accumulator = 0;
    let disposed = false;
    onBeforeRender(scene, (deltaMs: number) => {
        if (disposed) {
            return;
        }
        if (!frame(deltaMs)) {
            accumulator = 0;
            return;
        }
        accumulator += Math.min(deltaMs / 1000, 0.25);
        let steps = 0;
        while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
            step(simTime);
            simTime += TICK_TIME;
            accumulator -= FIXED_DT;
            steps++;
        }
    });
    return () => {
        disposed = true;
    };
}

export async function runAntigravityRacer(canvas: HTMLCanvasElement): Promise<void> {
    canvas.tabIndex = 0;
    const engine = await createEngine(canvas);
    const input = createInputSystem();
    // Ship + boulder models are loaded once for the whole page and cloned per mode
    // (see assets.ts), so switching modes never re-decodes their textures.
    const assets = await loadRacerAssets(engine);
    // The world (terrain, boulders, track pieces, lights, cascades) is built once for the whole page
    // too — a mode only adds it to its own scenes (see world.ts).
    const worlds = await createRacerWorlds(engine, assets);

    let mode: RunningMode | null = null;

    function teardown(): void {
        mode?.dispose();
        mode = null;
    }

    async function goToMainMenu(): Promise<void> {
        teardown();
        // Shared background behind the visible menu: no standalone exit control,
        // since the menu itself is already the "home" surface on top of it.
        mode = await buildRace(engine, assets, worlds, input, canvas, { humanCount: 0, aiCount: TOTAL_SHIP_COUNT, isMenuBackground: true }, { menu, goToMainMenu });
        menu.show(input);
    }

    function startRace(humanCount: 0 | 1 | 2, aiCount: number): () => Promise<void> {
        const start = async (): Promise<void> => {
            menu.hide(input);
            teardown();
            mode = await buildRace(engine, assets, worlds, input, canvas, { humanCount, aiCount, isMenuBackground: false }, { menu, goToMainMenu, restart: start });
        };
        return start;
    }

    async function startEditor(): Promise<void> {
        menu.hide(input);
        teardown();
        mode = await buildEditor(engine, worlds, input, canvas, () => startRace(1, 0)(), goToMainMenu);
    }

    const menu: MainMenu = createMainMenu({
        onTestTrack: () => void startRace(1, 0)(),
        onRace1P: () => void startRace(1, TOTAL_SHIP_COUNT - 1)(),
        onRace2P: () => void startRace(2, TOTAL_SHIP_COUNT - 2)(),
        onDemo: () => void startRace(0, TOTAL_SHIP_COUNT)(),
        onEditor: () => void startEditor(),
    });
    menu.hide(input);

    // Initial state: a living attract background behind the main menu.
    mode = await buildRace(engine, assets, worlds, input, canvas, { humanCount: 0, aiCount: TOTAL_SHIP_COUNT, isMenuBackground: true }, { menu, goToMainMenu });
    menu.show(input);

    await startEngine(engine);
    canvas.dataset.ready = "true";
    canvas.focus();
}

// ─── Races (Test Track / 1P / 2P split / Demo / menu background) ─────────────

interface RaceConfig {
    /** 0 = attract mode (demo camera), 1 = Test Track or 1P Race, 2 = split-screen. */
    humanCount: 0 | 1 | 2;
    aiCount: number;
    /** Runs behind the visible main menu: no HUD and no exit control of its own. */
    isMenuBackground: boolean;
}

interface RaceNav {
    menu: MainMenu;
    goToMainMenu: () => Promise<void>;
    restart?: () => Promise<void>;
}

function controlsHint(input: InputSystem, humanCount: number): string {
    if (humanCount === 2) {
        return "P1: A D steer · W accelerate · C camera — P2: ← → steer · ↑ accelerate · RShift camera — Esc pause";
    }
    return input.hasGamepad() ? "Left stick / D-pad steer · A / RT accelerate · LB/RB camera · Start pause" : "A D / ← → steer · W / ↑ accelerate · C camera · Esc pause";
}

async function buildRace(
    engine: EngineContext,
    assets: RacerAssets,
    worlds: RacerWorlds,
    input: InputSystem,
    canvas: HTMLCanvasElement,
    cfg: RaceConfig,
    nav: RaceNav
): Promise<RunningMode> {
    const split = cfg.humanCount === 2;
    const scenes: SceneContext[] = [];
    const disposers: (() => void)[] = [];

    const sceneA = createSceneContext(engine);
    sceneA.clearColor = SPACE_CLEAR_COLOR;
    scenes.push(sceneA);

    let secondCanvas: HTMLCanvasElement | null = null;
    if (split) {
        const wrap = canvas.parentElement!;
        secondCanvas = document.createElement("canvas");
        secondCanvas.id = "ag-canvas-p2";
        secondCanvas.className = canvas.className;
        wrap.appendChild(secondCanvas);
        wrap.classList.add("ag-split");
        const surface: SurfaceContext = createSurface(engine, secondCanvas);
        const stopResize = enableSurfaceResizeObserver(surface);
        const sceneB = createSceneContext(surface);
        sceneB.clearColor = SPACE_CLEAR_COLOR;
        scenes.push(sceneB);
        const canvas2 = secondCanvas;
        disposers.push(() => {
            stopResize();
            disposeSurface(surface);
            canvas2.remove();
            wrap.classList.remove("ag-split");
        });
    }

    // One world per pane: pane 2's cascades must be fit to pane 2's camera, so it gets its own
    // generator (and its own track receiver/caster pair) rather than sharing pane 1's.
    const paneWorlds: RenderWorld[] = [worlds.primary];
    if (split) {
        paneWorlds.push(worlds.secondary());
    }
    for (let i = 0; i < scenes.length; i++) {
        addWorldToScene(scenes[i]!, paneWorlds[i]!);
    }
    await Promise.all(scenes.map(loadRacerEnvironment));

    const grid: Grid = spawnGrid(engine, assets, scenes, worlds.track, cfg.humanCount, cfg.aiCount);
    for (const world of paneWorlds) {
        setWorldCasters(world, grid.casterMeshes);
    }

    const chases = cfg.humanCount === 0 ? [] : scenes.map((scene, i) => new ChaseCamera(scene, grid.rigs[i]!.state));
    const demoCamera =
        cfg.humanCount === 0
            ? new DemoCamera(
                  sceneA,
                  worlds.track,
                  grid.rigs.map((r) => r.state)
              )
            : null;

    // The attract mode has no player, so it gets no HUD — just an exit affordance when it is
    // the foreground mode (the menu background already has the menu itself on top).
    const hud: RaceHud | null = cfg.isMenuBackground || cfg.humanCount === 0 ? null : createRaceHud(cfg.humanCount === 2 ? 2 : 1);
    const exitHint = !cfg.isMenuBackground && cfg.humanCount === 0 ? createAttractExitHint(() => void nav.goToMainMenu()) : null;

    let disposed = false;
    const controlsForSlot = (slot: 0 | 1): ShipControls => (slot < cfg.humanCount ? input.getControls(slot) : NO_CONTROLS);

    if (hud) {
        hud.setControlsHint(controlsHint(input, cfg.humanCount));
        hud.onResume(() => hud.hidePause(input));
        hud.onMainMenu(() => void nav.goToMainMenu());
        if (nav.restart) {
            const restart = nav.restart;
            hud.onRestart(() => void restart());
        }
    }

    const stopLoop = driveFixedStep(
        sceneA,
        (): boolean => {
            if (disposed) {
                return false;
            }
            input.poll();
            if (nav.menu.isVisible()) {
                nav.menu.pollGamepadNav(input);
            }
            // Both edges are always drained so a stray press can't linger into the next mode.
            const pausePressed = input.consumePauseToggle();
            const cancelPressed = input.consumeCancel();
            if (hud) {
                if (pausePressed) {
                    if (hud.isPaused()) {
                        hud.hidePause(input);
                    } else {
                        hud.showPause(input);
                    }
                }
                if (hud.isPaused()) {
                    hud.pollGamepadNav(input);
                    return false;
                }
            } else if (exitHint && (pausePressed || cancelPressed)) {
                void nav.goToMainMenu();
                return false;
            }
            for (let i = 0; i < chases.length; i++) {
                if (input.consumeCameraToggle(i as 0 | 1)) {
                    chases[i]!.cycleOffset();
                }
            }
            return true;
        },
        (simTime: number): void => {
            grid.tick(controlsForSlot, simTime);
            for (let i = 0; i < chases.length; i++) {
                chases[i]!.tick();
            }
            demoCamera?.tick();
            if (hud) {
                for (let i = 0; i < chases.length; i++) {
                    hud.updatePlayer(i, grid.rigs[i]!.state);
                }
            }
        }
    );

    for (const scene of scenes) {
        await registerSceneWithShadowSupport(scene);
    }

    return {
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            stopLoop();
            for (const scene of scenes) {
                disposeScene(scene);
            }
            grid.dispose();
            // The world outlives the mode; only its ship casters go away with the grid.
            for (const world of paneWorlds) {
                setWorldCasters(world, []);
            }
            hud?.dispose();
            exitHint?.dispose();
            for (const fn of disposers) {
                fn();
            }
        },
    };
}

/** Small fixed DOM button + hint, shown only in standalone attract mode, for mouse/touch users. */
function createAttractExitHint(onExit: () => void): { dispose(): void } {
    const root = document.createElement("div");
    root.className = "ag-attract-hint";
    root.innerHTML = `<button type="button" class="ag-attract-btn">🏠 Main Menu <span>Esc / Start</span></button>`;
    root.querySelector("button")!.addEventListener("click", onExit);
    document.body.appendChild(root);
    return {
        dispose(): void {
            root.remove();
        },
    };
}

// ─── Track editor ───────────────────────────────────────────────────────────

async function buildEditor(
    engine: EngineContext,
    worlds: RacerWorlds,
    input: InputSystem,
    canvas: HTMLCanvasElement,
    onTest: () => Promise<void>,
    onExitToMenu: () => Promise<void>
): Promise<RunningMode> {
    const scene = createSceneContext(engine);
    scene.clearColor = SPACE_CLEAR_COLOR;
    const world = worlds.primary;
    addWorldToScene(scene, world);
    await loadRacerEnvironment(scene);
    // No ships in the editor: the cascades carry the world's own casters only.
    setWorldCasters(world, []);

    const hud: EditorHud = createEditorHud();
    hud.onBackToMenu(() => void onExitToMenu());
    hud.onTest(() => void onTest());

    // The editor mutates the session's one spline source, so every world's track — including the
    // split-screen pane built later — follows the edit and keeps it for the modes that come next,
    // exactly like the playground's single global track.
    const editor: TrackEditor = await createTrackEditor(engine, scene, canvas, worlds.track, hud, input);
    hud.onResetTrack(() => editor.resetToDefault());

    let disposed = false;
    onBeforeRender(scene, (deltaMs: number) => {
        if (disposed) {
            return;
        }
        input.poll();
        editor.tick(Math.min(deltaMs / 1000, 0.1), input);
    });

    await registerSceneWithShadowSupport(scene);
    return {
        dispose(): void {
            disposed = true;
            editor.dispose();
            disposeScene(scene);
            hud.dispose();
        },
    };
}
