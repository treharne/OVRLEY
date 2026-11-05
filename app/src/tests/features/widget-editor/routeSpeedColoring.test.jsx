import { beforeAll, describe, expect, test, vi } from 'vite-plus/test'
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import i18next from '@/i18n'
import RouteMapWidgetEditor from '@/features/widget-editor/components/RouteMapWidgetEditor'
import { createWidgetDefaults } from '@/lib/widget/widget-defaults'
import { DEFAULT_GLOBAL_DEFAULTS } from '@/lib/template/template-constants'
import { createDurableEditorState, createEditorEffectiveConfig } from '@/lib/template/template-state'

beforeAll(async () => {
  await i18next.changeLanguage('en')
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})
const defaults = () => createWidgetDefaults({ type: 'course' }, DEFAULT_GLOBAL_DEFAULTS)

describe('route speed colouring', () => {
  test('older templates get a disabled palette; configured bounds and stops survive save/load', () => {
    const legacy = defaults()
    delete legacy.speed_coloring
    const durable = createDurableEditorState({ config: { scene: {}, rasters: [], plots: [legacy] }, globalDefaults: DEFAULT_GLOBAL_DEFAULTS })
    expect(durable.config.plots[0].speed_coloring).toMatchObject({ enabled: false, min_speed_kmh: 0, max_speed_kmh: null })
    const settings = {
      enabled: true,
      min_speed_kmh: 2,
      max_speed_kmh: 42,
      stops: [
        { offset: 0, color: '#112233' },
        { offset: 1, color: '#abcdef' },
      ],
    }
    durable.config.plots[0].speed_coloring = settings
    const loaded = createDurableEditorState({ config: JSON.parse(JSON.stringify(durable.config)), globalDefaults: durable.globalDefaults })
    const effective = createEditorEffectiveConfig({ config: loaded.config, globalDefaults: loaded.globalDefaults, language: 'en' })
    expect(effective.plots[0].speed_coloring).toEqual(settings)
  })

  test('the editor toggles speed colouring and edits an optional maximum and palette', () => {
    cleanup()
    const data = defaults()
    const updateWidgetData = vi.fn()
    const props = {
      widget: { id: 'route', type: 'course', data },
      updateWidgetData,
      updateWidgetDraft: vi.fn(),
      commitWidgetDraft: vi.fn(),
      setNumericField: vi.fn(),
    }
    const view = render(<RouteMapWidgetEditor {...props} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Colour route by speed' }))
    expect(updateWidgetData).toHaveBeenLastCalledWith('route', { speed_coloring: { ...data.speed_coloring, enabled: true } })
    data.speed_coloring = { ...data.speed_coloring, enabled: true }
    view.rerender(<RouteMapWidgetEditor {...props} />)
    expect(screen.getByRole('group', { name: 'Gradient stops' })).toBeTruthy()
    const maximum = screen.getByPlaceholderText('Activity maximum')
    updateWidgetData.mockClear()
    fireEvent.change(maximum, { target: { value: '0' } })
    fireEvent.blur(maximum)
    expect(screen.getByRole('alert').textContent).toContain('greater than minimum')
    expect(updateWidgetData).not.toHaveBeenCalled()
    fireEvent.change(maximum, { target: { value: '' } })
    fireEvent.blur(maximum)
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(maximum, { target: { value: '45' } })
    fireEvent.blur(maximum)
    expect(updateWidgetData).toHaveBeenLastCalledWith('route', { speed_coloring: { ...data.speed_coloring, max_speed_kmh: 45 } })
    data.speed_coloring = { ...data.speed_coloring, max_speed_kmh: 45 }
    view.rerender(<RouteMapWidgetEditor {...props} />)
    fireEvent.change(maximum, { target: { value: '' } })
    fireEvent.blur(maximum)
    expect(updateWidgetData).toHaveBeenLastCalledWith('route', { speed_coloring: { ...data.speed_coloring, max_speed_kmh: null } })
    cleanup()
  })
})
