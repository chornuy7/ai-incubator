/** CRUD-роуты сущности «Цель» (§3.6). Монтируется в /api/goals. */
import { Router } from 'express'
import { listGoals, getGoal, createGoal, updateGoal, deleteGoal } from './goals.js'
import { listKb, createKb, updateKb, deleteKb, deleteKbByGoal } from './knowledgeBase.js'

export const goalsRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

goalsRouter.get('/', async (_req, res) => {
  try {
    res.json({ ok: true, goals: await listGoals() })
  } catch (err) { fail(res, err, 500) }
})

goalsRouter.get('/:id', async (req, res) => {
  try {
    const goal = await getGoal(req.params.id)
    if (!goal) return res.status(404).json({ ok: false, error: 'Цель не найдена' })
    res.json({ ok: true, goal })
  } catch (err) { fail(res, err, 500) }
})

goalsRouter.post('/', async (req, res) => {
  try {
    res.json({ ok: true, goal: await createGoal(req.body ?? {}) })
  } catch (err) { fail(res, err) }
})

goalsRouter.put('/:id', async (req, res) => {
  try {
    const goal = await updateGoal(req.params.id, req.body ?? {})
    if (!goal) return res.status(404).json({ ok: false, error: 'Цель не найдена' })
    res.json({ ok: true, goal })
  } catch (err) { fail(res, err) }
})

goalsRouter.delete('/:id', async (req, res) => {
  try {
    const ok = await deleteGoal(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Цель не найдена' })
    await deleteKbByGoal(req.params.id) // каскадно чистим базу знаний цели
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})

// ── База знаний цели (§3.6) ──
goalsRouter.get('/:goalId/kb', async (req, res) => {
  try {
    res.json({ ok: true, items: await listKb(req.params.goalId) })
  } catch (err) { fail(res, err, 500) }
})

goalsRouter.post('/:goalId/kb', async (req, res) => {
  try {
    res.json({ ok: true, item: await createKb(req.params.goalId, req.body ?? {}) })
  } catch (err) { fail(res, err) }
})

goalsRouter.put('/:goalId/kb/:kbId', async (req, res) => {
  try {
    const item = await updateKb(req.params.kbId, req.body ?? {})
    if (!item) return res.status(404).json({ ok: false, error: 'Запись не найдена' })
    res.json({ ok: true, item })
  } catch (err) { fail(res, err) }
})

goalsRouter.delete('/:goalId/kb/:kbId', async (req, res) => {
  try {
    const ok = await deleteKb(req.params.kbId)
    if (!ok) return res.status(404).json({ ok: false, error: 'Запись не найдена' })
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})
