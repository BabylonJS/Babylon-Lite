/**
 * SelectionBox — a thin-instance wireframe outline around the selected part.
 *
 * A component in the traditional sense: point `adornee` at any Part and a
 * light-blue box outline appears around it, tracking the part's transform via
 * its onChange notifications. Tool-agnostic — Move/Delete hover, Resize
 * selection, and the Dragger all reuse one instance.
 *
 * Rendering: ONE dedicated thin-instanced unit-box mesh with 12 instances
 * (one per edge), unlit emissive material. Hiding = instance count 0; no
 * meshes are created or destroyed after construction (GPU buffer is allocated
 * once for 12 instances). Never a shadow caster and never in the Workspace,
 * so it can't be picked or collide.
 */

import type { EngineContext, Mesh, SceneContext } from "babylon-lite";
import {
    addToScene,
    createBox,
    createStandardMaterial,
    enableThinInstanceGpuCulling,
    markMaterialUboDirty,
    mat4Compose,
    setThinInstanceCount,
    setThinInstanceMatrix,
    setThinInstances,
} from "babylon-lite";

import type { Part } from "./../part.js";

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Edge thickness in studs. */
const EDGE_T = 0.12;
/** Outline inflation beyond the part surface, in studs. */
const INFLATE = 0.06;
/** Selection light-blue. */
const DEFAULT_COLOR: readonly [number, number, number] = [0.4, 0.75, 1.0];

// ── SelectionBox ─────────────────────────────────────────────────────────────

export class SelectionBox {
    private readonly _mesh: Mesh;
    private readonly _material: ReturnType<typeof createStandardMaterial>;
    private readonly _emissive: [number, number, number];
    private _adornee: Part | null = null;
    private readonly _onAdorneeChange = (): void => this._refresh();

    constructor(engine: EngineContext, scene: SceneContext) {
        const mat = createStandardMaterial();
        mat.disableLighting = true;
        mat.diffuseColor = [1, 1, 1];
        this._emissive = [...DEFAULT_COLOR] as [number, number, number];
        mat.emissiveColor = this._emissive;

        this._material = mat;
        this._mesh = createBox(engine);
        this._mesh.material = mat;
        // Pre-size the instance buffer once (12 edges), then hide. GPU culling
        // opt-in routes the renderable to the per-frame direct draw list —
        // required for live show/hide/retarget (see part-renderer.ts).
        setThinInstances(this._mesh, new Float32Array(12 * 16), 12);
        setThinInstanceCount(this._mesh, 0);
        enableThinInstanceGpuCulling(this._mesh);
        addToScene(scene, this._mesh);
    }

    get adornee(): Part | null {
        return this._adornee;
    }

    set adornee(part: Part | null) {
        if (part === this._adornee) {
            return;
        }
        this._adornee?.offChange(this._onAdorneeChange);
        this._adornee = part;
        part?.onChange(this._onAdorneeChange);
        this._refresh();
    }

    /** Outline color (e.g. red tint for the Delete tool hover). */
    setColor(rgb: readonly [number, number, number]): void {
        this._emissive[0] = rgb[0];
        this._emissive[1] = rgb[1];
        this._emissive[2] = rgb[2];
        markMaterialUboDirty(this._material);
    }

    dispose(): void {
        this.adornee = null;
    }

    // ── Private ──────────────────────────────────────────────────────────

    private _refresh(): void {
        const part = this._adornee;
        if (!part || part.destroyed) {
            if (part?.destroyed) {
                this._adornee = null;
            }
            setThinInstanceCount(this._mesh, 0);
            return;
        }

        const b = part.getAABB();
        const minX = b.minX - INFLATE,
            minY = b.minY - INFLATE,
            minZ = b.minZ - INFLATE;
        const maxX = b.maxX + INFLATE,
            maxY = b.maxY + INFLATE,
            maxZ = b.maxZ + INFLATE;
        const cx = (minX + maxX) / 2,
            cy = (minY + maxY) / 2,
            cz = (minZ + maxZ) / 2;
        const lx = maxX - minX + EDGE_T,
            ly = maxY - minY + EDGE_T,
            lz = maxZ - minZ + EDGE_T;

        // 12 edges: 4 along X, 4 along Y, 4 along Z (axis-aligned scaled boxes).
        let slot = 0;
        const edge = (px: number, py: number, pz: number, sx: number, sy: number, sz: number): void => {
            const m = mat4Compose(px, py, pz, 0, 0, 0, 1, sx, sy, sz);
            setThinInstanceMatrix(this._mesh, slot++, m);
        };
        for (const sy of [minY, maxY]) {
            for (const sz of [minZ, maxZ]) {
                edge(cx, sy, sz, lx, EDGE_T, EDGE_T);
            }
        }
        for (const sx of [minX, maxX]) {
            for (const sz of [minZ, maxZ]) {
                edge(sx, cy, sz, EDGE_T, ly, EDGE_T);
            }
        }
        for (const sx of [minX, maxX]) {
            for (const sy of [minY, maxY]) {
                edge(sx, sy, cz, EDGE_T, EDGE_T, lz);
            }
        }
        setThinInstanceCount(this._mesh, 12);

        // Keep frustum-culling bounds in sync.
        this._mesh.boundMin = [minX - EDGE_T, minY - EDGE_T, minZ - EDGE_T];
        this._mesh.boundMax = [maxX + EDGE_T, maxY + EDGE_T, maxZ + EDGE_T];
    }
}
