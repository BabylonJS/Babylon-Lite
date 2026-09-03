import type { HavokEventContext, PhysicsBody, PhysicsWorld } from "./havok.js";

/** @internal Installs body lifetime tracking only when body-aware Havok events are enabled. */
export function ensureHavokEventContext(world: PhysicsWorld): HavokEventContext {
    if (world._events) {
        return world._events;
    }

    let draining = false;
    let removed: PhysicsBody[] | undefined;
    const context: HavokEventContext = {
        begin() {
            draining = true;
        },
        end() {
            draining = false;
            const deferred = removed;
            removed = undefined;
            if (deferred) {
                for (const body of deferred) {
                    world._hknp.HP_Body_Release(body._hkBody);
                }
            }
        },
        remove(body) {
            if (!draining) {
                return false;
            }
            (removed ??= []).push(body);
            return true;
        },
        resolve(nativeId) {
            const thinBody = world._thin?.resolve(nativeId);
            if (thinBody) {
                return thinBody;
            }
            const id = Number(nativeId);
            for (const body of world._bodies) {
                if (Number(body._hkBody[0]) === id) {
                    return [body, body._hkBody, 0];
                }
            }
            if (removed) {
                for (const body of removed) {
                    if (Number(body._hkBody[0]) === id) {
                        return [body, body._hkBody, 0];
                    }
                }
            }
            return null;
        },
        dispose() {
            draining = false;
            context.end();
        },
    };
    world._events = context;
    return context;
}
