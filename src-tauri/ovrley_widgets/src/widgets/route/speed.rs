//! Speed colouring shared by native exports and the app's WASM route preview.
//! Telemetry remains independent of the simplified drawing geometry.
use super::{geometry::RouteGeometry, layout::stroke_paint, validation::ValidatedRoutePlot};
use crate::{
    error::{WidgetError, WidgetResult},
    model::scene::ValidatedScenePresentation,
    render::{
        text::parse_color,
        track_fill::{validate_track_fill_color, GradientStop, TrackFillColor},
    },
};
use serde::{Deserialize, Serialize};
use skia_safe::{path_utils, BlendMode, Canvas, ClipOp, Paint, Path, PathBuilder, Point, Rect};
use std::sync::{Arc, OnceLock};

/// Older configs used explicit/custom settings before mode selection existed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeedColorMode {
    Auto,
    #[default]
    Custom,
}

/// Explicit template settings. A missing block preserves legacy solid routes.
/// Bounds are km/h; `None` uses the maximum observed in the entire activity.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SpeedColorConfig {
    pub enabled: bool,
    #[serde(default)]
    pub mode: SpeedColorMode,
    pub min_speed_kmh: f64,
    pub max_speed_kmh: Option<f64>,
    pub stops: Vec<GradientStop>,
}

impl SpeedColorConfig {
    pub fn validate(&self, field: &str) -> WidgetResult<Self> {
        if self.mode == SpeedColorMode::Auto {
            static DEFAULTS: OnceLock<SpeedColorConfig> = OnceLock::new();
            let defaults = DEFAULTS.get_or_init(|| {
                let manifest: serde_json::Value = serde_json::from_str(include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../assets/standard-widgets.json"
                )))
                .expect("widget manifest must be valid JSON");
                let course = manifest["definitions"]
                    .as_array()
                    .expect("widget definitions")
                    .iter()
                    .find(|w| w["type"] == "course")
                    .expect("course defaults");
                serde_json::from_value(course["defaults"]["speed_coloring"].clone())
                    .expect("speed color defaults must be valid")
            });
            // Resolve Auto in the shared engine, for both preview and exports.
            // Stored Custom settings stay in the template and can be restored.
            let custom = Self {
                enabled: self.enabled,
                mode: SpeedColorMode::Custom,
                ..defaults.clone()
            };
            let validated = custom.validate(field)?;
            return Ok(Self {
                mode: SpeedColorMode::Auto,
                ..validated
            });
        }
        if !self.min_speed_kmh.is_finite() || self.min_speed_kmh < 0.0 {
            return Err(WidgetError::Config(format!(
                "{field}.min_speed_kmh: expected a finite non-negative speed"
            )));
        }
        if self
            .max_speed_kmh
            .is_some_and(|v| !v.is_finite() || v <= self.min_speed_kmh)
        {
            return Err(WidgetError::Config(format!(
                "{field}.max_speed_kmh: must exceed the minimum speed"
            )));
        }
        let TrackFillColor::Gradient(stops) = validate_track_fill_color(
            Some("#ffffff"),
            Some(true),
            Some(self.stops.clone()),
            |_| format!("{field}.stops"),
        )?
        else {
            unreachable!()
        };
        if stops
            .windows(2)
            .any(|pair| pair[0].offset == pair[1].offset)
        {
            return Err(WidgetError::Config(format!(
                "{field}.stops: offsets must be distinct"
            )));
        }
        Ok(Self {
            stops,
            ..self.clone()
        })
    }

    fn color(&self, speed: f64, maximum: f64) -> String {
        let span = self.max_speed_kmh.unwrap_or(maximum) - self.min_speed_kmh;
        // A stationary activity (or minimum above the automatic maximum) uses
        // the slowest colour, without division by zero or invented speed limits.
        let offset = if span > 0.0 {
            ((speed - self.min_speed_kmh) / span).clamp(0.0, 1.0) as f32
        } else {
            0.0
        };
        let right = self.stops.partition_point(|stop| stop.offset < offset);
        if right == 0 {
            return self.stops[0].color.clone();
        }
        if right == self.stops.len() {
            return self.stops[right - 1].color.clone();
        }
        let (a, b) = (&self.stops[right - 1], &self.stops[right]);
        let fraction = (offset - a.offset) / (b.offset - a.offset);
        let (a, b) = (parse_color(&a.color, 1.0), parse_color(&b.color, 1.0));
        let channel = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * fraction).round() as u8;
        let rgb = format!(
            "#{:02x}{:02x}{:02x}",
            channel(a.r(), b.r()),
            channel(a.g(), b.g()),
            channel(a.b(), b.b())
        );
        let alpha = channel(a.a(), b.a());
        if alpha == 255 {
            rgb
        } else {
            format!("{rgb}{alpha:02x}")
        }
    }
}

pub struct SpeedProfile {
    pub points: Vec<(f32, Option<f64>)>,
    pub maximum_kmh: f64,
}
impl SpeedProfile {
    fn at(&self, progress: f32) -> Option<f64> {
        let index = self.points.partition_point(|p| p.0 < progress);
        if let Some(point) = self.points.get(index).filter(|p| p.0 == progress) {
            return point.1;
        }
        let (a, b) = (
            self.points.get(index.checked_sub(1)?)?,
            self.points.get(index)?,
        );
        Some(a.1? + (b.1? - a.1?) * ((progress - a.0) / (b.0 - a.0)) as f64)
    }
}

#[derive(Clone, Debug)]
struct SpeedSegment {
    start: f32,
    end: f32,
    a: Point,
    b: Point,
    paths: [Path; 2],
    join_disk: bool,
    completed: Paint,
    remaining: Paint,
}
#[derive(Clone, Debug)]
pub struct SpeedRoute {
    segments: Vec<SpeedSegment>,
    completed_opacity: f32,
    remaining_opacity: f32,
    bounds: Rect,
    geometry: Arc<RouteGeometry>,
    radii: [f32; 2],
    outlines: [Path; 2],
}

fn stroke_outline(path: &Path, radius: f32) -> WidgetResult<Path> {
    let mut outline = PathBuilder::new();
    let paint = stroke_paint("#ffffff", radius * 2.0, 1.0);
    if !path_utils::fill_path_with_paint(path, &paint, &mut outline, None, None) {
        return Err(WidgetError::Render(
            "unable to prepare speed route outline".into(),
        ));
    }
    Ok(outline.detach())
}

impl SpeedRoute {
    pub fn new(
        geometry: &Arc<RouteGeometry>,
        color: &SpeedColorConfig,
        profile: &SpeedProfile,
        config: &ValidatedRoutePlot,
        scene: &ValidatedScenePresentation,
        scale: f32,
    ) -> WidgetResult<Self> {
        // Split at BOTH geometric vertices and telemetry observations: retain
        // the existing curve, and do not lose speed changes along straight roads.
        let mut breaks = geometry.progress_values.clone();
        breaks.extend(
            profile
                .points
                .iter()
                .map(|p| p.0)
                .filter(|p| *p > 0.0 && *p < 1.0),
        );
        // A large speed change can cross several palette stops in one sample
        // interval. Split there too, so the chosen palette is respected exactly.
        let maximum = color.max_speed_kmh.unwrap_or(profile.maximum_kmh);
        for pair in profile.points.windows(2) {
            if let Some((a, b)) = pair[0].1.zip(pair[1].1).filter(|(a, b)| a != b) {
                for speed in color.stops.iter().map(|stop| {
                    color.min_speed_kmh + stop.offset as f64 * (maximum - color.min_speed_kmh)
                }) {
                    let fraction = (speed - a) / (b - a);
                    let progress = pair[0].0 + (pair[1].0 - pair[0].0) * fraction as f32;
                    if fraction > 0.0 && fraction < 1.0 && progress > 0.0 && progress < 1.0 {
                        breaks.push(progress);
                    }
                }
            }
        }
        breaks.sort_by(f32::total_cmp);
        breaks.dedup();
        let mut segments = Vec::with_capacity(breaks.len());
        for pair in breaks.windows(2) {
            if pair[1] <= pair[0] {
                continue;
            }
            let a = geometry.state(pair[0]);
            let b = geometry.state(pair[1]);
            let (a, b) = (
                Point::new(a.marker_x, a.marker_y),
                Point::new(b.marker_x, b.marker_y),
            );
            if a == b {
                continue;
            }
            let colors = profile.at(pair[0]).zip(profile.at(pair[1])).map(|(a, b)| {
                (
                    color.color(a, profile.maximum_kmh),
                    color.color(b, profile.maximum_kmh),
                )
            });
            let paint = |fallback: &str| -> WidgetResult<Paint> {
                // Apply opacity to the assembled stroke once in draw(), so
                // adjacent round caps cannot produce dark translucent seams.
                let opacity = 1.0;
                let mut paint = if let Some((start, end)) = &colors {
                    TrackFillColor::Gradient(vec![
                        GradientStop {
                            offset: 0.0,
                            color: start.clone(),
                        },
                        GradientStop {
                            offset: 1.0,
                            color: end.clone(),
                        },
                    ])
                    .linear_paint(opacity, a, b)?
                } else {
                    let mut paint = Paint::default();
                    paint.set_color(parse_color(fallback, opacity));
                    paint
                };
                // Shared polygon edges have no separate AA coverage. Antialias
                // only the assembled route outline, avoiding translucent cracks.
                paint.set_anti_alias(false);
                paint.set_style(skia_safe::paint::Style::Fill);
                paint.set_blend_mode(BlendMode::Src);
                Ok(paint)
            };
            segments.push(SpeedSegment {
                paths: [Path::default(), Path::default()],
                join_disk: false,
                start: pair[0],
                end: pair[1],
                a,
                b,
                completed: paint(&config.completed_line_color)?,
                remaining: paint(&config.remaining_line_color)?,
            });
        }
        let radii = [config.remaining_line_width, config.completed_line_width]
            .map(|width| (width * scene.scale).max(1.0) / scale * 0.5);
        let normal = |a: Point, b: Point| {
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let len = dx.hypot(dy).max(f32::EPSILON);
            Point::new(-dy / len, dx / len)
        };
        let mut offsets = Vec::with_capacity(segments.len() + 1);
        if let Some(first) = segments.first() {
            offsets.push(normal(first.a, first.b));
        }
        for pair in segments.windows(2) {
            let (a, b) = (normal(pair[0].a, pair[0].b), normal(pair[1].a, pair[1].b));
            let denominator = 1.0 + a.x * b.x + a.y * b.y;
            offsets.push(if denominator > 0.01 {
                Point::new((a.x + b.x) / denominator, (a.y + b.y) / denominator)
            } else {
                Point::new(b.x * 5.0, b.y * 5.0)
            });
        }
        if let Some(last) = segments.last() {
            offsets.push(normal(last.a, last.b));
        }
        for (index, segment) in segments.iter_mut().enumerate() {
            let (a, b) = (offsets[index], offsets[index + 1]);
            segment.join_disk = a.x.hypot(a.y) > 4.0;
            let clamp = |point: Point| {
                let factor = (4.0 / point.x.hypot(point.y).max(1.0)).min(1.0);
                Point::new(point.x * factor, point.y * factor)
            };
            let (a, b) = (clamp(a), clamp(b));
            segment.paths = radii.map(|radius| {
                let mut path = PathBuilder::new();
                path.move_to((segment.a.x + a.x * radius, segment.a.y + a.y * radius))
                    .line_to((segment.b.x + b.x * radius, segment.b.y + b.y * radius))
                    .line_to((segment.b.x - b.x * radius, segment.b.y - b.y * radius))
                    .line_to((segment.a.x - a.x * radius, segment.a.y - a.y * radius))
                    .close();
                path.detach()
            });
        }
        let outlines = radii
            .map(|radius| stroke_outline(&geometry.path.lock().expect("route path lock"), radius));
        let [remaining, completed] = outlines;
        let outlines = [remaining?, completed?];
        let half_width =
            (config.completed_line_width.max(config.remaining_line_width) * scene.scale).max(1.0)
                / scale
                * 0.5
                + 1.0;
        Ok(Self {
            segments,
            geometry: geometry.clone(),
            radii,
            outlines,
            completed_opacity: config.completed_line_opacity * scene.opacity,
            remaining_opacity: config.remaining_line_opacity * scene.opacity,
            bounds: geometry.point_bounds.with_outset((half_width, half_width)),
        })
    }

    pub fn draw(&self, canvas: &Canvas, progress: f32, completed: bool) {
        let opacity = if completed {
            self.completed_opacity
        } else {
            self.remaining_opacity
        };
        if opacity <= 0.0 || progress <= 0.0 {
            return;
        }
        if opacity < 1.0 {
            canvas.save_layer_alpha_f(self.bounds, opacity);
        } else {
            canvas.save();
        }
        let index = usize::from(completed);
        let outline = if completed && progress < 1.0 {
            let path = self.geometry.completed_path(&self.geometry.state(progress));
            // Validated positive widths make outline conversion infallible here.
            stroke_outline(&path, self.radii[index]).expect("validated route stroke")
        } else {
            self.outlines[index].clone()
        };
        canvas.clip_path(&outline, ClipOp::Intersect, true);
        if let Some(first) = self.segments.first() {
            let paint = if completed {
                &first.completed
            } else {
                &first.remaining
            };
            canvas.draw_circle(first.a, self.radii[index], paint);
        }
        let mut last = None;
        for segment in &self.segments {
            if segment.start >= progress {
                break;
            }
            let paint = if completed {
                &segment.completed
            } else {
                &segment.remaining
            };
            if segment.join_disk {
                canvas.draw_circle(segment.a, self.radii[index], paint);
            }
            canvas.draw_path(&segment.paths[index], paint);
            last = Some(segment);
            if segment.end >= progress {
                break;
            }
        }
        if let Some(last) = last {
            let state = self.geometry.state(progress);
            let paint = if completed {
                &last.completed
            } else {
                &last.remaining
            };
            canvas.draw_circle((state.marker_x, state.marker_y), self.radii[index], paint);
        }
        canvas.restore();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> SpeedColorConfig {
        SpeedColorConfig {
            enabled: true,
            mode: SpeedColorMode::Custom,
            min_speed_kmh: 0.0,
            max_speed_kmh: None,
            stops: vec![
                GradientStop {
                    offset: 0.0,
                    color: "#0000ff".into(),
                },
                GradientStop {
                    offset: 1.0,
                    color: "#ff0000".into(),
                },
            ],
        }
    }
    #[test]
    fn automatic_and_manual_range_and_stationary_activity() {
        let mut c = config();
        assert_eq!(c.color(0.0, 60.0), "#0000ff");
        assert_eq!(c.color(30.0, 60.0), "#800080");
        assert_eq!(c.color(60.0, 60.0), "#ff0000");
        assert_eq!(c.color(0.0, 0.0), "#0000ff");
        c.min_speed_kmh = 10.0;
        c.max_speed_kmh = Some(30.0);
        assert_eq!(c.color(20.0, 100.0), "#800080");
        assert_eq!(c.color(100.0, 100.0), "#ff0000");
        c.min_speed_kmh = 0.0;
        c.max_speed_kmh = None;
        c.stops[0].color = "#0000ff00".into();
        c.stops[1].color = "#ff0000ff".into();
        assert_eq!(c.color(30.0, 60.0), "#80008080");
    }
    #[test]
    fn auto_uses_zero_activity_maximum_and_default_palette() {
        let mut c = config();
        c.mode = SpeedColorMode::Auto;
        c.min_speed_kmh = 12.0;
        c.max_speed_kmh = Some(15.0);
        c.stops[0].color = "#ffffff".into();
        let resolved = c.validate("speed").unwrap();
        assert_eq!(resolved.mode, SpeedColorMode::Auto);
        assert_eq!(resolved.min_speed_kmh, 0.0);
        assert_eq!(resolved.max_speed_kmh, None);
        assert_eq!(resolved.stops.len(), 4);
        assert_eq!(resolved.color(0.0, 72.0), "#2563eb");
        assert_eq!(resolved.color(72.0, 72.0), "#ef4444");
        assert_eq!(c.min_speed_kmh, 12.0); // Auto does not destroy stored Custom values.
        c.mode = SpeedColorMode::Custom;
        assert_eq!(c.validate("speed").unwrap().max_speed_kmh, Some(15.0));
    }

    #[test]
    fn configs_without_a_mode_preserve_custom_settings() {
        let mut value = serde_json::to_value(config()).unwrap();
        value.as_object_mut().unwrap().remove("mode");
        value["min_speed_kmh"] = 5.0.into();
        value["max_speed_kmh"] = 35.0.into();
        let legacy: SpeedColorConfig = serde_json::from_value(value).unwrap();
        let resolved = legacy.validate("speed").unwrap();
        assert_eq!(resolved.mode, SpeedColorMode::Custom);
        assert_eq!(resolved.min_speed_kmh, 5.0);
        assert_eq!(resolved.max_speed_kmh, Some(35.0));
        assert_eq!(resolved.stops[0].color, "#0000ff");
    }

    #[test]
    fn rejects_invalid_ranges_and_palettes() {
        let mut c = config();
        c.max_speed_kmh = Some(0.0);
        assert!(c.validate("speed").is_err());
        c.max_speed_kmh = None;
        c.min_speed_kmh = f64::NAN;
        assert!(c.validate("speed").is_err());
        c.min_speed_kmh = 0.0;
        c.stops[1].offset = 0.0;
        assert!(c.validate("speed").is_err());
        c.stops[1].offset = 1.0;
        c.stops[0].color = "bad".into();
        assert!(c.validate("speed").is_err());
    }
    #[test]
    fn cropped_profile_keeps_activity_maximum_and_missing_speed() {
        use super::super::sampling::{RouteActivity, RouteWindow};
        let route = RouteActivity::new(
            &[0.0, 1.0, 2.0, 3.0],
            &[(Some(1.0), Some(1.0)); 4],
            &[0.0, 0.3, 0.6, 1.0],
            3.0,
        )
        .with_speeds(&[Some(20.0), Some(5.0), None, Some(-2.0)]);
        let p = route.speed_profile(Some(RouteWindow {
            start: 1.0,
            end: 2.0,
        }));
        assert_eq!(p.maximum_kmh, 72.0);
        assert_eq!(p.at(0.0), Some(18.0));
        assert_eq!(p.at(0.5), None);
        assert_eq!(p.at(1.0), None);
    }
    #[test]
    fn pixels_follow_speed_and_completed_progress_with_simplified_geometry() {
        use super::super::{
            config::CoursePlotConfig, geometry::RouteSample, validation::validate_route_plot,
        };
        use crate::{
            model::scene::{validate_scene_presentation, ScenePresentationConfig},
            render::pixels::read_surface_rgba,
        };
        let manifest: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../assets/standard-widgets.json"
        )))
        .unwrap();
        let defaults = manifest["definitions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["type"] == "course")
            .unwrap()["defaults"]
            .clone();
        let mut raw: CoursePlotConfig = serde_json::from_value(defaults).unwrap();
        raw.width = 200.0;
        raw.height = 100.0;
        raw.completed_line_width = 8.0;
        raw.remaining_line_width = 8.0;
        raw.completed_line_opacity = 100.0;
        raw.remaining_line_opacity = 35.0;
        let config = validate_route_plot(&raw, 0).unwrap();
        let scene: ScenePresentationConfig = serde_json::from_value(serde_json::json!({
            "width": 200, "height": 100, "scale": 1, "opacity": 1, "shadow_strength": 0,
            "shadow_distance": 0, "shadow_color": "#000000", "border_thickness": 0, "border_color": "#000000"
        })).unwrap();
        let scene = validate_scene_presentation(scene).unwrap();
        // Collinear geometry reduces to endpoints, but the middle speed peak
        // must remain red. Missing speed must retain the solid white colour.
        let geometry = RouteGeometry::new(
            &config,
            &[
                RouteSample {
                    point: (0.0, 0.0),
                    progress01: 0.0,
                },
                RouteSample {
                    point: (1.0, 0.0),
                    progress01: 1.0,
                },
            ],
        )
        .unwrap();
        let profile = SpeedProfile {
            points: vec![
                (0.0, Some(0.0)),
                (0.4, Some(60.0)),
                (0.6, Some(0.0)),
                (0.8, None),
                (1.0, None),
            ],
            maximum_kmh: 60.0,
        };
        let mut palette = self::config();
        palette.stops.insert(
            1,
            GradientStop {
                offset: 0.5,
                color: "#00ff00".into(),
            },
        );
        let route = SpeedRoute::new(
            &Arc::new(geometry),
            &palette,
            &profile,
            &config,
            &scene,
            1.0,
        )
        .unwrap();
        let geometry = &route.geometry;
        let render = |progress, completed| {
            let mut surface = skia_safe::surfaces::raster_n32_premul((200, 100)).unwrap();
            surface.canvas().clear(skia_safe::Color::TRANSPARENT);
            route.draw(surface.canvas(), progress, completed);
            let mut pixels = vec![0; 200 * 100 * 4];
            read_surface_rgba(&mut surface, &mut pixels).unwrap();
            pixels
        };
        let pixel = |pixels: &[u8], progress| {
            let state = geometry.state(progress);
            let i = (state.marker_y.round() as usize * 200 + state.marker_x.round() as usize) * 4;
            pixels[i..i + 4].to_vec()
        };
        let pixels = render(1.0, true);
        let slow = pixel(&pixels, 0.01);
        let peak = pixel(&pixels, 0.4);
        let missing = pixel(&pixels, 0.9);
        assert!(slow[2] > 230 && slow[0] < 25, "{slow:?}");
        assert!(peak[0] > 230 && peak[2] < 25, "{peak:?}");
        assert_eq!(missing, vec![255, 255, 255, 255]);
        let middle = pixel(&pixels, 0.2);
        assert!(
            middle[1] > 230 && middle[0] < 25 && middle[2] < 25,
            "palette stop: {middle:?}"
        );
        assert_eq!(pixel(&render(0.2, true), 0.4)[3], 0);
        let alpha = pixel(&render(1.0, false), 0.2)[3];
        assert!((85..=95).contains(&alpha), "{alpha}");
        // Joins retain the same opacity as segment interiors.
        let alpha = pixel(&render(1.0, false), 0.4)[3];
        assert!((85..=95).contains(&alpha), "join alpha: {alpha}");
        // Dense samples on a curved route must form one continuous stroke,
        // including the opaque interior at every geometric/sample boundary.
        let samples = (0..40)
            .map(|i| {
                let t = i as f64 / 39.0;
                RouteSample {
                    point: (t, (t * std::f64::consts::PI * 2.0).sin() * 0.25),
                    progress01: t as f32,
                }
            })
            .collect::<Vec<_>>();
        let curve = Arc::new(RouteGeometry::new(&config, &samples).unwrap());
        let dense = SpeedProfile {
            points: (0..200).map(|i| (i as f32 / 199.0, Some(10.0))).collect(),
            maximum_kmh: 10.0,
        };
        let dense_route = SpeedRoute::new(&curve, &palette, &dense, &config, &scene, 1.0).unwrap();
        let mut surface = skia_safe::surfaces::raster_n32_premul((200, 100)).unwrap();
        surface.canvas().clear(skia_safe::Color::TRANSPARENT);
        dense_route.draw(surface.canvas(), 1.0, true);
        let mut colored = vec![0; 200 * 100 * 4];
        read_surface_rgba(&mut surface, &mut colored).unwrap();
        surface.canvas().clear(skia_safe::Color::TRANSPARENT);
        surface.canvas().draw_path(
            &curve.path.lock().unwrap(),
            &stroke_paint("#ffffff", 8.0, 1.0),
        );
        let mut solid = vec![0; colored.len()];
        read_surface_rgba(&mut surface, &mut solid).unwrap();
        for (solid, colored) in solid.chunks_exact(4).zip(colored.chunks_exact(4)) {
            if solid[3] == 255 {
                assert!(colored[3] >= 250, "interior crack: {colored:?}");
            }
        }
        let mut legacy = serde_json::to_value(raw).unwrap();
        legacy.as_object_mut().unwrap().remove("speed_coloring");
        let legacy: CoursePlotConfig = serde_json::from_value(legacy).unwrap();
        assert!(validate_route_plot(&legacy, 0)
            .unwrap()
            .speed_coloring
            .is_none());
    }
}
