/**
 * Supports widget editing flows related to route map widget editor.
 */

import { useMemo, useState } from 'react'
import useStore from '@/store/useStore'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import GradientPicker from '@/components/ui/gradient-picker'
import { Palette } from 'lucide-react'
import { SectionHeading } from '@/components/ui/section-heading'
import { ColorField, NumberField, SelectField, TextField, SliderField, ToggleField } from './widgetFormControls'
import { DimensionsSection } from './widgetEditorSections'
import PlotMarkerSection from './PlotMarkerSection'
import { getThemeColor } from '@/lib/color-utils'
import { Label } from '@/components/ui/label'
import { useTranslation } from 'react-i18next'
import { ROUTE_SPEED_UNITS, routeSpeedUnit, isRoutePace, formatRouteSpeed, parseRouteSpeed } from '../utils/routeSpeedUnits'
import { normalizeRotation } from '@/features/wasm-widgets/utils/widgetGestureGeometry'

function RouteSpeedField({ value, unit, min, max, ...props }) {
  const displayValue = formatRouteSpeed(value, unit)
  return isRoutePace(unit) ? (
    <TextField {...props} value={displayValue} placeholder="m:ss" />
  ) : (
    <NumberField
      {...props}
      value={displayValue}
      min={formatRouteSpeed(min, unit)}
      max={max === null || max === undefined ? undefined : formatRouteSpeed(max, unit)}
      step={0.1}
      integerDisplay={false}
    />
  )
}

/**
 * Renders the route map widget editor component.
 *
 * @param {object} props - Component props.
 * @param {*} props.widget - Widget definition being rendered or edited.
 * @param {*} props.updateWidgetData - Value for update widget data.
 * @param {*} props.setNumericField - Value for set numeric field.
 * @returns {JSX.Element} Rendered component output.
 */
export default function RouteMapWidgetEditor({ widget, updateWidgetData, updateWidgetDraft, commitWidgetDraft, setNumericField }) {
  const { t } = useTranslation()
  const [speedRangeError, setSpeedRangeError] = useState(null)
  const speedColoring = widget.data.speed_coloring
  const unit = routeSpeedUnit(speedColoring.unit)
  const pace = isRoutePace(unit.value)
  const speedSeries = useStore((state) => state.parsedActivity?.speed)
  const activityMaximum = useMemo(() => {
    const valid = (speedSeries ?? []).filter((speed) => Number.isFinite(speed) && speed >= 0)
    return valid.length ? Number(valid.reduce((maximum, speed) => Math.max(maximum, speed), 0).toPrecision(12)) : null
  }, [speedSeries])
  const custom = speedColoring.mode === 'custom'
  const maximum = speedColoring.max_speed_mps ?? activityMaximum
  const span = maximum === null ? 0 : maximum - speedColoring.min_speed_mps
  const updateSpeedColoring = (patch) =>
    updateWidgetData(widget.id, {
      speed_coloring: { ...speedColoring, ...patch },
    })
  const updateSpeedBound = (key, raw) => {
    if (raw === '') {
      setSpeedRangeError(t('widget-editor.routeSpeedRequired', 'Enter a value.'))
      return
    }
    const value = parseRouteSpeed(raw, unit.value)
    if (value === null) {
      setSpeedRangeError(
        pace
          ? t('widget-editor.routeSpeedInvalidPace', 'Enter a pace as m:ss or ∞.')
          : t('widget-editor.routeSpeedInvalidValue', 'Enter a valid non-negative speed.'),
      )
      return
    }
    const next = { ...speedColoring, max_speed_mps: maximum, [key]: value }
    if (next.max_speed_mps !== null && next.max_speed_mps <= next.min_speed_mps) {
      setSpeedRangeError(
        pace
          ? t('widget-editor.routeSpeedInvalidPaceRange', 'Fast pace must be faster than slow pace.')
          : t('widget-editor.routeSpeedInvalidRange', 'Maximum speed must be greater than minimum speed.'),
      )
      return
    }
    setSpeedRangeError(null)
    updateSpeedColoring({ max_speed_mps: maximum, [key]: value })
  }
  const changeMode = (mode) => {
    if (!mode) return
    setSpeedRangeError(null)
    const patch = { mode }
    if (mode === 'custom' && speedColoring.max_speed_mps === null && activityMaximum > speedColoring.min_speed_mps) {
      patch.max_speed_mps = activityMaximum
    }
    updateSpeedColoring(patch)
  }
  const changeThreshold = (index, raw) => {
    const speed = parseRouteSpeed(raw, unit.value)
    const offset = speed === null ? NaN : (speed - speedColoring.min_speed_mps) / span
    if (
      raw === '' ||
      !Number.isFinite(offset) ||
      offset < 0 ||
      offset > 1 ||
      speedColoring.stops.some((stop, i) => i !== index && Math.abs(stop.offset - offset) < 1e-6)
    ) {
      setSpeedRangeError(t('widget-editor.routeSpeedInvalidThreshold', 'Choose a distinct threshold within the range.'))
      return
    }
    setSpeedRangeError(null)
    const stops = speedColoring.stops.map((stop, i) => (i === index ? { ...stop, offset } : stop)).sort((a, b) => a.offset - b.offset)
    updateSpeedColoring({ stops, max_speed_mps: maximum })
  }
  const lineWidth = widget.data.completed_line_width ?? widget.data.remaining_line_width
  const completedLineOpacity = widget.data.completed_line_opacity
  const remainingLineOpacity = widget.data.remaining_line_opacity
  const rotation = normalizeRotation(widget.data.rotation)
  const simplifyTolerance = widget.data.simplify_tolerance_px
  const targetDensity = widget.data.target_density

  return (
    <>
      <DimensionsSection widget={widget} setNumericField={setNumericField} />

      <SliderField
        editable
        label={t('widget-editor.mapRotation', 'Map Rotation')}
        value={rotation}
        min={0}
        max={360}
        step={1}
        integerDisplay
        suffix="°"
        onSliderChange={(rawValue) => updateWidgetDraft(widget.id, { rotation: rawValue })}
        onSliderCommit={() => commitWidgetDraft(widget.id)}
      />

      <div className="space-y-4">
        <SectionHeading icon={Palette} title={t('widget-editor.lineStyling', 'Line Styling')} />
        <SliderField
          editable
          label={t('widget-editor.thickness', 'Thickness')}
          value={lineWidth}
          min={0}
          max={20}
          step={1}
          integerDisplay
          valueDisplay={`${lineWidth}`}
          suffix="px"
          onSliderChange={(value) =>
            updateWidgetDraft(widget.id, {
              completed_line_width: value,
              remaining_line_width: value,
            })
          }
          onSliderCommit={() => commitWidgetDraft(widget.id)}
        />
        <div className="grid grid-cols-2 gap-4">
          <SliderField
            editable
            label={t('widget-editor.smoothing', 'Smoothing')}
            value={simplifyTolerance}
            min={0}
            max={4}
            step={0.05}
            valueDisplay={`${simplifyTolerance.toFixed(2)}`}
            suffix="px"
            onSliderChange={(value) =>
              updateWidgetDraft(widget.id, {
                simplify_tolerance_px: Number(value.toFixed(2)),
              })
            }
            onSliderCommit={() => commitWidgetDraft(widget.id)}
          />
          <SliderField
            editable
            label={t('widget-editor.routeDetail', 'Route Detail')}
            value={targetDensity}
            min={0.25}
            max={1.5}
            step={0.05}
            valueDisplay={`${targetDensity.toFixed(2)}`}
            suffix="x"
            onSliderChange={(value) =>
              updateWidgetDraft(widget.id, {
                target_density: Number(value.toFixed(2)),
              })
            }
            onSliderCommit={() => commitWidgetDraft(widget.id)}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs text-muted-foreground">{t('widget-editor.routeSpeedColoring', 'Color Route by Speed')}</Label>
          <ToggleField
            label={t('widget-editor.routeSpeedColoring', 'Color Route by Speed')}
            checked={speedColoring.enabled}
            onCheckedChange={(enabled) => {
              setSpeedRangeError(null)
              updateSpeedColoring({ enabled })
            }}
          />
        </div>
        {speedColoring.enabled ? (
          <div className="space-y-4">
            <ToggleGroup
              type="single"
              value={speedColoring.mode}
              onValueChange={changeMode}
              aria-label={t('widget-editor.routeSpeedMode', 'Speed Color Mode')}
              className="w-full"
            >
              <ToggleGroupItem value="auto" className="h-7 w-full px-3 text-xs">
                {t('widget-editor.routeSpeedAuto', 'Auto')}
              </ToggleGroupItem>
              <ToggleGroupItem value="custom" className="h-7 w-full px-3 text-xs">
                {t('widget-editor.routeSpeedCustom', 'Custom')}
              </ToggleGroupItem>
            </ToggleGroup>
            {custom ? (
              <>
                <SelectField
                  label={t('widget-editor.units', 'Units')}
                  value={unit.value}
                  options={ROUTE_SPEED_UNITS}
                  onValueChange={(unit) => {
                    setSpeedRangeError(null)
                    updateSpeedColoring({ unit })
                  }}
                />
                <div className="grid grid-cols-2 gap-4" onBlurCapture={() => setSpeedRangeError(null)}>
                  <RouteSpeedField
                    label={
                      pace
                        ? t('widget-editor.routeSpeedSlowPace', 'Slow pace ({{unit}})', { unit: unit.label })
                        : t('widget-editor.routeSpeedMinimum', 'Minimum speed ({{unit}})', { unit: unit.label })
                    }
                    value={speedColoring.min_speed_mps}
                    unit={unit.value}
                    min={0}
                    step={0.1}
                    integerDisplay={false}
                    onChange={(raw) => updateSpeedBound('min_speed_mps', raw)}
                  />
                  <RouteSpeedField
                    label={
                      pace
                        ? t('widget-editor.routeSpeedFastPace', 'Fast pace ({{unit}})', { unit: unit.label })
                        : t('widget-editor.routeSpeedMaximum', 'Maximum speed ({{unit}})', { unit: unit.label })
                    }
                    value={maximum}
                    unit={unit.value}
                    min={speedColoring.min_speed_mps}
                    step={0.1}
                    integerDisplay={false}
                    placeholder={t('widget-editor.routeSpeedMaximumPlaceholder', 'Maximum speed')}
                    onChange={(raw) => updateSpeedBound('max_speed_mps', raw)}
                  />
                </div>
                {speedRangeError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {speedRangeError}
                  </p>
                ) : null}
                <GradientPicker
                  label={t('widget-editor.routeSpeedPalette', 'Speed Colors: Slow to Fast')}
                  stops={speedColoring.stops}
                  onChange={(stops) => updateWidgetDraft(widget.id, { speed_coloring: { ...speedColoring, stops } })}
                  onCommit={() => commitWidgetDraft(widget.id)}
                />
                <div className="grid grid-cols-2 gap-4">
                  {speedColoring.stops.map((stop, index) => (
                    <RouteSpeedField
                      key={index}
                      unit={unit.value}
                      label={t('widget-editor.routeSpeedThreshold', 'Color {{number}} threshold ({{unit}})', { number: index + 1, unit: unit.label })}
                      value={span > 0 ? speedColoring.min_speed_mps + stop.offset * span : null}
                      min={speedColoring.min_speed_mps}
                      max={maximum ?? undefined}
                      step={0.1}
                      integerDisplay={false}
                      disabled={span <= 0}
                      onChange={(raw) => changeThreshold(index, raw)}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
        {!speedColoring.enabled ? (
          <div className="grid grid-cols-2 gap-4">
            <ColorField
              label={t('widget-editor.finishedColor', 'Finished Color')}
              value={widget.data.completed_line_color || getThemeColor('ice')}
              onChange={(value) =>
                updateWidgetData(widget.id, {
                  completed_line_color: value,
                  color: value,
                })
              }
            />
            <ColorField
              label={t('widget-editor.remainingColor', 'Remaining Color')}
              value={widget.data.remaining_line_color || getThemeColor('teal')}
              onChange={(value) => updateWidgetData(widget.id, { remaining_line_color: value })}
            />
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-4">
          <SliderField
            editable
            label={t('widget-editor.finishedOpacity', 'Finished Opacity')}
            value={completedLineOpacity}
            min={0}
            max={100}
            step={1}
            valueDisplay={`${completedLineOpacity}`}
            suffix="%"
            onSliderChange={(value) => updateWidgetDraft(widget.id, { completed_line_opacity: value })}
            onSliderCommit={() => commitWidgetDraft(widget.id)}
          />
          <SliderField
            editable
            label={t('widget-editor.remainingOpacity', 'Remaining Opacity')}
            value={remainingLineOpacity}
            min={0}
            max={100}
            step={1}
            valueDisplay={`${remainingLineOpacity}`}
            suffix="%"
            onSliderChange={(value) => updateWidgetDraft(widget.id, { remaining_line_opacity: value })}
            onSliderCommit={() => commitWidgetDraft(widget.id)}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex items-center justify-between gap-2 pl-1 pt-2 pb-2">
            <Label className="p-0 text-[0.667rem] text-muted-foreground uppercase font-bold">
              {t('widget-editor.showFullActivity', 'Show Full Activity')}
            </Label>
            <ToggleField
              checked={widget.data.show_full_activity}
              onCheckedChange={(checked) => updateWidgetData(widget.id, { show_full_activity: checked })}
            />
          </div>
        </div>
      </div>
      <PlotMarkerSection
        widget={widget}
        updateWidgetData={updateWidgetData}
        updateWidgetDraft={updateWidgetDraft}
        commitWidgetDraft={commitWidgetDraft}
      />
    </>
  )
}
