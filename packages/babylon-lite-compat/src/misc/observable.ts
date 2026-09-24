/**
 * Minimal Babylon.js-compatible `Observable`.
 *
 * Supports the common surface used by ported scenes: `add`, `addOnce`, `remove`,
 * `removeCallback`, `notifyObservers`, `hasObservers`, and `clear`. This is pure
 * JS with no Babylon Lite dependency and is fully unit-testable.
 */

export type ObserverCallback<T> = (eventData: T) => void;

export class Observable<T> {
    private _observers: Array<{ callback: ObserverCallback<T>; mask: number }> = [];
    private _hasNotified = false;
    private _lastNotifiedValue: T | undefined;
    private _lastNotifiedMask = -1;

    public constructor(
        private _onObserverAdded?: (observer: ObserverCallback<T>) => void,
        public notifyIfTriggered = false
    ) {}

    public add(callback: ObserverCallback<T>, mask = -1): ObserverCallback<T> {
        this._observers.push({ callback, mask });
        this._onObserverAdded?.(callback);
        if (this._hasNotified && this.notifyIfTriggered && (mask & this._lastNotifiedMask) !== 0) {
            callback(this._lastNotifiedValue as T);
        }
        return callback;
    }

    public addOnce(callback: ObserverCallback<T>, mask = -1): ObserverCallback<T> {
        const wrapper: ObserverCallback<T> = (eventData) => {
            this.removeCallback(wrapper);
            callback(eventData);
        };
        return this.add(wrapper, mask);
    }

    public remove(callback: ObserverCallback<T> | null | undefined): boolean {
        return callback ? this.removeCallback(callback) : false;
    }

    public removeCallback(callback: ObserverCallback<T>): boolean {
        const index = this._observers.findIndex((observer) => observer.callback === callback);
        if (index !== -1) {
            this._observers.splice(index, 1);
            return true;
        }
        return false;
    }

    public notifyObservers(eventData?: T, mask = -1): void {
        if (this.notifyIfTriggered) {
            this._hasNotified = true;
            this._lastNotifiedValue = eventData;
            this._lastNotifiedMask = mask;
        }
        // Iterate a copy so observers can add/remove during notification.
        for (const observer of this._observers.slice()) {
            if ((observer.mask & mask) !== 0) {
                observer.callback(eventData as T);
            }
        }
    }

    public hasObservers(): boolean {
        return this._observers.length > 0;
    }

    public clear(): void {
        this._observers = [];
        this._onObserverAdded = undefined;
        this.cleanLastNotifiedState();
    }

    public cleanLastNotifiedState(): void {
        this._hasNotified = false;
        this._lastNotifiedValue = undefined;
        this._lastNotifiedMask = -1;
    }
}
