import { describe, expect, test } from 'vite-plus/test'
import { ROUTE_SPEED_UNITS, routeSpeedToDisplay, formatRouteSpeed, parseRouteSpeed } from '@/features/widget-editor/utils/routeSpeedUnits'

describe('route speed display units', () => {
  test('offers existing speed and pace units', () => {
    expect(ROUTE_SPEED_UNITS.map((u) => u.value)).toEqual(['kmh', 'mph', 'kn', 'mps', 'min_per_km', 'min_per_mi'])
  })
  test.each([
    ['kmh', 36],
    ['mph', 22.3694],
    ['kn', 19.43844],
    ['mps', 10],
  ])('matches gauge conversions for %s', (unit, value) => {
    expect(routeSpeedToDisplay(10, unit)).toBeCloseTo(value, 6)
    expect(parseRouteSpeed(String(value), unit)).toBeCloseTo(10, 6)
  })
  test('pace reverses speed, supports miles, and represents stopped as infinity', () => {
    expect(formatRouteSpeed(10 / 3.6, 'min_per_km')).toBe('6:00')
    expect(formatRouteSpeed(15 / 3.6, 'min_per_km')).toBe('4:00')
    expect(parseRouteSpeed('6:00', 'min_per_km')).toBeCloseTo(10 / 3.6)
    expect(parseRouteSpeed('6:00', 'min_per_mi')).toBeCloseTo(16.09344 / 3.6)
    expect(formatRouteSpeed(0, 'min_per_km')).toBe('∞')
    expect(parseRouteSpeed('∞', 'min_per_km')).toBe(0)
    for (const value of ['', '0:00', '5:60', '5foo', '-5:00']) expect(parseRouteSpeed(value, 'min_per_km')).toBeNull()
  })
})
