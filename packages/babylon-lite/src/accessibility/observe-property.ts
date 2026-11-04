interface PropertyObserver {
    descriptor: PropertyDescriptor | undefined;
    inheritedAccessor: boolean;
    value: unknown;
    listeners: Set<() => void>;
}

let observations: WeakMap<object, Map<PropertyKey, PropertyObserver>> | undefined;

function descriptorOf(target: object, key: PropertyKey): PropertyDescriptor | undefined {
    for (let current: object | null = target; current; current = Object.getPrototypeOf(current) as object | null) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor) {
            return descriptor;
        }
    }
    return undefined;
}

/** @internal Observe direct writes and restore the original property shape after the last listener leaves. */
export function observeProperty(target: object, key: PropertyKey, listener: () => void): () => void {
    const byProperty = (observations ??= new WeakMap()).get(target) ?? new Map<PropertyKey, PropertyObserver>();
    observations.set(target, byProperty);
    let observer = byProperty.get(key);
    if (!observer) {
        const own = Object.getOwnPropertyDescriptor(target, key);
        const descriptor = own ?? descriptorOf(Object.getPrototypeOf(target) as object, key);
        if (own && !own.configurable) {
            return () => {};
        }
        observer = {
            descriptor: own,
            inheritedAccessor: !own && !!(descriptor?.get || descriptor?.set),
            value: descriptor?.get ? descriptor.get.call(target) : (own?.value ?? (target as Record<PropertyKey, unknown>)[key]),
            listeners: new Set(),
        };
        const state = observer;
        Object.defineProperty(target, key, {
            configurable: true,
            enumerable: own?.enumerable ?? true,
            get: descriptor?.get ? () => descriptor.get!.call(target) : () => state.value,
            set: (value: unknown) => {
                const previous = descriptor?.get ? descriptor.get.call(target) : state.value;
                if (descriptor?.set) {
                    descriptor.set.call(target, value);
                } else {
                    state.value = value;
                }
                const next = descriptor?.get ? descriptor.get.call(target) : state.value;
                if (next !== previous) {
                    for (const callback of [...state.listeners]) {
                        callback();
                    }
                }
            },
        });
        byProperty.set(key, observer);
    }
    observer.listeners.add(listener);
    return () => {
        observer!.listeners.delete(listener);
        if (observer!.listeners.size) {
            return;
        }
        const current = (target as Record<PropertyKey, unknown>)[key];
        if (observer!.descriptor) {
            const restored = { ...observer!.descriptor };
            if ("value" in restored) {
                restored.value = current;
            }
            Object.defineProperty(target, key, restored);
        } else {
            delete (target as Record<PropertyKey, unknown>)[key];
            if (!observer!.inheritedAccessor && current !== undefined) {
                Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value: current });
            }
        }
        byProperty.delete(key);
        if (!byProperty.size) {
            observations?.delete(target);
        }
    };
}
