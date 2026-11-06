// Explicit migration for templates from the experimental km/h preview.
// Runtime configs use only m/s; existing files are never overwritten here.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function migrateRouteSpeedTemplate(input) {
  if (input.format !== 'ovrley-template' || !Array.isArray(input.config?.plots)) {
    throw new Error('Expected an exported OVRLEY template')
  }
  const result = structuredClone(input)
  for (const plot of result.config.plots) {
    const settings = plot.speed_coloring
    if (!settings || (!Object.hasOwn(settings, 'min_speed_kmh') && !Object.hasOwn(settings, 'max_speed_kmh'))) continue
    if (Object.hasOwn(settings, 'min_speed_mps') || Object.hasOwn(settings, 'max_speed_mps')) {
      throw new Error('Mixed speed schemas; refusing ambiguous conversion')
    }
    const minimum = settings.min_speed_kmh
    const maximum = settings.max_speed_kmh
    if (!Number.isFinite(minimum) || minimum < 0 || (maximum !== null && (!Number.isFinite(maximum) || maximum <= minimum))) {
      throw new Error('Invalid km/h speed range')
    }
    settings.min_speed_mps = minimum / 3.6
    settings.max_speed_mps = maximum === null ? null : maximum / 3.6
    delete settings.min_speed_kmh
    delete settings.max_speed_kmh
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , source, output] = process.argv
  if (!source || !output) throw new Error('Usage: node scripts/migrate-route-speed-template.mjs INPUT.json NEW_OUTPUT.json')
  const result = migrateRouteSpeedTemplate(JSON.parse(readFileSync(source, 'utf8')))
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
}
