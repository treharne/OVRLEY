import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateRouteSpeedTemplate } from './migrate-route-speed-template.mjs'

const template = (settings) => ({ format: 'ovrley-template', config: { plots: [{ speed_coloring: settings }] } })
test('converts only bounds, preserving display units, palette and original object', () => {
  const settings = { min_speed_kmh: 3.6, max_speed_kmh: 36, mode: 'custom', unit: 'kn', stops: [{ offset: 0, color: '#abcdef' }] }
  const source = template(settings)
  const result = migrateRouteSpeedTemplate(source).config.plots[0].speed_coloring
  assert.deepEqual(result, { mode: 'custom', unit: 'kn', stops: settings.stops, min_speed_mps: 1, max_speed_mps: 10 })
  assert.equal(source.config.plots[0].speed_coloring.min_speed_kmh, 3.6)
  assert.equal(migrateRouteSpeedTemplate(template({ ...settings, max_speed_kmh: null })).config.plots[0].speed_coloring.max_speed_mps, null)
})
test('rejects invalid or ambiguous bounds and leaves current templates unchanged', () => {
  assert.throws(() => migrateRouteSpeedTemplate(template({ min_speed_kmh: 0, max_speed_kmh: 20, min_speed_mps: 0 })), /Mixed/)
  assert.throws(() => migrateRouteSpeedTemplate(template({ min_speed_kmh: 30, max_speed_kmh: 20 })), /Invalid/)
  const current = template({ min_speed_mps: 0, max_speed_mps: 10 })
  assert.deepEqual(migrateRouteSpeedTemplate(current), current)
})
