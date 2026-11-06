import { WIDGET_TYPE_DEFINITIONS } from '@/lib/widget/widget-catalog'

export const ROUTE_SPEED_UNITS = [...WIDGET_TYPE_DEFINITIONS.speed.supportedDisplayUnits, ...WIDGET_TYPE_DEFINITIONS.pace.supportedDisplayUnits]
export const routeSpeedUnit = (unit) => ROUTE_SPEED_UNITS.find((option) => option.value === unit)
export const isRoutePace = (unit) => unit === 'min_per_km' || unit === 'min_per_mi'
// Match the existing native speed/pace gauge conversions. Stored bounds stay km/h.
const speedFactor = { kmh: 1, mph: 2.23694 / 3.6, kn: 1.943844 / 3.6, mps: 1 / 3.6 }
const paceDistance = (unit) => (unit === 'min_per_mi' ? 1.609344 : 1)

export function routeSpeedToDisplay(kmh, unit) {
  if (isRoutePace(unit)) return kmh === 0 ? Infinity : (3600 * paceDistance(unit)) / kmh
  return kmh * speedFactor[unit]
}

export function formatRouteSpeed(kmh, unit) {
  if (kmh === null || kmh === undefined) return ''
  const value = routeSpeedToDisplay(kmh, unit)
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
    return seconds > 0 ? (3600 * paceDistance(unit)) / seconds : null
  }
  if (!text) return null
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 ? value / speedFactor[unit] : null
}
