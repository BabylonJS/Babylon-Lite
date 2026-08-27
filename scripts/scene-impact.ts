import { existsSync, readFileSync } from "fs";
import { dirname, extname, relative, resolve } from "path";

export interface SceneImpactManifest {
    version: 1;
    commit: string;
    scenes: string[];
    files: Record<string, string[]>;
}

export function isSceneImpactManifest(value: unknown): value is SceneImpactManifest {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const manifest = value as Partial<SceneImpactManifest>;
    return (
        manifest.version === 1 &&
        typeof manifest.commit === "string" &&
        Array.isArray(manifest.scenes) &&
        manifest.scenes.every((scene) => typeof scene === "string") &&
        typeof manifest.files === "object" &&
        manifest.files !== null &&
        Object.values(manifest.files).every((scenes) => Array.isArray(scenes) && scenes.every((scene) => typeof scene === "string"))
    );
}

interface BundleManifestEntry {
    runtimeChunks?: string[];
}

export type BundleManifest = Record<string, BundleManifestEntry>;

interface BundleInfoModule {
    id: string;
}

interface BundleInfoChunk {
    file: string;
    modules: BundleInfoModule[];
}

interface BundleInfo {
    chunks: BundleInfoChunk[];
}

export interface SceneSelection {
    scenes: string[];
    fullRun: boolean;
    reasons: string[];
}

export interface SceneSelectionInput {
    allScenes: string[];
    changedFiles: string[];
    changedSceneIds?: number[];
    impactManifest?: SceneImpactManifest | null;
    dependencies?: ReadonlyMap<string, readonly string[]>;
}

const DIRECT_SCENE_PATTERNS = [
    /^lab\/lite\/(?:src\/(?:lite|bjs|shared)\/)?scene(\d+)(?:[./-]|$)/,
    /^tests\/lite\/parity\/scenes\/scene(\d+)(?:-|\.spec\.ts$)/,
    /^reference\/lite\/scene(\d+)(?:-|\/)/,
];

const IGNORED_PATH_PATTERNS = [
    /^docs\//,
    /^\.github\//,
    /^playground\//,
    /^packages\/babylon-lite-gl\//,
    /^packages\/babylon-lite-compat\//,
    /^tests\/gl\//,
    /^reference\/gl\//,
    /^lab\/gl\//,
    /^lab\/public\/gl\//,
    /^lab\/public\/thumbnails\//,
    /^tests\/lite\/unit\//,
    /^tests\/lite\/build\//,
    /^tests\/lite\/no-webgpu\//,
    /(?:^|\/)(?:README|LICENSE|NOTICE)(?:\.[^/]*)?$/i,
    /\.md$/i,
];

const RUNTIME_PATH_PATTERNS = [/^packages\/babylon-lite\/src\//, /^lab\/lite\/src\/(?:lite|shared)\//, /^lab\/lite\/scene\d+\.html$/, /^lab\/public\//];

function normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function sceneNumber(scene: string): number {
    return Number(scene.slice("scene".length));
}

function sortScenes(scenes: Iterable<string>): string[] {
    return [...new Set(scenes)].sort((a, b) => sceneNumber(a) - sceneNumber(b) || a.localeCompare(b));
}

export function directSceneForPath(path: string): string | null {
    const normalized = normalizePath(path);
    for (const pattern of DIRECT_SCENE_PATTERNS) {
        const match = normalized.match(pattern);
        if (match) {
            return `scene${match[1]}`;
        }
    }
    return null;
}

export function normalizeImpactModulePath(moduleId: string): string | null {
    const normalized = normalizePath(moduleId).split("?", 1)[0]!;
    if (!normalized || normalized.startsWith("\0") || normalized.startsWith("node_modules/")) {
        return null;
    }

    const libPrefix = "packages/babylon-lite/build/lib/";
    if (normalized.startsWith(libPrefix)) {
        const libPath = normalized.slice(libPrefix.length);
        if (libPath.startsWith("_chunks/")) {
            return null;
        }
        const sourcePath = `packages/babylon-lite/src/${libPath}`;
        return sourcePath.replace(/\.(?:mjs|cjs|js)$/, ".ts");
    }

    return normalized;
}

function impactSourcePaths(root: string, moduleId: string): string[] {
    const normalized = normalizePath(moduleId).split("?", 1)[0]!;
    if (normalized.startsWith("packages/babylon-lite/build/lib/") && /\.(?:mjs|cjs|js)$/.test(normalized)) {
        const mapPath = resolve(root, `${normalized}.map`);
        if (existsSync(mapPath)) {
            const sourceMap = JSON.parse(readFileSync(mapPath, "utf-8")) as { sources?: string[] };
            const rootPrefix = normalizePath(resolve(root)) + "/";
            const sources = (sourceMap.sources ?? [])
                .map((source) => resolve(dirname(mapPath), source))
                .filter((source) => normalizePath(source).startsWith(rootPrefix))
                .map((source) => normalizePath(relative(root, source)))
                .filter((source) => !source.startsWith("node_modules/"));
            if (sources.length > 0) {
                return [...new Set(sources)];
            }
        }
    }
    const source = normalizeImpactModulePath(moduleId);
    return source ? [source] : [];
}

function extractLocalSpecifiers(source: string): string[] {
    const specifiers = new Set<string>();
    const patterns = [
        /(?:import|export)\s+(?:[^"'()]*?\s+from\s*)?["']([^"']+)["']/g,
        /import\s*\(\s*["']([^"']+)["']\s*\)/g,
        /new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
    ];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            const specifier = match[1];
            if (specifier?.startsWith(".")) {
                specifiers.add(specifier);
            }
        }
    }
    return [...specifiers];
}

function resolveLocalSpecifier(root: string, importer: string, specifier: string): string | null {
    const cleanSpecifier = specifier.split(/[?#]/, 1)[0]!;
    const absolute = resolve(root, dirname(importer), cleanSpecifier);
    const extension = extname(absolute);
    const candidates = [
        absolute,
        ...(extension === ".js" || extension === ".mjs" || extension === ".cjs" ? [absolute.slice(0, -extension.length) + ".ts", absolute.slice(0, -extension.length) + ".tsx"] : []),
        ...(extension ? [] : [`${absolute}.ts`, `${absolute}.tsx`, `${absolute}.json`, `${absolute}.wgsl`, resolve(absolute, "index.ts")]),
    ];
    const rootPrefix = normalizePath(resolve(root)) + "/";
    for (const candidate of candidates) {
        const normalizedAbsolute = normalizePath(resolve(candidate));
        if (normalizedAbsolute.startsWith(rootPrefix) && existsSync(candidate)) {
            return normalizePath(relative(root, candidate));
        }
    }
    return null;
}

export function localDependencies(root: string, file: string): string[] {
    const absolute = resolve(root, file);
    if (!existsSync(absolute) || ![".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extname(absolute))) {
        return [];
    }
    const source = readFileSync(absolute, "utf-8");
    return extractLocalSpecifiers(source)
        .map((specifier) => resolveLocalSpecifier(root, file, specifier))
        .filter((dependency): dependency is string => dependency !== null);
}

function addWithDependencies(
    root: string,
    fileScenes: Map<string, Set<string>>,
    dependencyCache: Map<string, string[]>,
    initialFile: string,
    scenes: readonly string[]
): void {
    const addScenes = (file: string): void => {
        let mappedScenes = fileScenes.get(file);
        if (!mappedScenes) {
            mappedScenes = new Set<string>();
            fileScenes.set(file, mappedScenes);
        }
        for (const scene of scenes) {
            mappedScenes.add(scene);
        }
    };

    addScenes(initialFile);
    let dependencies = dependencyCache.get(initialFile);
    if (!dependencies) {
        dependencies = localDependencies(root, initialFile);
        dependencyCache.set(initialFile, dependencies);
    }
    for (const dependency of dependencies) {
        if (![".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extname(dependency))) {
            addScenes(dependency);
        }
    }
}

export function createSceneImpactManifest(root: string, commit: string, bundleManifest: BundleManifest, bundleInfoDir: string): SceneImpactManifest {
    const fileScenes = new Map<string, Set<string>>();
    const dependencyCache = new Map<string, string[]>();
    const scenes = sortScenes(Object.keys(bundleManifest));

    for (const scene of scenes) {
        const runtimeChunks = new Set(bundleManifest[scene]?.runtimeChunks ?? []);
        const bundleInfoPath = resolve(bundleInfoDir, `${scene}.json`);
        if (runtimeChunks.size === 0 || !existsSync(bundleInfoPath)) {
            throw new Error(`Cannot build scene impact data for ${scene}: runtime chunks or bundle info are missing.`);
        }

        const bundleInfo = JSON.parse(readFileSync(bundleInfoPath, "utf-8")) as BundleInfo;
        for (const chunk of bundleInfo.chunks) {
            if (!runtimeChunks.has(chunk.file)) {
                continue;
            }
            for (const module of chunk.modules) {
                for (const file of impactSourcePaths(root, module.id)) {
                    addWithDependencies(root, fileScenes, dependencyCache, file, [scene]);
                }
            }
        }
    }

    const files: Record<string, string[]> = {};
    for (const file of [...fileScenes.keys()].sort()) {
        files[file] = sortScenes(fileScenes.get(file)!);
    }
    return { version: 1, commit, scenes, files };
}

function isIgnoredPath(path: string): boolean {
    return IGNORED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function isRuntimePath(path: string): boolean {
    return RUNTIME_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export function selectAffectedScenes(input: SceneSelectionInput): SceneSelection {
    const allScenes = sortScenes(input.allScenes);
    const allSceneSet = new Set(allScenes);
    const changedFiles = input.changedFiles.map(normalizePath);
    const changedSet = new Set(changedFiles);
    const selectedByFile = new Map<string, Set<string>>();
    const reasons: string[] = [];

    for (const file of changedFiles) {
        const scenes = new Set<string>();
        const directScene = directSceneForPath(file);
        if (directScene && allSceneSet.has(directScene)) {
            scenes.add(directScene);
        }
        for (const scene of input.impactManifest?.files[file] ?? []) {
            if (allSceneSet.has(scene)) {
                scenes.add(scene);
            }
        }
        selectedByFile.set(file, scenes);
    }

    for (const id of input.changedSceneIds ?? []) {
        const scene = `scene${id}`;
        if (allSceneSet.has(scene)) {
            let scenes = selectedByFile.get("scene-config.json");
            if (!scenes) {
                scenes = new Set<string>();
                selectedByFile.set("scene-config.json", scenes);
            }
            scenes.add(scene);
        }
    }

    let propagated = true;
    while (propagated) {
        propagated = false;
        for (const [importer, dependencies] of input.dependencies ?? []) {
            const importerScenes = selectedByFile.get(importer);
            if (!importerScenes?.size) {
                continue;
            }
            for (const dependency of dependencies) {
                if (!changedSet.has(dependency)) {
                    continue;
                }
                const dependencyScenes = selectedByFile.get(dependency) ?? new Set<string>();
                const previousSize = dependencyScenes.size;
                for (const scene of importerScenes) {
                    dependencyScenes.add(scene);
                }
                selectedByFile.set(dependency, dependencyScenes);
                propagated ||= dependencyScenes.size !== previousSize;
            }
        }
    }

    for (const file of changedFiles) {
        if (file === "scene-config.json" || selectedByFile.get(file)?.size || isIgnoredPath(file)) {
            continue;
        }
        if (isRuntimePath(file)) {
            reasons.push(`unmapped runtime file: ${file}`);
            return { scenes: allScenes, fullRun: true, reasons };
        }
        reasons.push(`unclassified file: ${file}`);
        return { scenes: allScenes, fullRun: true, reasons };
    }

    const selected = sortScenes([...selectedByFile.values()].flatMap((scenes) => [...scenes]));
    if (selected.length > 0) {
        reasons.push(`${selected.length} scene(s) selected from ${changedFiles.length} changed file(s)`);
    } else {
        reasons.push("no scene-affecting files changed");
    }
    return { scenes: selected, fullRun: false, reasons };
}
