import { addDeferredSceneRenderables } from "./scene-core.js";
import type { SceneContext } from "./scene-core.js";
import type { EngineContext } from "../engine/engine.js";
import type { Renderable } from "../render/renderable.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";

/** A committed membership change in one of a scene's custom-renderable collections. */
export interface SceneRenderableChangeEvent<T> {
    readonly type: "added" | "removed";
    readonly entity: T;
}

/** Receives committed membership changes of one custom-renderable collection. */
export type SceneRenderableChangeListener<T> = (event: SceneRenderableChangeEvent<T>) => void;

/** @internal The render work one member contributes once its scene builds. */
export interface SceneRenderableAttachment {
    /** @internal */
    _renderable: Renderable;
    /** @internal Detaches the attachment's GPU state synchronously (so nothing built later can reuse it) and returns its
     *  release. Removal runs the release after in-flight frames; scene disposal runs it immediately. */
    _detach?: () => () => void;
}

/** @internal One member's scene-side state. */
export interface SceneRenderableEntry {
    /** @internal Built render work; absent until the scene builds this member. */
    _attachment?: SceneRenderableAttachment;
    /** @internal Feature registration torn down synchronously when the member leaves (e.g. its pick source). */
    _unregister?: () => void;
}

/** @internal One family's members in add order, plus its subscribers. Allocated by the family's first add or
 *  subscription. Scene disposal releases built members through the scene's deferred-build disposal and publishes
 *  nothing; a disposed scene reports no members and rejects removal. */
export interface SceneRenderableCollection {
    /** @internal */
    readonly _members: Map<object, SceneRenderableEntry>;
    /** @internal */
    _listeners?: Set<SceneRenderableChangeListener<object>>;
    /** @internal Installed by the first subscription, so scenes that never observe a family carry no dispatch code. */
    _publish?: (event: SceneRenderableChangeEvent<object>) => void;
}

function getCollection(scene: SceneContext, family: string): SceneRenderableCollection {
    const collections = (scene._renderableCollections ??= new Map());
    let collection = collections.get(family);
    if (!collection) {
        collections.set(family, (collection = { _members: new Map() }));
    }
    return collection;
}

/** @internal Add `entity` to its family's collection and schedule its render attachment with the scene's other
 *  deferred render work. Returns the new entry, or `undefined` when `entity` is already a member. An attachment
 *  whose member was removed (or removed and re-added) before it finished building is released, not drawn. */
export function _addSceneRenderable(
    scene: SceneContext,
    family: string,
    entity: object,
    attach: (engine: EngineContext) => SceneRenderableAttachment | Promise<SceneRenderableAttachment>
): SceneRenderableEntry | undefined {
    const collection = getCollection(scene, family);
    const members = collection._members;
    if (members.has(entity)) {
        return undefined;
    }
    const entry: SceneRenderableEntry = {};
    members.set(entity, entry);
    addDeferredSceneRenderables(scene, async (engine) => {
        const attachment = await attach(engine);
        if (members.get(entity) !== entry) {
            attachment._detach?.()();
            return { renderables: [] };
        }
        entry._attachment = attachment;
        return {
            renderables: [attachment._renderable],
            // Scene disposal releases only a still-current member; removal already retired the others.
            dispose: () => {
                if (members.get(entity) === entry) {
                    attachment._detach?.()();
                }
            },
        };
    });
    collection._publish?.({ type: "added", entity });
    return entry;
}

/** @internal Remove `entity` from its family's collection. Its built renderable stops drawing immediately and its
 *  GPU state is released after in-flight frames. Returns whether `entity` was a member. */
export function _removeSceneRenderable(scene: SceneContext, family: string, entity: object): boolean {
    // A disposed scene already released its members.
    const collection = scene._z ? undefined : scene._renderableCollections?.get(family);
    const entry = collection?._members.get(entity);
    if (!entry) {
        return false;
    }
    collection!._members.delete(entity);
    const renderable = entry._attachment?._renderable;
    const index = renderable ? scene._renderables.indexOf(renderable) : -1;
    if (index >= 0) {
        scene._renderables.splice(index, 1);
        scene._renderableVersion++;
    }
    entry._unregister?.();
    const release = entry._attachment?._detach?.();
    if (release) {
        retireGpuResources(scene.surface.engine, release);
    }
    collection!._publish?.({ type: "removed", entity });
    return true;
}

/** @internal Snapshot of a family's members, in add order. */
export function _getSceneRenderables<T extends object>(scene: SceneContext, family: string): readonly T[] {
    const members = scene._z ? undefined : scene._renderableCollections?.get(family)?._members;
    return (members ? [...members.keys()] : []) as T[];
}

/** @internal Subscribe to a family's committed membership changes.
 *
 *  A change made by a listener is published after the current change reaches every listener. Listener failures do
 *  not prevent later listeners from running; they are rethrown to the mutating caller once dispatch completes.
 *  Scene disposal publishes no removals. The returned callback removes only this
 *  registration and is idempotent. */
export function _observeSceneRenderables<T extends object>(scene: SceneContext, family: string, listener: SceneRenderableChangeListener<T>): () => void {
    if (scene._z) {
        throw new Error("Cannot observe a disposed scene.");
    }
    const collection = getCollection(scene, family);
    const listeners = (collection._listeners ??= new Set());
    if (!collection._publish) {
        const pending: SceneRenderableChangeEvent<object>[] = [];
        collection._publish = (event) => {
            if (pending.push(event) > 1) {
                return;
            }
            const failures: unknown[] = [];
            for (let i = 0; i < pending.length; i++) {
                for (const subscribed of [...listeners]) {
                    if (listeners.has(subscribed)) {
                        try {
                            subscribed(pending[i]!);
                        } catch (error) {
                            failures.push(error);
                        }
                    }
                }
            }
            pending.length = 0;
            if (failures.length) {
                throw failures.length > 1 ? new AggregateError(failures) : failures[0];
            }
        };
    }
    const subscribed: SceneRenderableChangeListener<object> = (event) => listener(event as SceneRenderableChangeEvent<T>);
    listeners.add(subscribed);
    return () => {
        listeners.delete(subscribed);
    };
}
