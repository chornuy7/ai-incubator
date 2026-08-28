/**
 * §3.8 AND-пересечение парсера: канал остаётся, только если совпал со ВСЕМИ ключами.
 *
 * Живёт отдельной чистой функцией, потому что от неё зависят деньги и данные клиента,
 * а проверять её запуском реального парсинга нельзя. Карта совпадений (channelKey →
 * набор индексов ключевых слов) копится по ходу сбора и должна пережить паузу: при
 * «Продолжить» ранние запросы не переигрываются, и без сохранённой карты пересечение
 * в конце выбросило бы всё, собранное до паузы (нашёл аудит 23.07).
 */

/** Map<string,Set<number>> → простой объект для записи в задачу. */
export function serializeHits(map) {
  return Object.fromEntries([...map].map(([k, v]) => [k, [...v]]))
}

/** Объект из задачи → Map<string,Set<number>>. */
export function restoreHits(obj = {}) {
  return new Map(Object.entries(obj || {}).map(([k, v]) => [k, new Set(v)]))
}

/** Ключ канала для карты совпадений — как в воркере (username или id, в нижнем регистре). */
export function channelKey(row) {
  return String(row?.username || row?.id || '').toLowerCase()
}

/**
 * Оставить каналы, совпавшие минимум с `need` ключами. `hits` — Map или объект.
 * @param {Array<object>} results @param {Map|Object} hits @param {number} need
 * @param {number} [limit] Infinity/0 — без ограничения
 */
export function keepIntersecting(results = [], hits = new Map(), need = 1, limit = Infinity) {
  const size = (row) => {
    const k = channelKey(row)
    const v = hits instanceof Map ? hits.get(k) : hits[k]
    return v ? (v.size ?? v.length ?? 0) : 0
  }
  const kept = results.filter((r) => size(r) >= need)
  return (!limit || limit === Infinity) ? kept : kept.slice(0, limit)
}

/**
 * Применить пересечение — или НЕ применить, если оно вычёркивает всё.
 *
 * Правка 27.08. Прогоны 26–27.08: шесть неблизких слов (массаж, СТО, нужен разработчик,
 * создать бота, need developer, massage) + AND дали «5 → 0», и человек остался с пустым
 * экраном после десяти минут работы аккаунтов. Фильтр, срезающий сто процентов, — это
 * почти всегда не находка, а неверная настройка: пересечение требует, чтобы ОДИН канал
 * нашёлся по КАЖДОМУ слову, что выполнимо лишь для тесных синонимов.
 *
 * Показать собранное и объяснить полезнее, чем молча выбросить: данные уже оплачены и
 * добыты, а сузить выдачу человек может сам, сняв галочку.
 *
 * @returns {{results: Array<object>, applied: boolean, before: number}}
 */
export function applyIntersection(results = [], hits = new Map(), need = 1, limit = Infinity) {
  const before = results.length
  const kept = keepIntersecting(results, hits, need, limit)
  if (before > 0 && !kept.length) return { results, applied: false, before }
  return { results: kept, applied: true, before }
}
