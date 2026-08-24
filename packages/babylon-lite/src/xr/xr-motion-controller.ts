/**
 * WebXR Input Profiles motion-controller loading — real per-hand GLB controller
 * models from the `@webxr-input-profiles/assets` registry, ported in spirit from
 * Babylon.js `WebXRMotionController` + the input-profiles `motion-controllers`
 * package. Given an `XRInputSource`, it resolves the best-matching profile,
 * fetches its `profile.json` + the handedness `.glb`, loads the model, and binds
 * each component's `visualResponses` to the model's named nodes so buttons /
 * triggers / thumbsticks can be animated from live gamepad state.
 *
 * This module carries a network dependency (the profiles CDN) and pulls in the
 * glTF loader, so it is **not** part of the default lite surface: it is reached
 * only through `controllerModels({ profiles: … })`, which dynamic-imports it on
 * demand. Non-XR scenes — and box-only controller models — never bundle any of
 * this. Pure data + free functions (pillar 4b); no module-level side effects.
 */

import type { EngineContext } from "../engine/engine.js";
import type { AssetContainer } from "../asset-container.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { XrHandedness } from "./xr-support.js";
import { loadGltf } from "../loader-gltf/load-gltf.js";
import { lerpVec3 } from "../math/lerp-vec3.js";
import { setSubtreeVisible } from "../scene/visibility.js";

/** Default WebXR Input Profiles registry — the jsDelivr-hosted
 *  `@webxr-input-profiles/assets` package, the same default Babylon.js uses. */
export const DEFAULT_PROFILES_BASE_URL = "https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets/dist/profiles/";

/** Options controlling where motion-controller profiles + models are fetched from. */
export interface XrMotionControllerProfileOptions {
    /** Base URL of the WebXR Input Profiles asset registry (must end in `/`).
     *  Defaults to {@link DEFAULT_PROFILES_BASE_URL}. Point this at a self-hosted
     *  mirror to avoid the CDN dependency. */
    baseUrl?: string;
}

// ─── Registry / profile JSON shapes (minimal subset we consume) ──────────────

/** @internal `profilesList.json`: profile id → relative `profile.json` path. */
type ProfilesList = Record<string, { path: string; deprecated?: boolean }>;

/** @internal One `visualResponse` entry from a component. */
interface VisualResponseJson {
    componentProperty: "button" | "xAxis" | "yAxis" | "state";
    states: string[];
    valueNodeProperty: "transform" | "visibility";
    valueNodeName: string;
    minNodeName?: string;
    maxNodeName?: string;
}

/** @internal One component (trigger, squeeze, thumbstick, button, …). */
interface ComponentJson {
    type: string;
    gamepadIndices: { button?: number; xAxis?: number; yAxis?: number };
    rootNodeName?: string;
    visualResponses?: Record<string, VisualResponseJson>;
}

/** @internal One handedness layout. */
interface LayoutJson {
    assetPath?: string;
    rootNodeName?: string;
    selectComponentId?: string;
    components: Record<string, ComponentJson>;
}

/** @internal A parsed `profile.json`. */
interface ProfileJson {
    profileId: string;
    layouts: Record<string, LayoutJson>;
}

// ─── Bound runtime model ─────────────────────────────────────────────────────

/** @internal A `visualResponse` bound to concrete model nodes. */
interface BoundVisualResponse {
    /** The node whose transform / visibility is driven. */
    valueNode: SceneNode;
    /** Interpolation endpoints (transform responses only). */
    minNode: SceneNode | null;
    maxNode: SceneNode | null;
    /** Whether to drive the node's transform or its visibility. */
    property: "transform" | "visibility";
    /** Which gamepad quantity feeds the response. */
    source: "button" | "xAxis" | "yAxis" | "state";
    /** States (default/touched/pressed) in which a visibility response is shown. */
    states: string[];
    /** Gamepad indices copied from the owning component. */
    buttonIndex: number;
    xAxisIndex: number;
    yAxisIndex: number;
}

/** A loaded, node-bound motion controller. Create with {@link loadMotionController},
 *  drive each frame with {@link updateMotionController}. Plain data — the owner
 *  positions {@link root} at the grip pose and disposes {@link container}. */
export interface MotionController {
    /** The loaded asset container (owner adds it to the scene + disposes it). */
    container: AssetContainer;
    /** The model root node — position/orient this at the controller's grip pose. */
    root: SceneNode;
    /** The resolved profile id (e.g. `"oculus-touch-v3"`). */
    profileId: string;
    /** @internal Bound animatable responses. */
    _responses: BoundVisualResponse[];
}

// ─── Loading ─────────────────────────────────────────────────────────────────

/** @internal Fetch + parse JSON, throwing on a non-OK response. */
async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`WebXR profiles: ${res.status} fetching ${url}`);
    }
    return (await res.json()) as T;
}

/** @internal Pick the first of the source's ordered profile ids that the registry
 *  actually publishes (mirrors Babylon's fallback-through-profiles behaviour). */
function resolveProfile(profiles: readonly string[], list: ProfilesList): { id: string; path: string } | null {
    for (const id of profiles) {
        const entry = list[id];
        if (entry) {
            return { id, path: entry.path };
        }
    }
    return null;
}

/** @internal Choose the layout for a handedness, falling back to any published
 *  layout (some profiles expose only `none`, or share one layout across hands). */
function selectLayout(profile: ProfileJson, handedness: XrHandedness): LayoutJson | null {
    return profile.layouts[handedness] ?? profile.layouts.none ?? Object.values(profile.layouts)[0] ?? null;
}

/** @internal Index every named node in a subtree so visualResponses resolve in O(1). */
function indexNodesByName(root: SceneNode, out: Map<string, SceneNode>): void {
    if (root.name && !out.has(root.name)) {
        out.set(root.name, root);
    }
    for (const child of root.children) {
        indexNodesByName(child, out);
    }
}

/** @internal Bind a layout's components → visualResponses to concrete model nodes. */
function bindResponses(layout: LayoutJson, nodes: Map<string, SceneNode>): BoundVisualResponse[] {
    const bound: BoundVisualResponse[] = [];
    for (const component of Object.values(layout.components)) {
        const gi = component.gamepadIndices;
        const responses = component.visualResponses;
        if (!responses) {
            continue;
        }
        for (const vr of Object.values(responses)) {
            const valueNode = nodes.get(vr.valueNodeName);
            if (!valueNode) {
                continue;
            }
            bound.push({
                valueNode,
                minNode: vr.minNodeName ? (nodes.get(vr.minNodeName) ?? null) : null,
                maxNode: vr.maxNodeName ? (nodes.get(vr.maxNodeName) ?? null) : null,
                property: vr.valueNodeProperty,
                source: vr.componentProperty,
                states: vr.states,
                buttonIndex: gi.button ?? -1,
                xAxisIndex: gi.xAxis ?? -1,
                yAxisIndex: gi.yAxis ?? -1,
            });
        }
    }
    return bound;
}

/**
 * Resolve, fetch, and load the real motion-controller model for an input source.
 * Returns `null` (never throws) if the source advertises no known profile or any
 * network/parse step fails, so callers can keep a placeholder visual. The returned
 * container is **not** yet added to a scene — the caller owns `addToScene`.
 */
export async function loadMotionController(
    engine: EngineContext,
    source: XRInputSource,
    handedness: XrHandedness,
    options: XrMotionControllerProfileOptions = {}
): Promise<MotionController | null> {
    try {
        const base = options.baseUrl ?? DEFAULT_PROFILES_BASE_URL;
        const list = await fetchJson<ProfilesList>(new URL("profilesList.json", base).href);
        const match = resolveProfile(source.profiles, list);
        if (!match) {
            return null;
        }
        const profileUrl = new URL(match.path, base).href;
        const profile = await fetchJson<ProfileJson>(profileUrl);
        const layout = selectLayout(profile, handedness);
        if (!layout?.assetPath) {
            return null;
        }
        const glbUrl = new URL(layout.assetPath, profileUrl).href;
        const container = await loadGltf(engine, glbUrl);
        const root = container.entities[0] as SceneNode | undefined;
        if (!root) {
            return null;
        }
        const nodes = new Map<string, SceneNode>();
        indexNodesByName(root, nodes);
        return { container, root, profileId: profile.profileId, _responses: bindResponses(layout, nodes) };
    } catch {
        return null;
    }
}

// ─── Per-frame animation ─────────────────────────────────────────────────────

/** @internal Normalized spherical-linear quaternion blend (falls back to nlerp for
 *  near-parallel endpoints). Local to this feature so nothing else pulls it in. */
function slerpQuat(
    ax: number,
    ay: number,
    az: number,
    aw: number,
    bx: number,
    by: number,
    bz: number,
    bw: number,
    t: number,
    out: { x: number; y: number; z: number; w: number }
): void {
    let dot = ax * bx + ay * by + az * bz + aw * bw;
    // Take the shorter arc.
    if (dot < 0) {
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
        dot = -dot;
    }
    let s0: number;
    let s1: number;
    if (dot > 0.9995) {
        // Endpoints almost identical → linear blend avoids a divide-by-zero.
        s0 = 1 - t;
        s1 = t;
    } else {
        const theta = Math.acos(dot);
        const sinTheta = Math.sin(theta);
        s0 = Math.sin((1 - t) * theta) / sinTheta;
        s1 = Math.sin(t * theta) / sinTheta;
    }
    let x = s0 * ax + s1 * bx;
    let y = s0 * ay + s1 * by;
    let z = s0 * az + s1 * bz;
    let w = s0 * aw + s1 * bw;
    const len = Math.hypot(x, y, z, w) || 1;
    x /= len;
    y /= len;
    z /= len;
    w /= len;
    out.x = x;
    out.y = y;
    out.z = z;
    out.w = w;
}

/** @internal Current button state as one of default/touched/pressed. */
function buttonState(button: GamepadButton | undefined): string {
    if (!button) {
        return "default";
    }
    if (button.pressed) {
        return "pressed";
    }
    if (button.touched) {
        return "touched";
    }
    return "default";
}

const _q = { x: 0, y: 0, z: 0, w: 1 };

/** @internal Apply one bound response for a normalized [0,1] weight. */
function applyTransform(r: BoundVisualResponse, weight: number): void {
    if (!r.minNode || !r.maxNode) {
        return;
    }
    const min = r.minNode;
    const max = r.maxNode;
    const p = lerpVec3(min.position, max.position, weight);
    r.valueNode.position.set(p.x, p.y, p.z);
    const s = lerpVec3(min.scaling, max.scaling, weight);
    r.valueNode.scaling.set(s.x, s.y, s.z);
    const a = min.rotationQuaternion;
    const b = max.rotationQuaternion;
    slerpQuat(a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w, weight, _q);
    r.valueNode.rotationQuaternion.set(_q.x, _q.y, _q.z, _q.w);
}

/**
 * Update a controller's animatable nodes from its live gamepad — press a trigger
 * and the trigger geometry depresses, push a thumbstick and it tilts. Call once
 * per XR frame while the source is tracked. A no-op when `gamepad` is null.
 */
export function updateMotionController(mc: MotionController, gamepad: Gamepad | null): void {
    if (!gamepad) {
        return;
    }
    const buttons = gamepad.buttons;
    const axes = gamepad.axes;
    for (const r of mc._responses) {
        if (r.property === "visibility") {
            const state = buttonState(buttons[r.buttonIndex]);
            setSubtreeVisible(r.valueNode, r.states.includes(state));
            continue;
        }
        let weight: number;
        if (r.source === "xAxis") {
            weight = (axes[r.xAxisIndex] ?? 0) * 0.5 + 0.5;
        } else if (r.source === "yAxis") {
            weight = (axes[r.yAxisIndex] ?? 0) * 0.5 + 0.5;
        } else if (r.source === "button") {
            weight = buttons[r.buttonIndex]?.value ?? 0;
        } else {
            // "state" driving a transform: pressed → 1, else 0.
            weight = buttons[r.buttonIndex]?.pressed ? 1 : 0;
        }
        applyTransform(r, weight);
    }
}
