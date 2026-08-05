/**
 * Typed event emitter — lightweight callback registry for inter-controller
 * communication. No async, no bubbling.
 */

/** Semantic events emitted during gameplay. */
export interface PlayerEvents {
    jumped: void;
    landed: void;
    airborne: void;
    startedMoving: void;
    stoppedMoving: void;
}

/**
 * Minimal typed event emitter.
 *
 * Internal storage is a `Map<K, Set<handler>>`. `clear()` removes every
 * subscription (used by PlayerController.dispose()).
 */
export class EventEmitter<EventMap> {
    private readonly _handlers = new Map<keyof EventMap, Set<(payload: never) => void>>();

    on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): void {
        let set = this._handlers.get(event);
        if (!set) {
            set = new Set();
            this._handlers.set(event, set);
        }
        set.add(handler as (payload: never) => void);
    }

    off<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): void {
        this._handlers.get(event)?.delete(handler as (payload: never) => void);
    }

    emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
        const set = this._handlers.get(event);
        if (set) {
            for (const h of set) {
                h(payload as never);
            }
        }
    }

    clear(): void {
        this._handlers.clear();
    }
}
