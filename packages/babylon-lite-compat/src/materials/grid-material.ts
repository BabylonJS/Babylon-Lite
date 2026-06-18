/**
 * Babylon.js `@babylonjs/materials` `GridMaterial` over Babylon Lite's native
 * `createGridMaterial`.
 *
 * Babylon.js' `GridMaterial` is constructed empty and then has its appearance set
 * via mutable properties (`mainColor`, `lineColor`, `gridRatio`, …). Babylon Lite
 * instead bakes the grid options into a `ShaderMaterial` at creation time. The
 * compat wrapper accumulates the Babylon.js property assignments and builds the
 * Lite grid material lazily in {@link _ensureRenderable} (engine start, after all
 * properties are set), then exposes it as `_lite` so the mesh binds it.
 */

import { createGridMaterial } from "babylon-lite";
import type { EngineContext, ShaderMaterial as LiteShaderMaterial } from "babylon-lite";

import { Color3 } from "../math/color.js";
import { Vector3 } from "../math/vector.js";
import type { Scene } from "../scene/scene.js";

export class GridMaterial {
    public name: string;
    /** Background color between the lines (Babylon.js default black). */
    public mainColor = new Color3(0, 0, 0);
    /** Color of the grid lines (Babylon.js default teal). */
    public lineColor = new Color3(0.2, 0.2, 0.2);
    /** Spacing of the grid in object-space units. */
    public gridRatio = 1;
    /** Object-space offset added before computing the grid. */
    public gridOffset = new Vector3(0, 0, 0);
    /** Every Nth line is a major line. */
    public majorUnitFrequency = 10;
    /** Visibility of the minor (non-major) lines, `0..1`. */
    public minorUnitVisibility = 0.33;
    /** Opacity of the grid outside the lines; `<1` enables the transparent path. */
    public opacity = 1;
    /** Cosine-based antialiasing of the lines. */
    public antialias = true;
    /** Combine axes with `max` instead of additive sum. */
    public useMaxLine = false;
    /**
     * Babylon.js `@babylonjs/materials` 9.x `linesOnly` — show only the lines with
     * transparency between them. Babylon Lite expresses this via the opacity (`<1`)
     * transparent path, so enabling it forces that path.
     */
    public linesOnly = false;
    /** Back-face culling toggle. */
    public backFaceCulling = true;
    /** Babylon.js `Material.transparencyMode` (accepted for parity). */
    public transparencyMode: number | null = null;
    /** Wireframe toggle (not honoured by the grid material). */
    public wireframe = false;

    /** @internal The built Lite grid shader material (created at engine start). */
    public _lite: LiteShaderMaterial | undefined;

    public constructor(name: string, _scene?: Scene) {
        this.name = name;
    }

    public getClassName(): string {
        return "GridMaterial";
    }

    /**
     * @internal Build the Lite grid material from the accumulated Babylon.js
     * properties. Called by the engine just before the owning mesh is registered.
     */
    public _ensureRenderable(_engine: EngineContext): void {
        // `linesOnly` maps to Babylon Lite's transparent (opacity < 1) path; if the
        // caller left opacity at 1, nudge it just under 1 so the lines-only blend runs.
        const opacity = this.linesOnly && this.opacity >= 1 ? 0.9999 : this.opacity;
        this._lite = createGridMaterial({
            name: this.name,
            mainColor: [this.mainColor.r, this.mainColor.g, this.mainColor.b],
            lineColor: [this.lineColor.r, this.lineColor.g, this.lineColor.b],
            gridRatio: this.gridRatio,
            gridOffset: [this.gridOffset.x, this.gridOffset.y, this.gridOffset.z],
            majorUnitFrequency: this.majorUnitFrequency,
            minorUnitVisibility: this.minorUnitVisibility,
            opacity,
            antialias: this.antialias,
            useMaxLine: this.useMaxLine,
            backFaceCulling: this.backFaceCulling,
        });
    }

    public dispose(): void {
        // GPU resources are owned by the scene; disposed with it.
    }
}
