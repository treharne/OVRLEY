import { describe, expect, test } from 'vite-plus/test'
import { DEFAULT_LOCALE, locales, localeValues, requireLocale } from '@/i18n/locales'

describe('locale registry', () => {
  test('is the canonical source for supported codes and native labels', () => {
    expect(DEFAULT_LOCALE).toBe('en')
    expect(locales).toContainEqual({ value: 'zh-CN', label: '简体中文' })
    expect(locales).toContainEqual({ value: 'de', label: 'Deutsch' })
    expect(locales).toContainEqual({ value: 'pt-BR', label: 'Português (Brasil)' })
    expect(localeValues).toEqual(locales.map(({ value }) => value))
    expect(new Set(localeValues).size).toBe(locales.length)
  })

  test('rejects unsupported locale codes', () => {
    expect(() => requireLocale('en-US')).toThrow('Unsupported locale: en-US')
  })
})

const routeTranslations = import.meta.glob('../../i18n/locales/*-translation.json', { eager: true, import: 'default' })
describe('speed route locale coverage', () => {
  test('every supported locale defines all feature labels and preserves interpolation', () => {
    const english = Object.entries(routeTranslations).find(([name]) => name.endsWith('/en-translation.json'))[1]['widget-editor']
    const keys = Object.keys(english).filter((key) => key.startsWith('routeSpeed'))
    const placeholders = (text) => (text.match(/\{\{\w+\}\}/g) ?? []).sort()
    for (const code of localeValues) {
      const entry = Object.entries(routeTranslations).find(([name]) => name.endsWith(`/${code}-translation.json`))
      expect(entry, code).toBeTruthy()
      const translations = entry[1]['widget-editor']
      for (const key of keys) {
        expect(translations[key], `${code}.${key}`).toBeTypeOf('string')
        expect(translations[key].trim().length, `${code}.${key}`).toBeGreaterThan(0)
        expect(placeholders(translations[key]), `${code}.${key}`).toEqual(placeholders(english[key]))
      }
    }
  })
})
