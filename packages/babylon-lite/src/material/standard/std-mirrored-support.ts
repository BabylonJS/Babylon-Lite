/** Mirrored-mesh support, reached only through the public `enableMirroredMeshes()` opt-in.
 *
 *  Everything here is additive to the glTF loader's built-in winding handling:
 *   - a winding rule derived from the live world determinant, so procedural meshes and meshes
 *     mirrored after load are covered too (the loader only flags glTF nodes, once, at load time);
 *   - the Standard pipeline's primitive resolver, which otherwise has no winding reversal at all;
 *   - a per-scene watcher that re-resolves a mesh's pipeline when its determinant sign flips.
 *
 *  Kept out of every non-opting bundle: nothing in the engine imports this module statically, and
 *  `enableMirroredMeshes()` reaches it through a dynamic import. */
import type { Mesh } from "../../mesh/mesh.js";
import type { SceneContext } from "../../scene/scene-core.js";
import type { Mat4 } from "../../math/types.js";
import { _installWindingRule, _resolvePrimitive, _windingFrontFace } from "../pbr/pbr-primitive-resolver.js";
import { _installStdPrimitiveResolver } from "./standard-pipeline.js";
import { _installStdGeometryWinding } from "./standard-geometry-renderable.js";
import { enqueueMaterialSwap } from "../../scene/mesh-scene-registry.js";
import { mat4Determinant3 } from "../../math/mat4-determinant3.js";

/** Sign of the upper-left 3x3 determinant. Negative means the transform mirrors the geometry. */
function detSign(m: Mat4): number {
    return mat4Determinant3(m) < 0 ? -1 : 1;
}

/** A mesh is mirrored when its current world determinant disagrees with the sign its geometry was
 *  authored for: `+1` for procedural meshes, `-1` for glTF meshes (which sit under the loader's
 *  RH→LH `__root__` flip). Stateless on purpose — the per-scene watcher below owns all change
 *  tracking, so a mesh shared by several scenes cannot have one scene consume another's flip. */
function isMirrored(mesh: Mesh): boolean {
    return detSign(mesh.worldMatrix) !== (mesh._authoredSign ?? 1);
}

/** What a scene's watcher last observed for a mesh: the world-matrix version it examined and the
 *  determinant sign its renderable was built with. */
interface Watched {
    v: number;
    sign: number;
}

let _installed = false;

/** The watcher callback currently installed per scene, so a re-install replaces it instead of
 *  stacking a second one. Lazily allocated — a module-level `new WeakMap()` is a side effect. */
let _watchers: WeakMap<SceneContext, (deltaMs: number) => void> | null = null;

/**
 * Install the pipeline-side pieces once, then attach the runtime watcher to `scene`.
 *
 * Deliberately NOT underscore-prefixed: this is reached through a dynamic `import()` and read as a
 * property off the module namespace, which the scene bundler's Terser pass mangles for names
 * matching `/^_[a-z]/` (scripts/bundle-scenes-core.ts). It stays out of `index.ts`, so it is not
 * public API.
 * @internal
 */
export function installMirroredMeshSupport(scene: SceneContext): void {
    if (!_installed) {
        _installed = true;
        _installWindingRule(isMirrored);
        // A procedural Standard mesh given a negative scale is mirrored just like a glTF one;
        // without this its back faces would be culled and it would render inside-out.
        _installStdPrimitiveResolver(_resolvePrimitive);
        _installStdGeometryWinding(_windingFrontFace);
    }

    // Per-scene state, never on the mesh: one Mesh may belong to several scenes (see
    // scene/mesh-scene-registry.ts), so mesh-global change tracking would let the first scene's
    // rebuild hide the flip from every other scene's watcher.
    const seen = new WeakMap<Mesh, Watched>();

    // Seed from the meshes present now, i.e. the signs their renderables are about to be built with
    // (`registerScene` follows this call). Seeding lazily on first sight instead would miss a mesh
    // mirrored by a frame callback before the watcher's first run — the sign would be recorded as
    // if the renderable had been built mirrored, and no rebuild would ever be enqueued.
    for (const mesh of scene.meshes) {
        seen.set(mesh, { v: mesh.worldMatrixVersion, sign: detSign(mesh.worldMatrix) });
    }

    // The pipeline's `frontFace` is baked into the GPU pipeline object, so a flip has to go through
    // a renderable rebuild. Meshes are only examined when their world matrix actually changed
    // (integer version compare); the determinant is computed for those alone, and a rebuild is
    // enqueued only when the sign really flipped.
    const watch = (): void => {
        for (const mesh of scene.meshes) {
            const v = mesh.worldMatrixVersion;
            const prev = seen.get(mesh);
            if (prev?.v === v) {
                continue;
            }
            const sign = detSign(mesh.worldMatrix);
            // A mesh added after install is seeded on first sight, with the sign its renderable was
            // just built from.
            if (prev && prev.sign !== sign) {
                enqueueMaterialSwap(scene, mesh);
            }
            seen.set(mesh, { v, sign });
        }
    };

    // Appended to the END of `_beforeRender` (rather than registered through `onBeforeRender`, which
    // unshifts) so the watcher observes the transforms produced by this frame's animation and user
    // callbacks; the scene drains `_materialSwapQueue` right after `_beforeRender`, so a flip
    // detected here is rebuilt in the same frame. A previously installed watcher for this scene is
    // removed first, which lets a caller re-anchor it after adding assets that register their own
    // `_beforeRender` hooks (e.g. an animated glTF loaded later).
    const watchers = (_watchers ??= new WeakMap());
    const old = watchers.get(scene);
    if (old) {
        const i = scene._beforeRender.indexOf(old);
        if (i >= 0) {
            scene._beforeRender.splice(i, 1);
        }
    }
    watchers.set(scene, watch);
    scene._beforeRender.push(watch);
}
