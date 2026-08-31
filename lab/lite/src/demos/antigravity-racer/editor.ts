/**
 * Antigravity Racer — track editor mode.
 *
 * Seven pickable marker spheres, one per spline control point. Click a marker
 * (or Tab / gamepad shoulder button / D-pad up-down) to select it; drag with
 * the mouse via a position gizmo, or nudge with arrow keys / Page Up-Down
 * (keyboard) or the right stick (gamepad, deadzone-applied and delta-scaled by
 * NUDGE_SPEED) — any change is polled once per frame and pushed into the
 * track's control points, which triggers a live geometry rebuild. An orbit
 * camera (mouse) lets you fly around the whole loop while editing.
 */

import type { EngineContext, GpuPicker, Mesh, PositionGizmo, SceneContext, UtilityLayer } from "babylon-lite";
import {
    addToScene,
    attachControl,
    attachPositionGizmoToNode,
    createArcRotateCamera,
    createGpuPicker,
    createPositionGizmo,
    createSphere,
    createStandardMaterial,
    createUtilityLayer,
    disposePicker,
    disposePositionGizmo,
    disposeUtilityLayer,
    isGizmoDragging,
    pickAsync,
    registerUtilityLayer,
} from "babylon-lite";

import type { TrackData } from "./track.js";
import { DEFAULT_CONTROL_POINTS } from "./constants.js";
import type { InputSystem } from "./input.js";
import type { EditorHud } from "./hud.js";

const NUDGE_SPEED = 8; // world units/sec

export interface TrackEditor {
    /** Register the gizmo overlay after the main scene so it renders on top. */
    registerOverlay(): Promise<void>;
    tick(dt: number, input: InputSystem): void;
    resetToDefault(): void;
    dispose(): void;
}

export async function createTrackEditor(
    engine: EngineContext,
    scene: SceneContext,
    canvas: HTMLCanvasElement,
    track: TrackData,
    hud: EditorHud,
    input: InputSystem
): Promise<TrackEditor> {
    const cx = track.controlPoints.reduce((s, p) => s + p.x, 0) / track.controlPoints.length;
    const cy = track.controlPoints.reduce((s, p) => s + p.y, 0) / track.controlPoints.length;
    const cz = track.controlPoints.reduce((s, p) => s + p.z, 0) / track.controlPoints.length;
    const camera = createArcRotateCamera(-Math.PI / 2, 1.0, 130, { x: cx, y: cy, z: cz });
    camera.nearPlane = 0.5;
    camera.farPlane = 2000;
    scene.camera = camera;

    const markerMat = createStandardMaterial();
    markerMat.diffuseColor = [1, 0.82, 0.2];
    markerMat.emissiveColor = [0.5, 0.35, 0];
    const selectedMat = createStandardMaterial();
    selectedMat.diffuseColor = [0.25, 0.95, 0.55];
    selectedMat.emissiveColor = [0.05, 0.5, 0.2];

    const markers: Mesh[] = track.controlPoints.map((p, i) => {
        const marker = createSphere(engine, { diameter: 3 });
        marker.name = `track-point-${i}`;
        marker.material = markerMat;
        marker.position.set(p.x, p.y, p.z);
        addToScene(scene, marker);
        return marker;
    });

    const detachOrbit = attachControl(camera, canvas, scene, {
        isExternalDragActive: () => isGizmoDragging(canvas),
    });

    const utilityLayer: UtilityLayer = createUtilityLayer(engine, scene);
    const gizmo: PositionGizmo = createPositionGizmo(engine, utilityLayer);
    const picker: GpuPicker = createGpuPicker(scene);

    let selected = 0;
    let disposed = false;
    const select = (i: number): void => {
        selected = (i + markers.length) % markers.length;
        markers.forEach((m, idx) => (m.material = idx === selected ? selectedMat : markerMat));
        attachPositionGizmoToNode(gizmo, markers[selected]!);
        hud.setSelectedLabel(`Point ${selected + 1} / ${markers.length}`);
    };
    select(0);
    // A stray D-pad/confirm press from whatever the player was doing in the main
    // menu right before opening the editor must not immediately cycle/act here.
    input.resetNavEdges();

    const onPointerDown = (e: PointerEvent): void => {
        void pickAsync(picker, e.offsetX, e.offsetY).then(
            (info) => {
                if (disposed) {
                    return;
                }
                const picked = info.hit ? (info.pickedMesh as Mesh | null) : null;
                const idx = picked ? markers.indexOf(picked) : -1;
                if (idx >= 0) {
                    select(idx);
                }
            },
            (error: unknown) => {
                if (!disposed) {
                    console.error("Antigravity Racer editor pick failed.", error);
                }
            }
        );
    };
    canvas.addEventListener("pointerdown", onPointerDown);

    const keysDown = new Set<string>();
    const onKeyDown = (e: KeyboardEvent): void => {
        keysDown.add(e.code);
        if (e.code === "Tab") {
            e.preventDefault();
            select(selected + (e.shiftKey ? -1 : 1));
        }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
        keysDown.delete(e.code);
    };
    const clearKeys = (): void => keysDown.clear();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearKeys);

    const lastMarkerPos = markers.map((m) => ({ x: m.position.x, y: m.position.y, z: m.position.z }));
    let overlayRegistered = false;

    async function registerOverlay(): Promise<void> {
        if (!overlayRegistered) {
            await registerUtilityLayer(utilityLayer);
            overlayRegistered = true;
        }
    }

    function tick(dt: number, input: InputSystem): void {
        if (input.consumeCameraToggle(0) || input.consumeCameraToggle(1)) {
            select(selected + 1);
        }
        // Gamepad-only D-pad edges (consumeDpadUp/Down), distinct from consumeMenuUp/Down
        // (which also fire on the keyboard Up/Down arrows already used below for continuous nudging).
        if (input.consumeDpadDown()) {
            select(selected + 1);
        } else if (input.consumeDpadUp()) {
            select(selected - 1);
        }
        const marker = markers[selected]!;
        let dx = 0,
            dy = 0,
            dz = 0;
        if (keysDown.has("ArrowLeft")) {
            dx -= 1;
        }
        if (keysDown.has("ArrowRight")) {
            dx += 1;
        }
        if (keysDown.has("ArrowUp")) {
            dz += 1;
        }
        if (keysDown.has("ArrowDown")) {
            dz -= 1;
        }
        if (keysDown.has("PageUp")) {
            dy += 1;
        }
        if (keysDown.has("PageDown")) {
            dy -= 1;
        }
        // Right stick: x nudges sideways, y (up = negative on a standard gamepad) nudges forward.
        const rightStick = input.getRightStick(0);
        dx += rightStick.x;
        dz -= rightStick.y;
        if (dx || dy || dz) {
            marker.position.set(marker.position.x + dx * NUDGE_SPEED * dt, marker.position.y + dy * NUDGE_SPEED * dt, marker.position.z + dz * NUDGE_SPEED * dt);
        }

        let changed = false;
        for (let i = 0; i < markers.length; i++) {
            const m = markers[i]!;
            const last = lastMarkerPos[i]!;
            if (Math.abs(m.position.x - last.x) > 1e-4 || Math.abs(m.position.y - last.y) > 1e-4 || Math.abs(m.position.z - last.z) > 1e-4) {
                last.x = m.position.x;
                last.y = m.position.y;
                last.z = m.position.z;
                track.controlPoints[i]!.x = m.position.x;
                track.controlPoints[i]!.y = m.position.y;
                track.controlPoints[i]!.z = m.position.z;
                changed = true;
            }
        }
        if (changed) {
            track.rebuild();
        }
    }

    function resetToDefault(): void {
        for (let i = 0; i < markers.length; i++) {
            const d = DEFAULT_CONTROL_POINTS[i]!;
            markers[i]!.position.set(d.x, d.y, d.z);
            lastMarkerPos[i]!.x = d.x;
            lastMarkerPos[i]!.y = d.y;
            lastMarkerPos[i]!.z = d.z;
            track.controlPoints[i]!.x = d.x;
            track.controlPoints[i]!.y = d.y;
            track.controlPoints[i]!.z = d.z;
        }
        track.rebuild();
    }

    function dispose(): void {
        disposed = true;
        canvas.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("blur", clearKeys);
        detachOrbit();
        // Gizmo must be torn down before the utility layer it lives on; the
        // picker is scene-owned and independent of the layer/gizmo teardown.
        disposePositionGizmo(gizmo, utilityLayer);
        disposePicker(picker);
        disposeUtilityLayer(utilityLayer);
    }

    return { registerOverlay, tick, resetToDefault, dispose };
}
