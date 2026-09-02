/**
 * MR-290: развести аккаунты по РАЗНЫМ прокси.
 *
 * Зачем. На боевой 58 живых аккаунтов сидят на 41 прокси: двенадцать прокси делят между
 * собой несколько аккаунтов, а шестьдесят прокси из каталога не используются вовсе. Для
 * Telegram несколько аккаунтов с одного адреса — сигнал связки, и это ровно то, от чего
 * прокси и ставят. Свободных прокси хватает, чтобы у каждого был свой.
 *
 *   node --env-file=.env server/scripts/spread-proxies.mjs --dry   показать план
 *   node --env-file=.env server/scripts/spread-proxies.mjs         применить
 *
 * ─── ПОЧЕМУ НЕ «РАЗДАТЬ ВСЕМ СЛУЧАЙНЫЕ» ───
 *
 * Смена адреса у живого аккаунта — сама по себе подозрительное для Telegram событие:
 * вчера человек заходил из Киева, сегодня из Франкфурта. Переставить прокси всем разом
 * значит устроить это одновременно пятидесяти пяти аккаунтам — то есть заплатить риском
 * бана за исправление проблемы, которой у большинства из них нет.
 *
 * Поэтому трогаем ТОЛЬКО тех, у кого есть проблема:
 *   • аккаунт без прокси — выдаём свободный;
 *   • аккаунты, делящие один прокси, — оставляем на нём САМОГО СТАРОГО (он там дольше
 *     всех, и для Telegram это его привычный адрес), остальным выдаём свободные.
 * Аккаунт, у которого прокси уже свой и ничей больше, не трогаем вовсе.
 *
 * Страна учитывается: аккаунт с украинским номером через немецкий адрес — заметная
 * нестыковка. Если свободного прокси нужной страны нет, берём любой свободный и говорим
 * об этом в отчёте, а не подбираем молча.
 */
import 'dotenv/config'
import { getSupabase } from '../lib/supabase.js'

const DRY = process.argv.slice(2).includes('--dry')

const db = getSupabase()
if (!db) {
  console.error('Нет SUPABASE_URL / SUPABASE_SECRET_KEY — подключиться не к чему.')
  process.exit(1)
}

const { data: accounts, error: aErr } = await db
  .from('accounts_meta')
  .select('id, name, country, in_trash, proxy_id, created_at, data')
  .order('created_at', { ascending: true })
if (aErr) { console.error('accounts_meta:', aErr.message); process.exit(1) }

const { data: proxies, error: pErr } = await db
  .from('proxies')
  .select('id, host, port, country, status')
if (pErr) { console.error('proxies:', pErr.message); process.exit(1) }

/*
 * Ссылка берётся из колонки, а если её ещё нет (миграция не накатана) — из старого ключа
 * в json. Так скрипт работает и до, и после переезда.
 */
const live = (accounts || []).filter((a) => !a.in_trash)
const currentOf = (a) => a.proxy_id || a.data?.proxyId || null

// Кто на каком прокси сидит. Порядок внутри группы — по дате заведения (уже отсортированы).
const byProxy = new Map()
for (const a of live) {
  const id = currentOf(a)
  if (!id) continue
  if (!byProxy.has(id)) byProxy.set(id, [])
  byProxy.get(id).push(a)
}

const usable = (proxies || []).filter((p) => p.status !== 'dead' && p.status !== 'bad')
const free = usable.filter((p) => !byProxy.has(p.id))
const freeByCountry = new Map()
for (const p of free) {
  const c = String(p.country || '').toLowerCase()
  if (!freeByCountry.has(c)) freeByCountry.set(c, [])
  freeByCountry.get(c).push(p)
}
const takeFree = (country) => {
  const c = String(country || '').toLowerCase()
  const same = freeByCountry.get(c)
  if (same?.length) { const p = same.shift(); free.splice(free.indexOf(p), 1); return { proxy: p, sameCountry: true } }
  if (!free.length) return null
  const p = free.shift()
  const list = freeByCountry.get(String(p.country || '').toLowerCase())
  if (list) { const i = list.indexOf(p); if (i >= 0) list.splice(i, 1) }
  return { proxy: p, sameCountry: false }
}

const план = []
const беспризорные = []

// 1. Аккаунты без прокси.
for (const a of live.filter((x) => !currentOf(x))) {
  const got = takeFree(a.country)
  if (!got) { беспризорные.push(a); continue }
  план.push({ account: a, from: null, to: got.proxy, sameCountry: got.sameCountry, reason: 'был без прокси' })
}

// 2. Аккаунты, делящие прокси: самый старый остаётся, остальным — свои.
for (const [proxyId, group] of byProxy) {
  if (group.length < 2) continue
  for (const a of group.slice(1)) {
    const got = takeFree(a.country)
    if (!got) { беспризорные.push(a); continue }
    план.push({ account: a, from: proxyId, to: got.proxy, sameCountry: got.sameCountry, reason: `делил прокси с ${group.length - 1} аккаунт(ами)` })
  }
}

const nameOf = (a) => a.name || a.id
console.log('')
console.log(`Живых аккаунтов: ${live.length}, прокси в каталоге: ${(proxies || []).length}, годных: ${usable.length}`)
console.log(`Занято прокси: ${byProxy.size}, из них делят несколько аккаунтов: ${[...byProxy.values()].filter((g) => g.length > 1).length}`)
console.log(`К перестановке: ${план.length}${беспризорные.length ? `, не хватило прокси: ${беспризорные.length}` : ''}`)
console.log('')
for (const p of план) {
  const гео = p.sameCountry ? '' : ' ⚠ страна не совпала'
  console.log(`  · ${nameOf(p.account)} (${p.account.country || '—'}): ${p.from || 'без прокси'} → ${p.to.id} ${p.to.host}:${p.to.port} [${p.to.country || '—'}]${гео}  — ${p.reason}`)
}
for (const a of беспризорные) console.warn(`  ⚠ ${nameOf(a)} — свободных прокси не осталось`)

if (DRY) {
  console.log('')
  console.log('Пробный прогон — ничего не менялось. Запустите без --dry, чтобы применить.')
  process.exit(0)
}

if (!план.length) {
  console.log('Менять нечего: у каждого аккаунта свой прокси.')
  process.exit(0)
}

let ok = 0
for (const p of план) {
  const { error } = await db.from('accounts_meta').update({ proxy_id: p.to.id }).eq('id', p.account.id)
  if (error) { console.error(`  ✗ ${nameOf(p.account)}: ${error.message}`); continue }
  ok++
}
console.log('')
console.log(`Переставлено: ${ok} из ${план.length}.`)
console.log('Прежнее назначение осталось в data.proxyId — по нему можно откатиться.')
