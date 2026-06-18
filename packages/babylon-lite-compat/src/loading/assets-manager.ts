/**
 * Babylon.js-compatible `AssetsManager` — a pure task scheduler built on top of
 * the compat loaders. The scheduling/observable surface has no Babylon Lite or
 * GPU dependency and is fully unit-testable; the concrete mesh/texture task types
 * delegate to the compat loaders.
 */

import { Observable } from "../misc/observable.js";

export type TaskState = "init" | "running" | "done" | "error";

/** Base class for an asset-loading task. Subclasses implement {@link runAsync}. */
export abstract class AbstractAssetTask {
    public name: string;
    public state: TaskState = "init";
    public errorObject: { message: string; exception?: unknown } | undefined;

    public onSuccess?: (task: this) => void;
    public onError?: (task: this, message?: string, exception?: unknown) => void;

    public constructor(name: string) {
        this.name = name;
    }

    public get isCompleted(): boolean {
        return this.state === "done";
    }

    /** Run the task. Subclasses populate their result fields here. */
    public abstract runAsync(): Promise<void>;

    /** @internal Run with success/error bookkeeping. */
    public async _run(): Promise<void> {
        this.state = "running";
        try {
            await this.runAsync();
            this.state = "done";
            this.onSuccess?.(this);
        } catch (exception) {
            this.state = "error";
            const message = exception instanceof Error ? exception.message : String(exception);
            this.errorObject = { message, exception };
            this.onError?.(this, message, exception);
            throw exception;
        }
    }
}

/** A task whose work is provided as a plain async function (useful for custom assets and tests). */
export class CustomAssetTask<T> extends AbstractAssetTask {
    public result: T | undefined;

    public constructor(
        name: string,
        private readonly _loader: () => Promise<T>
    ) {
        super(name);
    }

    public override async runAsync(): Promise<void> {
        this.result = await this._loader();
    }
}

export class AssetsManager {
    public readonly onProgressObservable = new Observable<{ remainingCount: number; totalCount: number; task: AbstractAssetTask }>();
    public readonly onTaskSuccessObservable = new Observable<AbstractAssetTask>();
    public readonly onTaskErrorObservable = new Observable<AbstractAssetTask>();
    public readonly onFinishObservable = new Observable<AbstractAssetTask[]>();

    // Kept for Babylon.js API parity only. The compat AssetsManager has no
    // loading-screen UI, and `loadAsync` never rejects on task failure (per-task
    // errors surface via `onTaskErrorObservable`), so neither flag affects
    // loading behavior.
    public useDefaultLoadingScreen = false;
    public autoHideLoadingUI = false;

    private readonly _tasks: AbstractAssetTask[] = [];
    private _isLoading = false;

    public get tasks(): readonly AbstractAssetTask[] {
        return this._tasks;
    }

    public addTask<T extends AbstractAssetTask>(task: T): T {
        this._tasks.push(task);
        return task;
    }

    /** Add a custom async task and return it (handy for non-mesh/texture assets and tests). */
    public addCustomTask<T>(name: string, loader: () => Promise<T>): CustomAssetTask<T> {
        return this.addTask(new CustomAssetTask<T>(name, loader));
    }

    public reset(): this {
        this._tasks.length = 0;
        return this;
    }

    /** Run all queued tasks sequentially, emitting progress, and resolve when done. */
    public async loadAsync(): Promise<AbstractAssetTask[]> {
        if (this._isLoading) {
            throw new Error("AssetsManager is already loading.");
        }
        this._isLoading = true;
        const total = this._tasks.length;
        const completed: AbstractAssetTask[] = [];

        try {
            for (const task of this._tasks) {
                try {
                    await task._run();
                    this.onTaskSuccessObservable.notifyObservers(task);
                } catch {
                    this.onTaskErrorObservable.notifyObservers(task);
                }
                completed.push(task);
                this.onProgressObservable.notifyObservers({ remainingCount: total - completed.length, totalCount: total, task });
            }
            this.onFinishObservable.notifyObservers(this._tasks.slice());
            return completed;
        } finally {
            this._isLoading = false;
        }
    }
}
