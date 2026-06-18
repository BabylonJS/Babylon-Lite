/**
 * Minimal Babylon.js-compatible `Observable`.
 *
 * Supports the common surface used by ported scenes: `add`, `addOnce`, `remove`,
 * `removeCallback`, `notifyObservers`, `hasObservers`, and `clear`. This is pure
 * JS with no Babylon Lite dependency and is fully unit-testable.
 */

export type ObserverCallback<T> = (eventData: T) => void;

export class Observable<T> {
    private _observers: ObserverCallback<T>[] = [];

    public add(callback: ObserverCallback<T>): ObserverCallback<T> {
        this._observers.push(callback);
        return callback;
    }

    public addOnce(callback: ObserverCallback<T>): ObserverCallback<T> {
        const wrapper: ObserverCallback<T> = (eventData) => {
            this.removeCallback(wrapper);
            callback(eventData);
        };
        this._observers.push(wrapper);
        return wrapper;
    }

    public remove(callback: ObserverCallback<T> | null | undefined): boolean {
        return callback ? this.removeCallback(callback) : false;
    }

    public removeCallback(callback: ObserverCallback<T>): boolean {
        const index = this._observers.indexOf(callback);
        if (index !== -1) {
            this._observers.splice(index, 1);
            return true;
        }
        return false;
    }

    public notifyObservers(eventData?: T): void {
        // Iterate a copy so observers can add/remove during notification.
        for (const observer of this._observers.slice()) {
            observer(eventData as T);
        }
    }

    public hasObservers(): boolean {
        return this._observers.length > 0;
    }

    public clear(): void {
        this._observers = [];
    }
}
