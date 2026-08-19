/**
 * Выбор поста для массовых реакций.
 *
 * Вынесено из воркера ради тестируемости: до 18.08 «Режим» в UI был декоративным
 * (воркер всегда брал самый свежий пост), и заметить это можно было только живым
 * прогоном. Теперь правило выбора — чистая функция, и её проверяет юнит-тест.
 *
 * @typedef {{ id: number }} PostLike
 */

/** Границы глубины выборки: 0/мусор → 3, всё вне 1–20 обрезается. */
export function normalizeLastPostsCount(raw) {
  return Math.min(Math.max(Math.trunc(Number(raw) || 0) || 3, 1), 20)
}

/**
 * @param {PostLike[]} posts посты канала, свежие первыми (как отдаёт getMessages)
 * @param {object} opts
 * @param {0|1} opts.mode 0 — мониторинг новых, 1 — существующие посты
 * @param {number} opts.lastPostsCount глубина для режима 1
 * @param {number|undefined} opts.seenTop планка «что уже было» для этого канала
 * @param {(postId: number) => boolean} opts.reacted реагировал ли ЭТОТ аккаунт на пост
 * @returns {{ action: 'react', post: PostLike } | { action: 'baseline', topId: number } | { action: 'skip', reason: 'no-posts'|'no-new'|'all-reacted' }}
 */
export function pickReactionPost(posts, { mode, lastPostsCount, seenTop, reacted }) {
  if (!posts.length) return { action: 'skip', reason: 'no-posts' }

  // Порядок, в котором Telegram отдал сообщения, НЕ используем: считаем по id.
  // Иначе вся логика «что новее» держалась бы на недокументированном допущении, и
  // смена порядка молча превратила бы мониторинг в реакции на старые посты.
  const byIdDesc = [...posts].sort((a, b) => b.id - a.id)

  let pool
  if (mode === 1) {
    pool = byIdDesc.slice(0, normalizeLastPostsCount(lastPostsCount))
  } else if (seenTop === undefined) {
    // Первый заход в канал: запоминаем верхнюю границу и НЕ реагируем — иначе
    // «мониторинг новых» ставил бы реакцию на пост, который был опубликован до задачи.
    return { action: 'baseline', topId: byIdDesc[0].id }
  } else {
    pool = byIdDesc.filter((m) => m.id > seenTop)
    if (!pool.length) return { action: 'skip', reason: 'no-new' }
  }

  const fresh = pool.filter((m) => !reacted(m.id))
  if (!fresh.length) return { action: 'skip', reason: mode === 1 ? 'all-reacted' : 'no-new' }

  // Мониторинг: самый СТАРЫЙ из новых (минимальный id) — при частых постах ранние иначе
  // остались бы без реакций. Существующие посты: случайный, чтобы аккаунты не били в один.
  const post = mode === 1 ? fresh[Math.floor(Math.random() * fresh.length)] : fresh[fresh.length - 1]
  return { action: 'react', post }
}
