# Historical guide-only SSAO reconstruction

This is the superseded prototype, not the shipped implementation. It passed
some aggregate numerical budgets but retained user-visible shimmer. The active
API and native-format owner are specified in
[module 56](../56-screen-space-ambient-occlusion.md) and
[module 58](../58-diligent-denoiser.md).

The original owner and shaders are retained under `scripts/ao-reference/legacy/`,
outside the runtime package. Run `pnpm test:ao:temporal --legacy` explicitly to
exercise the historical numerical kernel. Add `--software` for isolated
SwiftShader execution. Passing this suite does not validate the production
denoiser or establish acceptable visual quality.
The numerical driver now exercises XeGTAO only; the VBAO-specific current-frame
blur described below was removed along with that estimator.

## Archived reconstruction design

Within verified moving-occluder footprints, retain long AO history when a
stationary receiver's occluder moves. Reject stale color, not the entire
accumulated sample count. A nine-tap same-surface guide uses three-pixel spacing
for a large projected AO footprint (over 40 pixels), one pixel otherwise.
Reject normal, tangent-plane, curvature, background, and locality mismatches.
Reproject its mean with the already validated history taps and update at
current weight 0.75. A coherent jump larger than
`0.05 + 3 * sqrt(guideVariance)` uses the current guide immediately.

Clip old AO around this fast guide by half a standard deviation, using the
smaller of same-surface local-box and guide spatial variance. Blend the unchanged
current AO estimate with weight `1 / count`, retaining the configured maximum
sample count rather than forcing all nearby floor pixels to four observations.
History alpha stores the independent fast guide; blue stores variance. Moving
receivers retain the existing material-point variance/reactivity path.
Inactive regions retain their unbiased original accumulation and statistics;
the broader guide must not spatially bias static-scene convergence.
Small projected footprints retain the existing fast-response path; its tight
low-resolution contact shadows must not acquire the broader guide's bias.
Visibility discontinuities over half the normalized range restart only the
affected pixel, not an entire moving-object footprint.
The public visibility target stays stable.

Private GPU ownership: one current spatial scratch, two AO-history targets
(`rgba16float`: visibility, confidence count, variance,
signal running mean or independent fast guide), and two geometry-history
targets (`rg32uint`: positive f32 view-depth bits with tracked-receiver flag
in the otherwise unused sign bit, octahedral packed signed world normal).
Every geometry-history consumer masks the flag before decoding depth.
The compute resolver writes grayscale visibility into the stable public output,
so material bindings and cached bundles are not invalidated each frame.
Scratch bind groups/pipelines are cached and allocated only on device/size/source
changes. Borrowed input textures are never destroyed.

The resolver reconstructs current position and world normal, projects into the
previous frame (or uses velocity), and gathers four bilinear history taps.
Each tap is independently validated for screen bounds, positive depth,
world-space tangent-plane distance, and world-normal agreement (dot >= 0.9).
The plane tolerance is `max(1e-4, min(viewDepth * 0.005, radius * 0.025))`;
curved surfaces add `0.5 * length(positionDelta) * length(normalDelta)`.
Tap separation must not exceed twice the AO radius. The normal-change allowance
is the curved-surface deviation from a tangent plane, not a blanket depth
relaxation. Spatial neighborhood weights use this same enlarged tolerance
so accepted taps never acquire negative weights.
No interpolated depth/normal across a silhouette is used for acceptance.

Outside the large-footprint guide path, valid history is renormalized and its
mean is clipped to the current same-surface neighborhood's variance envelope.
Geometry agreement is not sufficient: a moving occluder can change AO on a
stationary floor while the floor's depth, normal, and velocity stay unchanged.
Track a separate running mean and central variance of the same-surface spatial
AO signal. Compare its innovation with the learned noise range and raise the
current-frame weight on coherent signal changes. Spatial variance divided by
the effective weighted sample count bootstraps the first four observations;
mature history uses temporal signal variance so a high-contrast neighborhood
cannot legitimize a stale shadow. Winsorize the variance update at the noise
bound so genuine lighting changes are not subsequently learned as random noise.

Tracked moving receivers use the current material-point estimate as their
signal instead of the screen-neighborhood mean, whose support changes during
motion even when the surface's AO is unchanged. Rejected moving history seeds
its variance from the same-surface neighborhood; subsequent observations learn
point-signal variance. Reactivity starts at the full `0.015 + 3 * noiseSigma`
bound and reaches full rejection at 1.5 times that bound. Static receivers
retain the earlier, more responsive half-bound onset. Valid moving history
is not clamped to an instantaneous screen-neighborhood envelope; genuine
signal changes still raise its current-frame weight. A validated moving-history
tap retains the tracked-receiver flag even when motion pauses, so stopping or
reversing does not switch the meaning of its signal statistics.

When velocity is supplied, build an 8x8-tile activity hierarchy. Each cell stores
the exact active-tile XY bounding rectangle and its positive view-depth range,
not just an OR bit. XY bounds are packed as two 16-bit components per word;
the other two words retain min/max depth bits in `rgba32uint`. Parent cells
merge bounds. The query must intersect both the actual rectangle and the
receiver's finite AO depth interval. A coarse cell containing one moving object
must not reset every static object elsewhere in that cell.
The mask removes camera-only velocity by comparing supplied motion with depth-
reconstructed camera reprojection; a residual above half a pixel marks object
motion. Previous-depth mismatch also marks vacated/new occluder geometry.
Query a conservative projected AO-radius rectangle in the current and previous
activity pyramids. Both footprints are considered so a departing shadow does not
leave history behind. Stationary receivers with projected radius over 40 pixels
use the independent fast guide described above and retain full accumulation.
For smaller projected footprints, preserve the existing four-observation
fast-response path and its tight low-resolution contact detail. Static regions
retain their original accumulation and all configured history.
The actual XeGTAO current observation is never replaced by the broader guide.
Tracked moving receivers retain their material-point estimates and are not
subject to the stationary-receiver guide.

Pixels with genuinely short history need spatial stabilization rather than
exposing one or two noisy estimates. A final 5x5 confidence-guided pass writes
the stable public output from the resolved history. It filters only low-
confidence pixels, rejects depth/tangent-plane and normal discontinuities,
and uses the spatial AO signal as a bilateral guide so it does not blend
across contact-occlusion edges. Full-confidence pixels remain unchanged.
Tracked moving receivers also bypass this additional confidence-dependent
blur: changing its strength as their history matures would deform the contact
gradient and introduce flicker. They retain the estimator's spatial filtering
(including the temporal VBAO 3x3 filter) and material-point temporal accumulation.
The two small `rgba32uint` pyramids are allocated only when velocity is supplied;
classification and bounding reductions run before the temporal resolve. Odd
trailing tile rows/columns participate in the reductions. Temporal resolve
bindings 11 and 12 sample current/previous activity. No velocity means no
activity passes.

Per-pixel counts ramp the current weight from 1 to `1 / samples`; partial
bilinear coverage lowers confidence and substantial clipping in the original
fast-response path caps confidence at four samples. The large-footprint guide
clips stale color without reducing its count. Rejected pixels restart at count 1.
Background remains visibility 1 with count 0. VBAO receives a depth/normal-aware
3x3 spatial filter; XeGTAO retains its spatial denoiser without another blur.

The temporal UBO is 208 bytes: inverse current view, previous view,
previous view-projection (three mat4x4f), then reset/sample count/VBAO spatial
filter/previous-depth contract vec4f. Normals share the estimator's reconstruction
helper. Previous normals are stored in world space, so camera rotation alone
does not reject history. The packed normal uses `pack2x16snorm`, not f32 bitcasts
of potentially NaN words. AO means, moments, and counts are explicitly rounded
to half precision before storage, including subnormals.

The earlier four-sample cap and final 5x5 filter alone left visible shimmer.
The later large-footprint prototype retained long accumulation and used a
separate low-lag guide, but it was still superseded by the complete Diligent
pipeline and geometry-driven occlusion-history transport. Wider and multi-scale
finishing-filter experiments did not meet the combined quality requirements.
None of these guide-only paths is part of the shipped temporal enabler.
