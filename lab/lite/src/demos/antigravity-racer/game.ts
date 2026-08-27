/**
 * Antigravity Racer — top-level game orchestration.
 *
 * Owns the engine, the persistent input system, the main menu, and mode
 * switching (menu background / 1P race / 2P split-screen / demo / editor).
 * Every mode is fully self-contained and disposes everything it created
 * (scenes, surfaces, HUD, listeners) when torn down, so switching modes never
 * leaks GPU resources or stale event listeners.
 */

import type { EngineContext, SurfaceContext, Vec3 } from "babylon-lite";
import {
    createEngine,
    createSceneContext,
    createSurface,
    disposeScene,
    disposeSurface,
    enableSurfaceResizeObserver,
    onBeforeRender,
    registerScene,
    startEngine,
} from "babylon-lite";

import { createInputSystem, type InputSystem } from "./input.js";
import { createMainMenu, type MainMenu } from "./menu.js";
import { createRaceHud, createEditorHud, type RaceHud, type EditorHud } from "./hud.js";
import { buildArena, addArenaToScene, type Arena } from "./world.js";
import { spawnGrid, type Grid } from "./spawn.js";
import { ChaseCamera, SpectatorCamera } from "./camera-rig.js";
import { createTrackEditor, type TrackEditor } from "./editor.js";
import { rankShips, type ShipAxes } from "./simulation.js";
import { FIXED_DT, MAX_STEPS_PER_FRAME, TOTAL_SHIP_COUNT } from "./constants.js";

const SPACE_CLEAR_COLOR = { r: 0.025, g: 0.02, b: 0.06, a: 1 };

interface RunningMode {
    dispose(): void;
}

function neutralAxes(): ShipAxes {
    return { steer: 0, accelerate: false };
}

export async function runAntigravityRacer(canvas: HTMLCanvasElement): Promise<void> {
    canvas.tabIndex = 0;
    const engine = await createEngine(canvas);
    const input = createInputSystem();

    let mode: RunningMode | null = null;

    async function teardown(): Promise<void> {
        if (mode) {
            mode.dispose();
            mode = null;
        }
    }

    async function goToMainMenu(): Promise<void> {
        await teardown();
        // Shared background behind the visible menu: no standalone exit control,
        // since the menu itself is already the "home" surface on top of it.
        mode = await buildDemoBackground(engine, input, menu);
        menu.show(input);
    }

    async function startRace1P(controlPoints?: readonly Vec3[]): Promise<void> {
        menu.hide(input);
        await teardown();
        mode = await buildRace1P(engine, input, goToMainMenu, controlPoints);
    }

    async function startRace2P(): Promise<void> {
        menu.hide(input);
        await teardown();
        mode = await buildRace2P(engine, input, canvas, goToMainMenu);
    }

    async function startDemo(): Promise<void> {
        menu.hide(input);
        await teardown();
        // Standalone attract mode: menu is hidden, so give it its own exit control.
        mode = await buildDemoBackground(engine, input, menu, goToMainMenu);
    }

    async function startEditor(): Promise<void> {
        menu.hide(input);
        await teardown();
        mode = await buildEditor(engine, input, canvas, startRace1P, goToMainMenu);
    }

    const menu: MainMenu = createMainMenu({
        onRace1P: () => void startRace1P(),
        onRace2P: () => void startRace2P(),
        onDemo: () => void startDemo(),
        onEditor: () => void startEditor(),
    });
    menu.hide(input);

    // Initial state: a living demo/attract background behind the main menu.
    mode = await buildDemoBackground(engine, input, menu);
    menu.show(input);

    await startEngine(engine);
    canvas.dataset.ready = "true";
    canvas.focus();
}

// ─── Demo / attract background ─────────────────────────────────────────────

/**
 * Builds the "attract" ship-racing spectacle. Used in two contexts that share
 * identical simulation/camera code but differ in one respect — whether there
 * is an independent way out of this mode:
 *
 * - **Shared menu background** (`onExitToMenu` omitted): runs behind the
 *   visible main menu, which is already the "home" surface on top of it. No
 *   exit hint/button is created and Escape/gamepad Start/B are left
 *   unhandled here, so the menu's own controls are the only way to act.
 * - **Standalone attract mode** (`onExitToMenu` provided): reached via the
 *   menu's "Attract Mode" button, which hides the menu entirely. Without an
 *   exit path this would strand the user, so this mode additionally wires
 *   keyboard Escape, gamepad Start/B, and a small visible DOM button back to
 *   the main menu.
 */
async function buildDemoBackground(engine: EngineContext, input: InputSystem, menu: MainMenu, onExitToMenu?: () => Promise<void>): Promise<RunningMode> {
    const scene = createSceneContext(engine);
    scene.clearColor = SPACE_CLEAR_COLOR;
    const arena = buildArena(engine);
    addArenaToScene(scene, arena);
    const grid = spawnGrid(engine, [scene], arena.track, 0, TOTAL_SHIP_COUNT);
    const spectator = new SpectatorCamera(scene, grid.rigs[0]!.state);

    const exitHint = onExitToMenu ? createAttractExitHint(() => void onExitToMenu()) : null;

    let simTime = 0;
    let acc = 0;
    let disposed = false;
    onBeforeRender(scene, (deltaMs: number) => {
        if (disposed) {
            return;
        }
        input.poll();
        if (menu.isVisible()) {
            menu.pollGamepadNav(input);
        }
        // Always drain both edges (never short-circuited) so a stray press
        // can't linger and misfire in whichever mode runs next.
        const pausePressed = input.consumePauseToggle();
        const cancelPressed = input.consumeCancel();
        if (onExitToMenu && (pausePressed || cancelPressed)) {
            void onExitToMenu();
            return;
        }
        const dt = Math.min(deltaMs / 1000, 0.25);
        acc += dt;
        let steps = 0;
        while (acc >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
            grid.tick(FIXED_DT, neutralAxes, simTime);
            simTime += FIXED_DT;
            acc -= FIXED_DT;
            steps++;
        }
        spectator.tick(
            dt,
            grid.rigs.map((r) => r.state)
        );
    });

    await registerScene(scene);
    return {
        dispose(): void {
            disposed = true;
            disposeScene(scene);
            exitHint?.dispose();
        },
    };
}

/** Small fixed DOM button + hint, shown only in standalone attract mode, for mouse/touch users. */
function createAttractExitHint(onExit: () => void): { dispose(): void } {
    const root = document.createElement("div");
    root.className = "ag-attract-hint";
    root.innerHTML = `<button type="button" class="ag-attract-btn">🏠 Main Menu <span>Esc / Start</span></button>`;
    const button = root.querySelector("button")!;
    button.addEventListener("click", onExit);
    document.body.appendChild(root);
    return {
        dispose(): void {
            root.remove();
        },
    };
}

// ─── 1-player race ──────────────────────────────────────────────────────────

async function buildRace1P(engine: EngineContext, input: InputSystem, onExitToMenu: () => Promise<void>, controlPoints?: readonly Vec3[]): Promise<RunningMode> {
    const scene = createSceneContext(engine);
    scene.clearColor = SPACE_CLEAR_COLOR;
    const arena: Arena = buildArena(engine, controlPoints);
    addArenaToScene(scene, arena);
    const grid: Grid = spawnGrid(engine, [scene], arena.track, 1, TOTAL_SHIP_COUNT - 1);
    const player = grid.rigs[0]!.state;
    const chase = new ChaseCamera(scene, player);

    const hud: RaceHud = createRaceHud(1);
    hud.setControlsHint(
        input.hasGamepad() ? "Left stick / D-pad steer · A / RT accelerate · LB/RB camera · Start pause" : "A D / ← → steer · W / ↑ accelerate · C camera · Esc pause"
    );
    hud.onResume(() => hud.hidePause(input));
    hud.onMainMenu(() => void onExitToMenu());

    let simTime = 0;
    let acc = 0;
    let disposed = false;

    let currentMode: RunningMode = {
        dispose(): void {
            disposed = true;
            disposeScene(scene);
            hud.dispose();
        },
    };
    hud.onRestart(() => {
        void (async () => {
            currentMode.dispose();
            currentMode = await buildRace1P(engine, input, onExitToMenu, controlPoints);
        })();
    });

    onBeforeRender(scene, (deltaMs: number) => {
        if (disposed) {
            return;
        }
        input.poll();
        if (input.consumePauseToggle()) {
            if (hud.isPaused()) {
                hud.hidePause(input);
            } else {
                hud.showPause(input);
            }
        }
        if (hud.isPaused()) {
            hud.pollGamepadNav(input);
            return;
        }
        const dt = Math.min(deltaMs / 1000, 0.25);
        if (input.consumeCameraToggle(0)) {
            chase.cycleOffset();
        }
        acc += dt;
        let steps = 0;
        while (acc >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
            grid.tick(FIXED_DT, (slot) => (slot === 0 ? input.getAxes(0) : neutralAxes()), simTime);
            simTime += FIXED_DT;
            acc -= FIXED_DT;
            steps++;
        }
        chase.tick(dt, player);
        const rank = rankShips(grid.rigs.map((r) => r.state)).indexOf(player) + 1;
        hud.updatePlayer(0, player, rank, grid.rigs.length);
    });

    await registerScene(scene);
    return {
        dispose(): void {
            currentMode.dispose();
        },
    };
}

// ─── 2-player split-screen race ─────────────────────────────────────────────

async function buildRace2P(engine: EngineContext, input: InputSystem, primaryCanvas: HTMLCanvasElement, onExitToMenu: () => Promise<void>): Promise<RunningMode> {
    const wrap = primaryCanvas.parentElement!;
    const canvas2 = document.createElement("canvas");
    canvas2.id = "ag-canvas-p2";
    canvas2.className = primaryCanvas.className;
    wrap.appendChild(canvas2);
    wrap.classList.add("ag-split");

    const surface2: SurfaceContext = createSurface(engine, canvas2);
    const disposeResize = enableSurfaceResizeObserver(surface2);

    const sceneA = createSceneContext(engine);
    sceneA.clearColor = SPACE_CLEAR_COLOR;
    const sceneB = createSceneContext(surface2);
    sceneB.clearColor = SPACE_CLEAR_COLOR;

    const arena: Arena = buildArena(engine);
    addArenaToScene(sceneA, arena);
    addArenaToScene(sceneB, arena);
    const grid: Grid = spawnGrid(engine, [sceneA, sceneB], arena.track, 2, TOTAL_SHIP_COUNT - 2);
    const p1 = grid.rigs[0]!.state;
    const p2 = grid.rigs[1]!.state;
    const chaseA = new ChaseCamera(sceneA, p1);
    const chaseB = new ChaseCamera(sceneB, p2);

    const hud: RaceHud = createRaceHud(2);
    hud.setControlsHint("P1: A D / W steer+accel · P2: ← → / ↑ · Esc pause");
    hud.onResume(() => hud.hidePause(input));
    hud.onMainMenu(() => void exit());

    let simTime = 0;
    let acc = 0;
    let disposed = false;

    onBeforeRender(sceneA, (deltaMs: number) => {
        if (disposed) {
            return;
        }
        input.poll();
        if (input.consumePauseToggle()) {
            if (hud.isPaused()) {
                hud.hidePause(input);
            } else {
                hud.showPause(input);
            }
        }
        if (hud.isPaused()) {
            hud.pollGamepadNav(input);
            return;
        }
        const dt = Math.min(deltaMs / 1000, 0.25);
        if (input.consumeCameraToggle(0)) {
            chaseA.cycleOffset();
        }
        if (input.consumeCameraToggle(1)) {
            chaseB.cycleOffset();
        }
        acc += dt;
        let steps = 0;
        while (acc >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
            grid.tick(FIXED_DT, (slot) => input.getAxes(slot), simTime);
            simTime += FIXED_DT;
            acc -= FIXED_DT;
            steps++;
        }
        chaseA.tick(dt, p1);
        chaseB.tick(dt, p2);
        const ranked = rankShips(grid.rigs.map((r) => r.state));
        hud.updatePlayer(0, p1, ranked.indexOf(p1) + 1, grid.rigs.length);
        hud.updatePlayer(1, p2, ranked.indexOf(p2) + 1, grid.rigs.length);
    });

    async function exit(): Promise<void> {
        await onExitToMenu();
    }

    await registerScene(sceneA);
    await registerScene(sceneB);
    return {
        dispose(): void {
            disposed = true;
            disposeScene(sceneA);
            disposeScene(sceneB);
            disposeResize();
            disposeSurface(surface2);
            canvas2.remove();
            wrap.classList.remove("ag-split");
            hud.dispose();
        },
    };
}

// ─── Track editor ───────────────────────────────────────────────────────────

async function buildEditor(
    engine: EngineContext,
    input: InputSystem,
    canvas: HTMLCanvasElement,
    onTest: (controlPoints: readonly Vec3[]) => Promise<void>,
    onExitToMenu: () => Promise<void>
): Promise<RunningMode> {
    const scene = createSceneContext(engine);
    scene.clearColor = SPACE_CLEAR_COLOR;
    const arena: Arena = buildArena(engine);
    addArenaToScene(scene, arena);

    const hud: EditorHud = createEditorHud();
    hud.onBackToMenu(() => void onExitToMenu());
    hud.onTest(() => void onTest(arena.track.controlPoints));

    const editor: TrackEditor = await createTrackEditor(engine, scene, canvas, arena.track, hud, input);
    hud.onResetTrack(() => editor.resetToDefault());

    let disposed = false;
    onBeforeRender(scene, (deltaMs: number) => {
        if (disposed) {
            return;
        }
        input.poll();
        editor.tick(Math.min(deltaMs / 1000, 0.1), input);
    });

    await registerScene(scene);
    return {
        dispose(): void {
            disposed = true;
            editor.dispose();
            disposeScene(scene);
            hud.dispose();
        },
    };
}
