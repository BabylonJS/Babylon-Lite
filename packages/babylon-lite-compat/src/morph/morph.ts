/**
 * Babylon.js-compatible `MorphTarget` / `MorphTargetManager` over the Babylon
 * Lite native morph API (`createMorphTargets` / `setMorphTargetWeights`).
 *
 * Babylon.js morph targets carry **absolute** vertex positions/normals
 * (`target.setPositions(abs)`); Babylon Lite's `createMorphTargets` consumes
 * per-target **deltas** (target − base). The manager defers building the Lite
 * morph until engine start (when the owning mesh's base CPU geometry exists),
 * computes the deltas, and assigns the resulting `MorphTargetData` onto the
 * Lite mesh so the Standard/NME pipelines sample it. Weight changes
 * (`target.influence = …`) re-upload via `setMorphTargetWeights`.
 */

import { createMorphTargets, setMorphTargetWeights } from "babylon-lite";
import type { EngineContext, MorphTargetData } from "babylon-lite";

import type { Scene } from "../scene/scene.js";
import type { Mesh } from "../meshes/meshes.js";

/** Babylon.js `MorphTarget` — a single named morph influence with absolute target geometry. */
export class MorphTarget {
    public name: string;
    /** @internal Absolute target positions (Babylon.js `setPositions`). */
    public _positions: Float32Array | null = null;
    /** @internal Absolute target normals (Babylon.js `setNormals`). */
    public _normals: Float32Array | null = null;
    /** @internal Owning manager, set on `addTarget`, used to push weight updates. */
    public _manager: MorphTargetManager | undefined;
    private _influence: number;

    public constructor(name: string, influence = 0, _scene?: Scene) {
        this.name = name;
        this._influence = influence;
    }

    public get influence(): number {
        return this._influence;
    }
    public set influence(value: number) {
        this._influence = value;
        this._manager?._syncWeights();
    }

    /** Babylon.js `MorphTarget.setPositions(data)` — absolute target positions. */
    public setPositions(data: Float32Array | number[] | null): void {
        this._positions = data ? (data instanceof Float32Array ? data : Float32Array.from(data)) : null;
    }

    /** Babylon.js `MorphTarget.getPositions()`. */
    public getPositions(): Float32Array | null {
        return this._positions;
    }

    /** Babylon.js `MorphTarget.setNormals(data)` — absolute target normals. */
    public setNormals(data: Float32Array | number[] | null): void {
        this._normals = data ? (data instanceof Float32Array ? data : Float32Array.from(data)) : null;
    }

    /** Babylon.js `MorphTarget.getNormals()`. */
    public getNormals(): Float32Array | null {
        return this._normals;
    }
}

/** Babylon.js `MorphTargetManager` — owns a mesh's morph targets (Babylon Lite supports up to 4). */
export class MorphTargetManager {
    /** @internal */
    public _engine: EngineContext | undefined;
    /** @internal Built Lite morph data (created at engine start). */
    public _lite: MorphTargetData | undefined;
    private readonly _targets: MorphTarget[] = [];

    public constructor(_scene?: Scene) {
        // Scene retained implicitly via the mesh that adopts this manager.
    }

    public get numTargets(): number {
        return this._targets.length;
    }

    public getTarget(index: number): MorphTarget {
        return this._targets[index]!;
    }

    /** Babylon.js `MorphTargetManager.addTarget(target)`. */
    public addTarget(target: MorphTarget): void {
        target._manager = this;
        this._targets.push(target);
    }

    /**
     * @internal Build the Lite morph data from the mesh's base CPU geometry and
     * each target's absolute positions/normals (converted to deltas), then assign
     * it onto the Lite mesh. Called by the engine at start, once geometry exists.
     */
    public _build(mesh: Mesh, engine: EngineContext): void {
        const lite = mesh._lite as { _cpuPositions?: Float32Array; _cpuNormals?: Float32Array; morphTargets?: MorphTargetData | null };
        const base = lite._cpuPositions;
        if (!base) {
            return;
        }
        this._engine = engine;
        const vertexCount = base.length / 3;
        const baseNormals = lite._cpuNormals;
        const targets = this._targets.slice(0, 4).map((t) => {
            const abs = t._positions;
            const positions = new Float32Array(base.length);
            if (abs) {
                for (let i = 0; i < base.length; i++) {
                    positions[i] = (abs[i] ?? 0) - base[i]!;
                }
            }
            let normals: Float32Array | null = null;
            if (t._normals && baseNormals) {
                normals = new Float32Array(baseNormals.length);
                for (let i = 0; i < baseNormals.length; i++) {
                    normals[i] = (t._normals[i] ?? 0) - baseNormals[i]!;
                }
            }
            return { positions, normals };
        });
        const weights = this._targets.slice(0, 4).map((t) => t.influence);
        this._lite = createMorphTargets(engine, targets, vertexCount, weights);
        lite.morphTargets = this._lite;
    }

    /** @internal Re-upload current target influences to the GPU weights buffer. */
    public _syncWeights(): void {
        if (!this._lite || !this._engine) {
            return;
        }
        const weights = this._targets.slice(0, 4).map((t) => t.influence);
        setMorphTargetWeights(this._engine, this._lite, weights);
    }
}
