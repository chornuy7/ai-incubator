/**
 * GEO-модель (§8.3): страны + регионы «Европа / СНГ». Единый источник для фильтров
 * аккаунтов (менеджер + пикер). Регион «Европа+Украина» — цель бизнеса.
 * Коды согласованы с server/accountsMeta.js#countryFromPhone (по префиксу телефона).
 */
export type Region = 'europe' | 'cis'

export interface GeoCountry { code: string; flag: string; label: string; region: Region }

export const COUNTRIES: GeoCountry[] = [
  // Европа (+ Украина)
  { code: 'ua', flag: '🇺🇦', label: 'Украина', region: 'europe' },
  { code: 'pl', flag: '🇵🇱', label: 'Польша', region: 'europe' },
  { code: 'de', flag: '🇩🇪', label: 'Германия', region: 'europe' },
  { code: 'gb', flag: '🇬🇧', label: 'Великобритания', region: 'europe' },
  { code: 'fr', flag: '🇫🇷', label: 'Франция', region: 'europe' },
  { code: 'es', flag: '🇪🇸', label: 'Испания', region: 'europe' },
  { code: 'it', flag: '🇮🇹', label: 'Италия', region: 'europe' },
  { code: 'nl', flag: '🇳🇱', label: 'Нидерланды', region: 'europe' },
  { code: 'cz', flag: '🇨🇿', label: 'Чехия', region: 'europe' },
  { code: 'ro', flag: '🇷🇴', label: 'Румыния', region: 'europe' },
  { code: 'lt', flag: '🇱🇹', label: 'Литва', region: 'europe' },
  { code: 'lv', flag: '🇱🇻', label: 'Латвия', region: 'europe' },
  // СНГ
  { code: 'ru', flag: '🇷🇺', label: 'Россия', region: 'cis' },
  { code: 'kz', flag: '🇰🇿', label: 'Казахстан', region: 'cis' },
]

export const REGION_LABELS: Record<Region, string> = { europe: 'Европа', cis: 'СНГ' }

export const FLAGS: Record<string, string> = Object.fromEntries(COUNTRIES.map((c) => [c.code, c.flag]))
export const COUNTRY_NAME: Record<string, string> = Object.fromEntries(COUNTRIES.map((c) => [c.code, c.label]))
const REGION_OF: Record<string, Region> = Object.fromEntries(COUNTRIES.map((c) => [c.code, c.region]))

/** Опции фильтра: «Все» + регионы (reg:*) + отдельные страны. */
export const COUNTRIES_FILTER: { code: string; flag: string; label: string }[] = [
  { code: 'all', flag: '', label: 'Все страны' },
  { code: 'reg:europe', flag: '🇪🇺', label: 'Европа — регион' },
  { code: 'reg:cis', flag: '🌐', label: 'СНГ — регион' },
  ...COUNTRIES.map((c) => ({ code: c.code, flag: c.flag, label: c.label })),
]

/** Опции фильтра ТОЛЬКО по реально присутствующим у аккаунтов странам (§3.2):
 *  «Все страны» + регионы (если есть акки региона) + сами страны. Пустые/неизвестные отбрасываем. */
export function countryOptionsFrom(countries: (string | null | undefined)[]): { code: string; flag: string; label: string }[] {
  const present = new Set(countries.map((c) => (c || '').toLowerCase()).filter(Boolean))
  const opts: { code: string; flag: string; label: string }[] = [{ code: 'all', flag: '', label: 'Все страны' }]
  const regions = new Set<Region>()
  for (const c of COUNTRIES) if (present.has(c.code)) regions.add(c.region)
  if (regions.has('europe')) opts.push({ code: 'reg:europe', flag: '🇪🇺', label: 'Европа — регион' })
  if (regions.has('cis')) opts.push({ code: 'reg:cis', flag: '🌐', label: 'СНГ — регион' })
  for (const c of COUNTRIES) if (present.has(c.code)) opts.push({ code: c.code, flag: c.flag, label: c.label })
  return opts
}

/** Проходит ли страна аккаунта под выбранный фильтр (страна или регион `reg:*`). */
export function matchesGeo(country: string, filter: string): boolean {
  if (!filter || filter === 'all') return true
  if (filter.startsWith('reg:')) return REGION_OF[country] === filter.slice(4)
  return country === filter
}
