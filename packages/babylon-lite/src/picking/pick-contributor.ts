/** Pick contributor — the pluggable pick contract, analogous to `Renderable` for drawing.
 *
 *  The GPU picker draws meshes itself (the always-present base case, kept intrinsic so a
 *  scene that never picks pays zero pick bytes), then iterates `scene._pickSources` with no
 *  knowledge of any specific entity type. Each *optional* pickable entity (a Gaussian-splatting
 *  mesh, a billboard system, …) registers one `PickSource` when it is added to the scene — the
 *  raw entity plus a thunk that lazy-imports the entity's pick pipeline. Adding a new pickable
 *  type is a new module that calls `registerPickSource` — no edits to `gpu-picker.ts` or
 *  `scene-core.ts`.
 *
 *  A `PickSource` is pure data + a dynamic-`import()` thunk, so *rendering* a pickable entity
 *  pulls no pick-pipeline bytes (the leanest pay-for-use — a render scene ships only the entity
 *  reference + the import thunk). On the first pick the picker loads each source's pipeline, calls
 *  its `createPickContributor(entity)` to build the handler, and caches it — so the pipeline,
 *  GPU-resource, resolve, and view math all stay in a split chunk fetched only when a pick runs,
 *  and a contributor's GPU state lives in its closure and disposes generically.
 *
 *  Contributors draw into the SAME 1×1 pick pass as meshes (shared pick-id colour target,
 *  `r32float` depth, and reverse-Z depth test), so occlusion is respected across entity
 *  types. Each contributor owns a contiguous pick-id range assigned by the picker. */

import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { Camera } from "../camera/camera.js";
import type { PickingInfo } from "./picking-info.js";
import type { GpuPicker } from "./gpu-picker.js";

/** Shared state for the single 1×1 pick pass, handed to each contributor's `draw`. */
export interface PickPassContext {
    /** The picker running this pass. */
    readonly picker: GpuPicker;
    /** The open pick render pass (meshes already drawn into ids `1..M`). */
    readonly pass: GPURenderPassEncoder;
    readonly engine: EngineContext;
    readonly scene: SceneContext;
    readonly camera: Camera;
    /** Group-0 bind group holding the pick-zoomed view-projection (the mesh pick scene UBO).
     *  A contributor that rebinds group 0 (e.g. GS) must expect the next contributor to rebind
     *  what it needs; contributors that reuse the mesh VP rebind this at the start of `draw`. */
    readonly sceneBG: GPUBindGroup;
    /** Exact pick sample + pick-viewport size (canvas space), for contributors that build their own pick matrix. */
    readonly px: number;
    readonly py: number;
    readonly w: number;
    readonly h: number;
    /** Whether this pass includes the optional packed detailed-result attachment. */
    readonly detailed: boolean;
}

/** A pluggable pick handler for one optional pickable entity. Built lazily (once per picker) by a
 *  factory the entity registered when it was added; the picker iterates contributors with no
 *  entity-type knowledge. Reused across picks, so `draw` may cache GPU resources in its closure
 *  and free them in `dispose`. */
export interface PickContributor {
    /** Draw this entity's pickables into the shared pass, assigning ids from `baseId`.
     *  Returns the next free id, so `nextId - baseId` is the id count this contributor owns
     *  (a hidden/empty entity still consumes its ids so id↔entity mapping stays positional). */
    draw(ctx: PickPassContext, baseId: number): number;
    /** Resolve a read-back id owned by this contributor (`localId = pickId - baseId`) by
     *  attaching its payload to `info`. `info.pickedPoint` / `info.distance` are already set
     *  from the shared pick-depth readback. */
    resolve(info: PickingInfo, localId: number): void;
    /** Free any GPU resources this contributor created (called by `disposePicker`). */
    dispose?(): void;
}

/** The uniform export every pick-pipeline module provides: it builds the {@link PickContributor}
 *  for one entity. Lazy-imported and called by the picker on the first pick. */
export interface PickPipelineModule<E = unknown> {
    createPickContributor(entity: E): PickContributor;
}

/** A pickable entity registered on the scene: the entity plus a thunk that lazy-imports its pick
 *  pipeline. Pure data + a dynamic-`import()` thunk, so pushing one pulls no pick-pipeline bytes into
 *  the render bundle. The picker (at pick time) loads the pipeline and calls `createPickContributor`. */
export interface PickSource {
    /** The entity to pick (opaque to the picker; handed back to its own pipeline's factory). */
    readonly entity: unknown;
    /** Lazy-import this entity's pick pipeline module. */
    load(): Promise<PickPipelineModule>;
}

/** Register a pickable entity on the scene (mirrors pushing a `Renderable`). Fully typed: `load` must
 *  resolve to the entity's pick pipeline, whose `createPickContributor` accepts this entity's type.
 *  The scene stores a heterogeneous list, so the single entity-type erasure is contained here.
 *
 *  Returns an unregister function. The entity's disposer should call it so a disposed entity is not
 *  left behind in `scene._pickSources` (which the scene otherwise only clears wholesale on teardown). */
export function registerPickSource<E>(scene: SceneContext, entity: E, load: () => Promise<PickPipelineModule<E>>): () => void {
    const source: PickSource = { entity, load: load as () => Promise<PickPipelineModule> };
    scene._pickSources.push(source);
    return () => {
        const i = scene._pickSources.indexOf(source);
        if (i >= 0) {
            scene._pickSources.splice(i, 1);
        }
    };
}
