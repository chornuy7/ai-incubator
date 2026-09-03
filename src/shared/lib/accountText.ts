/**
 * Тексты, которые раньше собирал сервер.
 *
 * Почему они переехали сюда. В ответе API приезжали готовые фразы: `lastSeen: "11 ч"`,
 * `statusReason: "Спамблок — аккаунт помечен и пропускается"`, а в базе рядом с кодом
 * статуса лежала его же формулировка по-русски. Из-за этого:
 *
 *   • по «11 ч» нельзя ни отсортировать, ни пересчитать в часовой пояс читателя;
 *   • интерфейс невозможно перевести — язык зашит в данные;
 *   • правка формулировки означала бы UPDATE по боевым строкам;
 *   • числа («trust 74 > 70») были вплавлены в предложение и никаким запросом оттуда
 *     не доставались.
 *
 * Теперь сервер отдаёт момент времени и код с параметрами, а фразу строит тот, кто её
 * показывает. Это здесь.
 */

/** Человеческая «отлёжка» из момента времени. */
export function lastSeenText(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const мин = Math.floor((Date.now() - t) / 60_000)
  if (мин < 1) return 'только что'
  if (мин < 60) return `${мин} мин`
  const ч = Math.floor(мин / 60)
  if (ч < 24) return `${ч} ч`
  return `${Math.floor(ч / 24)} д`
}

/** Полная дата для подсказки — там, где короткой «11 ч» мало. */
export function fullTimeText(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t).toLocaleString('ru-RU') : '—'
}

/**
 * Почему у аккаунта такой статус — по коду и параметрам.
 *
 * Коды перечислены явно: набор конечный, и неизвестный код лучше показать как есть, чем
 * молча спрятать. Пустая строка означает «причина не записана» — так бывает у статусов,
 * выставленных до того, как коды появились.
 */
const ПРИЧИНЫ: Record<string, (p: Record<string, unknown>) => string> = {
  SPAM: () => 'Спамблок — аккаунт помечен и пропускается',
  SPAM_QUARANTINE: () => 'Спамблок → карантин аккаунта',
  SPAM_CLEARED: () => 'Спамблок снят через @SpamBot',
  NO_SESSION: () => 'Нет сессии — нужна переавторизация',
  AUTH_KEY_UNREGISTERED: () => 'Сессия недействительна — нужна переавторизация',
  USER_DEACTIVATED: () => 'Аккаунт удалён или заблокирован Telegram',
  FROZEN: () => 'Аккаунт заморожен Telegram',
  FLOOD_QUARANTINE: (p) => `Карантин после ${p.limit ?? ''} FloodWait`.replace('  ', ' '),
  FLOOD_CLEARED: () => 'FloodWait истёк — возврат в работу',
  BAN_QUARANTINE: () => 'Бан → карантин аккаунта (политика ИИ-безопасности)',
  BAN_STOPPED: () => 'Бан → аккаунт остановлен (политика ИИ-безопасности)',
  BAN_TASK_STOPPED: () => 'Бан → задача остановлена (политика ИИ-безопасности)',
  TRUST_RECOVERED: (p) => `trust ${p.trust ?? '?'} > ${p.threshold ?? '?'} — авто-возврат из прогрева`,
  MANUAL: () => 'Ручная пауза оператором',
}

export function statusText(code: string | null | undefined, params: Record<string, unknown> = {}): string {
  if (!code) return ''
  const f = ПРИЧИНЫ[code]
  return f ? f(params || {}) : code
}

/** Откуда аккаунт взялся. Раньше эта фраза лежала в заметке оператора. */
const ПРОИСХОЖДЕНИЕ: Record<string, string> = {
  IMPORT_TDATA: 'Импортирован из tdata',
  IMPORT_SESSION: 'Импортирован из файла сессии',
  MANUAL: 'Заведён вручную',
}

export function originText(code: string | null | undefined): string {
  if (!code) return ''
  return ПРОИСХОЖДЕНИЕ[code] || code
}
