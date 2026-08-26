/**
 * Собрать @username всех аккаунтов, зайдя по их сессиям (просьба владельца 26.08).
 *
 * Зачем скрипт, а не разовый запрос: в метаданных username записан лишь у пяти профилей
 * из девяноста восьми — остальные заводились импортом сессий, где его никто не спрашивал.
 * Узнать его можно только у Telegram.
 *
 * Почему по одному и с паузами. Девять десятков подключений подряд с разных прокси в одну
 * минуту — ровно тот всплеск, по которому фермы и вычисляют. `getMe` сам по себе дешёвый,
 * но важен темп, а не вес запроса. Поэтому строго последовательно и со случайной паузой.
 *
 * Найденный username сразу пишется в метаданные: второй раз ходить в Telegram не нужно.
 *
 *   node server/scripts/pullUsernames.js [сколько]   — по умолчанию все активные
 */
import 'dotenv/config'
import { loadAllMeta, setAccountMeta } from '../accountsMeta.js'
import { loadSessionString, createClient } from '../tgAuth.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const пауза = () => 1500 + Math.floor(Math.random() * 2500)

const limit = Number(process.argv[2]) || 0

const raw = await loadAllMeta()
const all = Array.isArray(raw) ? raw : Object.entries(raw).map(([id, v]) => ({ id, ...v }))
const meta = new Map(all.map((a) => [a.id, a]))

// Мёртвые сессии дёргать незачем: они и не подключатся, а время потратят.
const targets = all.filter((a) => !a.inTrash && ['active', 'pause', 'warming'].includes(String(a.status || 'active')))
const list = limit ? targets.slice(0, limit) : targets

console.log(`аккаунтов всего ${all.length} · берём в работу ${list.length} (мёртвые сессии пропускаем)`)

const ok = []
const fail = []

for (let i = 0; i < list.length; i += 1) {
  const acc = list[i]
  const m = meta.get(acc.id) || {}
  const prefix = `[${i + 1}/${list.length}] ${acc.id}`
  let client
  try {
    const session = await loadSessionString(acc.id)
    if (!session) throw new Error('нет файла сессии')
    client = await createClient(session, m.proxy, m.fingerprint)
    const me = await client.getMe()
    const username = me?.username ? String(me.username) : ''
    const phone = me?.phone ? String(me.phone) : ''
    const name = [me?.firstName, me?.lastName].filter(Boolean).join(' ')
    ok.push({ id: acc.id, username, phone, name })
    // Сохраняем — чтобы следующий раз обошёлся без Telegram.
    await setAccountMeta(acc.id, { username, phone, name })
    console.log(`${prefix} · ${username ? '@' + username : 'без username'} · ${name || '—'}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    fail.push({ id: acc.id, error: msg })
    console.log(`${prefix} · ОШИБКА: ${msg}`)
  } finally {
    try { await client?.disconnect() } catch { /* уже отключён */ }
  }
  if (i < list.length - 1) await sleep(пауза())
}

console.log('\n══ ИТОГ ══')
console.log(`получили: ${ok.length} · не вышло: ${fail.length}`)
console.log('\nUSERNAME:')
for (const r of ok) console.log(r.username ? `@${r.username}` : `(нет username) ${r.id} · ${r.name || '—'}`)
if (fail.length) {
  console.log('\nНЕ ОТВЕТИЛИ:')
  for (const f of fail) console.log(`${f.id} · ${f.error}`)
}
process.exit(0)
