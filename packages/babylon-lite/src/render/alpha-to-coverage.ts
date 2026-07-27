import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { NodeMaterial } from "../material/node/node-material.js";
import type { ShaderMaterial } from "../material/shader/shader-material.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";
import type { BillboardSpriteSystem } from "../sprite/billboard-sprite.js";
import type { Sprite2DLayer } from "../sprite/sprite-2d.js";
import type { TextRenderable } from "../text/text-renderable.js";
import { _registerAlphaToCoverageResolver } from "./alpha-to-coverage-hook.js";

/** A public object that owns or selects an immutable WebGPU render pipeline. */
export type AlphaToCoverageTarget = StandardMaterialProps | PbrMaterialProps | ShaderMaterial | TextRenderable | Sprite2DLayer | BillboardSpriteSystem;
type SupportedAlphaToCoverageTarget<T extends AlphaToCoverageTarget> = T extends NodeMaterial ? never : T;

// Target membership is private to this optional module. Keeping the WeakSet lazy means importing
// the package root allocates nothing; when the public setter is tree-shaken, pipeline resolver calls
// fold to false and non-users retain no A2C code or measured bundle-size cost.
let _enabledTargets: WeakSet<object> | null = null;

/**
 * Enable or disable alpha-to-coverage for one pipeline-owning target.
 *
 * Alpha-to-coverage is immutable WebGPU pipeline state, so call this before `registerScene` or
 * before adding a text/sprite target to a scene. To change a material after registration, update
 * the state and then call `rebuildMaterial`. This function does not change fragment alpha.
 *
 * @param target - Standard/PBR/Shader material, scene text, depth-hosted Sprite2D layer, or billboard system.
 * @param enabled - Whether its eligible multisampled pipelines should convert fragment alpha to sample coverage.
 */
export function setAlphaToCoverage<T extends AlphaToCoverageTarget>(target: SupportedAlphaToCoverageTarget<T>, enabled: boolean): void {
    assertSupportedTarget(target);
    if (enabled) {
        if (!_enabledTargets) {
            _enabledTargets = new WeakSet();
            _registerAlphaToCoverageResolver(_isAlphaToCoverageEnabled);
        }
        _enabledTargets.add(target);
    } else {
        _enabledTargets?.delete(target);
    }
}

/** Return whether alpha-to-coverage was requested for a pipeline-owning target. */
export function getAlphaToCoverage<T extends AlphaToCoverageTarget>(target: SupportedAlphaToCoverageTarget<T>): boolean {
    assertSupportedTarget(target);
    return _enabledTargets?.has(target) ?? false;
}

function assertSupportedTarget(target: AlphaToCoverageTarget): void {
    const family = (target as { _buildGroup?: { _materialFamily?: string } })._buildGroup?._materialFamily;
    if (family === "node") {
        throw new Error("Alpha-to-coverage is not supported for NodeMaterial.");
    }
}

function _isAlphaToCoverageEnabled(target: object): boolean {
    return _enabledTargets?.has(target) ?? false;
}
