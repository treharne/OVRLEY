//! Original-density course/progress indices; window extraction runs only on preparation.
use super::geometry::RouteSample;
use crate::{
    error::{WidgetError, WidgetResult},
    interpolation::interpolate_points,
    model::scene::ScenePresentationConfig,
};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RouteWindow {
    pub start: f64,
    pub end: f64,
}

impl RouteWindow {
    pub fn from_scene(
        scene: &ScenePresentationConfig,
        show_full_activity: bool,
    ) -> WidgetResult<Option<Self>> {
        // Preview timing is host-supplied, using the native scene's canonical range flag.
        let active = scene
            .extra
            .get("custom_export_range_active")
            .map(|value| {
                value.as_bool().ok_or_else(|| {
                    WidgetError::Config("custom_export_range_active must be boolean".into())
                })
            })
            .transpose()?
            .unwrap_or(false);
        if show_full_activity || !active {
            return Ok(None);
        }
        let read = |field| {
            scene
                .extra
                .get(field)
                .and_then(serde_json::Value::as_f64)
                .filter(|value| value.is_finite())
                .ok_or_else(|| WidgetError::Config(format!("{field}: required finite second")))
        };
        let start = read("start")?;
        let end = read("end")?;
        if start < 0.0 || end <= start {
            return Err(WidgetError::Config("invalid route export window".into()));
        }
        Ok(Some(Self { start, end }))
    }
}

pub struct RouteActivity {
    times: Vec<f64>,
    course: Vec<(Option<f64>, Option<f64>)>,
    latitude: Vec<(f64, f64)>,
    longitude: Vec<(f64, f64)>,
    progress: Vec<(f64, f64)>,
    full: Arc<Vec<RouteSample>>,
    speed: Vec<Option<f64>>,
    pub end: f64,
}

impl RouteActivity {
    pub fn new(
        times: &[f64],
        course: &[(Option<f64>, Option<f64>)],
        progress: &[f64],
        end: f64,
    ) -> Self {
        let full = Arc::new(project_course_samples(course, progress));
        let column = |component: usize| {
            times
                .iter()
                .copied()
                .zip(course)
                .filter_map(|(time, p)| {
                    let value = if component == 0 { p.0 } else { p.1 };
                    value.filter(|v| v.is_finite()).map(|value| (time, value))
                })
                .collect()
        };
        Self {
            speed: Vec::new(),
            times: times.to_vec(),
            course: course.to_vec(),
            end,
            full,
            latitude: column(0),
            longitude: column(1),
            progress: times
                .iter()
                .copied()
                .zip(progress.iter().copied())
                .filter(|p| p.1.is_finite())
                .collect(),
        }
    }

    /// Canonical speeds are metres/second, aligned with the activity timestamps.
    pub fn with_speeds(mut self, speed: &[Option<f64>]) -> Self {
        self.speed = speed.iter().map(|value| value.filter(|v| v.is_finite() && *v >= 0.0)).collect();
        self
    }

    /// Retain telemetry density independently of geometric simplification. The
    /// maximum always uses the full activity, even for a cropped route window.
    pub fn speed_profile(&self, window: Option<RouteWindow>) -> super::speed::SpeedProfile {
        let mut points: Vec<(f32, Option<f64>)> = Vec::new();
        for (index, time) in self.times.iter().enumerate() {
            let progress = if let Some(window) = window {
                let start = self.progress_at(window.start, None) as f64;
                let end = self.progress_at(window.end, None) as f64;
                if end > start {
                    ((self.progress_at(*time, None) as f64 - start) / (end - start)) as f32
                } else {
                    ((*time - window.start) / (window.end - window.start)) as f32
                }
            } else {
                self.progress_at(*time, None)
            };
            let speed = self.speed.get(index).copied().flatten();
            // Stationary samples share progress: retain the last observation at
            // that location, without introducing zero-length paint segments.
            if let Some(last) = points.last_mut().filter(|last| last.0 == progress) {
                *last = (progress, speed);
            } else {
                points.push((progress, speed));
            }
        }
        super::speed::SpeedProfile {
            points,
            maximum_mps: self.speed.iter().flatten().copied().fold(0.0, f64::max),
        }
    }

    pub fn samples(&self, window: Option<RouteWindow>) -> Arc<Vec<RouteSample>> {
        let Some(window) = window else {
            return self.full.clone();
        };
        let start = self.times.partition_point(|value| *value <= window.start);
        let end = self
            .times
            .partition_point(|value| *value < window.end)
            .max(start);
        let coordinate = |points: &[(f64, f64)], second| {
            points
                .first()
                .zip(points.last())
                .filter(|(a, b)| second >= a.0 && second <= b.0)
                .and_then(|_| interpolate_points(points, second))
        };
        let boundary = |second| {
            (
                coordinate(&self.latitude, second),
                coordinate(&self.longitude, second),
            )
        };
        let mut course = Vec::with_capacity(end - start + 2);
        let mut progress = Vec::with_capacity(end - start + 2);
        course.push(boundary(window.start));
        progress.push(interpolate_points(&self.progress, window.start));
        for index in start..end {
            course.push(self.course.get(index).copied().unwrap_or((None, None)));
            progress.push(interpolate_points(&self.progress, self.times[index]));
        }
        course.push(boundary(window.end));
        progress.push(interpolate_points(&self.progress, window.end));
        let first = progress.iter().find_map(|value| *value);
        let last = progress.iter().rev().find_map(|value| *value);
        let span = first.zip(last).filter(|(a, b)| b > a);
        let normalized = progress
            .iter()
            .enumerate()
            .map(|(index, value)| {
                span.and_then(|(a, b)| value.map(|v| ((v - a) / (b - a)).clamp(0.0, 1.0)))
                    .unwrap_or(index as f64 / (progress.len() - 1) as f64)
            })
            .collect::<Vec<_>>();
        Arc::new(project_course_samples(&course, &normalized))
    }

    pub fn progress_at(&self, second: f64, window: Option<RouteWindow>) -> f32 {
        let absolute = interpolate_points(&self.progress, second)
            .unwrap_or_else(|| (second / self.end.max(1e-9)).clamp(0.0, 1.0));
        if let Some(window) = window {
            if let Some((start, end)) = interpolate_points(&self.progress, window.start)
                .zip(interpolate_points(&self.progress, window.end))
                .filter(|(a, b)| b > a)
            {
                return ((absolute - start) / (end - start)).clamp(0.0, 1.0) as f32;
            }
            return ((second - window.start) / (window.end - window.start)).clamp(0.0, 1.0) as f32;
        }
        absolute.clamp(0.0, 1.0) as f32
    }
}

/// Native and preview share equirectangular projection and missing-GPS handling.
pub fn project_course_samples(
    course: &[(Option<f64>, Option<f64>)],
    progress: &[f64],
) -> Vec<RouteSample> {
    let valid = course
        .iter()
        .enumerate()
        .filter_map(|(index, (lat, lon))| {
            lat.zip(*lon)
                .filter(|(lat, lon)| lat.is_finite() && lon.is_finite())
                .map(|(lat, lon)| (index, lat, lon))
        })
        .collect::<Vec<_>>();
    if valid.is_empty() {
        return Vec::new();
    }
    let latitude = valid.iter().map(|p| p.1).sum::<f64>() / valid.len() as f64;
    valid
        .into_iter()
        .map(|(index, lat, lon)| RouteSample {
            point: (lon * latitude.to_radians().cos(), lat),
            progress01: progress
                .get(index)
                .copied()
                .filter(|v| v.is_finite())
                .unwrap_or_else(|| index as f64 / course.len().saturating_sub(1).max(1) as f64)
                .clamp(0.0, 1.0) as f32,
        })
        .collect()
}
