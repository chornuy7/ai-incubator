/** CRUD-роуты сущности «Цель» (§3.6). Монтируется в /api/goals. */
import { Router } from 'express'
import { listGoals, getGoal, createGoal, updateGoal, deleteGoal, goalProgress } from './goals.js'
import { getAgent } from './agents.js'
import { listKb, createKb, updateKb, deleteKb, deleteKbByGoal } from './knowledgeBase.js'
import { saveKbFile, readKbFile, deleteKbFile, isValidRef } from './kbFiles.js'
import { ownedForRequest, ownsRecord } from './lib/accessGuard.js'

export const goalsRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

/**
 * Цель под id и право автора запроса на неё.
 *
 * Аудит 21.08: список целей закрыли по владельцу, а точечные роуты остались открытыми.
 * Id цели не секрет — он виден в ссылке, в карточке кампании, в задачах и логах, поэтому
 * фильтр на списке защищал только от случайного взгляда: `GET /:id` отдавал чужую
 * стратегию и метрику, `PUT` переписывал чужую цель, `DELETE` сносил её вместе с базой
 * знаний. Считаем по владельцу пространства — админ и дев-режим по-прежнему видят всё.
 * @returns {Promise<{goal: object|null, allowed: boolean}>}
 */
async function goalAccess(req, id) {
  const goal = await getGoal(id)
  if (!goal) return { goal: null, allowed: false }
  return { goal, allowed: await ownsRecord(req, goal) }
}

/** Единый отказ: цели нет — 404, цель чужая — 403. */
function denyGoal(res, goal) {
  return goal
    ? res.status(403).json({ ok: false, error: 'Это не ваша цель' })
    : res.status(404).json({ ok: false, error: 'Цель не найдена' })
}

/** Гейт для роутов базы знаний цели: пускаем только владельца цели-контейнера. */
async function guardGoalKb(req, res) {
  const { goal, allowed } = await goalAccess(req, req.params.goalId)
  if (allowed) return true
  denyGoal(res, goal)
  return false
}

/**
 * Запись КБ, которая ДЕЙСТВИТЕЛЬНО принадлежит этой цели.
 *
 * `updateKb`/`deleteKb` ищут запись по её собственному id и про цель в адресе ничего
 * не знают. Без сверки хватало подставить свой goalId к чужому kbId — и чужая запись
 * правилась или удалялась в обход проверки владельца.
 */
async function kbItemOfGoal(goalId, kbId) {
  const items = await listKb(goalId)
  return items.find((i) => i.id === kbId) || null
}

/**
 * Кому принадлежит контейнер записи базы знаний.
 *
 * Записи КБ лежат одним списком, а поле `goalId` хранит id ЛИБО цели, ЛИБО агента
 * (КБ переехала к агенту 24.07, поле не переименовывали, чтобы не мигрировать данные).
 * Файлы обеих КБ отдаёт одна ручка `/kb-file/:ref`, поэтому владельца ищем в обоих местах.
 * Контейнер не нашёлся — запись ничья, её видит только админ (как в `ownedForRequest`).
 */
async function ownsKbContainer(req, containerId) {
  const goal = await getGoal(containerId)
  if (goal) return ownsRecord(req, goal)
  const agent = await getAgent(containerId).catch(() => null)
  return ownsRecord(req, agent)
}

// Аудит 20.08: роут отдавал ВСЕ цели всем — чужая стратегия/промпты были видны любому
// зарегистрировавшемуся. Владелец у цели уже пишется (ownerColumn), фильтруем на чтении.
goalsRouter.get('/', async (req, res) => {
  try {
    const goals = await ownedForRequest(req, await listGoals())
    res.json({ ok: true, goals })
  } catch (err) { fail(res, err, 500) }
})

/**
 * Счётчики по всем целям разом. Отдельным роутом (и ДО `/:id`, иначе «progress»
 * уедет в параметр), потому что этот же счёт читает статистика кампаний: цель
 * считает, кампания показывает.
 *
 * Считаем только по СВОИМ целям: сводка шла по всей платформе, и даже без названий
 * это выдавало факт существования чужих целей вместе с их результатами.
 */
goalsRouter.get('/progress', async (req, res) => {
  try {
    const mine = await ownedForRequest(req, await listGoals())
    const progress = {}
    for (const g of mine) progress[g.id] = await goalProgress(g.id)
    res.json({ ok: true, progress })
  } catch (err) { fail(res, err, 500) }
})

goalsRouter.get('/:id/progress', async (req, res) => {
  try {
    const { goal, allowed } = await goalAccess(req, req.params.id)
    if (!allowed) return denyGoal(res, goal)
    res.json({ ok: true, progress: await goalProgress(req.params.id) })
  } catch (err) { fail(res, err, 500) }
})

goalsRouter.get('/:id', async (req, res) => {
  try {
    const { goal, allowed } = await goalAccess(req, req.params.id)
    if (!allowed) return denyGoal(res, goal)
    res.json({ ok: true, goal })
  } catch (err) { fail(res, err, 500) }
})

goalsRouter.post('/', async (req, res) => {
  try {
    // §11.3: цель привязывается к создателю — иначе запись «висит в пустоте».
    // Личность берём из x-user-id, который ставит sessionGuard из ПОДПИСАННОЙ сессии
    // (присланный клиентом заголовок он срезает). Без сессии владелец пустой — это
    // правильно: анонимную запись лучше оставить без владельца, чем приписать чужому.
    res.json({ ok: true, goal: await createGoal({ ...(req.body ?? {}), userId: req.body?.userId || req.header('x-user-id') || '' }) })
  } catch (err) { fail(res, err) }
})

goalsRouter.put('/:id', async (req, res) => {
  try {
    const { goal, allowed } = await goalAccess(req, req.params.id)
    if (!allowed) return denyGoal(res, goal)
    const updated = await updateGoal(req.params.id, req.body ?? {})
    if (!updated) return res.status(404).json({ ok: false, error: 'Цель не найдена' })
    res.json({ ok: true, goal: updated })
  } catch (err) { fail(res, err) }
})

goalsRouter.delete('/:id', async (req, res) => {
  try {
    const { goal, allowed } = await goalAccess(req, req.params.id)
    if (!allowed) return denyGoal(res, goal)
    const ok = await deleteGoal(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Цель не найдена' })
    await deleteKbByGoal(req.params.id) // каскадно чистим базу знаний цели
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})

// ── База знаний цели (§3.6) ──
// КБ — это прайсы, условия и внутренние факты о продукте, поэтому читать и пополнять
// её может только владелец цели: иначе чужая коммерческая кухня отдавалась по одному id.
goalsRouter.get('/:goalId/kb', async (req, res) => {
  try {
    if (!(await guardGoalKb(req, res))) return
    res.json({ ok: true, items: await listKb(req.params.goalId) })
  } catch (err) { fail(res, err, 500) }
})

goalsRouter.post('/:goalId/kb', async (req, res) => {
  try {
    if (!(await guardGoalKb(req, res))) return
    res.json({ ok: true, item: await createKb(req.params.goalId, req.body ?? {}) })
  } catch (err) { fail(res, err) }
})

// §4: база знаний с ФАЙЛАМИ. Файл приходит data-URL'ом; на диск кладём отдельно,
// в записи КБ остаётся только fileRef (см. server/kbFiles.js).
goalsRouter.post('/:goalId/kb/upload', async (req, res) => {
  try {
    if (!(await guardGoalKb(req, res))) return
    const { name, dataUrl, title } = req.body ?? {}
    const saved = await saveKbFile(name, dataUrl)
    const item = await createKb(req.params.goalId, {
      kind: saved.kind,
      title: String(title || saved.name),
      content: `${saved.name} · ${Math.max(1, Math.round(saved.size / 1024))} КБ`,
      fileRef: saved.ref,
    })
    res.json({ ok: true, item, file: saved })
  } catch (err) { fail(res, err) }
})

// Отдача файла КБ (превью/скачивание). Ссылка валидируется от обхода каталога.
// Сама ссылка доступом не является: зная ref (он приходит в ответе на загрузку и стоит
// в разметке карточки), любой вошедший скачивал чужой прайс или договор. Поэтому
// поднимаем запись КБ по ref и спрашиваем владельца её цели/агента.
goalsRouter.get('/kb-file/:ref', async (req, res) => {
  try {
    const { ref } = req.params
    if (!isValidRef(ref)) return res.status(400).json({ ok: false, error: 'Некорректная ссылка на файл' })
    const item = (await listKb()).find((i) => i.fileRef === ref)
    if (!item) return res.status(404).json({ ok: false, error: 'Файл не найден' })
    if (!(await ownsKbContainer(req, item.goalId))) {
      return res.status(403).json({ ok: false, error: 'Это не ваш файл' })
    }
    const buf = await readKbFile(ref)
    if (!buf) return res.status(404).json({ ok: false, error: 'Файл не найден' })
    res.type(ref.split('.').pop() || 'bin').send(buf)
  } catch (err) { fail(res, err, 500) }
})

goalsRouter.put('/:goalId/kb/:kbId', async (req, res) => {
  try {
    if (!(await guardGoalKb(req, res))) return
    if (!(await kbItemOfGoal(req.params.goalId, req.params.kbId))) {
      return res.status(404).json({ ok: false, error: 'Запись не найдена' })
    }
    const item = await updateKb(req.params.kbId, req.body ?? {})
    if (!item) return res.status(404).json({ ok: false, error: 'Запись не найдена' })
    res.json({ ok: true, item })
  } catch (err) { fail(res, err) }
})

goalsRouter.delete('/:goalId/kb/:kbId', async (req, res) => {
  try {
    if (!(await guardGoalKb(req, res))) return
    // §4: вместе с записью убираем и сам файл, чтобы не копить мусор на диске.
    const target = await kbItemOfGoal(req.params.goalId, req.params.kbId)
    if (!target) return res.status(404).json({ ok: false, error: 'Запись не найдена' })
    const ok = await deleteKb(req.params.kbId)
    if (!ok) return res.status(404).json({ ok: false, error: 'Запись не найдена' })
    if (target.fileRef) await deleteKbFile(target.fileRef)
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})
