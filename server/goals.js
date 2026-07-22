/**
 * Сущность «Цель» (Goal) — слой Целей/KB/Лидов (§3.6, docs/ARCH-goals-crm.md).
 * MVP: бэкенд-скелет CRUD. Хранение — JSON в server/data/goals.json (как папки целей).
 * Путь переопределяется env GOALS_FILE (изоляция в тестах).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

/**
 * Путь считаем ЛЕНИВО, при каждом обращении.
 *
 * Раньше он вычислялся один раз при импорте модуля — и тест, выставивший GOALS_FILE
 * уже после того, как модуль подтянулся по цепочке импортов, писал в БОЕВОЙ файл.
 * Именно так в рабочие цели попали четыре тестовых.
 */
const goalsFile = () => process.env.GOALS_FILE || dataPath('goals.json')

/** Поля, которые можно задавать/менять (остальное — служебное). */
const FIELDS = ['name', 'description', 'targetAction', 'stages', 'completionCriteria', 'audience', 'channels', 'deadline', 'leadTarget', 'followUp', 'toneOfVoice', 'restrictions']

/** Нормализовать список каналов/групп цели: trim, без @, без дублей. @param {*} v */
function normChannels(v) {
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((x) => String(x || '').trim().replace(/^@/, '')).filter(Boolean))]
}

/** §4: разумные границы дедлайна. Прошлое разрешаем — по нему проверяют «цель просрочена». */
export const DEADLINE_MIN_YEAR = 2000
export const DEADLINE_MAX_YEAR = new Date().getFullYear() + 20

/** §4: потолок цели по лидам. Больше миллиона — это опечатка, а не план. */
export const LEAD_TARGET_MAX = 1_000_000

/**
 * §4: дедлайн цели — строго 'YYYY-MM-DD' в разумных годах, иначе null.
 *
 * Раньше проверка была «лишь бы `new Date()` распарсил», и в базу проходил
 * год 123123 (опечатка в поле даты): на карточке рисовалось «до 24.07.123123»,
 * а цель никогда не истекала. Год 0001 и 1899 проходили так же.
 * @param {*} v
 */
function normDeadline(v) {
  if (!v) return null
  const s = String(v).trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const year = Number(m[1])
  if (year < DEADLINE_MIN_YEAR || year > DEADLINE_MAX_YEAR) return null
  const d = new Date(`${s}T00:00:00Z`)
  if (isNaN(d.getTime())) return null
  // Отсекаем несуществующие даты вроде 2026-02-31 — Date их «доворачивает» на март.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== Number(m[2]) || d.getUTCDate() !== Number(m[3])) return null
  return s
}

/**
 * §4: сколько лидов должна привести цель (0 = не задано).
 * Ограничено сверху: без потолка в поле проходило `999999999999`, и прогресс-бар
 * на карточке становился бессмысленным.
 * @param {*} v
 */
function normLeadTarget(v) {
  const n = Math.floor(Number(v) || 0)
  if (n <= 0) return 0
  return Math.min(n, LEAD_TARGET_MAX)
}

/**
 * §4: дедлайн задали, но он не прошёл проверку. Нужен, чтобы форма показала ошибку,
 * а не молча «забыла» дату — иначе оператор уверен, что дедлайн стоит.
 * @param {*} input
 */
function rejectedDeadline(input) {
  return Boolean(input?.deadline) && normDeadline(input.deadline) === null
}

/** Нормализовать вход в чистую цель. @param {object} input */
export function normalizeGoal(input = {}) {
  return {
    name: String(input.name ?? '').trim(),
    description: String(input.description ?? ''),
    targetAction: String(input.targetAction ?? ''),
    stages: Array.isArray(input.stages) ? input.stages.map((s) => String(s)) : [],
    completionCriteria: String(input.completionCriteria ?? ''),
    audience: String(input.audience ?? ''),
    channels: normChannels(input.channels),
    deadline: normDeadline(input.deadline), // §4: дедлайн (опц.)
    leadTarget: normLeadTarget(input.leadTarget), // §4: цель по лидам (опц.)
    followUp: normFollowUp(input.followUp), // §9: дожим после достижения цели
    // §9: как писать и чего не делать. Одно место на всю кампанию — иначе правила
    // расходятся между модулями: в рассылке один тон, в комментариях другой.
    toneOfVoice: String(input.toneOfVoice ?? '').slice(0, 2000),
    restrictions: String(input.restrictions ?? '').slice(0, 2000),
  }
}

/** Сколько сообщений подряд можно дожимать одного человека, если он написал сам. */
export const FOLLOW_UP_MAX = 50
export const FOLLOW_UP_DEFAULT = 10

/**
 * §9: «дожим» — что делать, когда цель по человеку уже достигнута (или он отказался),
 * а он вдруг написал снова.
 *
 * Без этого такой человек попадал в стоп-лист навсегда: диалог закрыт, бот молчит.
 * Но написал он сам — значит интерес живой, и это самый тёплый контакт, какой бывает.
 * Лимит нужен, чтобы дожим не превратился в бесконечную переписку: исчерпали — молчим.
 * @param {*} v
 */
function normFollowUp(v) {
  if (!v || typeof v !== 'object') return { enabled: false, limit: FOLLOW_UP_DEFAULT, instructions: '' }
  const n = Math.floor(Number(v.limit) || 0)
  return {
    enabled: !!v.enabled,
    limit: n > 0 ? Math.min(n, FOLLOW_UP_MAX) : FOLLOW_UP_DEFAULT,
    instructions: String(v.instructions ?? '').slice(0, 2000),
  }
}

/**
 * §4: истёк ли дедлайн цели. Чистая функция. По истечении дедлайна работа по цели
 * должна останавливаться (воркеры), а цель — помечаться завершённой/просроченной.
 * @param {{deadline?: string|null}} goal @param {number} [now]
 */
export function isGoalExpired(goal, now = Date.now()) {
  if (!goal?.deadline) return false
  const d = new Date(goal.deadline)
  if (isNaN(d.getTime())) return false
  // Дедлайн — конец указанного дня (включительно).
  return now > d.getTime() + 24 * 60 * 60 * 1000 - 1
}

export async function listGoals() {
  const all = await readJson(goalsFile(), [])
  // Цели, созданные до появления поля, отдаём с дефолтом: иначе воркеру и форме
  // пришлось бы проверять `undefined` в каждом месте, где читается дожим.
  return (Array.isArray(all) ? all : []).map((g) => ({
    ...g,
    followUp: normFollowUp(g?.followUp),
    toneOfVoice: String(g?.toneOfVoice ?? ''),
    restrictions: String(g?.restrictions ?? ''),
  }))
}

export async function getGoal(id) {
  const goals = await listGoals()
  return goals.find((g) => g.id === id) || null
}

/** @param {object} input @throws если пустое имя */
export async function createGoal(input) {
  const clean = normalizeGoal(input)
  if (!clean.name) throw new Error('Укажите название цели')
  if (rejectedDeadline(input)) throw new Error(`Проверьте дедлайн: нужна дата в формате ГГГГ-ММ-ДД, год от ${DEADLINE_MIN_YEAR} до ${DEADLINE_MAX_YEAR}`)
  const goals = await listGoals()
  const goal = {
    id: `goal_${crypto.randomUUID().slice(0, 8)}`,
    ...clean,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  goals.unshift(goal)
  await writeJson(goalsFile(), goals)
  return goal
}

/** @param {string} id @param {object} patch @returns {Promise<object|null>} */
export async function updateGoal(id, patch = {}) {
  const goals = await listGoals()
  const i = goals.findIndex((g) => g.id === id)
  if (i === -1) return null
  if (rejectedDeadline(patch)) throw new Error(`Проверьте дедлайн: нужна дата в формате ГГГГ-ММ-ДД, год от ${DEADLINE_MIN_YEAR} до ${DEADLINE_MAX_YEAR}`)
  for (const k of FIELDS) {
    if (patch[k] !== undefined) {
      goals[i][k] = k === 'stages'
        ? (Array.isArray(patch[k]) ? patch[k].map((s) => String(s)) : goals[i].stages)
        : k === 'channels'
          ? normChannels(patch[k])
          : k === 'deadline'
            ? normDeadline(patch[k])
            : k === 'leadTarget'
              ? normLeadTarget(patch[k])
              : k === 'followUp'
                ? normFollowUp(patch[k])
                : ['toneOfVoice', 'restrictions'].includes(k)
                  ? String(patch[k] ?? '').slice(0, 2000)
                  : (k === 'name' ? String(patch[k]).trim() : String(patch[k]))
    }
  }
  if (!goals[i].name) throw new Error('Название цели не может быть пустым')
  goals[i].updatedAt = Date.now()
  await writeJson(goalsFile(), goals)
  return goals[i]
}

/** @param {string} id @returns {Promise<boolean>} */
export async function deleteGoal(id) {
  const goals = await listGoals()
  const next = goals.filter((g) => g.id !== id)
  if (next.length === goals.length) return false
  await writeJson(goalsFile(), next)
  return true
}
