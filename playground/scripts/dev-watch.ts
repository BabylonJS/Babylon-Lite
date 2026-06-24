/**
 * Optional dev loop for working on the Lite engine *and* the playground at once.
 *
 * The default `pnpm dev` builds the self-hosted "nightly" engine bundle once at
 * startup, so edits under `packages/babylon-lite/src` are NOT reflected until you
 * restart. This script instead runs two processes together:
 *
 *   1. `vite build --config vite.engine.config.ts --watch` — rebuilds the engine
 *      bundle into `public/engine/dev` on every core source change.
 *   2. `vite` — the playground dev server.
 *
 * Reload the page after an engine rebuild to pick up your core changes. Type
 * declarations for Monaco IntelliSense are generated once up front (the api-extractor
 * pass is too slow to run on every keystroke); re-run `pnpm build:types` if you
 * change the engine's public API surface and want updated editor hints.
 *
 * Launched via `pnpm dev:watch`. Dependency-free so it needs no extra tooling.
 */
import { spawn, type ChildProcess } from "node:child_process";

interface Task {
    name: string;
    command: string;
}

const tasks: Task[] = [
    { name: "engine", command: "vite build --config vite.engine.config.ts --watch" },
    { name: "app", command: "vite" },
];

const children: ChildProcess[] = [];
let shuttingDown = false;

function shutdown(code: number): void {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
        }
    }
    process.exit(code);
}

for (const task of tasks) {
    // `shell: true` resolves the local `vite` bin from the PATH the pnpm script
    // sets up, and keeps the spawn cross-platform (Windows uses vite.cmd).
    const child = spawn(task.command, { shell: true, stdio: "inherit" });
    children.push(child);
    child.on("exit", (code) => {
        if (!shuttingDown) {
            console.error(`[dev:watch] "${task.name}" exited (code ${code ?? "null"}); stopping.`);
            shutdown(code ?? 1);
        }
    });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
