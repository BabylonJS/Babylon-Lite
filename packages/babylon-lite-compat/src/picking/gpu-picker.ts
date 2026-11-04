/**
 * Babylon.js-compatible `GPUPicker` over Babylon Lite's GPU picker
 * (`createGpuPicker` / `pickAsync` / `disposePicker`).
 *
 * Babylon.js's `GPUPicker` is **asynchronous** GPU picking — which is exactly
 * what Babylon Lite provides — so this is a real wrapper, not a stub. You set a
 * picking list of meshes, then `pickAsync(x, y)` resolves with the picked mesh
 * (or `null`).
 *
 * Coverage notes vs. Babylon.js:
 * - `setPickingList`, `addPickingList`, `clearPickingList`, `pickAsync`,
 *   `multiPickAsync`, `pickingInProgress`, and `dispose` are implemented.
 * - The `{ mesh, material }` list-item form is accepted, but the custom picking
 *   material is ignored (Lite assigns picking ids internally).
 * - `boxPickAsync` is not supported (Lite has no box-pick primitive) and throws.
 * - Hardware `InstancedMesh` picking is not represented; thin-instance picking is
 *   surfaced through `thinInstanceIndex` exactly as Babylon.js does.
 */

import { createGpuPicker, pickAsync as litePickAsync, disposePicker } from "babylon-lite";
import type { GpuPicker, Mesh as LiteMesh, GaussianSplattingMesh as LiteGsMesh } from "babylon-lite";

import { unsupported } from "../error.js";
import { Mesh } from "../meshes/meshes.js";
import { GaussianSplattingMesh } from "../meshes/gaussian-splatting.js";
import type { Scene } from "../scene/scene.js";

/** A pickable compat mesh: a regular `Mesh` or a `GaussianSplattingMesh`. */
type PickableMesh = Mesh | GaussianSplattingMesh;

/** Result of a single GPU pick. Mirrors Babylon.js `IGPUPickingInfo`. */
export interface IGPUPickingInfo {
    mesh: PickableMesh;
    thinInstanceIndex?: number;
}

/** Result of a multi-point GPU pick. Mirrors Babylon.js `IGPUMultiPickingInfo`. */
export interface IGPUMultiPickingInfo {
    meshes: Array<PickableMesh | null>;
    thinInstanceIndexes?: number[];
}

type PickListItem = PickableMesh | { mesh: PickableMesh; material?: unknown };

function meshOf(item: PickListItem): PickableMesh {
    return item instanceof Mesh || item instanceof GaussianSplattingMesh ? item : item.mesh;
}

/** @internal The backing Lite node used as the picker's identity key for a compat mesh. */
function liteNodeOf(mesh: PickableMesh): LiteMesh | LiteGsMesh | undefined {
    return mesh instanceof GaussianSplattingMesh ? mesh._pickLiteNode : mesh._lite;
}

export class GPUPicker {
    private _picker: GpuPicker | null = null;
    private _scene: Scene | null = null;
    /** Maps Lite nodes (regular mesh or splat node) back to the compat meshes the caller supplied. */
    private readonly _liteToCompat = new Map<LiteMesh | LiteGsMesh, PickableMesh>();
    /** Regular Lite meshes that are pickable (drives the Lite `pickAsync` filter; GS meshes bypass it). */
    private _pickable = new Set<LiteMesh>();
    private _inProgress = false;

    /** True while an async pick is running (Babylon.js parity). */
    public get pickingInProgress(): boolean {
        return this._inProgress;
    }

    /** Replace the picking list. Passing `null` clears it. */
    public setPickingList(list: PickListItem[] | null): void {
        this.clearPickingList();
        if (list && list.length > 0) {
            this.addPickingList(list);
        }
    }

    /** Add meshes to the current picking list. */
    public addPickingList(list: PickListItem[]): void {
        if (!list || list.length === 0) {
            return;
        }
        const first = meshOf(list[0]!);
        const scene = first.getScene();
        if (!scene) {
            unsupported("GPUPicker.setPickingList", "Picking-list meshes must belong to a Scene (create them with a scene argument).");
        }
        if (!this._picker || this._scene !== scene) {
            // Switching to a different scene: release the previous Lite picker so
            // we don't leak its GPU resources.
            if (this._picker) {
                disposePicker(this._picker);
            }
            this._scene = scene;
            this._picker = createGpuPicker(scene._lite);
        }
        for (const item of list) {
            const mesh = meshOf(item);
            const liteNode = liteNodeOf(mesh);
            if (!liteNode) {
                // A GaussianSplattingMesh whose splat is not loaded yet has no node to
                // key on; it becomes pickable once loaded and re-added.
                continue;
            }
            this._liteToCompat.set(liteNode, mesh);
            // Only regular meshes participate in the Lite filter; the Lite picker
            // auto-includes scene splat meshes (its GS pass ignores the filter).
            if (mesh instanceof Mesh) {
                this._pickable.add(mesh._lite);
            }
        }
    }

    /** Clear the picking list and release its bookkeeping. */
    public clearPickingList(): void {
        this._liteToCompat.clear();
        this._pickable = new Set<LiteMesh>();
    }

    /** Pick the mesh at canvas coordinates `(x, y)`. Resolves to `null` on a miss. */
    public async pickAsync(x: number, y: number, disposeWhenDone = false): Promise<IGPUPickingInfo | null> {
        if (this._inProgress || !this._picker || this._liteToCompat.size === 0) {
            return null;
        }
        this._inProgress = true;
        try {
            const info = await litePickAsync(this._picker, x, y, { filter: (mesh) => this._pickable.has(mesh) });
            if (!info.hit || !info.pickedMesh) {
                return null;
            }
            const mesh = this._liteToCompat.get(info.pickedMesh as LiteMesh | LiteGsMesh);
            if (!mesh) {
                return null;
            }
            return info.thinInstanceIndex >= 0 ? { mesh, thinInstanceIndex: info.thinInstanceIndex } : { mesh };
        } finally {
            this._inProgress = false;
            if (disposeWhenDone) {
                this.dispose();
            }
        }
    }

    /** Pick at several points. Always returns one entry per coordinate (mesh or `null`). */
    public async multiPickAsync(xy: Array<{ x: number; y: number }>, disposeWhenDone = false): Promise<IGPUMultiPickingInfo | null> {
        if (this._inProgress || !this._picker || this._liteToCompat.size === 0 || xy.length === 0) {
            return null;
        }
        const meshes: Array<PickableMesh | null> = [];
        const thinInstanceIndexes: number[] = [];
        for (const point of xy) {
            // Sequential: Lite picks one pixel per call.
            const result = await this.pickAsync(point.x, point.y);
            meshes.push(result?.mesh ?? null);
            thinInstanceIndexes.push(result?.thinInstanceIndex ?? 0);
        }
        if (disposeWhenDone) {
            this.dispose();
        }
        return { meshes, thinInstanceIndexes };
    }

    /** Box picking is not implemented in Babylon Lite. */
    public boxPickAsync(): never {
        return unsupported("GPUPicker.boxPickAsync", "Box (area) picking is not implemented in Babylon Lite. Use `multiPickAsync` over the points you need.");
    }

    /** Release GPU picking resources. */
    public dispose(): void {
        if (this._picker) {
            disposePicker(this._picker);
            this._picker = null;
        }
        this._scene = null;
        this.clearPickingList();
    }
}
