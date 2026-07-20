/** CRUD-роуты сущности «Цель» (§3.6). Монтируется в /api/goals. */
import { Router } from 'express'
import { listGoals, getGoal, createGoal, updateGoal, deleteGoal } from './goals.js'
import { listKb, createKb, updateKb, deleteKb, deleteKbByGoal } from './knowledgeBase.js'
import { saveKbFile, readKbFile, deleteKbFile, isValidRef } from './kbFiles.js'

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

// §4: база знаний с ФАЙЛАМИ. Файл приходит data-URL'ом; на диск кладём отдельно,
// в записи КБ остаётся только fileRef (см. server/kbFiles.js).
goalsRouter.post('/:goalId/kb/upload', async (req, res) => {
  try {
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
goalsRouter.get('/kb-file/:ref', async (req, res) => {
  try {
    const { ref } = req.params
    if (!isValidRef(ref)) return res.status(400).json({ ok: false, error: 'Некорректная ссылка на файл' })
    const buf = await readKbFile(ref)
    if (!buf) return res.status(404).json({ ok: false, error: 'Файл не найден' })
    res.type(ref.split('.').pop() || 'bin').send(buf)
  } catch (err) { fail(res, err, 500) }
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
    // §4: вместе с записью убираем и сам файл, чтобы не копить мусор на диске.
    const items = await listKb(req.params.goalId)
    const target = items.find((i) => i.id === req.params.kbId)
    const ok = await deleteKb(req.params.kbId)
    if (!ok) return res.status(404).json({ ok: false, error: 'Запись не найдена' })
    if (target?.fileRef) await deleteKbFile(target.fileRef)
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})
