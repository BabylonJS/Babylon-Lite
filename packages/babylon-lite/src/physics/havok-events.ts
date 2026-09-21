import type { HavokEventContext, PhysicsBody, PhysicsWorld, ResolvedPhysicsBodyInstance } from "./havok.js";

/** @internal Installs body lifetime tracking only when body-aware Havok events are enabled. */
export function ensureHavokEventContext(world: PhysicsWorld): HavokEventContext {
    if (world._events) {
        return world._events;
    }

    let draining = false;
    let removed: PhysicsBody[] | undefined;
    const bodiesByNativeId = new Map<number, ResolvedPhysicsBodyInstance>();

    const forEachInstance = (body: PhysicsBody, callback: (nativeId: number, resolved: ResolvedPhysicsBodyInstance) => void): void => {
        const count = world._thin?.count(body);
        if (count === undefined) {
            callback(Number(body._hkBody[0]), [body, body._hkBody, 0]);
            return;
        }
        for (let index = 0; index < count; index++) {
            const handle = world._thin!.instance(body, index);
            if (handle) {
                callback(Number(handle[0]), [body, handle, index]);
            }
        }
    };

    const add = (body: PhysicsBody): void => {
        forEachInstance(body, (nativeId, resolved) => bodiesByNativeId.set(nativeId, resolved));
    };

    const drop = (body: PhysicsBody): void => {
        forEachInstance(body, (nativeId) => {
            if (bodiesByNativeId.get(nativeId)?.[0] === body) {
                bodiesByNativeId.delete(nativeId);
            }
        });
    };

    const releaseRemoved = (): void => {
        const deferred = removed;
        removed = undefined;
        if (deferred) {
            for (const body of deferred) {
                drop(body);
                world._hknp.HP_Body_Release(body._hkBody);
            }
        }
    };

    const context: HavokEventContext = {
        begin() {
            draining = true;
        },
        end() {
            draining = false;
            releaseRemoved();
        },
        add,
        remove(body) {
            if (draining) {
                (removed ??= []).push(body);
                return true;
            }
            drop(body);
            return false;
        },
        resolve(nativeId) {
            return bodiesByNativeId.get(Number(nativeId)) ?? null;
        },
        dispose() {
            draining = false;
            releaseRemoved();
            bodiesByNativeId.clear();
        },
    };
    for (const body of world._bodies) {
        add(body);
    }
    world._events = context;
    return context;
}
