/**
 * Сущность «Цель» (Goal) — слой Целей/KB/Лидов (§3.6, docs/ARCH-goals-crm.md).
 * MVP: бэкенд-скелет CRUD. Хранение — JSON в server/data/goals.json (как папки целей).
 * Путь переопределяется env GOALS_FILE (изоляция в тестах).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

function sbGoals() { return supabaseEnabled() ? getSupabase() : null }
// row → полный объект цели: data-jsonb несёт все поля кроме id/name/времени.
const rowToGoal = (r) => ({ id: r.id, name: r.name, ...(r.data || {}), createdAt: r.created_at ? new Date(r.created_at).getTime() : 0, updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0 })
const goalToRow = (g) => {
  const { id, name, createdAt, updatedAt, ...data } = g
  return { id, name, data, created_at: new Date(createdAt || Date.now()).toISOString(), updated_at: new Date(updatedAt || Date.now()).toISOString() }
}

/**
 * Путь считаем ЛЕНИВО, при каждом обращении.
 *
 * Раньше он вычислялся один раз при импорте модуля — и тест, выставивший GOALS_FILE
 * уже после того, как модуль подтянулся по цепочке импортов, писал в БОЕВОЙ файл.
 * Именно так в рабочие цели попали четыре тестовых.
 */
const goalsFile = () => process.env.GOALS_FILE || dataPath('goals.json')

/** Поля, которые можно задавать/менять (остальное — служебное). */
// SPEC §1.2 (решение звонка 22.07): цель отвечает на «чего добиваемся» — измеримый
// результат, критерий завершения, дедлайн, аудитория. Тон, ограничения и дожим ушли
// в сущность «Агент»: это манера общения, а не результат, и одна цель не должна
// навязывать один голос всем кампаниям (сценарий «500 хвалят / 500 спорят»).
// Старые цели с этими полями читаются как есть — миграция не нужна, поля просто
// перестают участвовать в промпте и в форме.
const FIELDS = ['name', 'description', 'metric', 'status', 'priority', 'period']

/** Жизненный цикл цели: активна → достигнута/в архиве. Управляется вручную. */
export const GOAL_STATUSES = ['active', 'achieved', 'archived']
/** Приоритет цели — чтобы понимать, какая важнее для кампаний. */
export const GOAL_PRIORITIES = ['low', 'mid', 'high']

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
 * Сколько единиц нужно набрать (0 = не задано).
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
 * Что именно считаем. Виды берём не с потолка: это те результаты, которые система
 * умеет посчитать сама. Для остального — `custom`, там оператор ведёт счёт руками.
 */
export const METRIC_KINDS = ['leads', 'clicks', 'joins', 'replies', 'custom']

/** Человеческие названия единиц — для карточки и отчёта кампании. */
export const METRIC_LABELS = {
  leads: 'горячих лидов',
  clicks: 'переходов по ссылке',
  joins: 'вступлений',
  replies: 'ответов',
  custom: 'шт.',
}

/**
 * Измеримый результат цели — «число + единица» из §1.1 спеки.
 *
 * Это и есть вся цель: ЧТО получить и СКОЛЬКО. Ни модулей, ни каналов, ни тона —
 * цель про результат, а не про способ. Считает система, отдаёт кампании для статистики.
 * @param {*} v @param {*} legacyLeadTarget старое поле `leadTarget` — не ломаем цели до правки
 */
function normMetric(v, legacyLeadTarget) {
  const m = v && typeof v === 'object' ? v : {}
  const kind = METRIC_KINDS.includes(m.kind) ? m.kind : 'leads'
  return {
    kind,
    target: normLeadTarget(m.target ?? legacyLeadTarget),
    // Единица словами: пусто — берём стандартную по виду.
    unit: String(m.unit ?? '').trim().slice(0, 40) || METRIC_LABELS[kind],
  }
}

/** Статус цели из белого списка, иначе 'active'. @param {*} v */
function normStatus(v) {
  return GOAL_STATUSES.includes(v) ? v : 'active'
}

/** Приоритет из белого списка, иначе 'mid'. @param {*} v */
function normPriority(v) {
  return GOAL_PRIORITIES.includes(v) ? v : 'mid'
}

/**
 * Период учёта счётчика: `all` — за всё время, `from` — с даты `from` (та же проверка
 * даты, что у дедлайна). Раньше период статистики нигде не задавался (открытый вопрос
 * §10 отчёта) — счёт всегда шёл за всё время.
 * @param {*} v @returns {{mode:'all'|'from', from:string|null}}
 */
function normPeriod(v) {
  const p = v && typeof v === 'object' ? v : {}
  const from = normDeadline(p.from) // 'YYYY-MM-DD' в разумных годах или null
  const mode = p.mode === 'from' && from ? 'from' : 'all'
  return { mode, from: mode === 'from' ? from : null }
}

/**
 * §4: дедлайн задали, но он не прошёл проверку. Нужен, чтобы форма показала ошибку,
 * а не молча «забыла» дату — иначе оператор уверен, что дедлайн стоит.
 * @param {*} input
 */
function rejectedDeadline(input) {
  return Boolean(input?.deadline) && normDeadline(input.deadline) === null
}

/**
 * Нормализовать вход в чистую цель.
 *
 * Цель — это СЧЁТЧИК: что нужно получить и сколько. Всё остальное вынесено
 * (решения звонков 22.07 и 24.07):
 *   тон, ограничения, характер, язык, критерий завершения, аудитория, база знаний → АГЕНТ
 *   дожим, дедлайн, каналы, модули                                               → КАМПАНИЯ
 * Прямая цитата заказчика: «Цель нахуй не знает ни про модули, ни про общение,
 * ни про тон. Она и про группы, по сути, ничего знать не должна.»
 *
 * Старые цели с лишними полями читаются как есть: поля просто перестают
 * участвовать — отдельная миграция не нужна.
 * @param {object} input
 */
export function normalizeGoal(input = {}) {
  return {
    name: String(input.name ?? '').trim(),
    // Свободный текст желания сохраняется в модели для СТАРЫХ целей (мейлинг ещё читает
    // из него варианты первого сообщения), но из формы убран: цель не «руководит» ИИ.
    // Источник первого сообщения переезжает в Агента (шаг «мейлинг↔агент»).
    description: String(input.description ?? ''),
    // Измеримый результат: что считаем и сколько нужно.
    metric: normMetric(input.metric, input.leadTarget),
    // Жизненный цикл, приоритет и период учёта счётчика.
    status: normStatus(input.status),
    priority: normPriority(input.priority),
    period: normPeriod(input.period),
  }
}

/**
 * §4: истёк ли дедлайн. Чистая функция.
 *
 * Дедлайн переехал из цели в КАМПАНИЮ (решение 24.07): срок — это про этап работы,
 * а не про желаемый результат. Функция осталась общей: ей всё равно, у кого читать
 * поле `deadline`, — вызывающий передаёт кампанию. Имя сохранено, чтобы не трогать
 * вызовы в воркерах ради переименования.
 * @param {{deadline?: string|null}} owner цель (legacy) или кампания @param {number} [now]
 */
export function isGoalExpired(owner, now = Date.now()) {
  if (!owner?.deadline) return false
  const d = new Date(owner.deadline)
  if (isNaN(d.getTime())) return false
  // Дедлайн — конец указанного дня (включительно).
  return now > d.getTime() + 24 * 60 * 60 * 1000 - 1
}

export async function listGoals() {
  const db = sbGoals()
  if (db) {
    const { data } = await db.from('goals').select('*').order('created_at', { ascending: false })
    return (data || []).map((r) => { const g = rowToGoal(r); return { id: g.id, ...normalizeGoal(g), createdAt: g.createdAt, updatedAt: g.updatedAt } })
  }
  const all = await readJson(goalsFile(), [])
  if (!Array.isArray(all)) return []
  // Цели, заведённые до переезда полей, лежат в файле как есть — но наружу отдаём
  // только то, чем цель является сейчас. Иначе форма и промпт продолжали бы видеть
  // тон, каналы и дедлайн, которых у цели больше нет, и модель тихо поехала бы назад.
  // Файл при этом не трогаем: перезапишется при первом сохранении цели.
  return all.map((g) => ({ id: g.id, ...normalizeGoal(g), createdAt: g.createdAt, updatedAt: g.updatedAt }))
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
  const db = sbGoals()
  if (db) { await db.from('goals').insert(goalToRow(goal)); return goal }
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
    if (patch[k] === undefined) continue
    if (k === 'metric') goals[i].metric = normMetric(patch[k], goals[i].metric?.target)
    else if (k === 'status') goals[i].status = normStatus(patch[k])
    else if (k === 'priority') goals[i].priority = normPriority(patch[k])
    else if (k === 'period') goals[i].period = normPeriod(patch[k]) // объект — String() сломал бы
    else if (k === 'name') goals[i].name = String(patch[k]).trim()
    else goals[i][k] = String(patch[k]) // description
  }
  if (!goals[i].name) throw new Error('Название цели не может быть пустым')
  goals[i].updatedAt = Date.now()
  const db = sbGoals()
  if (db) { await db.from('goals').update(goalToRow(goals[i])).eq('id', id); return goals[i] }
  await writeJson(goalsFile(), goals)
  return goals[i]
}

/**
 * Счётчик цели: сколько уже набрано против того, сколько нужно.
 *
 * Считает СЕРВЕР, а не карточка: тот же счёт нужен кампании для статистики и отчёта
 * клиенту. Пока он жил в форме целей, кампания о нём не знала и показать «сколько
 * сделали к цели» не могла.
 *
 * Что во что засчитывается:
 *   `leads`   — лиды со статусом `target` («выполнил целевое действие»). Это единственный
 *               вид, который система считает сама и без доп. инфраструктуры (SPEC §1.3).
 *   `clicks`  — переходы по нашей короткой ссылке (linkTracker).
 *   остальные — счётчика пока нет: отдаём `counted: false`, чтобы интерфейс не рисовал
 *               «0 из 200» там, где считать нечем, и не выдавал это за правду.
 *
 * Отдельно считаем **дожатых** — тех, кого довели после закрытия диалога: это уже не
 * та же воронка, и мерить их вместе с остальными значит не понимать, что сработало.
 *
 * @param {string} goalId @returns {Promise<{done:number, target:number, pct:number,
 *   counted:boolean, followUpsDone:number, unit:string, kind:string}>}
 */
export async function goalProgress(goalId) {
  const goal = await getGoal(goalId)
  const metric = goal?.metric || { kind: 'leads', target: 0, unit: '' }
  const out = {
    kind: metric.kind, target: metric.target || 0, unit: metric.unit || '',
    done: 0, pct: 0, counted: false, followUpsDone: 0,
  }
  if (!goal) return out

  try {
    if (metric.kind === 'leads') {
      const { listLeads } = await import('./leads.js')
      const leads = await listLeads()
      const mine = (Array.isArray(leads) ? leads : []).filter((l) => l.goalId === goalId)
      // Цель достигнута — это статус `target`. Просто «есть лид» целью не считается:
      // иначе счётчик показывал бы успех там, где человек ещё ничего не сделал.
      out.done = mine.filter((l) => l.status === 'target').length
      out.followUpsDone = mine.filter((l) => (Number(l.followUps) || 0) > 0).length
      out.counted = true
    } else if (metric.kind === 'clicks') {
      const { goalHits } = await import('./linkTracker.js')
      const h = await goalHits(goalId)
      // Считаем УНИКАЛЬНЫЕ переходы: «20 000 переходов» — это люди, а не обновления
      // страницы одним и тем же человеком.
      out.done = h.uniqueHits || h.hits || 0
      out.counted = true
    }
  } catch { /* счётчик недоступен — отдаём план без факта, это честнее нуля */ }

  out.pct = out.target > 0 ? Math.min(100, Math.round((out.done / out.target) * 100)) : 0
  return out
}

/** Счётчики сразу по всем целям — для списка и для статистики кампаний. */
export async function allGoalProgress() {
  const goals = await listGoals()
  const out = {}
  for (const g of goals) out[g.id] = await goalProgress(g.id)
  return out
}

/** @param {string} id @returns {Promise<boolean>} */
export async function deleteGoal(id) {
  const db = sbGoals()
  if (db) {
    const { data } = await db.from('goals').delete().eq('id', id).select('id')
    return !!(data && data.length)
  }
  const goals = await listGoals()
  const next = goals.filter((g) => g.id !== id)
  if (next.length === goals.length) return false
  await writeJson(goalsFile(), next)
  return true
}
