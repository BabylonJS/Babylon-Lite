import type {
    SogImageInfo,
    SogInterval,
    SogV2SourceMetadata,
    StreamBound,
    StreamBranch,
    StreamLeaf,
    StreamManifest,
    StreamRepresentation,
    StreamSource,
    StreamTreeNode,
} from "./splat-stream-types.js";

const PREFIX = "[GaussianSplatStream]";
const MAX_DEPTH = 64;
const MAX_NODES = 1_000_000;

function fail(context: string, message: string): never {
    throw new Error(`${PREFIX} ${context}: ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(context, "expected an object");
    }
    return value as Record<string, unknown>;
}

function safeInteger(value: unknown, context: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        fail(context, `expected a safe integer >= ${minimum}`);
    }
    return value as number;
}

function finiteNumber(value: unknown, context: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(context, "expected a finite number");
    }
    return value;
}

function tuple3(value: unknown, context: string): [number, number, number] {
    if (!Array.isArray(value) || value.length !== 3) {
        fail(context, "expected exactly three components");
    }
    return [finiteNumber(value[0], `${context}[0]`), finiteNumber(value[1], `${context}[1]`), finiteNumber(value[2], `${context}[2]`)];
}

function strictKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            fail(context, `unsupported property "${key}"`);
        }
    }
}

function resolveLooseReference(reference: unknown, declaringUrl: string, context: string): string {
    if (typeof reference !== "string" || reference.length === 0) {
        fail(context, "expected a nonempty relative URL");
    }
    if (reference.includes("\0") || reference.includes("\\") || reference.startsWith("/") || reference.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(reference)) {
        fail(context, "unsafe relative URL");
    }
    let decodedPath: string;
    try {
        decodedPath = decodeURIComponent(reference.split(/[?#]/, 1)[0]!);
    } catch {
        fail(context, "malformed URL encoding");
    }
    if (decodedPath.includes("\0") || decodedPath.includes("\\") || decodedPath.startsWith("/") || decodedPath.split("/").some((segment) => segment === "..")) {
        fail(context, "relative URL traversal is not allowed");
    }
    let resolved: URL;
    try {
        resolved = new URL(reference, declaringUrl);
    } catch {
        fail(context, "invalid URL");
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
        fail(context, "only http and https URLs are supported");
    }
    if (resolved.pathname.toLowerCase().endsWith(".sog")) {
        fail(context, "packed .sog archives are unsupported");
    }
    return resolved.href;
}

function parseBound(value: unknown, context: string): StreamBound {
    const bound = record(value, context);
    strictKeys(bound, ["min", "max"], context);
    const sourceMin = tuple3(bound.min, `${context}.min`);
    const sourceMax = tuple3(bound.max, `${context}.max`);
    for (let axis = 0; axis < 3; axis++) {
        if (sourceMin[axis]! > sourceMax[axis]!) {
            fail(context, `min exceeds max on axis ${axis}`);
        }
    }
    const min = new Float32Array([sourceMin[0], sourceMin[1], -sourceMax[2]]);
    const max = new Float32Array([sourceMax[0], sourceMax[1], -sourceMin[2]]);
    const center = new Float32Array([(min[0]! + max[0]!) * 0.5, (min[1]! + max[1]!) * 0.5, (min[2]! + max[2]!) * 0.5]);
    const dx = max[0]! - center[0]!;
    const dy = max[1]! - center[1]!;
    const dz = max[2]! - center[2]!;
    return { boundMin: min, boundMax: max, center, radius: Math.hypot(dx, dy, dz) };
}

interface RawRepresentation {
    leafId: number;
    lod: number;
    fileId: number;
    offset: number;
    count: number;
    error: number;
}

function parseLeafRepresentations(
    leaf: Record<string, unknown>,
    leafId: number,
    lodLevels: number,
    fileCount: number,
    sourceIds: readonly number[],
    authoredErrors: boolean,
    context: string
): StreamRepresentation[] {
    const lods = record(leaf.lods, `${context}.lods`);
    const errors = leaf.errors;
    if (authoredErrors && !Array.isArray(errors)) {
        fail(`${context}.errors`, "required when lodErrors is true");
    }
    if (errors !== undefined && !Array.isArray(errors)) {
        fail(`${context}.errors`, "expected an array");
    }
    const raw: RawRepresentation[] = [];
    for (const [key, rawValue] of Object.entries(lods)) {
        if (!/^(0|[1-9]\d*)$/.test(key)) {
            fail(`${context}.lods`, `LOD key "${key}" is not a canonical decimal integer`);
        }
        const lod = Number(key);
        if (lod >= lodLevels) {
            fail(`${context}.lods.${key}`, "LOD index is outside lodLevels");
        }
        const rep = record(rawValue, `${context}.lods.${key}`);
        strictKeys(rep, ["file", "offset", "count"], `${context}.lods.${key}`);
        const fileId = safeInteger(rep.file, `${context}.lods.${key}.file`);
        if (fileId >= fileCount) {
            fail(`${context}.lods.${key}.file`, "file index is outside filenames");
        }
        const offset = safeInteger(rep.offset, `${context}.lods.${key}.offset`);
        const count = safeInteger(rep.count, `${context}.lods.${key}.count`);
        if (!Number.isSafeInteger(offset + count)) {
            fail(`${context}.lods.${key}`, "offset + count is not a safe integer");
        }
        if (count > 0) {
            const error = authoredErrors ? finiteNumber((errors as unknown[])[lod], `${context}.errors[${lod}]`) : 0;
            if (error < 0) {
                fail(`${context}.errors[${lod}]`, "error must be nonnegative");
            }
            raw.push({ leafId, lod, fileId: sourceIds[fileId]!, offset, count, error });
        }
    }
    if (raw.length === 0) {
        fail(context, "leaf has no positive-count representation");
    }
    if (!authoredErrors) {
        const finest = raw.reduce((best, rep) => (rep.lod < best.lod ? rep : best));
        let previousError = 0;
        for (const rep of raw.slice().sort((a, b) => a.lod - b.lod)) {
            rep.error = previousError = Math.max(previousError, Math.log(finest.count / rep.count));
        }
    }
    raw.sort((a, b) => a.count - b.count || a.error - b.error || a.lod - b.lod);
    const retained: StreamRepresentation[] = [];
    let bestError = Infinity;
    let lastCount = -1;
    for (const rep of raw) {
        if (rep.count === lastCount) {
            continue;
        }
        if (rep.error < bestError) {
            retained.push(rep);
            bestError = rep.error;
            lastCount = rep.count;
        }
    }
    return retained;
}

/** @internal Parses and validates a complete lod-meta v1 object. */
export function parseSplatStreamManifest(value: unknown, declaringUrl: string): StreamManifest {
    const manifest = record(value, "manifest");
    strictKeys(manifest, ["version", "asset", "count", "counts", "lodLevels", "filenames", "environment", "lodErrors", "tree"], "manifest");
    if (manifest.version !== 1) {
        fail("manifest.version", "only lod-meta version 1 is supported");
    }
    const lodLevels = safeInteger(manifest.lodLevels, "manifest.lodLevels", 1);
    if (lodLevels > 32) {
        fail("manifest.lodLevels", "must be in 1..32");
    }
    if (manifest.asset !== undefined) {
        const asset = record(manifest.asset, "manifest.asset");
        strictKeys(asset, ["generator", "chunkGaussians", "chunkExtent"], "manifest.asset");
        if (typeof asset.generator !== "string" || asset.generator.length === 0) {
            fail("manifest.asset.generator", "expected a nonempty string");
        }
        safeInteger(asset.chunkGaussians, "manifest.asset.chunkGaussians", 1);
        const chunkExtent = finiteNumber(asset.chunkExtent, "manifest.asset.chunkExtent");
        if (chunkExtent <= 0) {
            fail("manifest.asset.chunkExtent", "must be greater than zero");
        }
    }
    if (manifest.count !== undefined) {
        safeInteger(manifest.count, "manifest.count", 1);
    }
    if (manifest.counts !== undefined) {
        if (!Array.isArray(manifest.counts) || manifest.counts.length !== lodLevels) {
            fail("manifest.counts", `expected exactly ${lodLevels} entries`);
        }
        manifest.counts.forEach((count, index) => safeInteger(count, `manifest.counts[${index}]`, 0));
    }
    if (!Array.isArray(manifest.filenames) || manifest.filenames.length === 0) {
        fail("manifest.filenames", "expected a nonempty array");
    }
    const declaredUrls = manifest.filenames.map((filename, index) => resolveLooseReference(filename, declaringUrl, `manifest.filenames[${index}]`));
    const urls: string[] = [];
    const idsByUrl = new Map<string, number>();
    const sourceIds = declaredUrls.map((url) => {
        const existing = idsByUrl.get(url);
        if (existing !== undefined) {
            return existing;
        }
        const id = urls.length;
        urls.push(url);
        idsByUrl.set(url, id);
        return id;
    });
    if (manifest.lodErrors !== undefined && typeof manifest.lodErrors !== "boolean") {
        fail("manifest.lodErrors", "expected a boolean");
    }
    let environmentUrl: string | null = null;
    if (manifest.environment !== undefined && manifest.environment !== null) {
        environmentUrl = resolveLooseReference(manifest.environment, declaringUrl, "manifest.environment");
    }

    const seen = new WeakSet<object>();
    const leaves: StreamLeaf[] = [];
    let nodeCount = 0;
    const visit = (rawNode: unknown, depth: number, context: string): StreamTreeNode => {
        if (depth > MAX_DEPTH) {
            fail(context, `tree depth exceeds ${MAX_DEPTH}`);
        }
        const node = record(rawNode, context);
        if (seen.has(node)) {
            fail(context, "tree contains a cycle or reused node");
        }
        seen.add(node);
        nodeCount++;
        if (nodeCount > MAX_NODES) {
            fail(context, `tree contains more than ${MAX_NODES} nodes`);
        }
        const hasChildren = Object.prototype.hasOwnProperty.call(node, "children");
        const hasLods = Object.prototype.hasOwnProperty.call(node, "lods");
        if (hasChildren === hasLods) {
            fail(context, "node must have exactly one of children or lods");
        }
        const bound = parseBound(node.bound, `${context}.bound`);
        if (hasChildren) {
            strictKeys(node, ["bound", "children"], context);
            if (!Array.isArray(node.children) || node.children.length === 0) {
                fail(`${context}.children`, "expected a nonempty array");
            }
            const children = node.children.map((child, index) => visit(child, depth + 1, `${context}.children[${index}]`));
            return { kind: "branch", ...bound, children } satisfies StreamBranch;
        }
        strictKeys(node, ["bound", "lods", "errors"], context);
        const id = leaves.length;
        const alternatives = parseLeafRepresentations(node, id, lodLevels, declaredUrls.length, sourceIds, manifest.lodErrors === true, context);
        const parsed = { kind: "leaf", id, ...bound, alternatives } satisfies StreamLeaf;
        leaves.push(parsed);
        return parsed;
    };
    const root = visit(manifest.tree, 0, "manifest.tree");
    const consumers = urls.map(() => [] as StreamRepresentation[]);
    for (const leaf of leaves) {
        for (const rep of leaf.alternatives) {
            consumers[rep.fileId]!.push(rep);
        }
    }
    const sources: StreamSource[] = urls.map((url, id) => ({ id, url, consumers: consumers[id]! }));
    return { lodLevels, root, leaves, sources, environmentUrl };
}

function codebook(value: unknown, context: string): Float32Array {
    if (!Array.isArray(value) || value.length !== 256) {
        fail(context, "expected exactly 256 entries");
    }
    return new Float32Array(value.map((entry, index) => finiteNumber(entry, `${context}[${index}]`)));
}

function files(value: unknown, count: number, declaringUrl: string, context: string): string[] {
    if (!Array.isArray(value) || value.length !== count) {
        fail(context, `expected exactly ${count} file reference${count === 1 ? "" : "s"}`);
    }
    return value.map((entry, index) => resolveLooseReference(entry, declaringUrl, `${context}[${index}]`));
}

/** @internal Validates loose (directory-based) SOG v2 metadata in the supported DC/SH0 subset. */
export function parseLooseSogV2Metadata(value: unknown, declaringUrl: string): SogV2SourceMetadata {
    const metadata = record(value, "SOG metadata");
    strictKeys(metadata, ["version", "asset", "count", "means", "scales", "quats", "sh0", "shN"], "SOG metadata");
    if (metadata.version !== 2) {
        fail("SOG metadata.version", "only loose SOG version 2 is supported");
    }
    if (Object.prototype.hasOwnProperty.call(metadata, "shN")) {
        fail("SOG metadata.shN", "higher-order SH is unsupported");
    }
    if (metadata.asset !== undefined) {
        const asset = record(metadata.asset, "SOG metadata.asset");
        strictKeys(asset, ["generator"], "SOG metadata.asset");
        if (typeof asset.generator !== "string" || asset.generator.length === 0) {
            fail("SOG metadata.asset.generator", "expected a nonempty string");
        }
    }
    const count = safeInteger(metadata.count, "SOG metadata.count", 1);
    const means = record(metadata.means, "SOG metadata.means");
    const scales = record(metadata.scales, "SOG metadata.scales");
    const quats = record(metadata.quats, "SOG metadata.quats");
    const sh0 = record(metadata.sh0, "SOG metadata.sh0");
    strictKeys(means, ["mins", "maxs", "files"], "SOG metadata.means");
    strictKeys(scales, ["codebook", "files"], "SOG metadata.scales");
    strictKeys(quats, ["files"], "SOG metadata.quats");
    strictKeys(sh0, ["codebook", "files"], "SOG metadata.sh0");
    const meansMin = tuple3(means.mins, "SOG metadata.means.mins");
    const meansMax = tuple3(means.maxs, "SOG metadata.means.maxs");
    for (let axis = 0; axis < 3; axis++) {
        if (meansMin[axis]! > meansMax[axis]!) {
            fail("SOG metadata.means", `mins exceeds maxs on axis ${axis}`);
        }
    }
    const meansFiles = files(means.files, 2, declaringUrl, "SOG metadata.means.files");
    const scaleFiles = files(scales.files, 1, declaringUrl, "SOG metadata.scales.files");
    const quatFiles = files(quats.files, 1, declaringUrl, "SOG metadata.quats.files");
    const sh0Files = files(sh0.files, 1, declaringUrl, "SOG metadata.sh0.files");
    return {
        count,
        meansMin: new Float32Array(meansMin),
        meansMax: new Float32Array(meansMax),
        scaleCodebook: codebook(scales.codebook, "SOG metadata.scales.codebook"),
        sh0Codebook: codebook(sh0.codebook, "SOG metadata.sh0.codebook"),
        imageUrls: [meansFiles[0]!, meansFiles[1]!, scaleFiles[0]!, quatFiles[0]!, sh0Files[0]!],
    };
}

/** @internal Validates decoded image dimensions, format, CPU admission, capacity, and all referencing intervals. */
export function validateLooseSogV2Images(metadata: SogV2SourceMetadata, images: readonly SogImageInfo[], maxCpuBytes: number, intervals: readonly SogInterval[]): number {
    if (!Number.isSafeInteger(maxCpuBytes) || maxCpuBytes <= 0) {
        fail("maxCpuBytes", "expected a positive safe integer");
    }
    if (images.length !== 5) {
        fail("SOG images", "expected exactly five decoded images");
    }
    const width = safeInteger(images[0]?.width, "SOG images[0].width", 1);
    const height = safeInteger(images[0]?.height, "SOG images[0].height", 1);
    for (let index = 0; index < images.length; index++) {
        const image = images[index]!;
        if (safeInteger(image.width, `SOG images[${index}].width`, 1) !== width || safeInteger(image.height, `SOG images[${index}].height`, 1) !== height) {
            fail(`SOG images[${index}]`, "all decoded images must have identical dimensions");
        }
        const webpMime = image.mimeType?.toLowerCase().split(";", 1)[0] === "image/webp";
        let webpPath = false;
        if (image.url) {
            try {
                webpPath = new URL(image.url).pathname.toLowerCase().endsWith(".webp");
            } catch {
                fail(`SOG images[${index}].url`, "invalid image URL");
            }
        }
        if (!webpMime && !webpPath) {
            fail(`SOG images[${index}]`, "image must use image/webp MIME or a .webp URL path");
        }
    }
    const texels = width * height;
    const bytesPerImage = texels * 4;
    const decodedBytes = bytesPerImage * 5;
    if (!Number.isSafeInteger(texels) || !Number.isSafeInteger(bytesPerImage) || !Number.isSafeInteger(decodedBytes)) {
        fail("SOG images", "decoded image capacity is not a safe integer");
    }
    if (decodedBytes > maxCpuBytes) {
        fail("SOG images", `decoded images require ${decodedBytes} bytes, exceeding maxCpuBytes`);
    }
    if (texels < metadata.count || texels > metadata.count + Math.max(width, 4096)) {
        fail("SOG images", "image capacity is outside the admitted count padding");
    }
    for (let index = 0; index < intervals.length; index++) {
        const offset = safeInteger(intervals[index]!.offset, `intervals[${index}].offset`);
        const count = safeInteger(intervals[index]!.count, `intervals[${index}].count`);
        if (!Number.isSafeInteger(offset + count) || offset + count > metadata.count) {
            fail(`intervals[${index}]`, "interval exceeds SOG metadata count");
        }
    }
    return decodedBytes;
}
