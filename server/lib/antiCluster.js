/**
 * SPEC §4.4 (D4): защита от ВОЛНОВЫХ банов.
 *
 * Telegram отслеживает связанные аккаунты: находит один фейк, изучает его параметры
 * (гео, прокси, время работы, скорость) и добивает похожие в той же группе. Заказчик:
 * «почему у тебя отваливаются целыми группами? Телега находит паттерн».
 *
 * Здесь — чистые функции-проверки без I/O, чтобы правила можно было менять и тестировать
 * отдельно от воркеров. Часть анти-кластера уже есть в системе (интервальные задержки,
 * рандомизация, множитель уровня защиты) — тут то, чего не хватало.
 */

/** Во скольких чатах аккаунт может работать одновременно. У человека не десять рук. */
export const MAX_PARALLEL_CHATS = 2

/**
 * Сколько аккаунтов одного прокси допустимо запускать в одном «залпе». Если вся пачка
 * выходит с одного IP в одну минуту — это и есть паттерн, по которому банят волной.
 */
export const MAX_PER_PROXY_BURST = 2

/**
 * Человеческий темп: пауза «на чтение» перед ответом и время «на набор».
 * Нельзя ответить на сообщение мгновенно и нельзя написать 100 слов за полсекунды.
 * @param {string} text что собираемся отправить
 * @param {number} [incomingLen] длина входящего, которое читаем
 * @returns {{readMs:number, typeMs:number, totalMs:number}}
 */
export function humanPace(text = '', incomingLen = 0) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length
  // Чтение: ~15 знаков в секунду, но не меньше 3 секунд — мгновенный ответ выдаёт бота.
  const readMs = Math.max(3000, Math.round((Number(incomingLen) || 0) / 15 * 1000))
  // Набор: ~40 слов в минуту у обычного человека, плюс «подумать» перед первым словом.
  const typeMs = Math.round(1500 + (words / 40) * 60 * 1000)
  return { readMs, typeMs, totalMs: readMs + typeMs }
}

/**
 * Можно ли аккаунту взять ЕЩЁ один чат прямо сейчас.
 * @param {number} activeChats сколько чатов уже ведёт аккаунт
 * @param {number} [max]
 */
export function parallelChatsGate(activeChats = 0, max = MAX_PARALLEL_CHATS) {
  const n = Math.max(0, Number(activeChats) || 0)
  if (n >= max) {
    return { ok: false, reason: `уже работает в ${n} чатах одновременно — у человека не десять рук` }
  }
  return { ok: true }
}

/**
 * Разброс по прокси: не выпускаем пачку аккаунтов с одного IP разом.
 * @param {Record<string,string>} proxyByAccount карта accountId → прокси (URL или id)
 * @param {string[]} accountIds кого собираемся запустить
 * @param {number} [max]
 * @returns {{ok:boolean, reason?:string, worst?:{proxy:string, count:number}}}
 */
export function proxySpreadGate(proxyByAccount = {}, accountIds = [], max = MAX_PER_PROXY_BURST) {
  const counts = {}
  for (const id of accountIds) {
    const p = String(proxyByAccount[id] || '').trim()
    // Прямое подключение не считаем кластером: это разные домашние IP, а не один шлюз.
    if (!p || p === '—') continue
    counts[p] = (counts[p] || 0) + 1
  }
  let worst = null
  for (const [proxy, count] of Object.entries(counts)) {
    if (!worst || count > worst.count) worst = { proxy, count }
  }
  if (worst && worst.count > max) {
    return {
      ok: false,
      worst,
      reason: `${worst.count} аккаунтов выходят через один прокси — запускайте их вразнобой, иначе Telegram видит группу`,
    }
  }
  return { ok: true, worst: worst || undefined }
}

/**
 * Сводная проверка перед запуском пачки: то, что стоит показать оператору ДО старта,
 * а не после бана. Возвращает список предупреждений, не запрещая запуск: решение
 * за человеком, наша задача — чтобы он видел риск.
 * @param {{proxyByAccount?:Record<string,string>, accountIds?:string[], targets?:string[]}} input
 */
export function clusterWarnings(input = {}) {
  const warnings = []
  const ids = input.accountIds || []
  const spread = proxySpreadGate(input.proxyByAccount || {}, ids)
  if (!spread.ok) warnings.push(spread.reason)

  // Одинаковое гео у всей пачки — второй по частоте признак кластера после прокси.
  const targets = input.targets || []
  if (ids.length >= 5 && targets.length === 1) {
    warnings.push(`${ids.length} аккаунтов работают в одном чате — разнесите по разным целям или запускайте частями`)
  }
  return warnings
}
