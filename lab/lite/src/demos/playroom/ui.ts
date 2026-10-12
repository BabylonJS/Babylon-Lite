import type { PlayroomPhase, PlayroomState } from "./types.js";

const SOURCE_REVISION = "d22ce23ef308e28d1f8b6598b4c72ea944205925";
const LOADING_ROTATION_STEP_RADIANS = 360 / 8;
const READY_ROTATION_STEP = 0.02;
export const PLAYROOM_STARTUP_INTERVAL_MS = 10;

type PlayroomStartupAnimationMode = "loading" | "ready" | "stopped";

interface PlayroomStartupAnimation {
    readonly setMode: (mode: PlayroomStartupAnimationMode) => void;
    readonly dispose: () => void;
}

let startupAnimations: WeakMap<HTMLCanvasElement, PlayroomStartupAnimation> | null = null;

function element<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) {
        throw new Error(`The Playroom UI is missing #${id}.`);
    }
    return value as T;
}

export interface PlayroomUiLayout {
    readonly orientation: "landscape" | "portrait";
    readonly startupActionSize: number;
    readonly kickSize: number;
    readonly nextSize: number;
    readonly replaySize: number;
    readonly freeSize: number;
}

export interface PlayroomUiVisibility {
    readonly startup: boolean;
    readonly action: "loading" | "play" | "hidden";
    readonly hud: boolean;
    readonly kick: boolean;
    readonly next: boolean;
    readonly replay: boolean;
    readonly free: boolean;
}

export function calculatePlayroomUiLayout(width: number, height: number): PlayroomUiLayout {
    const orientation = width / height < 1 ? "portrait" : "landscape";
    const scaled = (factor: number): number => Math.round(width * factor * 1000) / 1000;
    return {
        orientation,
        startupActionSize: scaled(orientation === "portrait" ? 0.2 : 0.15),
        kickSize: Math.round(Math.min(width * 0.2, height * 0.4) * 1000) / 1000,
        nextSize: scaled(0.2),
        replaySize: scaled(0.2),
        freeSize: scaled(0.12),
    };
}

export function playroomUiVisibility(phase: PlayroomPhase, throwCount: number, _settlingFrames: number): PlayroomUiVisibility {
    const gameplay = phase === "aiming" || phase === "watching" || phase === "ended" || phase === "free";
    return {
        startup: phase === "loading" || phase === "ready",
        action: phase === "loading" ? "loading" : phase === "ready" ? "play" : "hidden",
        hud: gameplay,
        kick: phase === "aiming",
        next: phase === "watching" && throwCount < 3,
        replay: phase === "ended",
        free: gameplay,
    };
}

export interface PlayroomStartupUi {
    readonly showError: (message: string) => void;
    readonly dispose: () => void;
}

export function playroomStartupRotationAtTick(mode: Exclude<PlayroomStartupAnimationMode, "stopped">, tick: number): number {
    if (tick === 0) {
        return 0;
    }
    return mode === "loading" ? tick * LOADING_ROTATION_STEP_RADIANS : Math.cos((tick - 1) * READY_ROTATION_STEP) * 0.5;
}

function createStartupAnimation(action: HTMLButtonElement): PlayroomStartupAnimation {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let mode: PlayroomStartupAnimationMode = "stopped";
    let interval: number | null = null;
    let tick = 0;
    let disposed = false;

    const stopInterval = (): void => {
        if (interval !== null) {
            window.clearInterval(interval);
            interval = null;
        }
    };
    const applyRotation = (rotation: number): void => {
        action.style.setProperty("--playroom-action-rotation", `${rotation}rad`);
    };
    const restart = (): void => {
        stopInterval();
        tick = 0;
        applyRotation(0);
        if (mode === "stopped" || reducedMotion.matches) {
            return;
        }
        interval = window.setInterval(() => {
            tick++;
            applyRotation(playroomStartupRotationAtTick(mode as "loading" | "ready", tick));
        }, PLAYROOM_STARTUP_INTERVAL_MS);
    };
    const onReducedMotionChange = (): void => restart();
    reducedMotion.addEventListener("change", onReducedMotionChange);

    return {
        setMode(nextMode): void {
            if (disposed || mode === nextMode) {
                return;
            }
            mode = nextMode;
            restart();
        },
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            stopInterval();
            applyRotation(0);
            reducedMotion.removeEventListener("change", onReducedMotionChange);
        },
    };
}

function setStartupAnimationMode(canvas: HTMLCanvasElement, mode: PlayroomStartupAnimationMode): void {
    startupAnimations?.get(canvas)?.setMode(mode);
}

function applyResponsiveLayout(canvas: HTMLCanvasElement): void {
    const layout = calculatePlayroomUiLayout(window.innerWidth, window.innerHeight);
    const root = document.documentElement.style;
    root.setProperty("--playroom-startup-action-size", `${layout.startupActionSize}px`);
    root.setProperty("--playroom-kick-size", `${layout.kickSize}px`);
    root.setProperty("--playroom-next-size", `${layout.nextSize}px`);
    root.setProperty("--playroom-replay-size", `${layout.replaySize}px`);
    root.setProperty("--playroom-free-size", `${layout.freeSize}px`);
    const art = element<HTMLImageElement>("playroom-startup-art");
    art.src = layout.orientation === "portrait" ? art.dataset.portraitSrc! : art.dataset.landscapeSrc!;
    canvas.dataset.uiOrientation = layout.orientation;
}

function updateLoadingAnnouncement(canvas: HTMLCanvasElement): void {
    const status = element("playroom-loading-status");
    const detail = canvas.dataset.loadingDetail ?? "Loading The Playroom…";
    const progress = canvas.dataset.progress ? ` ${canvas.dataset.progress}%` : "";
    const size = canvas.dataset.loadingSize ? ` ${canvas.dataset.loadingSize}` : "";
    status.textContent = `${detail}${progress}${size}`;
}

export function installPlayroomStartupUi(canvas: HTMLCanvasElement): PlayroomStartupUi {
    const resize = (): void => applyResponsiveLayout(canvas);
    const progressObserver = new MutationObserver(() => updateLoadingAnnouncement(canvas));
    const animation = createStartupAnimation(element<HTMLButtonElement>("playroom-startup-action"));
    (startupAnimations ??= new WeakMap()).set(canvas, animation);
    animation.setMode("loading");
    resize();
    updateLoadingAnnouncement(canvas);
    window.addEventListener("resize", resize);
    progressObserver.observe(canvas, {
        attributes: true,
        attributeFilter: ["data-loading-detail", "data-loading-size", "data-progress"],
    });
    let disposed = false;
    return {
        showError(message: string): void {
            animation.setMode("stopped");
            const startup = element("playroom-startup");
            const error = element("playroom-startup-error");
            startup.dataset.state = "error";
            startup.hidden = false;
            error.textContent = message;
            error.hidden = false;
            element<HTMLButtonElement>("playroom-startup-action").disabled = true;
            element("playroom-loading-status").textContent = message;
        },
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            animation.dispose();
            startupAnimations?.delete(canvas);
            progressObserver.disconnect();
            window.removeEventListener("resize", resize);
        },
    };
}

export function updatePlayroomUi(state: PlayroomState): void {
    const visibility = playroomUiVisibility(state.phase, state.throwCount, state.settlingFrames);
    const startup = element("playroom-startup");
    const startupAction = element<HTMLButtonElement>("playroom-startup-action");
    const hud = document.querySelector<HTMLElement>(".playroom-hud");
    if (!hud) {
        throw new Error("The Playroom UI is missing .playroom-hud.");
    }

    if (state.phase === "ended") {
        element("playroom-throw-count").textContent = `${state.throwCount} throws`;
        element("playroom-score").textContent = `Total : ${state.score} points`;
    } else {
        element("playroom-throw-count").textContent = `throw ${state.throwCount} / 3`;
        element("playroom-score").textContent = `${state.score} points`;
    }
    element("playroom-audio").textContent = state.audio.status === "unavailable" ? "Audio unavailable" : state.audio.status === "ready" ? "Sound on" : "Loading audio";

    startup.hidden = !visibility.startup;
    startup.dataset.state = visibility.action === "play" ? "ready" : visibility.action;
    startupAction.disabled = visibility.action !== "play";
    startupAction.setAttribute("aria-label", visibility.action === "play" ? "Play" : "Loading The Playroom");
    startupAction.textContent = visibility.action === "play" ? "Play" : "Loading";
    setStartupAnimationMode(state.canvas, visibility.action === "play" ? "ready" : visibility.action === "loading" ? "loading" : "stopped");
    hud.hidden = !visibility.hud;
    element<HTMLButtonElement>("playroom-kick").hidden = !visibility.kick;
    const next = element<HTMLButtonElement>("playroom-next");
    next.hidden = !visibility.next;
    next.disabled = state.phase !== "watching" || state.settlingFrames < 2;
    element<HTMLButtonElement>("playroom-replay").hidden = !visibility.replay;
    const free = element<HTMLButtonElement>("playroom-free");
    free.hidden = !visibility.free;
    free.setAttribute("aria-pressed", String(state.phase === "free"));
    state.canvas.dataset.gamePhase = state.phase;
    state.canvas.dataset.throwCount = String(state.throwCount);
    state.canvas.dataset.score = String(state.score);
    state.canvas.dataset.bodyCount = String(state.world.records.length);
    state.canvas.dataset.constraintCount = String(state.world.constraints.length);
    state.canvas.dataset.sourceUiRevision = SOURCE_REVISION;
}

export function markPlayroomReady(state: PlayroomState): void {
    if (state.phase !== "loading") {
        return;
    }
    state.phase = "ready";
    state.underlyingPhase = "ready";
    updatePlayroomUi(state);
}

export interface PlayroomUiHandlers {
    play: () => void;
    kick: () => void;
    next: () => void;
    replay: () => void;
    free: () => void;
}

export function installPlayroomUi(handlers: PlayroomUiHandlers): () => void {
    const bindings: readonly [string, () => void][] = [
        ["playroom-startup-action", handlers.play],
        ["playroom-kick", handlers.kick],
        ["playroom-next", handlers.next],
        ["playroom-replay", handlers.replay],
        ["playroom-free", handlers.free],
    ];
    for (const [id, handler] of bindings) {
        element(id).addEventListener("click", handler);
    }
    return () => {
        for (const [id, handler] of bindings) {
            element(id).removeEventListener("click", handler);
        }
    };
}
