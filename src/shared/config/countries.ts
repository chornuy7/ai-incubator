export interface CountryOpt {
  code: string
  flag: string
  label: string
  dial: string
}

export const COUNTRIES: CountryOpt[] = [
  { code: 'ua', flag: '🇺🇦', label: 'Украина', dial: '+380' },
  { code: 'ru', flag: '🇷🇺', label: 'Россия', dial: '+7' },
  { code: 'kz', flag: '🇰🇿', label: 'Казахстан', dial: '+7' },
  { code: 'pl', flag: '🇵🇱', label: 'Польша', dial: '+48' },
  { code: 'de', flag: '🇩🇪', label: 'Германия', dial: '+49' },
]
