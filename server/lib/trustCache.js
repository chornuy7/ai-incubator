/**
 * Кэш trust score по аккаунтам (§3.3). Пишется при расчёте в buildAccountStats,
 * читается дёшево там, где полный расчёт (сеть/активность) не по карману:
 *  - assignment-gate: не пускать аккаунты с trust<40 в боевые модули (авто-стоп §6);
 *  - индикатор trust в списке аккаунтов.
 * Отдельный стор (а не meta), чтобы не дёргать updatedAt/lastSeen аккаунта.
 */
import { dataPath, readJson, writeJson } from './jsonStore.js'
import { toDbTime, fromDbTime } from './dbTime.js'
import { getSupabase, supabaseEnabled } from './supabase.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }

const FILE = process.env.TRUST_CACHE_FILE || dataPath('trust-cache.json')

/*
 * MR-290: кэш живёт в базе, файл остаётся запасным путём.
 *
 * Таблица `trust_cache` существовала с самого начала и была пуста: стор её не открывал.
 * Порог trust < 40 закрывает боевые модули, а в файле он у каждого процесса свой — на
 * втором инстансе аккаунт мог быть допущен там, где первый его не пустил. Для значения,
 * от которого зависит «будет ли аккаунт работать вообще», это неприемлемо.
 */

export async function getAllTrustCache() {
  const db = sb()
  if (db) {
    const { data, error } = await db.from('trust_cache').select('account_id, score, band, updated_at')
    if (!error) {
      const out = {}
      for (const r of data || []) {
        out[r.account_id] = { score: Number(r.score), band: r.band || null, checkedAt: fromDbTime(r.updated_at) }
      }
      return out
    }
  }
  const m = await readJson(FILE, {})
  return m && typeof m === 'object' ? m : {}
}

export async function getTrustCache(accountId) {
  if (!accountId) return null
  const db = sb()
  if (db) {
    // По одному аккаунту — точечный запрос: полный список тут не нужен, а зовут это с
    // проверки допуска, то есть на каждый запуск модуля.
    const { data, error } = await db.from('trust_cache')
      .select('score, band, updated_at').eq('account_id', accountId).maybeSingle()
    if (!error) return data ? { score: Number(data.score), band: data.band || null, checkedAt: fromDbTime(data.updated_at) } : null
  }
  return (await getAllTrustCache())[accountId] || null
}

export async function setTrustCache(accountId, { score, band }, now = Date.now()) {
  if (!accountId) return
  const db = sb()
  if (db) {
    const { error } = await db.from('trust_cache')
      .upsert({ account_id: accountId, score, band: band || null, updated_at: toDbTime(now) }, { onConflict: 'account_id' })
    if (!error) return
    // Аккаунта нет в базе — кэшировать доверие не для кого. В файл такое не дублируем:
    // иначе запись пережила бы аккаунт и всплыла бы у следующего с тем же id.
    if (String(error.code) === '23503') return
  }
  const m = await readJson(FILE, {})
  const all = m && typeof m === 'object' ? m : {}
  all[accountId] = { score, band, checkedAt: now }
  await writeJson(FILE, all)
}
