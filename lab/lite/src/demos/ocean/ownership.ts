import {
    createComputeBindingSet,
    createComputeShader,
    createComputeTask,
    createStorageBuffer,
    disposeComputeBindingSet,
    disposeComputeShader,
    disposeStorageBuffer,
    prepareComputeShader,
    type ComputeShader,
    type EngineContext,
} from "babylon-lite";

export interface OceanResourceScope {
    readonly releases: (() => void)[];
    disposed: boolean;
}

export function createOceanResourceScope(): OceanResourceScope {
    return { releases: [], disposed: false };
}

export function assertOceanScopeActive(scope: OceanResourceScope): void {
    if (scope.disposed) {
        throw new Error("Ocean resources have been disposed.");
    }
}

export function ownOceanResource<T>(scope: OceanResourceScope, resource: T, release: (value: T) => void): T {
    if (scope.disposed) {
        release(resource);
        throw new Error("Ocean resources have been disposed.");
    }
    scope.releases.push(() => release(resource));
    return resource;
}

export function disposeOceanScope(scope: OceanResourceScope): void {
    scope.disposed = true;
    const pending = scope.releases.splice(0);
    const errors: unknown[] = [];
    for (let index = pending.length - 1; index >= 0; index--) {
        const release = pending[index]!;
        try {
            release();
        } catch (error) {
            scope.releases.unshift(release);
            errors.push(error);
        }
    }
    if (errors.length) {
        throw new AggregateError(errors, "Ocean resource cleanup failed; release external consumers before retrying disposal.");
    }
}

export function rollbackOceanScope(scope: OceanResourceScope, error: unknown): never {
    try {
        disposeOceanScope(scope);
    } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Ocean initialization and resource cleanup failed.", { cause: error });
    }
    throw error;
}

export function createOceanComputeOwner(engine: EngineContext, scope: OceanResourceScope) {
    const shaders: ComputeShader[] = [];
    return {
        shader(options: Parameters<typeof createComputeShader>[1]) {
            const shader = ownOceanResource(scope, createComputeShader(engine, options), disposeComputeShader);
            shaders.push(shader);
            return shader;
        },
        bindings(shader: Parameters<typeof createComputeBindingSet>[0], resources: Parameters<typeof createComputeBindingSet>[1]) {
            return ownOceanResource(scope, createComputeBindingSet(shader, resources), disposeComputeBindingSet);
        },
        buffer(source: Parameters<typeof createStorageBuffer>[1], options?: Parameters<typeof createStorageBuffer>[2]) {
            return ownOceanResource(scope, createStorageBuffer(engine, source, options), disposeStorageBuffer);
        },
        task(name: string) {
            const task = createComputeTask(engine, name);
            const dispose = task.dispose.bind(task);
            task.dispose = () => {
                scope.disposed = true;
                dispose();
            };
            return ownOceanResource(scope, task, (owned) => owned.dispose());
        },
        async prepare(): Promise<void> {
            const failures: unknown[] = [];
            for (const result of await Promise.allSettled(shaders.map((shader) => prepareComputeShader(shader)))) {
                if (result.status === "rejected") {
                    failures.push(result.reason);
                }
            }
            if (failures.length) {
                throw new AggregateError(failures, "Ocean compute shader preparation failed.");
            }
            assertOceanScopeActive(scope);
        },
    };
}

export type OceanComputeOwner = ReturnType<typeof createOceanComputeOwner>;
