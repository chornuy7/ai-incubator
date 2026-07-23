/** CRUD-роуты сущности «Агент» (§9, спека 22.07). Монтируется в /api/agents. */
import { Router } from 'express'
import { listAgents, getAgent, createAgent, updateAgent, deleteAgent } from './agents.js'

export const agentsRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

agentsRouter.get('/', async (_req, res) => {
  try {
    res.json({ ok: true, agents: await listAgents() })
  } catch (err) { fail(res, err, 500) }
})

agentsRouter.get('/:id', async (req, res) => {
  try {
    const agent = await getAgent(req.params.id)
    if (!agent) return res.status(404).json({ ok: false, error: 'Агент не найден' })
    res.json({ ok: true, agent })
  } catch (err) { fail(res, err, 500) }
})

agentsRouter.post('/', async (req, res) => {
  try {
    res.json({ ok: true, agent: await createAgent(req.body ?? {}) })
  } catch (err) { fail(res, err) }
})

agentsRouter.put('/:id', async (req, res) => {
  try {
    const agent = await updateAgent(req.params.id, req.body ?? {})
    if (!agent) return res.status(404).json({ ok: false, error: 'Агент не найден' })
    res.json({ ok: true, agent })
  } catch (err) { fail(res, err) }
})

agentsRouter.delete('/:id', async (req, res) => {
  try {
    const ok = await deleteAgent(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Агент не найден' })
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})
