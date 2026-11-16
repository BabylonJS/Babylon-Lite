# Module: WebGPU-native Gaussian splat streaming

> Package path: `packages/babylon-lite/src/loader-splat-stream/`

## Purpose

This optional subsystem loads a spatial Gaussian-splat LOD manifest, draws a broad coarse representation as soon as its first shared source file is GPU-ready, and progressively replaces visible leaf intervals with finer alternatives under explicit splat, CPU-memory, GPU-memory, request, and decode limits.

The initial protocol scope is intentionally narrow:

- `lod-meta.json` manifest version 1;
- loose SOG `meta.json` version 2 chunks;
- DC/SH0 color only;
- WebGPU only.

The loader rejects higher-order SH (`shN`), packed `.sog` archives, SOG v1, unknown manifest/SOG versions, unsafe relative URLs, invalid ranges, and malformed data. Existing `loadSplat`, `loadSOG`, and `loadSPZ` behavior is unchanged. The streaming path has no WebGL or CPU-sort fallback and never exposes WebGPU handles publicly.

Manifest internal nodes are bounds-only hierarchy nodes. Renderable representations belong only to leaves. Each leaf LOD is an alternative `(file, offset, count)` interval. Files are fetched, decoded, cached, and evicted by resolved URL; leaves are selected and displayed by interval.

## Public API Surface

All public values are pure data. Behavior is provided by standalone functions. `GaussianSplatStream` never references a `SceneContext`.

```ts
export interface GaussianSplatStreamOptions {
    maxSplats?: number;
    maxCapacitySplats?: number;
    maxGpuBytes?: number;
    maxCpuBytes?: number;
    maxConcurrentRequests?: number;
    maxConcurrentDecodes?: number;
    screenError?: number;
    lodHysteresis?: number;
    lodCooldownMs?: number;
    maxRetries?: number;
    signal?: AbortSignal;
}

export type GaussianSplatStreamPhase = "bootstrap" | "streaming" | "idle" | "budget-limited" | "error" | "disposed";

export interface GaussianSplatStreamStats {
    readonly phase: GaussianSplatStreamPhase;
    readonly visibleLeaves: number;
    readonly coveredLeaves: number;
    readonly targetLeaves: number;
    readonly selectedSplats: number;
    readonly residentFiles: number;
    readonly queuedFiles: number;
    readonly pendingRequests: number;
    readonly residentGpuBytes: number;
    readonly allocatedGpuBytes: number;
    readonly fetchedBytes: number;
    readonly firstFrameMs: number | null;
    readonly error: Error | null;
}

export interface GaussianSplatStream extends SceneNode {
    readonly stats: GaussianSplatStreamStats;
    readonly firstFrameReady: Promise<void>;
    readonly boundMin: readonly [number, number, number];
    readonly boundMax: readonly [number, number, number];
    maxSplats: number;
    screenError: number;
    /** @internal */ /* subsystem-owned mutable state and GPU resources */
}

export function loadGaussianSplatStream(engine: EngineContext, metadataUrl: string, options?: GaussianSplatStreamOptions): Promise<GaussianSplatStream>;

export function attachGaussianSplatStream(scene: SceneContext, stream: GaussianSplatStream): void;

export function disposeGaussianSplatStream(scene: SceneContext, stream: GaussianSplatStream): void;
```

Defaults:

| Option                  |   Default | Validation                                   |
| ----------------------- | --------: | -------------------------------------------- |
| `maxSplats`             | 1,000,000 | safe integer, greater than zero              |
| `maxCapacitySplats`     | maxSplats | immutable safe integer, at least `maxSplats` |
| `maxGpuBytes`           |   256 MiB | safe integer, greater than zero              |
| `maxCpuBytes`           |    64 MiB | safe integer, greater than zero              |
| `maxConcurrentRequests` |         6 | safe integer in 1..32                        |
| `maxConcurrentDecodes`  |         2 | safe integer in 1..8                         |
| `screenError`           |  2 pixels | finite and greater than zero                 |
| `lodHysteresis`         |      0.15 | finite in 0..1                               |
| `lodCooldownMs`         |      0 ms | finite and nonnegative                       |
| `maxRetries`            |         2 | safe integer in 0..8                         |

The Trogir streaming demo uses the zero-ms cooldown default; error hysteresis stabilizes detail selection without delaying new demand.

The load promise resolves after the manifest is validated and stream state is initialized. It does not wait for a chunk. `attachGaussianSplatStream` is explicit, idempotence-guarded, and must run before or during scene registration. `firstFrameReady` resolves only after a nonempty coarse indirect draw has been submitted and `queue.onSubmittedWorkDone()` confirms completion. It rejects on bootstrap failure or disposal before that draw. Refinement failures remain visible through `stats.error` without rejecting an already-resolved readiness promise.

## Protocol Validation

### Manifest

JSON is parsed as `unknown`. Validation precedes large typed-array or GPU allocations.

```ts
interface StreamManifestV1 {
    version: 1;
    asset?: { generator: string; chunkGaussians: number; chunkExtent: number };
    count?: number;
    counts?: number[];
    lodLevels: number;
    filenames: string[];
    environment?: string | null;
    lodErrors?: boolean;
    tree: ManifestBranch | ManifestLeaf;
}

interface ManifestBound {
    min: [number, number, number];
    max: [number, number, number];
}

interface ManifestBranch {
    bound: ManifestBound;
    children: Array<ManifestBranch | ManifestLeaf>;
}

interface ManifestLeaf {
    bound: ManifestBound;
    lods: Record<string, { file: number; offset: number; count: number }>;
    errors?: number[];
}
```

Required invariants:

- explicit manifest `version` equals 1;
- optional splat-transform summary metadata is validated but does not influence selection: nonempty `asset.generator`, positive `asset.chunkGaussians`/`asset.chunkExtent`, positive `count`, and `counts` with one nonnegative safe integer per LOD;
- `lodLevels` is a safe integer in 1..32;
- `filenames` is nonempty and contains safe relative URL references, never `.sog` packed archives;
- every bound has six finite values and `min <= max` per axis;
- tree depth is at most 64, total nodes at most 1,000,000, and traversal detects cycles/reused objects;
- a node has exactly `children` or `lods`;
- a leaf LOD key is a canonical decimal integer in `[0, lodLevels)`;
- `file`, `offset`, `count`, and `offset + count` are safe integers; count zero is intentionally empty and never requested;
- every retained leaf has at least one positive-count representation;
- file references are resolved with `new URL(reference, declaringUrl)` and allow only `http:` or `https:` at runtime;
- `environment`, when present, resolves as a separate loose SOG metadata URL and never delays the first coarse frame.

Each positive representation receives authored error only when `lodErrors === true` and its matching error is finite and nonnegative. Otherwise the whole manifest uses derived errors. The lowest positive raw LOD index is the finest representation; increasing raw indices are visited in coarsening order, including across sparse missing indices. Starting at that finest positive representation count `Nref`, derived error for each coarser positive representation is:

```text
error[finest] = 0
error[lod] = max(previousError, ln(Nref / count[lod]))
```

Representations are sorted by ascending count and then ascending error. Keep a representation only when it strictly improves error over every cheaper retained representation. This removes dominated and equal-error alternatives even when authored counts are nonmonotonic. Stable ties use raw LOD and leaf ID.

Missing entries and count-zero entries do not consume an error and do not represent network failures. A zero in `errors` for a missing level is ignored.

### Loose SOG v2

```ts
interface SogV2Metadata {
    version: 2;
    asset?: { generator: string };
    count: number;
    means: { mins: [number, number, number]; maxs: [number, number, number]; files: [string, string] };
    scales: { codebook: number[]; files: [string] };
    quats: { files: [string] };
    sh0: { codebook: number[]; files: [string] };
    shN?: unknown;
}
```

Validation requires:

- `version === 2`, positive safe `count`, no `shN`;
- optional `asset.generator` is a nonempty provenance string;
- finite ordered three-component means bounds;
- scale and SH0 codebooks contain exactly 256 finite entries;
- exactly five safe relative image references;
- all decoded images have the same positive dimensions;
- dimensions and `width * height * 4` are safe and admitted under `maxCpuBytes`;
- image capacity is at least `count` and bounded by `count + max(width, 4096)` to reject malformed oversized sources;
- every manifest interval referencing the file satisfies `offset + count <= metadata.count`;
- image response MIME is `image/webp` or has a `.webp` URL path, and decoding succeeds without resizing.

`createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "none" })` preserves bytes. Upload uses `rgba8unorm`, no mipmaps, no Y flip, and `copyExternalImageToTexture`. Bitmaps are closed in `finally`, including cancellation, stale generations, and partial failure.

## Coordinate and Decode Math

For splat index `i`, image coordinate is `(i % width, i / width)` using integer division. Row zero remains row zero.

For each mean axis:

```text
u16 = lowByte + 256 * highByte
t = u16 / 65535
signedLog = min + (max - min) * t
sourcePosition = sign(signedLog) * (exp(abs(signedLog)) - 1)
```

Scale image RGB bytes independently index the same scalar codebook:

```text
scale = exp(scaleCodebook[byte])
```

Quaternion bytes:

```text
a,b,c = (byte / 255 - 0.5) * sqrt(2)
d = sqrt(max(0, 1 - a*a - b*b - c*c))
selector = alphaByte - 252
```

The exact source XYZW table is:

| Selector | XYZW        |
| -------: | ----------- |
|        0 | `(a,b,c,d)` |
|        1 | `(d,b,c,a)` |
|        2 | `(b,d,c,a)` |
|        3 | `(b,c,d,a)` |

Selectors outside 0..3 invalidate the splat and produce the projection sentinel. Metadata-wide invalid selector rates are surfaced as an error in tests; runtime does not read back a count.

Color and opacity:

```text
rgb = 0.5 + 0.28209479177387814 * sh0Codebook[sh0.rgbByte]
opacity = sh0.alphaByte / 255
```

RGB remains full-precision and is never clamped to UNORM. HDR and negative DC values are valid.

Let quaternion matrix be `R`, and let the Lite Gaussian physical axis matrix use twice the decoded scales:

```text
M = R * diag(2*sx, 2*sy, 2*sz)
Csource = M * transpose(M)
S = diag(1, 1, -1)
centerLite = S * centerSource
Clite = S * Csource * transpose(S)
```

The same `S` transforms leaf/root bounds by transforming all eight corners and recomputing min/max. No static-loader Y negation or X rotation is applied.

Dataset-authored scene placement remains separate from this format conversion. The published Trogir viewer places its Gaussian entity with a 180-degree Z rotation, so the Trogir demo sets `stream.rotation.z = Math.PI` before attachment and transforms the public bounds with the same placement. This ordinary scene-node transform is consumed by both GPU center/covariance projection and CPU world-bound planning. It is not part of SOG decoding and must not be replaced by a screen-Y, camera-up, WebP-row, or generic loader flip.

## Internal Architecture

### Immutable manifest data

```ts
interface StreamRepresentation {
    readonly leafId: number;
    readonly lod: number;
    readonly fileId: number;
    readonly offset: number;
    readonly count: number;
    readonly error: number;
}

interface StreamLeaf {
    readonly id: number;
    readonly boundMin: Float32Array;
    readonly boundMax: Float32Array;
    readonly center: Float32Array;
    readonly radius: number;
    readonly alternatives: readonly StreamRepresentation[]; // cheap/coarse to costly/fine
}

interface StreamSource {
    readonly id: number;
    readonly url: string;
    readonly consumers: readonly StreamRepresentation[];
}
```

Depth-first traversal assigns stable leaf IDs. Internal tree nodes are retained only for CPU frustum traversal; they never receive representations.

### Mutable file state

```text
unrequested -> queued -> fetching-metadata -> fetching-images
             -> decoding -> uploading -> resident
queued/fetching/decoding/uploading -> cancelled
network failure -> retry-wait -> queued
terminal protocol/decode failure -> failed
any nonterminal state -> disposed
resident -> evicting -> unrequested
```

Every file state stores generation, attempt, demand count, bootstrap pin, displayed refs, pending refs, last-used frame, encoded bytes, decoded bytes, GPU bytes, error, abort controller, and source textures/codebook buffer. A completion publishes only when stream, file generation, and selection demand still match.

### Mutable leaf state

```ts
interface StreamLeafState {
    visible: boolean;
    target: StreamRepresentation;
    displayed: StreamRepresentation | null;
    pending: StreamRepresentation | null;
    lastVisibleFrame: number;
    selectionGeneration: number;
    lodCooldownUntil: number;
    cooldownHeld: boolean;
}
```

`target`, `resident`, `displayed`, and `pending` are independent. A target change never removes `displayed`. At a frame boundary, pending replacements are evaluated against the complete currently displayed foreground generation and the environment reservation. A replacement publishes only when the resulting aggregate fits; downgrades can free space for later upgrades in the same boundary. No overflow path truncates intervals or drops valid displayed coverage. One active generation contains at most one interval per leaf.

`lodCooldownUntil` is stamped from the injected monotonic clock only after `setSplatStreamGpuIntervals` accepts a generation in which an already displayed leaf is replaced by a different representation. `cooldownHeld` records that the current shared solve actually admitted that deadline's hold; publication and pressure classification consult this decision rather than treating every unexpired timestamp as affordable. Initial coverage does not stamp it. The first coarse-to-fine replacement is immediate and starts the first deadline; identical, rejected, pending-only, and retargeted work does not change the deadline. A zero `lodCooldownMs` disables the policy.

`displayed` records the leaf's last successful fallback independently of camera visibility. After the first camera selection, active range generation contains only currently visible displayed leaves. Invisible historical leaves keep cache residency when otherwise useful, but contribute no active interval, no displayed protection/reference, and no splats to the indirect draw. Re-entering the region can reactivate the retained fallback without a request; eviction remains legal while it is invisible and unpinned.

### Stream phases

```text
load/validate -> bootstrap
bootstrap source queued + pipelines compiling
bootstrap source resident -> coarse active generation
coarse draw submitted/completed -> streaming
no queued/pending useful work -> idle
delayed desired LOD waiting for its deadline -> streaming
new camera/budget/residency change -> streaming
unmet refinement waits for protected-aware GPU retirement -> budget-limited
terminal bootstrap/runtime failure -> error
dispose from any phase -> disposed
```

Fine refinement scheduling is disabled until a one-time bootstrap copy of the GPU-written indirect arguments reports `instanceCount > 0`. If the initial camera sees no leaf covered by the primary bootstrap source, its visible cheapest source is requested before this barrier so readiness cannot deadlock on an invisible bootstrap file. The 16-byte MAP_READ buffer is encoded after projection, mapped only after frame submission, and immediately destroyed and released from the ledger. Zero-opacity, invalid-selector, culled, and otherwise sentinel-only canonical input cannot satisfy readiness. No steady-state readback exists. Pipeline compilation overlaps bootstrap I/O. After readiness, an uncovered leaf requests its cheapest source before its finer target so an unaffordable fine file cannot prevent coarse coverage. The environment is queued only after the coarse submission. From that point until residency or disposal, it owns one persistent demand independent of leaf visibility/LOD demand; repeated selection updates cannot cancel or duplicate its queued/in-flight request.

The mandatory 16-byte bootstrap readback owns protected ledger headroom before any source can be admitted. The first pass that records a nonempty bootstrap projection converts that hold into the readback allocation; other pass bindings cannot consume a second hold. If the hold cannot be admitted, stream creation fails explicitly before source requests begin. Disposal releases an unused hold, while a recorded readback remains charged through mapping and destruction.

Before the nonempty coarse-draw barrier resolves, every publication path is coarse-only: camera selection may retain a finer desired `target`, but resident target staging, source completion, fallback recovery, and aggregate commit may publish only each visible leaf's cheapest representation. This deliberate bootstrap wait is not generation pressure and never stamps a cooldown. When the barrier resolves, already-resident desired targets are staged and committed immediately; the first accepted coarse-to-fine replacement then starts its cooldown from that post-barrier publication time.

## Selection and Scheduling

Selection uses the actual pass camera, projection, stream world transform, and target dimensions supplied through `DrawUpdateContext`. Each draw binding retains its own visibility, nearest-bound distance, and projected-radius snapshot for the current and immediately preceding frame. Fresh snapshots are merged per leaf by minimum camera distance and maximum projected radius, then one shared coarse-floor allocation runs against the stream's capacity. The aggregate therefore cannot contain independently affordable camera plans whose union exceeds capacity; single-camera ordering is unchanged. Cancellation and cache protection consume the resulting aggregate, so an update from one camera cannot cancel delayed work still required by another. Perspective cameras are supported initially. Orthographic cameras set a visible actionable stream error and preserve the last displayed generation.

Transform leaf bounds conservatively. For arbitrary affine world transforms, transform the eight AABB corners; radius is the maximum distance from transformed center. Frustum tests use six normalized world-space planes. Bounds outside the current frustum receive no new refinement request, though already resident sources remain cacheable.

CPU-selected splats and resident source files are planning/cache metrics, not the GPU-visible draw count. Shared files may remain resident and selected ranges may contain sentinel records after individual behind-camera rejection; only the valid sorted prefix named by the reset-per-projection indirect instance count is rasterized.

For leaf sphere radius `r`, nearest camera-to-AABB distance `d`, target height `h`, and projection matrix element `p11`:

```text
focalScale = h * abs(p11) / 2
projectedRadius = focalScale * r / max(r + d, near)
errorProxy = projectedRadius * representation.error
```

This is an error-weighted projected-radius proxy in pixels, not a metric geometric error bound.

The planner begins with the cheapest positive representation for every visible leaf and recomputes allocation from that floor whenever the camera, viewport, transform, or target changes. If this baseline exceeds `maxSplats`, selection fails explicitly; it never drops visible leaves silently. Screen error decides whether a successor is justified. Among justified affordable successors, the nearest leaf bounds to the current camera upgrade first; equal distances prefer greater current projected screen-error proxy and then stable leaf ID:

```text
currentErrorProxy = projectedRadiusPx * current.error
```

Only Pareto-chain successors with positive error reduction are candidates; splat cost is an admission constraint, not an efficiency divisor. Distance ordering concentrates scarce detail in camera-containing and nearby volumes instead of spending the finite budget on many cheap distant leaves. Stop when no affordable upgrade remains above its threshold, all leaves meet `screenError`, or no positive reduction remains.

Previous targets do not reserve budget before the solve. Hysteresis biases each candidate threshold instead:

- steps up to the previous target use `screenError * (1 - lodHysteresis)`, retaining displayed detail within the lower band when it still wins the current distance ordering;
- steps beyond the previous target use `screenError * (1 + lodHysteresis)`;
- steps without a previous target, and every step under hard pressure, use `screenError`;
- no hysteresis value, including zero, can lock an old region's allocation when a moved camera makes another visible leaf's screen error worse.

An unheld aggregate solve first determines current desired detail. During an active per-leaf cooldown, a second shared solve starts that visible leaf at its displayed alternative and forbids further refinement of that leaf. The held representations and every other visible leaf's coarse floor are admitted as one aggregate. If that complete baseline exceeds the effective foreground budget, no hold is applied and the normal solve runs. Generation/admission pressure, missing coverage, source eviction, visibility removal, and environment-driven or explicit budget reductions likewise bypass or clear holds. A cooldown wait alone is never generation pressure and never causes a request/cancel cycle. Resident completions and fallback publication pass through the same policy, so asynchronous arrival cannot replace a held visible LOD. Expired deadlines are detected from the monotonic clock during normal updates and invalidate the aggregate cache without browser timers; delayed desired work keeps phase `streaming` until reconsidered. Disposal clears all pending cooldown state.

Per-binding geometry metrics are cached only for byte-for-byte identical numeric inputs: copied view-projection and world-matrix contents, camera position, projection scale and near plane, effective target dimensions, perspective mode, capacity, screen error, and hysteresis. Public option validation still runs before a cache hit. Mutable arrays are compared by contents, never identity. The shared aggregate result is reused only when the ordered binding-plan identities, effective allowance, policy settings, pressure/admission state, source/publication generation, and cooldown-expiry generation are unchanged. Source arrival or eviction, bootstrap release, environment allowance changes, accepted publication, pressure changes, cache-admission changes, binding addition/removal, and cooldown expiry invalidate the corresponding cache. Retirement, completion handling, retries, source scheduling, protection, and statistics continue on cached frames.

File request priorities are:

1. primary bootstrap source;
2. visible uncovered leaves with no displayed representation;
3. visible upgrades by nearest requesting leaf distance, deduplicated by file;
4. environment;
5. optional adjacent prefetch only when all higher classes are admitted.

Bootstrap source selection aggregates each leaf's cheapest representation by file and chooses greatest leaf coverage, then lowest splat count, then lowest stable file ID. This selects Trogir `6_0/meta.json` without filename/index special casing. It is pinned for stream lifetime. Sparse leaves not covered by it do not delay first frame; after the barrier their cheapest sources are class 2.

## Transport, CPU Admission, and Retry

A priority queue is keyed by file URL and generation. At most one file preparation exists per URL. Demand from several leaves increments shared ownership and never duplicates fetch/decode/upload.

`maxConcurrentRequests` bounds both concurrent source preparations and the global HTTP-response semaphore. `maxConcurrentDecodes` separately limits active `createImageBitmap` calls. Concurrent preparations each receive a fixed admission allowance of `floor(maxCpuBytes / maxConcurrentRequests)` before fetching metadata. Actual encoded and decoded bytes remain charged to the global ledger. Each source fetches and decodes its images in order while other sources progress independently. The sum of allowances cannot exceed the CPU budget, preventing circular waits between retained payloads.

A preparation whose peak exceeds its shared allowance releases its resources and requeues once for exclusive admission with the full CPU budget. An exclusive job at the head of the priority queue waits for active preparations to drain and prevents lower-ranked jobs from starting. Valid large sources retain access to the entire budget. Exceeding the full budget is terminal. Admission retries preserve the original priority and FIFO sequence; disposal, cancellation and generation replacement never restart a job.

When the active slots are full or an exclusive preparation blocks admission, queued strictly higher-priority work cooperatively preempts lower-priority active preparations. Each scheduling pass fills available slots before evaluating preemption for the remaining queue, so cleanup of one preempted attempt can admit urgent work and reclaim the next needed slot without a demand change or another request completing. A source whose demand changes from refinement to uncovered coverage promotes its existing same-generation scheduler job in place: the promise, generation, FIFO sequence, request ownership, and preparation handlers remain unchanged. Within a priority class, sources are ordered by the nearest requesting leaf distance, then FIFO sequence. Camera distance changes and queued cancellations share one deferred scheduling pass per synchronous batch. Cancelling a queued exclusive job directly or through its signal lets eligible work use spare slots on the next microtask without waiting for active preparations to finish. Equal-class updates never abort active work. Strict-priority promotions schedule immediately. Any immediate scheduling pass consumes pending updates and suppresses the redundant deferred pass. Runtime-provided preparation hooks retain their own ownership and are never invoked again merely to promote priority.

Preemption aborts interruptible metadata/image transport promptly. `createImageBitmap` is not assumed abortable: preemption latches during an active decode and changes owners only after that decode actually settles, its late bitmap is closed, and all counters and reservations are released. The lower-priority attempt's `finally` cleanup releases every body, bitmap, CPU reservation and preparation slot before the same unresolved job is requeued with its original FIFO sequence. External abort, generation replacement, disposal, retry exhaustion, and terminal errors never requeue. Equal priorities cannot preempt. This gives newly visible coarse coverage bounded progress ahead of stalled abortable fine transport while preserving whole-preparation peak accounting and unique ownership; a nonabortable stalled platform decode remains an unavoidable safe-boundary limit.

`Content-Length`, when present, is parsed as a canonical safe integer and reserved before the body reader is acquired. An over-budget declared body is rejected without application-side buffering. Unknown-length bodies are consumed from `ReadableStream` chunks; each retained chunk is admitted before retention. The transport never calls `response.blob()` on an unaccounted whole body.

For WebP images, the bounded RIFF/VP8X, VP8L, or VP8 frame header is inspected without altering the encoded payload. While the first encoded body remains charged, validated `width * height * 4 * imageCount` decoded capacity is reserved before the first `createImageBitmap` call. Every later encoded body is admitted in addition to that complete decoded hold and remains charged until its decode settles. This accounts for all retained prior bitmaps, the current encoded `Blob`, and the bitmap allocation that decode may create at the same instant. Competing preparations may wait for one another's reservations, but a preparation whose own retained decoded capacity plus the next body exceeds `maxCpuBytes` rejects immediately rather than self-deadlocking. Subsequent image headers must match before decode. CPU-admission waiters reject immediately on abort. Encoded and decoded reservations are independently released in `finally` across success, cancellation, stale generations, and failures.

CPU accounting includes JSON/encoded response bytes, decoded bitmap capacity (`width * height * 4` per bitmap), queued upload payloads, and temporary validation buffers. Reservations release in `finally`.

The initial manifest and all source metadata/images apply the same policy: transient status 408, 425, 429, and 5xx plus network failures retry at most `maxRetries` times with abort-aware delay:

```text
delayMs = min(2000, 125 * 2^attempt) + deterministicJitter(fileId, attempt, 0..63)
```

Protocol, JSON, image decode, unsupported-format, unsafe URL, 4xx other than the listed statuses, and CPU payloads that can never fit their explicit limit are terminal. Cancellation is not a failed attempt. A valid refinement source that temporarily cannot reserve GPU bytes is not a source failure: decoded/encoded CPU reservations are released, its demand becomes `budget-limited`, and the displayed fallback remains active. A blocked request records its required bytes and retries only when bytes were released, source-protection eligibility changed enough to reclaim the shortfall, or demand leaves and re-enters; allocation growth alone never triggers a retry, and unchanged frames never fetch/decode again. The reservation callback and its matching ledger are one dependency contract so every successful reservation has a valid cleanup path. Terminal refinement failure records the error and keeps fallback display. Terminal bootstrap failure enters `error` and rejects `firstFrameReady`.

## Source Cache and GPU Memory

Each resident source owns:

- five `rgba8unorm` textures;
- a 2,048-byte metadata/codebook storage buffer: 256 scale `f32` plus 256 SH0 `f32`;
- dimensions, count, validated intervals, generation, pin/ref counts, and last-used frame.

Source texture bytes are `5 * width * height * 4`. GPU accounting uses one stream-wide ledger and includes active canonical atlas, projected records, two key/index arrays, both indirect buffers, radix histograms/scans, uniforms, source metadata, pending replacement generation, and resources queued for retirement. `residentGpuBytes` is the exact byte total of currently useful allocated buffers/textures; `allocatedGpuBytes` additionally retains retirement-pending bytes until their fence disposer runs. Admission holds (which own budget but are not yet allocations) are not reported as allocated bytes. Before source textures are created, global-ledger admission computes the byte shortfall after crediting source bytes already queued for retirement, selects only enough additional unprotected farthest-first source victims to make that reservation possible after retirement, and retires them. Their allocated bytes remain charged until the submission fence disposer runs, so an attempt waits rather than evicting extra sources while prior victims are still retiring. Source upload reserves once and transfers that reservation to the cache; cache admission never grants it again.

Canonical capacity is bounded by device limits and by at most 75% of `maxGpuBytes` for one canonical plus one pass-local working generation, leaving source headroom. `maxCapacitySplats` separates this immutable allocation ceiling from the mutable `maxSplats` selection target. Environment residency subtracts from the current foreground planning allowance but does not make an unchanged legal `maxSplats` value invalid; only mutating `maxSplats` above the immutable capacity is an error. If device limits or the working budget cannot admit the requested capacity exactly, load fails with the requested and admitted capacities instead of silently clamping and failing later during display. The exact first pass-local allocation is held before source requests can consume its budget, then converted to allocated bytes when the binding is built. Additional target bindings require independent admission. One 256-byte gather descriptor per manifest leaf plus an optional environment descriptor is protected before any source request. Failure to reserve that initial hold retires the just-created canonical state and releases every ledger charge before load rejects. Recording converts only the needed protected hold into an allocated, stats-visible submission-local buffer; retirement atomically restores the hold, so source admission cannot steal the headroom between generations. A changed generation waits with the prior display intact while an earlier gather descriptor submission remains in flight. Replacement is make-before-break, and old generations remain charged until `retireGpuResources` runs.

Eviction considers only resident sources with zero displayed refs, zero pending refs, zero active-interval refs, and no bootstrap pin. Under memory pressure, eligible sources are ordered by descending distance to the nearest active camera, then oldest use, largest GPU allocation, and URL. Source distance is the minimum camera-to-world-AABB distance over every leaf using that file, including off-screen leaves and shared files. Each binding retains its latest camera-position snapshot; bindings older than the existing one-frame grace period do not influence eviction. Distances are evaluated once per candidate when admission needs victims, using the current stream world transform, rather than rescanning bounds on unchanged frames. With no active camera or leaf bounds, infinite distances fall back to recency ordering. Active descriptors, including the environment interval, pending replacements, and submitted generations protect resources. The stream maintains per-source displayed, pending, and active counts incrementally when leaf visibility/references or the published interval generation changes. A dirty generation applies those counts to resident cache entries in one source pass; unchanged frames do not rescan the leaf hierarchy or resident interval list. Active sources alone receive a cheap per-frame recency touch. `lastUsedFrame` therefore advances only when a source participates in the active interval generation; merely remaining warm does not refresh it.

Eviction removes the cache entry and synchronously clears its source runtime plus every matching displayed and pending leaf reference before retirement, so no stale descriptor can falsely satisfy target equality or coverage. If that leaf becomes visible again, the best already-resident alternative at or below its target is displayed immediately while the unchanged target source is requested again. The main bootstrap fallback remains pinned. Sparse-leaf fallback intervals may be copied into canonical active storage without pinning their entire otherwise-unused large source after a later replacement is displayed.

The optional environment stores an explicit source-state identity. When its resolved URL aliases a leaf source, it reuses that exact runtime, request, decoded textures, cache entry, and GPU allocation; it never creates a duplicate source. Environment demand adds one persistent owner after the coarse barrier, foreground allowance subtracts the shared source count once, and publication appends the environment interval from that same source identity. Leaf display and environment use may coexist against one cache entry, and eviction/reload/disposal observe their combined protections. A nonaliased environment receives one dedicated source state with identical lifecycle rules.

Admission fails or defers instead of evicting the only displayed representation. Temporary refinement pressure preserves coverage and reports `budget-limited` with `stats.error === null`; moving demand can make older sources eligible, and completion of their retirement fence resumes blocked demand. Explicit user limits that cannot fit the bootstrap source plus minimum working buffers reject the load with a budget error.

## GPU Buffer Layouts

All fields use WebGPU storage-buffer alignment.

### Canonical splat, 64 bytes

```wgsl
struct CanonicalSplat {
    centerOpacity: vec4<f32>, // 0: Lite center xyz, opacity
    covarianceA: vec4<f32>,  // 16: c00, c01, c02, c11
    covarianceB: vec4<f32>,  // 32: c12, c22, 0, 0
    color: vec4<f32>,        // 48: linear DC rgb, reserved
}
```

### Active range descriptor, 32 bytes

```wgsl
struct ActiveRange {
    sourceOffset: u32,
    count: u32,
    destinationOffset: u32,
    leafId: u32,
    fileGeneration: u32,
    lod: u32,
    _pad0: u32,
    _pad1: u32,
}
```

Descriptors are sorted by stable leaf ID. Environment, when resident, is appended once with leaf ID `0xffffffff`.

### Projected splat, 64 bytes

```wgsl
struct ProjectedSplat {
    clipCenter: vec4<f32>, // clip xyzw
    axis0: vec4<f32>,      // clip-space xy offset at unit corner; zw reserved
    axis1: vec4<f32>,
    color: vec4<f32>,      // rgb and opacity
}
```

Projection writes each surviving record at its deterministic active input index. Culled records and their sparse key slots remain unspecified and receive validity zero.

### Sort and indirect records

```wgsl
struct KeyIndex { key: u32, index: u32 } // 8 bytes
struct DrawIndirectArgs {
    vertexCount: u32,   // always 6
    instanceCount: u32, // GPU survivor count
    firstVertex: u32,   // 0
    firstInstance: u32, // 0
}
```

Projection writes one validity flag and one sparse `(key, canonicalIndex)` pair at each active canonical index. Valid positive view depths use `~bitcast<u32>(depth)` so ascending unsigned order is far-to-near. Invalid projections write flag zero and need not initialize their sparse pair. The 64-byte projected cache remains indexed by canonical ID; it is never physically compacted and therefore needs no second 256 MiB cache at four-million capacity.

After projection, a stable GPU compaction scans the validity flags in original canonical order and scatters surviving key/index pairs into a dense prefix. The scan is a hierarchical 256-lane exclusive Blelloch scan: level zero scans flags, each higher level scans the previous level's block sums, and reverse add passes propagate parent offsets. A survivor at canonical index `i` writes to `exclusivePrefix[i]`, so pre-sort order is strictly ascending canonical index across workgroups. Equal depth keys therefore retain the same deterministic original-ID tie order as the previous full-pool stable radix sort. Compaction never rewrites projected records; dense pairs continue to reference their original projected/canonical IDs.

A fixed one-invocation setup reads the compact scan's root total and writes:

```text
runtime[0] = survivorCount
drawIndirect = { vertexCount: 6, instanceCount: survivorCount, firstVertex: 0, firstInstance: 0 }
dispatch[0] = { x: ceil(survivorCount / 256), y: 1, z: 1 } // histogram and scatter
dispatch[1 + level] = { x: max(1, ceil(levelItemCount / 256)), y: 16, z: 1 } // radix scans
dispatch[1 + levelCount + childLevel] = { x: ceil(childCount / 256), y: 16, z: 1 } // radix adds
```

`levelCount` starts at `ceil(survivorCount / 256)` and recursively applies `ceil(n / 256)`. Scan dispatches use at least one workgroup so zero survivors overwrite every root total with zero; histogram, add, and scatter dispatch zero work when their GPU-derived count is zero. The runtime/dispatch buffer has `STORAGE | INDIRECT | COPY_SRC | COPY_DST` usage and is pass-local; `COPY_DST` permits an explicit pre-projection reset so an empty active pool cannot reuse prior-frame counts. Production never maps or reads survivor counts.

Compaction adds exactly two `u32` arrays per admitted pass capacity: one validity flag and one exclusive prefix, or 8 bytes per capacity entry (32,080,000 bytes at the demo's 4,010,000-splat capacity). A 128-byte survivor/dispatch buffer and one 64-byte nonaliasing binding placeholder complete the added fixed allocation. The hierarchical compaction scan reuses radix scratch before histogram overwrites it. All 32,080,192 added bytes participate in initial pass hold, allocation admission, partial-failure unwind, and fenced retirement. The separate mandatory 16-byte bootstrap readback hold is also admitted before source residency; the existing 1 GiB demo ledger still admits the unchanged 4,010,000 capacity with a mutable startup target of 4,000,000.

## Compute Pipelines

### Gather

One dispatch per active source/range group reads the five source textures and codebooks and writes canonical records. A 256-thread workgroup handles one splat per invocation. Dispatch count is bounded and split when device limits require it. Gather runs only when displayed selection/residency generation changes.

Gather parameters use a distinct 256-byte dynamic-uniform slot per recorded dispatch. Rewriting one uniform location between encoded dispatches is forbidden.

The shader applies the exact SOG decode, covariance, and handedness math above. Invalid quaternion selectors or nonfinite results write opacity zero; projection later emits validity zero.

### Projection, ellipse, culling, and keys

Projection runs when any of these generations changes: canonical content, camera view, projection, stream world matrix, target width, or target height.

For each canonical splat:

1. transform center and covariance by stream world and active view;
2. reject nonfinite values, opacity `<= 0`, view depth `<= near`, or zero clip `w`; in Lite's left-handed view space, splats behind the eye have nonpositive depth and cannot increment the indirect count regardless of ellipse size;
3. before evaluating the perspective Jacobian, apply the existing Lite Gaussian projection-domain guard: with `bounds = 1.2 * clip.w`, reject centers whose clip X or Y lies outside `[-bounds, bounds]`. This rejects far-off-axis, near-eye centers before their first-order covariance approximation can create a screen-covering ellipse;
4. derive the perspective Jacobian from the actual projection and viewport;
5. compute 2D covariance and add `0.3` to both diagonal terms;
6. solve the symmetric 2x2 eigenproblem robustly:

```text
trace = a + c
disc = sqrt(max(0, (a-c)^2 + 4*b^2))
lambda0 = max(0.1, (trace + disc) / 2)
lambda1 = max(0.1, (trace - disc) / 2)
```

For `abs(b) + abs(lambda0-a) > epsilon`, normalize `(b, lambda0-a)`; otherwise choose `(1,0)` when `a >= c`, `(0,1)` otherwise. The perpendicular is `(-y,x)`.

Ellipse axes use `min(sqrt(2 * lambda), 1024)` pixels independently for the major and minor lengths, matching Lite's existing saturation convention. They are converted to clip offsets as `pixelAxis * clip.w / viewport`; the viewport normalization has no additional factor of two. Both clip axes must remain finite before conservative offscreen culling includes their combined extents. The center-domain guard and axis saturation are reference-equivalence limits of the established Lite Gaussian projection, not dataset-specific decoder or covariance changes.

7. write the projected record at the active index;
8. write `(depthKey, activeIndex)` and validity one at that same sparse index.

The post-projection compaction then produces the dense live key prefix and the GPU survivor count. Projection still evaluates every active canonical record and does not change visibility, opacity, clipping, covariance, or depth-key math.

The raster kernel remains Lite-compatible: generated billboard corners span `[-2,2]`; fragment alpha is `exp(-dot(corner,corner)) * opacity`; fragments outside radius 2 are discarded. The covariance factor, 0.3 kernel, `sqrt(2*lambda)` axes, corner range, and exponent are a single convention and must not be mixed with another engine's focal/kernel normalization.

### Portable stable 32-bit radix sort

Sort consumes only the compacted survivor prefix. No invalid sentinel enters radix input, and no stale suffix from an earlier larger frame can affect histogram totals, scatter destinations, or draw order.

Use 4 bits per pass, 16 digits, eight least-significant-digit passes, 256 items per workgroup:

1. **Histogram:** each indirectly dispatched live group writes 16 digit counts. Workgroup atomics are permitted only for counts.
2. **Hierarchical scan:** exclusive-scan each digit's group counts in 256-element blocks using Blelloch upsweep/downsweep in workgroup memory. Recursively scan block sums until one block remains, then add scanned block bases on the way down. Non-power-of-two tails load zero. A 16-element scan of digit totals supplies global digit bases.
   At every hierarchy level, digit rows use the allocation-capacity stride, not the active-count stride. Runtime-sized block sums are copied digit-by-digit into the next level's capacity-strided rows. The digit-base pass reads each root total at `digit * root.blocks`, where `root.blocks` is the selected level's allocation-capacity sum-row stride even when the active hierarchy collapses to level zero. This is required when capacity greatly exceeds the current active count, whether the active scan uses one hierarchy level or several.

3. **Stable scatter:** workgroup memory contains 16 digit rows of eight `atomic<u32>` words (512 bytes). All 256 lanes uniformly clear the words, synchronize, and each valid lane atomically ORs its unique lane bit into its digit row. After a second barrier, a valid lane computes its stable rank from `countOneBits` over at most seven preceding words plus the current word masked below its lane bit. Invalid tail lanes participate in both barriers and only then return. It writes to:

```text
digitBase[digit] + scannedGroupCount[group,digit] + localStableRank
```

This bounded eight-popcount local operation replaces the quadratic 32,640 predecessor comparisons of a full group while avoiding nondeterministic atomic scatter, subgroup assumptions, inter-workgroup spin waiting, and a single-thread global scan. Bit 31 masks use unsigned shifts without overflowing the lane mask. Ping-pong buffers alternate every pass. All eight 4-bit passes remain intact, so arbitrary 32-bit keys retain stable compacted canonical-ID tie order and unchanged sort semantics.

Every pass has an immutable parameter record at a distinct 256-byte uniform offset. Histogram, every hierarchy scan, every reverse add, and scatter use `dispatchWorkgroupsIndirect` with the GPU-produced survivor count; only compaction over the known active projection pool, the one-invocation runtime setup, and the 16-lane digit-base pass use direct dispatch. Histogram and scan buffer sizes derive from admitted capacity and are checked against device dispatch and storage limits. Zero, singleton, partial, non-multiple-of-256, and all-survivor counts use the same path. Zero survivors reset draw args and scan roots, while visible-to-zero-to-visible transitions cannot reuse stale rows or stale indirect dimensions.

## Render Pipeline Configuration

The streaming feature owns its WGSL, layouts, pipeline cache, bind groups, and update batch. Generic engine/render/scene code receives no streaming-specific branch.

- scene bind group: group 0;
- stream projected/sorted/indirect resources: group 1;
- topology: `triangle-list`;
- generated nonindexed vertices: six per instance, no quad buffer;
- `drawIndirect(indirectBuffer, 0)` once for all foreground leaves and environment;
- color blending: ordinary ordered alpha combine matching existing Gaussian rendering;
- depth compare: target's existing reversed-Z convention;
- depth write: disabled;
- cull mode: none;
- multisample count and target formats: target signature;
- render order: existing transparent Gaussian order.

Vertex index maps to corners:

```text
0=(-2,-2), 1=(2,-2), 2=(2,2), 3=(-2,-2), 4=(2,2), 5=(-2,2)
```

Instance index reads sorted index, then projected record, and adds `axis0 * corner.x + axis1 * corner.y` to clip center.

## Draw-Batch Integration

Each target-specific `DrawBinding.update(context)` consumes `context._camera`, `context.targetWidth`, and `context.targetHeight`. It hashes the actual view, projection, world matrix, viewport, and content generation. It never closes over `scene.camera` or the engine primary target.

Bindings expose one feature-owned `DrawUpdateBatch` through `_updateBatches`. Target build calls `enableDrawBatchCollection(signature)`. A lazy weak cache reuses the non-retired streaming batch only for the same stream GPU state and the same `RenderTargetSignature` object. Rebuilding one render task after resize therefore shares its pass-local projection/radix generation across the old and candidate binding generations, while distinct task/signature objects remain isolated even when their formats match. Candidate rollback and committed retirement continue through the existing retained batch-state protocol. The renderer's existing ordering is used unchanged:

```text
batch.reset()
binding.update(actual pass context) queues requested work
batch.flush(engine) encodes upload/gather/project/radix work on engine._currentEncoder
render pass begins
one indirect draw
```

The batch never retains, finishes, or separately submits the active encoder. Distinct camera/target bindings own distinct projected caches, validity/prefix buffers, compaction/radix scratch, survivor/runtime dispatch arguments, and draw arguments so one pass cannot overwrite another pass's pending records. Gather parameters are immutable submission-local mapped buffers, chunked in at most 4,096 dynamic-offset records and retired after the referencing submission; recording another pass or encoder cannot rewrite an earlier dispatch's snapshot, and valid active interval counts above 4,096 remain supported. Shared source textures and canonical content remain stream-owned. Every added pass-local buffer is included in admission accounting, destroyed on partial allocation failure, and retired exactly once with its owning pass.

Publication is one transaction over the aggregate display. Every GPU-ready reduction is staged without an intermediate per-leaf fit gate and applied to a scratch count before capacity is checked, even when no single reduction gets an already-over-capacity intermediate below the limit. Only after the complete reduced generation fits are affordable upgrades admitted. Logical displayed descriptors change only for the admitted set. A capacity-rejected resident fine target is removed from pending cache protection even when a coarse representation is already displayed. For an uncovered leaf, fallback search walks every successively cheaper resident alternative and publishes the first one that fits the actual aggregate after committed reductions; a resident but still-unaffordable intermediate fallback cannot hide a cheaper admissible representation. After the final admission pass, every unpublished capacity-rejected upgrade loses pending protection. Active canonical sources stay protected while missing downgrade prerequisites load. Unmet resident aggregate targets set persistent generation pressure independently of pending cache protection, reported as `budget-limited` until the target publishes or camera demand withdraws it, including when the current display itself is below capacity.

Resource generations are make-before-break. Once no retained binding/batch references an old generation, destruction is scheduled with `retireGpuResources(engine, disposer)`. Disposal is idempotent and each GPU handle is destroyed exactly once.

## Lifecycle and Error Policy

Attachment registers deferred scene renderables and scene-disposal cleanup without teaching `addToScene`, scene core, render task, or engine about streaming. The stream node's ordinary TRS/parent state participates in world transforms. Explicit stream disposal unregisters its scene callback; scene-driven disposal marks the attachment disposed without splicing the live `_disposables` iteration, so adjacent stream and application callbacks each run exactly once.

Disposal:

1. registers scene-lifetime cleanup immediately at attachment, then on disposal marks phase `disposed` and increments stream/file generations;
2. aborts queued/fetching work and clears retry timers;
3. closes retained bitmaps and releases CPU reservations;
4. detaches/deactivates renderables and batches;
5. rejects unresolved `firstFrameReady`;
6. retires submitted GPU resources and directly destroys never-submitted resources;
7. removes scene disposal registration;
8. is safe to call repeatedly.

Errors are `Error` objects with a stable subsystem prefix and URL/context. No malformed input resolves as an empty stream. Refinement errors preserve the displayed generation. A selection validation failure caused by mutable public inputs (`maxSplats`, `screenError`) is stream-owned and recoverable: the display remains intact, later valid input clears only that exact transient error even when the exact-input planner cache is reused, and phase is recomputed. Genuine source/bootstrap failures are never masked by successful selection.

Before `firstFrameReady` settles, unsupported projection mode or an internal selection/update failure is terminal: phase becomes `error`, readiness rejects exactly once with the actionable reason, queued/requested source work is cancelled through normal disposal ownership, and late source/GPU callbacks cannot re-enable bootstrap. Every asynchronous coarse-signal continuation, including synchronous publication or queue-fence setup performed inside it, routes failures through that same terminal path. After readiness, the same unsupported mutable camera input remains a recoverable visible selection error that preserves the current display. Bootstrap source/decode failure and a GPU-empty coarse projection remain terminal.

Selection errors own only the error object they publish. They do not replace an existing source/bootstrap error, and valid mutable input clears a selection error only while that same object is still current. A source error arriving while a transient selection error is visible replaces it and remains current after later valid selection. Mutable `maxSplats` failures—including a budget below the currently visible coarse baseline—are range errors and remain recoverable before first-frame readiness; correcting the budget allows the coarse draw and readiness fence to proceed. Unsupported projection mode and internal planner failures remain terminal before readiness. Runtime errors update `stats.phase` and `stats.error` and use repository-standard warning/error diagnostics.

## Trogir Demo

### Collision navigation

`packages/babylon-lite/src/collision/splat-voxel-collision.ts` provides optional collision queries through the package root:

```typescript
interface SplatVoxelCollision {
    readonly min: [number, number, number];
    readonly max: [number, number, number];
    readonly resolution: number;
    readonly depth: number;
    readonly nodes: Uint32Array;
    readonly masks: Uint32Array;
}
function parseSplatVoxelCollision(metadata: unknown, buffer: ArrayBuffer): SplatVoxelCollision;
function loadSplatVoxelCollision(metadataUrl: string, signal?: AbortSignal): Promise<SplatVoxelCollision>;
function moveSplatVoxelCamera(collision: SplatVoxelCollision, from: [number, number, number], to: [number, number, number], radius?: number): [number, number, number];
```

The loader accepts an HTTP(S) `.voxel.json` URL and derives its sibling `.voxel.bin` by replacing the pathname suffix, preserving the query. Metadata is bounded to 64 KiB and the decoded binary to 128 MiB. Parsing accepts voxel format 1.1 only: finite increasing grid bounds, positive resolution, four-voxel leaves, depth 1..20, and exact little-endian node/mask counts. Every child range, mixed-leaf index, depth and unique parent is checked before navigation. A word `0xff000000` is solid; a zero high byte indexes a pair of 32-bit occupancy masks; other words encode an eight-bit child mask and a 24-bit first-child index. Child order is X/Y/Z Morton order; mixed mask bits use `x + 4*y + 16*z`. Queries use the dataset's coordinate frame, require a clear starting position, block the grid boundary, and provide wall sliding without gravity. The module has no renderer or GPU dependency and is removed when its exports are unused.

The voxel grid is already in the original viewer's world frame. Trogir collision queries convert Lite world positions with `(x,y,-z)` only. Camera motion sweeps a 0.15-unit half-extent box through occupied octree volumes using segment/slab intersections, then removes the blocked normal component and repeats for up to three sliding contacts. A small contact offset prevents repeated boundary intersections. Outside-grid motion is blocked. Continuous sweeps prevent tunnelling even on long frames; no geometry is inferred from partially loaded splats.

Collision fetching starts alongside scene initialization. Controls stay unattached until collision data is ready; the coarse scene can appear while navigation is loading. Failures leave navigation disabled with an explicit HUD error. Page disposal aborts the collision request and prevents late control attachment. The default manifest and voxel pair are hosted under `https://assets.babylonjs.com/splats/Trogir/`. All asset roots use sibling voxel files and preserve their query parameters for both voxel requests. A nonempty `?collisionUrl=` selects a separate HTTP(S) voxel metadata URL with its own query parameters; an empty override uses the asset-root default. Dataset URLs and the Trogir coordinate adapter remain in the demo. The collision correction runs after free-camera input and before rendering, translating position and target together and removing its callback on detach.

Files:

- `lab/lite/demo-trogir-streaming.html`;
- `lab/lite/src/demos/trogir-streaming.ts`;
- `demos-config.json`;
- `lab/vite.config.ts`.

The Vite plugin mounts only the configured dataset root at `/local-gs/trogir/` when `GS_STREAM_ASSET_ROOT` is set. It:

- accepts only GET/HEAD;
- decodes the relative URL safely;
- rejects NUL, backslash, absolute, and `..` segments;
- canonicalizes configured root and requested file with `realpath`;
- verifies `relative(realRoot, realFile)` does not escape;
- requires a regular file;
- streams rather than buffers the response;
- serves `.json` as `application/json`, `.webp` as `image/webp`, and other supported binary files as `application/octet-stream`;
- returns useful 404/405 errors and `Cache-Control: no-cache`;
- never exposes the host path to client code.

Client metadata URL precedence:

1. `?assetRoot=<dataset-root-or-full-lod-meta.json-url>` resolved against `location.href`;
2. the Babylon-hosted public source manifest `https://assets.babylonjs.com/splats/Trogir/lod-meta.json`.

The public source requires no local setup. To select the optional local mount explicitly:

```text
GS_STREAM_ASSET_ROOT="<dataset-directory>" pnpm --dir lab dev
http://localhost:5174/demo-trogir-streaming.html?assetRoot=/local-gs/trogir/
```

An `assetRoot` ending in `/lod-meta.json` is used as the manifest URL directly; other values retain directory-root behavior and have `lod-meta.json` appended. If the selected source cannot be loaded, the page reports the error and shows both the local setup and hosted override forms instead of hanging.

Root query preservation covers the manifest and the demo's sibling voxel pair only. Stream chunk metadata and WebP references use normal relative-URL resolution: they retain their own query strings and do not inherit the declaring document's query. Private datasets must authorize every relative resource reference independently (or use suitable host authentication); a signed `assetRoot` alone does not authorize the entire dataset. Voxel hosts must accept the same query on both members of the pair.

The demo provides quality, detail error and splat-budget controls, first-person mouse/keyboard controls, and a nonblocking HUD for phase, first-frame time, selected splats, visible/covered leaves, resident/allocated GPU bytes, resident files, and pending requests. Its viewport permits browser zoom, and reduced-motion preference disables the loading-spinner animation. Quality is selected before device creation by `?quality=low|high`; absent or unknown values select lower memory. Changing the quality selector reloads the page, retaining asset overrides, so immutable allocations are recreated. The splat-budget slider is initialized and capped at that tier's foreground target; moving it alone does not shrink fixed buffers.

| Tier                   | Foreground splats | Immutable capacity | GPU ledger | CPU admission | Required buffer size |
| ---------------------- | ----------------: | -----------------: | ---------: | ------------: | -------------------: |
| Lower memory (default) |         1,000,000 |          1,010,000 |    256 MiB |        64 MiB |     64,640,000 bytes |
| High detail            |         4,000,000 |          4,010,000 |      1 GiB |       192 MiB |    256,640,000 bytes |

Each tier reserves 10,000 slots for the 9,237-splat environment and requests its buffer size for both `maxBufferSize` and `maxStorageBufferBindingSize`. Fixed stream/pass storage is approximately 147 MiB in lower memory and 583 MiB in high detail; source residency is additional and bounded by the GPU ledger. Collision data sits outside the CPU admission budget: the Trogir pair retains 18,275,664 bytes (17.4 MiB), with approximately 37.2 MiB needed during parsing. Engine targets, browser decoding and driver allocations are also outside those ledgers. An adapter that cannot expose a selected tier's limits fails explicitly during startup.

The camera starts at world eye `(-33.03, 0.24, -65.76)` with HUD yaw `27.70°`, up-positive pitch `6.62°`, roll `0.00°`, near `0.1`, and far `1500`. Camera speed is `0.8` with inertia `0.6`. Startup creates that `FreeCamera` pose directly and attaches first-person controls exactly once after collision data loads; there is no orbit camera, camera-mode state, or camera-mode UI.

The page owns engine, scene, stream, controls, HUD callbacks, and asynchronous startup as one idempotent lifecycle. `pagehide` or any failure during engine creation, stream load, scene registration, engine start, or first-frame readiness disposes every resource already acquired before showing an error. As soon as a stream result becomes owned, the page installs a rejection observer on its original readiness promise; later awaiting that original promise still reports a genuine readiness failure, while registration/start failure or pagehide can dispose the stream without producing a second unhandled readiness rejection. Each awaited completion checks whether disposal already fired; a late engine or stream result is observed and immediately disposed instead of escaping ownership. Success-only readiness flags and overlay removal cannot run after disposal.

An initially collapsed native `details` section in the same panel reports the camera's world position and yaw/pitch/roll in degrees. It derives from `scene.camera.worldMatrix`: translation is matrix elements 12–14, forward is the normalized third basis column, yaw is rotation about world +Y, pitch is positive when looking up, and roll is the signed rotation of the first basis column from the zero-roll right vector about forward. Near a vertical forward direction, yaw falls back to the projected right/up basis so every valid displayed value remains finite; exact and rounded negative zero format as zero. Nonfinite, zero-length, or singular camera bases are rejected by the pure pose reader with a `RangeError`; the HUD catches only that expected validation type, displays its specific message plus unavailable fields instead of substituting plausible zero values, and rethrows unrelated failures. Opening the details element refreshes the values immediately, while the render callback skips all pose derivation and formatting while collapsed. The HUD keeps its existing content width but bounds its total box to the viewport margins and scrolls vertically when expanded content exceeds a short viewport. The blocking overlay disappears on `firstFrameReady`, not convergence.

Attribution is always visible: “Get lost in the alleys of historical Trogir, Croatia” by Paolo Tosolini, source `https://superspl.at/scene/14bac5b2`, licensed CC BY 4.0.

Core stream correction invariants are stricter than diagnostic policy. CPU admission retains encoded bytes through decode and reserves the simultaneous encoded-plus-decoded peak; a source preparation that cannot progress without waiting on its own retained resources rejects cleanly and releases all reservations. Environment residency reduces the planner allowance but never invalidates an unchanged legal public `maxSplats`; only raising the mutable target above immutable foreground capacity is an error. Submission-local gather descriptors have protected ledger headroom before source admission and remain charged through overlapping retirement fences. Selection snapshots and demand are per draw binding and aggregated before source cancellation, so disjoint cameras cannot erase each other's requests. Scene disposers never mutate the live disposal array during `disposeScene`.

Pending publication is transactional. All reductions are staged against a scratch aggregate even while intermediate totals remain above capacity, the complete reduced generation is validated, and only then are affordable upgrades admitted. A fine candidate rejected by aggregate capacity cannot suppress an available coarse representation; unpublished fine sources lose pending protection when that protection blocks required coverage or downgrade prerequisites, while canonical sources remain active-protected. Generation-admission pressure is explicit persistent state consumed by `updateStats` and clears only after successful publication.

No dataset bytes, personal path, fabricated thumbnail, or golden reference are committed.

## Babylon.js Equivalence Map

This is a new Lite-only streaming transport/ownership path. It reuses Lite's existing Gaussian mathematical kernel, transparent blend/depth convention, scene-node transforms, render-target signatures, draw-update batching, active frame encoder, and GPU retirement. It does not claim Babylon.js has an equivalent streaming API. Existing static Gaussian scenes remain the compatibility oracle for shared math only.

## Dependencies

- existing `EngineContext`, `SceneContext`, `SceneNode`, deferred renderables, and render target signatures;
- existing `DrawBinding`, `DrawUpdateContext`, `DrawUpdateBatch`, and `enableDrawBatchCollection`;
- existing `retireGpuResources`;
- browser Fetch, AbortController, `createImageBitmap`, and WebGPU;
- no worker, WebGL, canvas readback, external runtime package, or module-level mutable collection.

Every cache is lazy and device-keyed. Importing the root exports performs no work.

## Validation Requirements

### Unit tests

- manifest v1 parsing, unknown versions, malformed bounds/tree, cycle/depth/node limits;
- shared file intervals, arbitrary filename order, invalid indices/ranges, missing/sparse LODs;
- zero errors for missing LODs ignored; derived errors; nonmonotonic/equal/dominated alternatives;
- frustum planes using Lite's real reverse-Z perspective, fully behind and conservatively straddling bounds, inside-bound camera, transformed bounds, FOV/resize, hysteresis and budget failure;
- Trogir's actual demo placement helper, asymmetric public bounds, and a non-diagonal covariance transformed by the same scene-node rotation;
- the exact Trogir first-person startup formats as the specified six-field HUD pose, retains its FOV/near/far settings, attaches first-person controls exactly once, and detaches them idempotently;
- bootstrap file chosen by broad coverage before fine requests;
- request deduplication, concurrent HTTP/decode limits, memory allowances and exclusive large-source fallback, nearby-file queue ordering, cancellation, bounded retry, out-of-order stale generations, and disposal;
- strict-priority preparation preemption proves stalled fine work fully unwinds, newly visible coarse coverage completes, then the original job resumes without exceeding HTTP/decode/CPU caps;
- aliased and nonaliased environment sources share or own exactly one runtime/cache allocation respectively, preserve combined leaf/environment demand, foreground allowance, publication, eviction/reload, and disposal;
- pre-bootstrap orthographic selection rejects readiness and prevents late callbacks; mutable selection errors recover on valid cached and recomputed inputs without masking source failures;
- protection counters update deterministically on visibility, pending, publication, environment, and eviction changes; unchanged frames perform no leaf/interval protection rescan while active recency still advances;
- displayed fallback retained across delayed/failed/cancelled replacements, progressively cheaper resident admission, and below-capacity resident-target pressure;
- fake-clock per-leaf cooldown covering immediate initial coverage/refinement, below/exact deadline transitions, oscillation, async arrival, shared views, pressure/budget bypass, missing coverage, disposal, zero compatibility, and option validation;
- exact-input cache reuse and planner counters covering mutable matrix/camera/viewport/world changes plus every source, admission, binding, pressure, publication, environment, and cooldown-expiry invalidation while lifecycle scheduling continues;
- cache accounting, pin/ref protections, farthest-first admission with deterministic recency ties, moving/multiple cameras, transformed and shared-source bounds, partial upload cleanup, and retirement.

### Numerical/GPU behavior

- exact mean endpoints/sign crossing and last/padding texel behavior;
- all four quaternion selectors and covariance `S*C*S`;
- scale exponentiation once, direct alpha, negative/HDR SH0 color;
- byte-preserving RGBA8 upload including low alpha/high RGB and first/last rows;
- gather interval offset mapping and same-file multiple leaves;
- projection using Lite's real reverse-Z perspective: negative/eye/near-boundary/positive depths, large behind-eye ellipses, camera/world translation and rotation, sentinel ordering, and indirect reset after an all-culled frame;
- radix counts 0, 1, equal keys, sentinels, near-identical depths, non-power-of-two tails, all 16 digits, lane/word boundaries 0/31/32/63/255, arbitrary random 32-bit keys, 255/256/257 items, 65,536 hierarchy boundary, active-count collapse at capacity 500,000, stale-row recovery, and all eight passes;
- survivor compaction verifies dense prefixes without invalid sentinels, GPU count-driven dispatch dimensions, strict equal-depth canonical-ID ties across workgroups, and zero-to-many-to-one-to-zero transitions;
- actual material `bind` calls preserve distinct stable selection identities for separate views;
- WGSL pipelines must compile on WebGPU implementations, and diagnostic readback must never enter the production render path.

## File Manifest

```text
packages/babylon-lite/src/loader-splat-stream/
  splat-stream-types.ts
  splat-stream-meta.ts
  splat-stream-selection.ts
  splat-stream-requests.ts
  splat-stream-cache.ts
  splat-stream-gather.wgsl
  splat-stream-project.wgsl
  splat-stream-radix.wgsl
  splat-stream-render.wgsl
  splat-stream-gpu.ts
  splat-stream-material.ts
  load-gaussian-splat-stream.ts

packages/babylon-lite/src/index.ts
docs/lite/architecture/55-gaussian-splat-streaming.md
lab/lite/demo-trogir-streaming.html
lab/lite/src/demos/trogir-camera.ts
lab/lite/src/demos/trogir-assets.ts
lab/lite/src/demos/trogir-collision.ts
packages/babylon-lite/src/collision/splat-voxel-collision.ts
lab/lite/src/demos/trogir-quality.ts
lab/lite/src/demos/trogir-camera-pose.ts
lab/lite/src/demos/trogir-streaming-placement.ts
lab/lite/src/demos/trogir-streaming.ts
lab/vite.config.ts
demos-config.json
tests/lite/unit/splat-stream-meta.test.ts
tests/lite/unit/splat-stream-selection.test.ts
tests/lite/unit/splat-stream-requests.test.ts
tests/lite/unit/splat-stream-cache.test.ts
tests/lite/unit/splat-stream-orchestration.test.ts
tests/lite/unit/trogir-camera.test.ts
tests/lite/unit/trogir-quality.test.ts
tests/lite/unit/splat-voxel-collision.test.ts
tests/lite/unit/trogir-streaming-placement.test.ts
tests/lite/build/public-api-types.test.ts
tests/lite/build/splat-voxel-treeshake.test.ts
```
