# Demo: The Playroom

> Entry: `lab/lite/src/demos/playroom.ts`
>
> Asset root: `lab/public/playroom/`
>
> Source: private `BabylonJS/ThePlayroom` revision
> `d22ce23ef308e28d1f8b6598b4c72ea944205925`

## Purpose

The Playroom is a standalone WebGPU/Havok gallery demo port of the complete
Babylon.js 6.0 physics application. It preserves the authored child-room
environment, 103 puzzle placements, three-throw bunny game, free camera pushes,
popper chains, score effects, and active sound palette. It is a demo rather than
a numbered parity scene, so it has no golden or MAD entry.

## Public API surface

The demo exports no package API. Its browser entry creates the scene and passes
plain state to standalone subsystem functions.

The engine adds two root-exported, standalone operations:

```ts
function applyPhysicsBodyInstanceImpulse(world: PhysicsWorld, body: PhysicsBody, instanceIndex: number, impulse: Vec3, location: Vec3): void;

function getPhysicsBodyInstanceLinearVelocityToRef(world: PhysicsWorld, body: PhysicsBody, instanceIndex: number, result: Vec3): void;
```

They validate ownership, lifetime, integer bounds, and address exactly one
native instance. Existing generic body operations keep broadcast semantics.

## Authored world

`GAME_SCALE` is `0.2`. Positions in `layout.ts` remain in source units and are
converted exactly once when expanded into matrices. `PLAYROOM_LAYOUT` contains
103 top-level placements:

| Family                     | Placements |
| -------------------------- | ---------: |
| domino                     |         12 |
| stack                      |          1 |
| tower                      |          1 |
| cup                        |          9 |
| bowling ball / pins / ramp |     1 each |
| cube stack                 |         41 |
| cubes-on-path              |          4 |
| arch                       |         15 |
| popper                     |         16 |
| chess                      |          1 |

Spline families use uniform Catmull-Rom samples followed by the source
equal-distance spreading pass. Random color/angle choices use a deterministic
generator so replay restores identical authored initial conditions.

### Source transform oracle

`tests/lite/fixtures/playroom-source-transforms.json` is the immutable numeric
oracle for correction work. It was generated manually from authenticated,
read-only access to `BabylonJS/ThePlayroom` revision
`d22ce23ef308e28d1f8b6598b4c72ea944205925`. The fixture records the Git blob
and SHA-256 identities of the source files, local asset SHA-256 values, imported
node TRS and hierarchy determinants, each source override/bake operation,
source material culling, selected transformed vertices, asymmetric triangle
winding, normals, tangent handedness, and all 1,955 authored instance matrices
in both native source and comparison space. The source lock resolves Babylon.js
Core `6.0.0` and Havok `1.0.0`; newer Babylon.js versions are not accepted as
the oracle.

The comparison convention mirrors the source right-handed world into Lite
space exactly once with `F = diag(-1, 1, 1, 1)`: instance matrices use
`F * M_source * F`, while baked vertices use `F * v_source`. Source placement
construction consumes one seeded random stream in constructor order, including
cosmetic color draws that affect later transform draws. Expected values are
never regenerated from `expandPuzzle`.

Every imported asset hierarchy has a positive signed determinant. Lite's
synthetic glTF root and reflected geometry bake each contribute a negative
determinant, while swapping the second and third triangle indices contributes
the matching winding reversal. All selected asymmetric source and comparison
triangles face their transformed vertex normals after that pair of operations.

### Asset-template equivalence

The 15 prop templates retain the existing geometry bake because the independent
oracle proves their positions, indices, normals, bounds, and winding already
match. The apparent differences between source detach/clone operations and
Lite's scale-only bake are permitted internal factorization differences: the
final baked vertices are identical. In particular, source replace-scale
operations for `arch` (`0.2`), `archTop` (`0.5,0.5,0.2`), and `chessboard`
(`0.6`) must remain replacement-equivalent rather than multiplying imported
node scale a second time.

`getMeshGeometry(mesh)` returns an authored tangent attribute when the mesh
retains it. Of the two focused bundle representatives, BoomBox in `scene1`
contains and renders authored tangents for normal mapping, while the
POSITION/NORMAL-interleaved XMP cube in `scene210` has no tangent accessor and
does not call `getMeshGeometry`. The Playroom correction must therefore not charge `scene210` for CPU tangent
retention merely because both scenes import the core glTF loader.
`enableGltfCpuTangents` installs the retention hook only for Playroom loads and
only when an asset declares a tangent accessor; the default loader path stores
no CPU tangent reference. Playroom retains the one required source tangent
payload while loading `towerGameBlock.glb`, and `createMeshFromData` retains
that array on the baked mesh. `bakeTemplate` reflects tangent X and negates
tangent W exactly once before the new template GPU buffer is created. Missing
optional source attributes stay absent; no synthetic tangent, double-sided
material, culling override, or second negative scale is introduced.

### Exact placement expansion

World creation owns one seeded random stream:

```ts
type PuzzleRandom = () => number;
function createPuzzleRandom(seed: number): PuzzleRandom;
function expandPuzzle(entry: LayoutEntry, random: PuzzleRandom, templates: Readonly<Record<string, ModelTemplate>>): PuzzleBatch[];
```

The seed is `0x504c4159`, and all 103 entries consume it in source constructor
order. Stack consumes rotation, X jitter, then Z jitter for each block.
Source-space rotation noise is `random * 0.2 - 0.2`; X/Z jitter is
`random * 0.5 - 0.5`. The source-space block translation and yaw are then
mirrored exactly once into Lite space.

Radial-tower anchors are derived from height `7.5 * GAME_SCALE`, width
`1.5 * GAME_SCALE`, relative radius `0.9`, and inner adjustment `0.8`.
Their final Y values include the common `0.05` floor offset; the seven ordered
piece roles use `0.8`, `0.8`, `1.7`, `2.9`, `2.0`, `2.9`, and `3.8` in Lite
scene units. Combined pitch/yaw uses the source Euler XYZ composition before
the RH-to-LH similarity transform, so its quaternion cross term has the
opposite sign from an unreflected yaw/pitch composition.

Cup tiers derive half-height from the baked `cup` bounds and deliberately do
not add spline-point Y: tier Y is
`halfHeight * 2.011 * (iteration + 1) + 0.05`. Cube-path instances consume
angle and color draws interleaved for each level, derive vertical spacing and
bottom offset from baked cube bounds, and update the previous spline point only
after every level at the current point. Cube-stack colors consume one draw per
instance. Arch column, arch, and top colors consume draws at their source
construction sites. These ordering rules preserve later random state as well
as the visible per-instance data.

All placement matrices are rigid carrier-local matrices with scale one.
Template scale is baked into vertices, so matrix scale differences caused only
by alternative carrier factorization are acceptable only when every sampled
world vertex is identical. The checked geometry gate requires all 31,280
matrix scalars, origins, basis vectors, determinants, and selected world points
to match the independent fixture at `1e-5 + abs(expected) * 1e-6`.

The local Babylon.js `6.0.0` capture harness includes one recorded browser
compatibility shim: removed `GPUAdapter.requestAdapterInfo()` is bridged to the
current `GPUAdapter.info` property before engine initialization. It does not
change scene, transform, shader, or draw data.

`lab/lite/playroom-placement-harness.html` is the physics-free rendering target.
It loads the real Lite asset path, installs every current thin-instance matrix,
renders without importing or creating Havok, and publishes only a copied JSON
scalar snapshot. `tests/lite/integration/playroom/placement.spec.ts` compares
that snapshot by stable placement/model/instance key, including geometry
bounds, selected local/world vertices and triangles, basis vectors,
determinants, effective pipeline state, and the full rendered inventory. A
directional shadow generator records the same inventory in a real depth-only
pass. Its initial failures are intentional regression evidence for the later
correction tasks.

The source Spector.GPU capture maps all 135 draws to independent
64-byte-stride matrix buffers. Upstream Spector.GPU does not spy
`GPURenderBundleEncoder` or serialize render-bundle contents, so the normal
Lite capture intentionally reports one opaque `executeBundles` command and
zero serialized draws while retaining its shader, pipeline, texture, UBO, and
buffer resources. A Playwright `document_start` pass-through observer supplies
the missing evidence without changing rendering: it records the actual
`createRenderBundleEncoder`, `setVertexBuffer`, `drawIndexed`, `finish`, and
`executeBundles` calls as copied scalar data. The executed main and shadow
bundles each contain 135 draws and 1,955 instances; both map all 135 matrix
buffers and 31,280 matrix scalars to the published physics-free Lite snapshot.
Their effective pipelines all use `frontFace: "ccw"`; source double-sided PBR
families use `cullMode: "none"`, while NME and default chess PBR families use
`cullMode: "back"` in both passes. The observer publishes no GPU or engine
objects.

Physics writes dynamic prop poses into the CPU thin-instance slabs before
rendering. Each material renderable then performs one version-gated per-frame
upload to the stable matrix buffer captured by its cached main and shadow
bundles. Main and shadow therefore consume the same current pose without
re-recording either bundle. This is a temporal contract, not only an initial
placement contract: runtime tests correlate intermediate native Havok poses,
CPU matrices, GPU readback from the exact bound buffer, and subsequent
executions of both unchanged bundles. PBR and Node Material families follow
the same ownership rule even though their shader construction differs.

The current Lite positions, normals, indices, and asymmetric winding samples
match all 15 source models. The `towerGameBlock` template does not retain its
source tangent attribute through the baked upload, so the required reflected
tangent handedness has a dedicated failing GPU regression rather than being
masked with double-sided rendering. Separately, 487 instances in stack, tower,
cup, and cubes retain the intentional transform regression. Lite's test-only
`?capture=1` mode remains useful for expanded Spector pipeline/resource
diagnostics, but it is not used as proof of normal scene instancing because it
bypasses opaque render bundles. This evidence covers the physics-free main
color and shadow passes, not physics-body instancing.

`tests/lite/fixtures/playroom-cube-stage-markers.json` fixes stable first,
middle, and last identities for source-matching `cubeStack/000/cube` and the
known pre-physics `cubes/003/cube` regression. Geometry output and GPU-consumed
matrices agree for both cohorts. Later physics work must preserve those IDs
while recording the distinct pre-native, post-native/pre-step, controlled
zero-gravity write-back, and first gravity/contact checkpoints; carrier,
instance, shape-local center, and stripped render scale must each be accounted
for exactly once.

### Physics-instance alignment

The 135 prop batch records own 1,955 active render instances and exactly 1,955
native Havok bodies. The ground and four walls add five ordinary logical/native
bodies. The persistent ragdoll adds ten ordinary bodies, producing 150 logical
records and 1,970 native bodies in the running game. These three counters are
reported independently by the isolated physics harness; a logical batch count
is never treated as native-body proof.

Each prop record retains its stable source batch key, render-instance count,
and native-instance count. Within a record, render index, native creation
index, collision index, raycast index, score index, and indexed-control index
are the same stable identity. Source batch shapes are shared across those
native instances:

- automatic boxes use the baked comparison-geometry center and full extents;
  domino remains the authored box centered at `(0,0.16,0)` with extents
  `(0.176,0.32,0.042)`;
- the stack's baked `towerGameBlock` box is centered at `(0,0.15,0)` with
  extents `(0.5,0.3,1.5)`. Its source asset scale `20` was already baked before
  the aggregate was created, so each rigid instance has unit scale and shares
  that absolute body-space shape;
- the transformed radial tower remains centered at the origin with extents
  `(0.5,1.5,0.3)`. These are the source's explicit absolute dimensions, and
  its asset scale `0.2` was likewise baked before body creation;
- the chessboard preserves Babylon.js 6.0.0 aggregate behavior: its local
  center is `(0,0.0260188989341259,0)`, while automatic box extents are the
  world bounds multiplied by the still-live `0.6` carrier scale, yielding
  `(0.7200000286102295,0.03122267872095108,0.7200000286102295)`. Lite's
  rendering bakes the equivalent `0.6` scale into vertices, but its collider
  must retain the source aggregate's observed body-space dimensions rather
  than substitute rendered bounds;
- the bowling ball is a radius-`0.5` sphere;
- arch columns use the source Y-axis cylinder from `(0,0,0)` to `(0,0.6,0)`
  with radius `0.12`;
- cups, bowling pins, arch tops, and chess pieces use their baked convex hulls;
  the ramp uses its baked indexed triangle mesh even though it is dynamic;
- each arch body shares the source three-box container, with left/right centers
  `(-0.3696,0.2,0)` and `(0.3696,0.2,0)`, middle center `(0,0.3,0)`, and
  extents `(0.3696,0.4,0.4)`, `(0.3696,0.4,0.4)`, and
  `(0.3696,0.2,0.4)`.

The physics regression records each stable cube cohort at four distinct
checkpoints: immediately before native creation, immediately after creation
before stepping, the first zero-gravity/zero-velocity synchronization, and the
first normal-gravity contact. Every checkpoint compares the full effective
matrix, signed determinant, and selected transformed world vertices, not only
translation. Shape-local centers remain separate from instance placement.
First/middle/last native handle identities remain stable, indexed controls for
zero and the last instance issue one native call each, and raycast/collision
results return the same indices. The harness wraps real Havok calls with a
pass-through scalar observer and publishes no native objects.

The room uses `childRoom_ibl.env` at intensity `0.6`, the six separate
`childRoom_1K_*.jpg` skybox faces, directional light `(0,-2,-2)` at intensity
`0.85`, hemispheric light `(0,1,0.5)` at intensity `0.1`, and a 2048 PCF shadow
map. The source image-processing defaults are restored after environment load:
tone mapping off, exposure `1`, contrast `1`.

Ground rendering is 40×40 at Y `0.05`; collision extents are `(600,0.1,600)`
around `(0,-0.05,0)`. Four invisible walls are centred at X/Z `±18`, Y `18`.
Movable props keep source masses multiplied by `0.2³`, material friction and
restitution, mesh/convex/compound shape selection, and start asleep.
Box shapes normally use each baked model's geometry bounds for their center and
extents. The source-authored domino `(0,0.16,0)` and transformed radial-tower
`(0,0,0)` dimensions remain explicit, as does the Babylon.js 6 chessboard
aggregate's scaled-extents behavior above. Bottom-origin models therefore sit
on their intended Y plane instead of intersecting the floor or neighboring
rows.

## Materials and assets

All runtime URLs resolve through `demoAssetUrl` relative to the entry module.
No GitHub, snippet, CDN, or old `assets/` URL is used at runtime. The local NME
graphs provide rug, wooden block, domino, popper artwork, and aiming ribbon.
Repeated embedded NME image names are normalized by block ID; image bytes are
extracted losslessly and checksummed. Imported materials remain attached except
where the source explicitly replaces them.

`lab/public/playroom/asset-manifest.json` is authoritative for provenance,
hashes, omissions, and transformations. Redistribution is based on the user's
explicit authorization. The source package's ISC declaration is recorded
without asserting an unverified per-asset license or copyright holder.

## Ragdoll

The bunny uses ten BOX bodies for `root`, arms, legs, two sections of each ear,
and `head`; mass is `0.08`, friction `0.6`, restitution `0`. Nine
ball-and-socket constraints connect each body to its nearest configured
ancestor. `bunny-rig.json` records source joint indices, rest local transforms,
bind world transforms, dimensions, offsets, and nearest configured parents.

One world-lifetime post-physics callback rotates each collider offset through
the joint's current body rotation to recover the joint position, and derives
the desired joint rotation from the body delta and bind-world rotation. Every
configured joint is submitted as an absolute skeleton-space world pose through
`setBoneWorldPoseDeferred`, followed by one `bakeSkeleton`. The pose position
is divided by `gameScale` because the visible skinned primitive carries that
scale; the world-pose API supplies the loader's handedness reflection so the
primitive's reflected world matrix does not mirror absolute translations a
second time. Unconfigured spine and ear nodes continue to inherit from their
configured parent through the skeleton hierarchy. Source joint axes are Z for
limbs/head and X for ears. Launch applies force magnitude `500` for one active
step at the root application point; it is not treated as an impulse of 500.

The ragdoll alignment contract is final skin space, not the CPU override map.
For opposite X launches and a Z control, integration coverage reconstructs a
root-weighted visible vertex and configured joint landmarks from the palette,
inverse bind data, mesh world matrix, JOINTS, and WEIGHTS consumed by the
main draw. Those world positions and rotations must match the corresponding
Havok joints throughout flight and contact without changing the body
trajectory, camera-follow target, or the scene's independently cached main and
shadow tasks. The bunny is not registered as a shadow caster.

All ten bodies remain `DYNAMIC` with node-to-body prestep disabled from
creation through startup, aiming, flight, Next Kick, and replay. Gravity and
contacts therefore lower the bunny from its spawn pose onto the floor before a
throw, and the world-lifetime callback transfers body poses to the skeleton
after every physics step regardless of launch state.

Kick is guarded only by the per-throw `launched` flag. It neither restores
cached transforms, clears velocities, nor changes motion ownership; it applies
one source force of magnitude `500` at the root's current simulated
application point. Next Kick and replay restore the ten existing bodies to the
spawn configuration and clear their velocities, but leave them immediately
dynamic so they fall and settle again. All ten body identities, nine constraint
identities, and per-record scoring sets survive between throws. Replay clears
those score sets while resetting world score and puzzle state.

## Game state and controls

Phases are `loading → ready → aiming → watching → ended`, with `free` as an
overlay mode retaining the underlying phase. Play enters aiming. Kick arms
poppers, enables scoring, launches and follows the bunny. Throws one and two
offer Next Kick; throw three ends after settling or leaving ±16 in X/Z.
Destruction and score eligibility remain between throws. The ten ragdoll
bodies and nine constraints persist across all three throws: Next Kick
resets the complete body set to the cached spawn configuration, clears linear
and angular velocities, and leaves every body `DYNAMIC`. Replay is an
in-page reset. It restores copied authored thin-instance matrices into the
existing CPU slabs and native bodies, clears velocities,
effects/audio/debounce and score state, restores popped props, resets the
existing ragdoll, and returns directly to aiming. Meshes, GPU buffers, physics
bodies, shapes, constraints, collision registration, shadow membership, and
pose callbacks retain their identities across every replay.
Restored puzzle bodies remain simulation-controlled, matching initial gameplay:
gravity and contacts can wake and move them while the player is aiming.

Each eligible body/instance awards seven points once. Contact identity and
scored flags live in the demo registry, not engine handles.

Orbit aiming uses alpha `-1.25`, beta `1.2`, radius `1`, target Y `0.3`, FOV
`0.4π`, near/far `0.002/64`, beta limits `0.8..1.75`. A 15-segment ballistic
ribbon uses speed `10`, gravity `9.81`, width `0.2`, and source NME time input.
Watching eases radius toward `2.4` and follows the root. Free mode uses WASD on
desktop. Physics raycasts select one positive-mass non-ragdoll instance;
press-and-hold impulse magnitude is `0.0008 × heldMilliseconds`. Movement,
blur, pointer cancel, mode exit, or disposal cancels a charge.
Only the active camera owns controls: orbit input is attached in game modes,
free input is attached in free mode, and neither controller is attached before
Play.

### Startup and source UI equivalence

The DOM UI reproduces the pinned `BabylonJS/ThePlayroom` revision
`d22ce23ef308e28d1f8b6598b4c72ea944205925` without adding Babylon GUI. In
`app_package/src/playgroundRunner.ts`, the landscape (`1481×691`) or portrait
(`871×1866`) splash occupies the full GUI texture with
`Image.STRETCH_UNIFORM`. The Lite `<img>` therefore fills the viewport with
`object-fit: contain`; it is never cover-cropped. Its containing startup layer
has no color or opacity, so the WebGPU canvas remains composited behind every
transparent pixel and outside the uniformly fitted art.

The source loading control is right/bottom aligned with `left = "-2%"` and
`top = "-2%"`. It is a square whose side is 15% of viewport width in landscape
and 20% in portrait: source height is `widthFraction × (viewportWidth /
viewportHeight)`, which resolves to the same pixel side as its width. The same
pixel-square rule applies after the loading image becomes Play. Lite maps the
offsets to `right: 2vw; bottom: 2vh` and recomputes exact pixel variables on
every resize.

The pinned source changes the loading image rotation by `360 / 8` **radians**
every 10 ms, then resets it and uses `cos(time) × 0.5` radians while incrementing
`time` by `0.02` every 10 ms after readiness. Lite retains those observable
units, interval, first ready sample (`0.5` radians), and cosine samples exactly;
it does not reinterpret the loading step as degrees or approximate the cosine
with CSS keyframes. One startup-owned interval rotates only the button's image
pseudo-element. It is replaced at the loading-to-ready transition and stopped
on Play, error, disposal, or reduced-motion preference; no interval or extra
render loop survives those boundaries.

Gameplay controls retain the exact source size and anchors:

- Kick is bottom-right, 2% above the bottom, with side
  `min(20vw, 40vh)`.
- Next Kick is bottom-left, 2% above the bottom, with side `20vw`.
- Play Again is bottom-right, 7% above the bottom, with side `20vw`.
- Free Mode is top-right with side `12vw`.

The source top-center stack uses Verdana: the throw line is 20 px in a 30 px
row with a `3px 3px 8px #111` shadow; points are bold 24 px `#a09` in a 30 px
row with a `#bbb` 3 px glow. Before Play, the HUD and every gameplay control,
including Free Mode, are hidden. In watching, Next Kick is source-visible but
disabled until the existing settle gate permits the next throw. Image controls
use the source-like 0.95 pressed scale, accessible names, keyboard activation,
focus rings, and touch-safe pointer handling.

Poppers arm after kick/free entry, trigger once above angular speed `0.06`, and
apply per-instance linear-falloff impulses within radius `1.6` (power `0.096`,
or `0.256` for the two strong poppers). A popped body is hidden and excluded
from scoring immediately, then parked below the scene and made static after
contact draining completes. Replay invalidates any queued park, restores the
existing body and matrix, and re-enables the popper without allocating a
replacement.

## Effects and audio

The local aiming graph drives one non-pickable, double-sided world-space
ribbon. Its 15 segments use the smoothed camera-derived launch pitch/yaw and
source ballistic intercept equation; its launch offset instead uses the
current unsmoothed pitch, as the source does. While aiming, the orbit target is
centered from the ragdoll root with the source `2 * GAME_SCALE` horizontal
offset and `1.5 * GAME_SCALE` height, so both camera and ribbon origin follow
the bunny's current gravity-settled pose. The ribbon is hidden before Play,
while the bunny is in flight, after the game ends, and in Free Mode.

The ribbon starts with degenerate hidden positions, then uploads cumulative
distance U coordinates once the first nondegenerate aiming curve exists. This
matches the source's first `CreateRibbon` frame and lets the authored graph's
UV fade produce coverage; later frames update only the existing position
buffer. Repeated serialized NME inputs receive distinct Babylon-style uniform
names (`Float`, `Float1`, ...), preserving all six authored scalar defaults,
and the graph's `Time` input advances in seconds. The checked-in graph is byte-identical to pinned source snippet `8FCL7N#8`
(SHA-256 `446e8813b77ec4c497ee9e3f899f560779a7cb9c8db57c4c5c4b11c240d61131`).
Its alpha path is
`FragmentOutput #431.a <- Scale #452`, where `Scale #453` multiplies
`Pow #445(Sin #446(uv.y * Float #449), Float #450)` by `Alpha #454`, and
`Min #718` clamps `uv.x * Float #456` against `Float #719`. With the serialized
values `Float #449 = 3.141592`, `Float #450 = 0.4`, `Alpha #454 = 0.25`,
`Float #456 = 12`, and `Float #719 = 1`, the exact fragment expression is
`pow(sin(uv.y * 3.141592), 0.4) * 0.25 * min(uv.x * 12, 1)`.

The pinned-source capture's generated WGSL (`shd_10`, lines 78-85 and 110-124)
emits that expression, and its bound UBO contains the same five values. The
Lite capture's generated WGSL (`shd_5`, line 48) emits the same expression and
the focused integration test checks all five values in the bound UBO.
The serialized material alpha is `1`; neither material alpha nor Babylon's
source `mesh.visibility = 0.4` assignment appears as a shader uniform or a
fixed-function opacity factor. Source `Mesh.DOUBLESIDE` duplicates the 90
front-face indices, so a center/full-length fragment reaches per-surface alpha
`0.25` and is alpha-composited twice in the 180-index draw (effective color
coverage `1 - (1 - 0.25)^2 = 0.4375`). Lite preserves that compositing rather
than multiplying the graph alpha: it retains the authored `0.25` and adds the
reverse-wound index set to the same ribbon mesh. Alpha-combine uses `src-alpha
/ one-minus-src-alpha` for color and `one / one` for alpha, retains depth
testing, disables depth writes, and disables culling. No replacement mesh,
material, physics body, pick target, shadow caster, or per-frame resource is
created.

`pointStar.png`, `flare.png`, and `confetti.png` are world-space billboard
simulations owned by the scene. Their capacities, lifetimes, emission rates,
sizes, colors, cone/sphere trajectories, gravity, angular speed, and burst
counts retain the source values; no DOM particle overlay substitutes for
scene-space motion. Per-frame sprite synchronization writes each live particle
through one effects-owned mutable descriptor whose position and size arrays are
allocated once. `addBillboardSpriteIndex` copies those scalars immediately into
the system's stable instance slab, so descriptor reuse cannot alias sprites or
change particle geometry, count, color, rotation, or lifetime.

The 28 active MP3 files cover wood/plastic/cup/pin/chess/domino contacts, ground
thumps, projectile launch/flight, scoring, and poppers. Files decode once;
bounded voices provide overlap. Contact routing matches both participants'
source tags, reads both exact instance velocities regardless of event
orientation, and gates on squared relative speed plus vertical ground impact.
The bowling, chess, plastic, cup, wood, domino, and projectile-ground pools
retain their own thresholds, debounce, pitch, and volume rules. Master gain is
6 with source relative gains. Audio unlocks from a user gesture. Unavailable
audio is visibly reported and never blocks gameplay. The collision callback
owns two velocity vectors, one metrics object, and match storage for its full
lifetime rather than recreating them per native event. Profile matching can
rewrite caller-provided match records in place. Ready/voice/projectile/cooldown
and pair-deduplication checks run before native velocity reads; the original
checks run again at playback so observer ordering, thresholds, pool selection,
timestamps, and the eight-voice cap remain authoritative. An event for which no
profile can currently play performs no velocity read.

## Lifecycle and deployment

The startup controller installs the single resize listener, animation owner,
and progress observer before asynchronous setup. The existing
`installFetchProgress` handle remains the only fetch wrapper; its
progress/detail datasets feed a live-region announcement. The original `fetch`
function identity is restored by `done()` on both success and failure. Audio
loading starts into a stable state object while assets, physics, materials, and
the game are built. As soon as that actual world is complete, the scene is
registered once and the engine's only render loop starts, so its first and
subsequent frames remain visible behind the transparent loading UI while a late
audio fetch/decode is still pending. Required loading, game construction, scene
registration, audio completion (or its explicit unavailable state), and the
first rendered world frame all complete before the game moves from `loading`
to `ready`, `canvas.dataset.ready = "true"` is published, and Play is enabled.
Audio engine, input route, and decoded-buffer ownership is published
incrementally across async boundaries. Disposal uses the package's public
sound-source and audio-engine disposal operations; a resource that resolves
after disposal is immediately released rather than reattached. The late startup
continuation also exits without publishing ready when page teardown has already
disposed the game.
Setup failure keeps the transparent splash composition, disables the action,
exposes a visible alert, and disconnects startup observers/listeners. Stable
datasets expose phase, score, throw, body, constraint, and popper counts for
nonvisual smoke tests without exposing scene or native handles.

The standalone document owns the scene and releases it on navigation; replay
uses the subsystem reset path described above. The shared demo bundler copies
the entire `playroom` directory beside the flat bundle, so both
`/lite/demo-playroom.html` and arbitrary nested flat deployments resolve JS,
WASM, models, graphs, images, environment faces, and MP3 files locally.
Replay performs no scene or GPU retirement. During construction, each batch
captures its authored thin-instance matrix slab and native-pose checkpoint
before physics stepping begins; replay uses them to update the existing native
instances and retained matrix buffers.
Restored bodies have zero linear/angular velocity and start asleep under their
normal simulation-controlled activation. This keeps main/shadow packets and
caster membership stable while making the reset synchronous and allocation-free
for native and GPU resources.

### Lifecycle investigation harness

`lab/lite/playroom-lifecycle-harness.html` is an opt-in diagnostic entry, not a
production debug mode. It builds the normal Playroom scene and keeps render
bundles, real Havok stepping, the single 2048 PCF shadow map, effects, audio,
and replay behavior enabled. Test commands cross the page boundary through
copied `CustomEvent` data; no scene, Havok, or GPU handle is published on
`window`.

The harness pass-through observer records wall-clock frames, JavaScript frame
work, fixed physics steps, GPU timestamp results, native body/shape/constraint
lifetime, collision stream drains and phases, native-ID resolutions, transform
polls, GPU buffer writes, effect descriptor writes, active audio/deduplication
state, and pending world/GPU retirement. Measurements are cumulative scalar
counters and bounded samples. Browser CPU and retained-allocation profiles are
captured separately through the DevTools protocol with Spector disabled.
The normal harness uses production event-ID lookup. A diagnostic may remove
effect particles only inside this test entry and must never become a runtime
quality reduction or production default.

## Validation

- Unit: indexed body access; 103-family counts, real geometry/collider bounds,
  and deterministic expansion; bind-world ragdoll mapping and joint pivots;
  persistent three-throw/scoring/reset behavior; camera control ownership and
  charge cancellation; source effect trajectories; two-participant indexed
  audio routing; manifest checksums and local URLs.
- Build: root-only public types, single-demo runtime asset copy and MIME.
- Browser: nonvisual ready/phase/actions/reset/free-mode/nested-path checks.
- Presentation: one approved representative 1280×720 JPG below 250 KB.

No local parity, performance, all-scene suite, golden, MAD, or ceiling update is
part of this demo delivery.
