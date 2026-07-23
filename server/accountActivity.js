/**
 * SPEC §4.3 (D1): статистика и усталость живут У САМОГО АККАУНТА, а не в задаче.
 *
 * Раньше счётчики были в задаче: каждая новая задача начинала считать с нуля и не знала,
 * что профиль только что отработал смену в соседнем модуле. Поэтому освободившийся
 * аккаунт мог тут же уйти лить 50 реакций — ровно то, на что жаловался заказчик.
 * Здесь состояние общее: усталость, отдых и дневные счётчики видны всем модулям сразу.
 *
 * Хранение — JSON `data/account-activity.json`; путь через env (изоляция тестов).
 * Запись через `mutateJson`: усталость меняют параллельные воркеры, и без сериализации
 * они затирали бы друг друга — та же болезнь, что была у accounts-meta.
 */
import { dataPath, readJson, mutateJson } from './lib/jsonStore.js'
import {
  DEFAULT_FATIGUE, DEFAULT_SCHEDULE, applyAction, fatigueGate, scheduleGate,
  currentFatigue, normalizeFatigueProfile,
} from './lib/accountFatigue.js'

const FILE = () => process.env.ACCOUNT_ACTIVITY_FILE || dataPath('account-activity.json')

/** @returns {Promise<Record<string, object>>} */
async function loadAll() {
  const all = await readJson(FILE(), {})
  return all && typeof all === 'object' ? all : {}
}

/** Состояние одного аккаунта: усталость, отдых, профиль и распорядок. */
export async function getActivity(accountId) {
  const all = await loadAll()
  const s = all[accountId] || {}
  return {
    fatigue: Number(s.fatigue) || 0,
    lastActionAt: Number(s.lastActionAt) || 0,
    restUntil: Number(s.restUntil) || 0,
    actionsTotal: Number(s.actionsTotal) || 0,
    profile: { ...DEFAULT_FATIGUE, ...(s.profile || {}) },
    schedule: s.schedule && typeof s.schedule === 'object' ? s.schedule : DEFAULT_SCHEDULE,
  }
}

/** Все состояния разом — для списка аккаунтов и массовых операций. */
export async function listActivity() {
  const all = await loadAll()
  const now = Date.now()
  const out = {}
  for (const [id, s] of Object.entries(all)) {
    const profile = { ...DEFAULT_FATIGUE, ...(s.profile || {}) }
    out[id] = {
      fatigue: currentFatigue(s, profile, now),
      threshold: profile.threshold,
      restUntil: Number(s.restUntil) || 0,
      actionsTotal: Number(s.actionsTotal) || 0,
      resting: (Number(s.restUntil) || 0) > now,
    }
  }
  return out
}

/**
 * Зафиксировать совершённое действие: усталость +1, при достижении порога — отдых.
 * Вызывается из воркеров ПОСЛЕ успешного действия, любым модулем.
 */
export async function noteAction(accountId, now = Date.now()) {
  if (!accountId) return null
  let patch = null
  await mutateJson(FILE(), (all) => {
    const cur = (all && all[accountId]) || {}
    const profile = { ...DEFAULT_FATIGUE, ...(cur.profile || {}) }
    patch = applyAction(cur, profile, now)
    return { ...(all || {}), [accountId]: { ...cur, ...patch } }
  })
  return patch
}

/**
 * Можно ли брать аккаунт в работу прямо сейчас — усталость И распорядок.
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function canWorkNow(accountId, now = Date.now(), rnd = Math.random) {
  const s = await getActivity(accountId)
  const f = fatigueGate(s, s.profile, now)
  if (!f.ok) return f
  return scheduleGate(s.schedule, now, rnd)
}

/**
 * §4.5: задать профиль усталости/распорядок — одному или СРАЗУ ПАЧКЕ аккаунтов.
 * Массовое задание — прямой запрос владельца: «чтобы можно было массово всем задавать
 * усталость и отдых от модулей, как живой человек».
 * @param {string[]} accountIds @param {{profile?:object, schedule?:object, reset?:boolean}} patch
 */
export async function setActivityProfile(accountIds, patch = {}) {
  const ids = (Array.isArray(accountIds) ? accountIds : []).filter(Boolean)
  if (!ids.length) return 0
  const profile = patch.profile ? normalizeFatigueProfile(patch.profile) : null
  await mutateJson(FILE(), (all) => {
    const next = { ...(all || {}) }
    for (const id of ids) {
      const cur = next[id] || {}
      next[id] = {
        ...cur,
        ...(profile ? { profile } : {}),
        ...(patch.schedule ? { schedule: patch.schedule } : {}),
        // «Отправить отдыхать» пачкой: обнуляем усталость и снимаем принудительный отдых.
        ...(patch.reset ? { fatigue: 0, restUntil: 0 } : {}),
      }
    }
    return next
  })
  return ids.length
}

/** Отправить аккаунты на отдых на N минут (массовая операция «дать отдохнуть»). */
export async function restAccounts(accountIds, minutes = 60, now = Date.now()) {
  const ids = (Array.isArray(accountIds) ? accountIds : []).filter(Boolean)
  if (!ids.length) return 0
  const until = now + Math.max(1, Number(minutes) || 1) * 60000
  await mutateJson(FILE(), (all) => {
    const next = { ...(all || {}) }
    for (const id of ids) next[id] = { ...(next[id] || {}), restUntil: until }
    return next
  })
  return ids.length
}
