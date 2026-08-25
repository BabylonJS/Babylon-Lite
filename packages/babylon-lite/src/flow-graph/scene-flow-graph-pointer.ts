import type { Mesh } from "../mesh/mesh.js";
import type { PickingInfo } from "../picking/picking-info.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { FgRuntime } from "./runtime.js";
import { pumpFgEvent } from "./event-bus.js";
import { FgEventType } from "./types.js";

interface PickedInteractivityMesh extends Mesh {
    _gltfNodeIndex?: number;
}

function graphUsesPointerEvent(runtime: FgRuntime): boolean {
    return runtime.graph.blocks.some((block) => block.event === FgEventType.Pointer);
}

function isFlowGraphMeshSelectable(scene: SceneContext, mesh: Mesh): boolean {
    const nodeIndex = (mesh as PickedInteractivityMesh)._gltfNodeIndex;
    if (nodeIndex === undefined) {
        return false;
    }
    const selectablePointer = `/nodes/${nodeIndex}/extensions/KHR_node_selectability/selectable`;
    return !(scene._flowGraphs?.filter(graphUsesPointerEvent) ?? []).some((runtime) => runtime.env.accessors[selectablePointer]?.get() === false);
}

/** Dispatch one successful scene pick to every distinct Flow Graph event bus. */
export function dispatchFlowGraphPointerPick(scene: SceneContext, pick: PickingInfo): void {
    const nodeIndex = (pick.pickedMesh as PickedInteractivityMesh | null)?._gltfNodeIndex;
    const runtimes = scene._flowGraphs?.filter(graphUsesPointerEvent) ?? [];
    const selectablePointer = `/nodes/${nodeIndex}/extensions/KHR_node_selectability/selectable`;
    if (!pick.hit || nodeIndex === undefined || runtimes.some((runtime) => runtime.env.accessors[selectablePointer]?.get() === false)) {
        return;
    }
    const buses = new Set(runtimes.map((runtime) => runtime.env.events));
    for (const bus of buses) {
        pumpFgEvent(bus, FgEventType.Pointer, {
            nodeIndex,
            controllerIndex: 0,
            event: "/extensions/KHR_interactivity/events/pointer",
        });
    }
}

function refreshFlowGraphPointerPicking(scene: SceneContext): Promise<void> | undefined {
    if (!scene._flowGraphs?.some(graphUsesPointerEvent)) {
        scene._flowGraphPointerCleanup?.();
        return;
    }
    if (scene._flowGraphPointerCleanup || scene._flowGraphPointerInit) {
        return scene._flowGraphPointerInit;
    }
    scene._flowGraphPointerInit = import("../picking/gpu-picker.js")
        .then(({ createGpuPicker, pickAsync, disposePicker }) => {
            if (!scene._flowGraphs?.some(graphUsesPointerEvent)) {
                return;
            }
            const canvas = scene.surface.canvas;
            if (!("addEventListener" in canvas)) {
                return;
            }
            const picker = createGpuPicker(scene);
            let disposed = false;
            let press: { pointerId: number; x: number; y: number } | undefined;
            const onPointerDown = (event: Event): void => {
                const pointer = event as PointerEvent;
                if (pointer.button === 0) {
                    press = { pointerId: pointer.pointerId, x: pointer.offsetX, y: pointer.offsetY };
                }
            };
            const onPointerUp = (event: Event): void => {
                const pointer = event as PointerEvent;
                const start = press;
                press = undefined;
                if (!start || start.pointerId !== pointer.pointerId || Math.hypot(pointer.offsetX - start.x, pointer.offsetY - start.y) > 5) {
                    return;
                }
                void pickAsync(picker, pointer.offsetX, pointer.offsetY, { filter: (mesh) => isFlowGraphMeshSelectable(scene, mesh) })
                    .then((pick) => {
                        if (!disposed) {
                            dispatchFlowGraphPointerPick(scene, pick);
                        }
                    })
                    .catch((error: unknown) => {
                        console.error("Flow Graph pointer selection failed:", error);
                    });
            };
            const onPointerCancel = (): void => {
                press = undefined;
            };
            canvas.addEventListener("pointerdown", onPointerDown);
            canvas.addEventListener("pointerup", onPointerUp);
            canvas.addEventListener("pointercancel", onPointerCancel);
            scene._flowGraphPointerCleanup = () => {
                if (disposed) {
                    return;
                }
                disposed = true;
                canvas.removeEventListener("pointerdown", onPointerDown);
                canvas.removeEventListener("pointerup", onPointerUp);
                canvas.removeEventListener("pointercancel", onPointerCancel);
                disposePicker(picker);
                scene._flowGraphPointerCleanup = undefined;
            };
        })
        .finally(() => {
            scene._flowGraphPointerInit = undefined;
        });
    return scene._flowGraphPointerInit;
}

/** Enable canvas pointer selection for Flow Graph pointer-event blocks on a scene.
 * Keeping this bridge explicit prevents the optional GPU picker from entering
 * bundles that only load non-interactive glTF assets. */
export function enableFlowGraphPointerPicking(scene: SceneContext): Promise<void> | undefined {
    scene._flowGraphPointerRefresh = () => {
        void refreshFlowGraphPointerPicking(scene);
    };
    return refreshFlowGraphPointerPicking(scene);
}
