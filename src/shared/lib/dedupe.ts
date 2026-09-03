/**
 * Отсев дублей в текстовых списках (номера, юзернеймы, ссылки на каналы).
 *
 * Списки почти всегда собираются из нескольких источников — папка + выгрузка + руками, —
 * и дубли в них норма. Раньше они схлопывались молча при разборе: человек видел «валидных
 * 8500» вместо введённых 10000 и не понимал, куда делись полторы тысячи. Теперь это
 * явное действие с понятным результатом.
 */

/** Как сравнивать строки при поиске дублей. */
export type DedupeMode =
  /** Телефоны: сравниваем только цифры, чтобы +38 (067) 123 и 380671230 не разъехались. */
  | 'phone'
  /** Юзернеймы и ссылки: без учёта регистра, «@» и хвоста t.me/. */
  | 'handle'
  /** Как есть, с точностью до пробелов по краям. */
  | 'exact'
  /**
   * Смешанный список (мейлинг: номера + юзернеймы). Тип строки определяется так же,
   * как на сервере: есть буквы — юзернейм, иначе номер. Без этого режим 'phone'
   * давал юзернеймам без цифр ПУСТОЙ ключ и молча их удалял.
   */
  | 'auto'

/** Ключ сравнения строки в выбранном режиме. */
export function dedupeKey(line: string, mode: DedupeMode = 'exact'): string {
  const s = String(line ?? '').trim()
  if (mode === 'auto') return /[a-zA-Zа-яА-Я_]/.test(s) ? dedupeKey(s, 'handle') : dedupeKey(s, 'phone')
  if (mode === 'phone') return s.replace(/\D/g, '')
  if (mode === 'handle') {
    return s
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^(www\.)?t\.me\//, '')
      .replace(/^@/, '')
      .replace(/\/+$/, '')
  }
  return s
}

export interface DedupeResult {
  /** Текст без дублей — порядок первых вхождений сохранён. */
  text: string
  /** Сколько строк убрано. */
  removed: number
  /** Сколько осталось. */
  kept: number
}

/**
 * Убрать дубли из многострочного текста. Пустые строки отбрасываются, порядок
 * первых вхождений сохраняется — человек ожидает увидеть свой список, а не пересортированный.
 * @param text исходный текст (строки через перевод, запятую или точку с запятой)
 * @param mode как сравнивать
 */
export function dedupeText(text: string, mode: DedupeMode = 'exact'): DedupeResult {
  const lines = String(text ?? '').split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean)
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of lines) {
    const k = dedupeKey(l, mode)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(l)
  }
  return { text: out.join('\n'), removed: lines.length - out.length, kept: out.length }
}
