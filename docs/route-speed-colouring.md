# Route speed coloring

Select a Route Map and enable **Color Route by Speed** under Line Styling, then
choose **Auto** or **Custom**. Speed coloring is off by default.

- **Auto** uses zero as the minimum, the highest valid speed in the entire
  activity as the maximum, and the default blue/cyan/yellow/red palette. Its
  range and palette controls are hidden. Exporting a short range does not change
  the automatic maximum.
- **Custom** adds one unit selector: km/h, mph, knots, m/s, min/km or min/mile.
  It exposes the range, editable color stops and numeric thresholds for each stop.
  Pace ranges use Slow pace / Fast pace and m:ss values (∞ means zero speed). The gradient editor supports two to five stops.
  Switching to Auto preserves the stored Custom settings for switching back.

Each activity has its own automatic maximum. Stationary activities use the slow
color. Speeds outside a custom range clamp to its endpoint colors.

Both finished and remaining paths use the same historical speed colors, with
their existing independent thickness and opacity. Marker styling is independent.
Finished Color and Remaining Color controls are hidden while speed coloring is
enabled, and return when it is disabled. Their saved values remain the fallback
wherever speed is missing. Missing, negative and non-finite speeds are not converted to zero.
Existing route projection, smoothing and GPS-gap behaviour are unchanged.
At a crossing, later route segments paint over earlier ones as before.

Templates store an optional `speed_coloring` block on the `course` plot:

```json
{
  "speed_coloring": {
    "enabled": true,
    "mode": "auto",
    "unit": "kmh",
    "min_speed_kmh": 0,
    "max_speed_kmh": null,
    "stops": [
      { "offset": 0, "color": "#2563eb" },
      { "offset": 0.333333, "color": "#06b6d4" },
      { "offset": 0.666667, "color": "#facc15" },
      { "offset": 1, "color": "#ef4444" }
    ]
  }
}
```

Older templates without this block keep solid coloring. Previously customized
settings without a mode retain Custom behavior; unchanged defaults migrate to
Auto in the editor. Direct native configs without a mode preserve their previous
explicit settings. The shared renderer resolves Auto against the canonical
manifest defaults, even if the template retains different Custom values.
The native renderer validates custom ranges and palette colors/offsets at ingress.
Bounds remain canonical km/h and stops remain normalized offsets; `unit` is an
editor display preference, so changing units never changes the rendered range.
All 15 existing UI locales include the feature labels and validation messages.

The shared widget engine handles app preview and native export. Speed samples
remain separate from simplified route geometry. Drawing segments split at
geometric vertices, telemetry samples and palette thresholds, so straight roads
do not lose speed peaks. Paints and paths are prepared once per layout; the
remaining route is raster-cached. For opaque palette colors, a device-aligned
completed-prefix raster appends fully passed segments rather than replaying them
each frame. The active segment, completed outline and marker still update. Each
preview/export worker owns one prefix surface, bounded by the visible route clip;
reverse seeks or transform/bounds changes rebuild it. Clones start empty.
Intrinsic-alpha palettes retain the vector path to preserve their compositing.
Finished/remaining opacity and chronological overlap coloring remain supported.
Rasterization at antialiased edges can differ slightly from the uncached path. Contiguous color polygons share their edges
and are clipped to the rounded route outline. Only the assembled outline is
antialiased, and opacity is applied once, avoiding dots and cracks between dense
samples while keeping rounded line ends and progress markers.

## Checks

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir app test
cd src-tauri
cargo test --locked --release -p ovrley_widgets -p ovrley_core --lib
cargo build --locked --release -p ovrley_core --bin render_video --bin render_preview
```

The core atlas composite test expects an ignored video fixture at
`src-tauri/ovrley_core/tests/fixtures/video/test-1080p.mp4`. If absent, create a
synthetic 1920x1080 H.264 fixture with FFmpeg (no personal footage is needed):

```sh
mkdir -p ovrley_core/tests/fixtures/video
ffmpeg -n -f lavfi -i 'testsrc2=size=1920x1080:rate=30000/1001' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 2 \
  -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p -c:a aac \
  ovrley_core/tests/fixtures/video/test-1080p.mp4
```

Production app packaging also needs the SDK versions in `scripts/build-wasm.mjs`
and an `EMSDK` path in `.env.local`; see the existing app build documentation.
