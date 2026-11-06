import { afterEach, beforeAll, describe, expect, test, vi } from 'vite-plus/test'
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import i18next from '@/i18n'
import useStore from '@/store/useStore'
import RouteMapWidgetEditor from '@/features/widget-editor/components/RouteMapWidgetEditor'
import { createWidgetDefaults } from '@/lib/widget/widget-defaults'
import { DEFAULT_GLOBAL_DEFAULTS } from '@/lib/template/template-constants'
import { createDurableEditorState, createEditorEffectiveConfig } from '@/lib/template/template-state'

beforeAll(async () => {
  await i18next.changeLanguage('en')
  HTMLElement.prototype.scrollIntoView = vi.fn()
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
afterEach(() => {
  cleanup()
  useStore.setState({ parsedActivity: null })
})
const defaults = () => createWidgetDefaults({ type: 'course' }, DEFAULT_GLOBAL_DEFAULTS)
const propsFor = (data) => ({
  widget: { id: 'route', type: 'course', data },
  updateWidgetData: vi.fn(),
  updateWidgetDraft: vi.fn(),
  commitWidgetDraft: vi.fn(),
  setNumericField: vi.fn(),
})

describe('route speed coloring', () => {
  test('new templates default to Auto, legacy settings stay Custom, and modes survive save/load', () => {
    const data = defaults()
    expect(data.speed_coloring.mode).toBe('auto')
    delete data.speed_coloring
    let state = createDurableEditorState({ config: { scene: {}, rasters: [], plots: [data] }, globalDefaults: DEFAULT_GLOBAL_DEFAULTS })
    expect(state.config.plots[0].speed_coloring).toMatchObject({ enabled: false, mode: 'auto', min_speed_mps: 0, max_speed_mps: null })
    const legacyDefaults = defaults()
    delete legacyDefaults.speed_coloring.mode
    const migrated = createDurableEditorState({
      config: { scene: {}, rasters: [], plots: [legacyDefaults] },
      globalDefaults: DEFAULT_GLOBAL_DEFAULTS,
    })
    expect(migrated.config.plots[0].speed_coloring.mode).toBe('auto')
    const settings = {
      enabled: true,
      min_speed_mps: 2 / 3.6,
      max_speed_mps: 42 / 3.6,
      unit: 'kn',
      stops: [
        { offset: 0, color: '#112233' },
        { offset: 1, color: '#abcdef' },
      ],
    }
    state.config.plots[0].speed_coloring = settings
    state = createDurableEditorState({ config: state.config, globalDefaults: state.globalDefaults })
    expect(state.config.plots[0].speed_coloring).toEqual({ ...settings, mode: 'custom' })
    for (const mode of ['auto', 'custom']) {
      state.config.plots[0].speed_coloring.mode = mode
      const loaded = createDurableEditorState({ config: JSON.parse(JSON.stringify(state.config)), globalDefaults: state.globalDefaults })
      const effective = createEditorEffectiveConfig({ config: loaded.config, globalDefaults: loaded.globalDefaults, language: 'en' })
      expect(effective.plots[0].speed_coloring).toEqual({ ...settings, mode })
    }
  })

  test('rejects earlier km/h templates with explicit migration instructions', () => {
    const data = defaults()
    data.speed_coloring = { enabled: true, min_speed_kmh: 0, max_speed_kmh: 36, stops: data.speed_coloring.stops }
    expect(() => createDurableEditorState({ config: { scene: {}, plots: [data] }, globalDefaults: DEFAULT_GLOBAL_DEFAULTS })).toThrow(
      'migrate-route-speed-template.mjs',
    )
  })

  test('rejects malformed saved units instead of silently changing them', () => {
    for (const unit of ['kph', '', null, 12]) {
      const data = defaults()
      data.speed_coloring.unit = unit
      expect(() => createDurableEditorState({ config: { scene: {}, plots: [data] }, globalDefaults: DEFAULT_GLOBAL_DEFAULTS })).toThrow(
        'Unsupported route speed unit',
      )
    }
  })

  test('Auto is compact; Custom exposes the range and palette and preserves them across mode changes', () => {
    useStore.setState({ parsedActivity: { speed: [null, 0, 10, 20] } })
    const data = defaults(),
      props = propsFor(data)
    const view = render(<RouteMapWidgetEditor {...props} />)
    expect(screen.getByText('Finished Color')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Color Route by Speed' }))
    expect(props.updateWidgetData).toHaveBeenLastCalledWith('route', { speed_coloring: { ...data.speed_coloring, enabled: true } })
    data.speed_coloring.enabled = true
    view.rerender(<RouteMapWidgetEditor {...props} />)
    expect(screen.queryByText('Finished Color')).toBeNull()
    expect(screen.queryByText('Remaining Color')).toBeNull()
    expect(screen.queryByText('Minimum speed (km/h)')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Gradient stops' })).toBeNull()
    expect(screen.queryByText(/leave maximum|missing speed|colour/i)).toBeNull()
    expect(screen.getByText('Finished Opacity')).toBeTruthy()
    fireEvent.click(screen.getByText('Custom', { exact: true }))
    expect(props.updateWidgetData).toHaveBeenLastCalledWith('route', {
      speed_coloring: { ...data.speed_coloring, mode: 'custom', max_speed_mps: 20 },
    })
    data.speed_coloring = { ...data.speed_coloring, mode: 'custom', max_speed_mps: 20 }
    view.rerender(<RouteMapWidgetEditor {...props} />)
    expect(screen.getByRole('group', { name: 'Gradient stops' })).toBeTruthy()
    const maximum = screen.getByPlaceholderText('Maximum speed')
    props.updateWidgetData.mockClear()
    fireEvent.change(maximum, { target: { value: '0' } })
    fireEvent.blur(maximum)
    expect(screen.getByRole('alert').textContent).toContain('greater than minimum')
    expect(props.updateWidgetData).not.toHaveBeenCalled()
    fireEvent.change(maximum, { target: { value: '' } })
    fireEvent.blur(maximum)
    expect(screen.getByRole('alert').textContent).toContain('Enter a value')
    fireEvent.change(maximum, { target: { value: '45' } })
    fireEvent.blur(maximum)
    expect(props.updateWidgetData).toHaveBeenLastCalledWith('route', { speed_coloring: { ...data.speed_coloring, max_speed_mps: 45 / 3.6 } })
    data.speed_coloring = { ...data.speed_coloring, max_speed_mps: 45 / 3.6 }
    view.rerender(<RouteMapWidgetEditor {...props} />)
    fireEvent.click(screen.getByText('Auto', { exact: true }))
    expect(props.updateWidgetData).toHaveBeenLastCalledWith('route', { speed_coloring: { ...data.speed_coloring, mode: 'auto' } })
    data.speed_coloring = { ...data.speed_coloring, mode: 'auto' }
    view.rerender(<RouteMapWidgetEditor {...props} />)
    expect(screen.queryByPlaceholderText('Maximum speed')).toBeNull()
    expect(data.speed_coloring.max_speed_mps).toBe(12.5)
    data.speed_coloring.enabled = false
    view.rerender(<RouteMapWidgetEditor {...props} />)
    expect(screen.getByText('Finished Color')).toBeTruthy()
    expect(screen.getByText('Remaining Color')).toBeTruthy()
  })

  test('Custom edits exact color thresholds without accepting duplicates', () => {
    const data = defaults()
    data.speed_coloring = { ...data.speed_coloring, enabled: true, mode: 'custom', max_speed_mps: 60 / 3.6 }
    const props = propsFor(data)
    render(<RouteMapWidgetEditor {...props} />)
    const threshold = screen.getByDisplayValue('20')
    fireEvent.change(threshold, { target: { value: '15' } })
    fireEvent.blur(threshold)
    const settings = props.updateWidgetData.mock.calls.at(-1)[1].speed_coloring
    expect(settings.stops[1].offset).toBe(0.25)
    expect(settings.stops[1].color).toBe(data.speed_coloring.stops[1].color)
    props.updateWidgetData.mockClear()
    fireEvent.change(threshold, { target: { value: '0' } })
    fireEvent.blur(threshold)
    expect(props.updateWidgetData).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('distinct threshold')
  })
  test('pace bounds use slow/fast labels and edit canonical speeds', () => {
    const data = defaults()
    data.speed_coloring = {
      ...data.speed_coloring,
      enabled: true,
      mode: 'custom',
      unit: 'min_per_km',
      min_speed_mps: 10 / 3.6,
      max_speed_mps: 15 / 3.6,
    }
    const props = propsFor(data)
    render(<RouteMapWidgetEditor {...props} />)
    expect(screen.getByText('Slow pace (min/km)')).toBeTruthy()
    expect(screen.getByText('Fast pace (min/km)')).toBeTruthy()
    const slow = screen.getAllByDisplayValue('6:00')[0]
    fireEvent.change(slow, { target: { value: '7:30' } })
    fireEvent.blur(slow)
    expect(props.updateWidgetData.mock.calls.at(-1)[1].speed_coloring.min_speed_mps).toBeCloseTo(8 / 3.6)
    const fast = screen.getAllByDisplayValue('4:00')[0]
    fireEvent.change(fast, { target: { value: '8:00' } })
    fireEvent.blur(fast)
    expect(screen.getByRole('alert').textContent).toContain('Fast pace')
  })
  test('changing display units leaves the stored range and thresholds intact', async () => {
    const data = defaults()
    data.speed_coloring = { ...data.speed_coloring, enabled: true, mode: 'custom', min_speed_mps: 10 / 3.6, max_speed_mps: 30 / 3.6 }
    const props = propsFor(data)
    render(<RouteMapWidgetEditor {...props} />)
    const units = screen.getAllByRole('combobox').find((element) => element.textContent.includes('km/h'))
    fireEvent.keyDown(units, { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'kn', exact: true }))
    expect(props.updateWidgetData).toHaveBeenLastCalledWith('route', { speed_coloring: { ...data.speed_coloring, unit: 'kn' } })
  })
})
