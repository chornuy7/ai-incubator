// Порт констант TGStat-парсера из telegram-master (tgstat_svc.py).
// Каталог каналов на зеркалах TGStat: {host}/{category} + «Показать больше».

/** Регионы = субдомены/префиксы зеркал TGStat. */
export const REGION_HOSTS = {
  russia: 'https://tgstat.com/ru',
  ukraine: 'https://uk.tgstat.com',
  belarus: 'https://by.tgstat.com',
  kazakhstan: 'https://kaz.tgstat.com',
  kyrgyzstan: 'https://kg.tgstat.com',
  uzbekistan: 'https://uz.tgstat.com',
  iran: 'https://ir.tgstat.com',
  china: 'https://cn.tgstat.com',
  india: 'https://in.tgstat.com',
  ethiopia: 'https://et.tgstat.com',
  world: 'https://tgstat.com',
}
export const DEFAULT_HOST = REGION_HOSTS.russia

export const REGIONS = {
  russia: 'Россия',
  ukraine: 'Украина',
  belarus: 'Беларусь',
  kazakhstan: 'Казахстан',
  uzbekistan: 'Узбекистан',
  kyrgyzstan: 'Киргизия',
  iran: 'Иран',
  china: 'Китай',
  india: 'Индия',
  ethiopia: 'Эфиопия',
  world: 'Весь мир',
}

/** Сколько каналов TGStat отдаёт до первого «Показать больше» (≈100 на категорию). */
export const TGSTAT_ITEMS_PER_LOAD_STEP = 100

export const CATEGORIES = {
  blogs: 'Блоги',
  news: 'Новости и СМИ',
  entertainment: 'Юмор и развлечения',
  tech: 'Технологии',
  economics: 'Экономика',
  business: 'Бизнес и стартапы',
  crypto: 'Криптовалюты',
  travels: 'Путешествия',
  marketing: 'Маркетинг, PR, реклама',
  psychology: 'Психология',
  design: 'Дизайн',
  politics: 'Политика',
  art: 'Искусство',
  law: 'Право',
  education: 'Образование',
  books: 'Книги',
  language: 'Лингвистика',
  career: 'Карьера',
  edutainment: 'Познавательное',
  courses: 'Курсы и гайды',
  sport: 'Спорт',
  beauty: 'Мода и красота',
  medicine: 'Медицина',
  health: 'Здоровье и Фитнес',
  pics: 'Картинки и фото',
  apps: 'Софт и приложения',
  video: 'Видео и фильмы',
  music: 'Музыка',
  games: 'Игры',
  food: 'Еда и кулинария',
  quotes: 'Цитаты',
  handmade: 'Рукоделие',
  babies: 'Семья и дети',
  nature: 'Природа',
  construction: 'Интерьер и строительство',
  telegram: 'Telegram',
  instagram: 'Instagram',
  sales: 'Продажи',
  transport: 'Транспорт',
  religion: 'Религия',
  esoterics: 'Эзотерика',
  darknet: 'Даркнет',
  gambling: 'Букмекерство',
  shock: 'Шок-контент',
  erotica: 'Эротика',
  adult: 'Для взрослых',
  other: 'Другое',
}

/** Cookies, наличие которых означает полный вход через Telegram (нужен для >100). */
export const TELEGRAM_LOGIN_COOKIES = new Set([
  '_identity', 'PHPSESSID', 'tgstat_session', 'tgstat_sirk', 'tgstat_idrk',
])

export const CATALOG_PEER_TYPES = ['channel', 'chat']

export const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.6',
  'Accept-Encoding': 'gzip, deflate',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
}

export function buildCatalogUrl(host, category) {
  const slug = String(category).trim().replace(/^\/+|\/+$/g, '')
  return `${host.replace(/\/+$/, '')}/${slug}`
}

export function categoryLabel(slug) { return CATEGORIES[slug] || slug }
export function regionLabel(slug) { return slug ? (REGIONS[slug] || slug) : null }

/** categories/regions для дропдаунов фронта. */
export function catalogOptions() {
  return {
    categories: Object.entries(CATEGORIES).map(([slug, label]) => ({ slug, label })),
    regions: Object.entries(REGIONS).map(([slug, label]) => ({ slug, label })),
    catalog_items_per_step: TGSTAT_ITEMS_PER_LOAD_STEP,
    catalog_url_pattern: '{host}/{category}',
  }
}
