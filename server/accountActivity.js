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
import { mapStore } from './lib/tableStore.js'
import {
  DEFAULT_FATIGUE, DEFAULT_SCHEDULE, applyAction, fatigueGate, scheduleGate, freeAt, recoveryEveryMs,
  currentFatigue, normalizeFatigueProfile, normalizeSchedule, scheduleForAccount,
} from './lib/accountFatigue.js'

const FILE = () => process.env.ACCOUNT_ACTIVITY_FILE || dataPath('account-activity.json')

// §10.2: усталость аккаунтов — в БД. Она общая для всех модулей и определяет, кого
// можно брать в работу: на втором инстансе файл разъедется, и аккаунт получит двойную
// нагрузку вместо отдыха.
const activityStore = mapStore({
  table: 'account_activity',
  file: FILE,
  keyCol: 'account_id',
  toRow: (accountId, a) => { const { fatigue, restUntil, lastActionAt, actionsTotal, ...data } = a || {}; return {
    account_id: accountId,
    fatigue: Number(fatigue) || 0,
    rest_until: Number(restUntil) || 0,
    last_action_at: Number(lastActionAt) || 0,
    actions_total: Number(actionsTotal) || 0,
    data,
    updated_at: new Date().toISOString(),
  } },
  fromRow: (r) => [r.account_id, {
    ...(r.data || {}),
    fatigue: Number(r.fatigue) || 0,
    restUntil: Number(r.rest_until) || 0,
    lastActionAt: Number(r.last_action_at) || 0,
    actionsTotal: Number(r.actions_total) || 0,
  }],
})

/** @returns {Promise<Record<string, object>>} */
async function loadAll() {
  const all = await activityStore.readAll()
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
    // Распорядок не задан руками — берём ЛИЧНЫЙ, выведенный из id (§4.4). Одинаковая
    // кривая на всей ферме читается как группа: профили оживают и замолкают синхронно.
    schedule: s.schedule && typeof s.schedule === 'object'
      ? normalizeSchedule(s.schedule)
      : scheduleForAccount(accountId),
    scheduleCustom: !!(s.schedule && typeof s.schedule === 'object'),
  }
}

/** Все состояния разом — для списка аккаунтов и массовых операций. */
export async function listActivity() {
  const all = await loadAll()
  const now = Date.now()
  const hour = new Date(now).getHours()
  const out = {}
  for (const [id, s] of Object.entries(all)) {
    const profile = { ...DEFAULT_FATIGUE, ...(s.profile || {}) }
    const schedule = s.schedule && typeof s.schedule === 'object'
      ? normalizeSchedule(s.schedule)
      : scheduleForAccount(id)
    out[id] = {
      fatigue: currentFatigue(s, profile, now),
      // Весь профиль, а не только порог: форма настройки обязана показывать СОХРАНЁННОЕ.
      // Раньше отдавался один threshold, и окно «Усталость и отдых» каждый раз рисовало
      // умолчания 15/45/5 — выглядело как сброс настроек, а повторное «Применить»
      // действительно затирало заданное (правка 18.08).
      threshold: profile.threshold,
      restMinutes: profile.restMinutes,
      // Третий параметр вернулся 20.08 (ТЗ 19.08 §4: «восстановление отдельно»).
      // Период восстановления (мс на единицу). Старое `recoveryPerHour` больше не отдаём:
      // «единиц в час» не выражало ни «единицу за 20 минут», ни «за полтора часа».
      recoveryEveryMs: recoveryEveryMs(profile),
      restUntil: Number(s.restUntil) || 0,
      actionsTotal: Number(s.actionsTotal) || 0,
      resting: (Number(s.restUntil) || 0) > now,
      // Когда аккаунт вернётся в строй (0 — уже может). Карточка показывает обратный
      // отсчёт: «устал» без срока — половина ответа.
      freeAt: freeAt(s, profile, now),
      // Шанс текущего часа: без него «почему аккаунт ничего не делает» приходится
      // выяснять по логам задачи — а ответ обычно именно здесь.
      chanceNow: Math.round((schedule[hour] || 0) * 100),
      scheduleCustom: !!(s.schedule && typeof s.schedule === 'object'),
    }
  }
  return out
}

/** Распорядок аккаунта в процентах — для формы редактирования. */
export async function getSchedulePercent(accountId) {
  const s = await getActivity(accountId)
  const out = {}
  for (let h = 0; h < 24; h++) out[h] = Math.round((s.schedule[h] || 0) * 100)
  return { schedule: out, custom: s.scheduleCustom }
}

/**
 * Зафиксировать совершённое действие: усталость +1, при достижении порога — отдых.
 * Вызывается из воркеров ПОСЛЕ успешного действия, любым модулем.
 */
export async function noteAction(accountId, now = Date.now()) {
  if (!accountId) return null
  let patch = null
  await activityStore.mutate((all) => {
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
/*
 * Неудачный бросок распорядка ПОМНИМ до назначенного срока.
 *
 * Жалоба владельца 25.08: «следующая попытка не трекается — он сразу три раза запустил,
 * пока не выпало положительно». Так и было: бросок был без памяти, и на каждом круге
 * (а круг это секунды) аккаунт получал новый шанс. Строка «следующая попытка через 45 с»
 * оказывалась пустым обещанием, но хуже другое — сам распорядок терял смысл: профиль,
 * активный на 44%, при десятке бросков подряд выходил на работу почти всегда.
 *
 * Держим в памяти процесса, а не в хранилище: срок короткий (десятки секунд), а все
 * воркеры живут в одном процессе — распорядок «сквозь модули» этим и обеспечивается.
 * После перезапуска бэкенда бросок будет новый, и это нормально: перезапуск и так
 * начинает смену заново.
 */
const scheduleHold = new Map() // accountId → { until, reason, chance }

/** Для тестов и обслуживания: забыть отложенные броски. */
export function clearScheduleHolds() { scheduleHold.clear() }

export async function canWorkNow(accountId, now = Date.now(), rnd = Math.random) {
  const s = await getActivity(accountId)
  const f = fatigueGate(s, s.profile, now)
  if (!f.ok) return f
  const held = scheduleHold.get(accountId)
  if (held && now < held.until) {
    // `cached` — чтобы воркер не писал одну и ту же строку на каждом круге: причина
    // уже названа, и повторять её раз в десять секунд для полусотни аккаунтов незачем.
    return { ok: false, reason: held.reason, chance: held.chance, until: held.until, cached: true }
  }
  const g = scheduleGate(s.schedule, now, rnd)
  if (!g.ok && g.until) scheduleHold.set(accountId, { until: g.until, reason: g.reason, chance: g.chance })
  else if (g.ok) scheduleHold.delete(accountId)
  return g
}

/**
 * §4.5: задать профиль усталости/распорядок — одному или СРАЗУ ПАЧКЕ аккаунтов.
 * Массовое задание — прямой запрос владельца: «чтобы можно было массово всем задавать
 * усталость и отдых от модулей, как живой человек».
 * Распорядок принимается в процентах (0–100) — так его редактирует оператор.
 * `spread` (по умолчанию включён) раздаёт КАЖДОМУ свой сдвиг вокруг заданной кривой:
 * без этого массовое задание одного расписания на 48 аккаунтов само создаёт кластер,
 * от которого мы и защищаемся. Выключать имеет смысл, только если распорядок должен
 * совпасть до часа (например, дежурная пара аккаунтов под конкретное окно).
 *
 * @param {string[]} accountIds
 * @param {{profile?:object, schedule?:object, spread?:boolean, reset?:boolean}} patch
 */
export async function setActivityProfile(accountIds, patch = {}) {
  const ids = (Array.isArray(accountIds) ? accountIds : []).filter(Boolean)
  if (!ids.length) return 0
  const profile = patch.profile ? normalizeFatigueProfile(patch.profile) : null
  const base = patch.schedule ? normalizeSchedule(patch.schedule) : null
  const spread = patch.spread !== false
  await activityStore.mutate((all) => {
    const next = { ...(all || {}) }
    for (const id of ids) {
      const cur = next[id] || {}
      next[id] = {
        ...cur,
        ...(profile ? { profile } : {}),
        ...(base ? { schedule: spread ? scheduleForAccount(id, base) : base } : {}),
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
  await activityStore.mutate((all) => {
    const next = { ...(all || {}) }
    for (const id of ids) next[id] = { ...(next[id] || {}), restUntil: until }
    return next
  })
  return ids.length
}
