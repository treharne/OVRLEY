import { WIDGET_TYPE_DEFINITIONS } from '@/lib/widget/widget-catalog'

export const ROUTE_SPEED_UNITS = [...WIDGET_TYPE_DEFINITIONS.speed.supportedDisplayUnits, ...WIDGET_TYPE_DEFINITIONS.pace.supportedDisplayUnits]
export const routeSpeedUnit = (unit) => ROUTE_SPEED_UNITS.find((option) => option.value === unit)
export const isRoutePace = (unit) => unit === 'min_per_km' || unit === 'min_per_mi'
// Match the existing native speed/pace gauge conversions. Stored bounds stay metres/second.
const speedFactor = { kmh: 3.6, mph: 2.23694, kn: 1.943844, mps: 1 }
const paceDistance = (unit) => (unit === 'min_per_mi' ? 1.609344 : 1)

export function routeSpeedToDisplay(mps, unit) {
  if (isRoutePace(unit)) return mps === 0 ? Infinity : (1000 * paceDistance(unit)) / mps
  return mps * speedFactor[unit]
}

export function formatRouteSpeed(mps, unit) {
  if (mps === null || mps === undefined) return ''
  const value = routeSpeedToDisplay(mps, unit)
  if (!isRoutePace(unit)) return Number(value.toFixed(2))
  if (value === Infinity) return '∞'
  const seconds = Math.max(1, Math.round(value))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function parseRouteSpeed(raw, unit) {
  const text = String(raw).trim()
  if (isRoutePace(unit)) {
    if (text === '∞') return 0
    const match = /^(\d+):([0-5]\d(?:\.\d+)?)$/.exec(text)
    if (!match) return null
    const seconds = Number(match[1]) * 60 + Number(match[2])
    return seconds > 0 ? (1000 * paceDistance(unit)) / seconds : null
  }
  if (!text) return null
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 ? value / speedFactor[unit] : null
}
