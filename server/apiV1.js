/**
 * §10.3: публичный API v1 для внешнего AI-оркестратора («мозги»).
 *
 * Всё под закрытым ключом (Authorization: Bearer aii_live_sk_…). Даёт то, что
 * просили на созвоне 27.07:
 *  1) создавать цели / кампании / задачи модулей по ключу;
 *  2) спрашивать, ЧТО умеет каждый модуль (capabilities) — тот же ответ пригоден
 *     как MCP-манифест инструментов;
 *  3) до запуска отдавать estimate (стоимость + время).
 *
 * Слой тонкий: переиспользует те же серверные функции, что и UI (createGoal,
 * createCampaign, startModuleTask, effectivePrices) — один источник правды, а не
 * второй путь мимо валидаций.
 */
import { Router } from 'express'
import { requireApiKey } from './apiKeys.js'
import { MODULE_DEFS, listModuleKeys, startModuleTask } from './modules/registry.js'
import { moduleTitle } from './lib/moduleTitles.js'

export const apiV1Router = Router()

apiV1Router.use(requireApiKey())

/** Собрать «что умеет модуль» — из дефинишенов + эффективных цен. */
async function capabilities() {
  const { effectivePrices } = await import('./priceStore.js')
  const eff = await effectivePrices()
  const priceOf = (k) => eff.modules.find((m) => m.key === k) || { month: 0, action: 0 }
  return listModuleKeys().map((key) => {
    const def = MODULE_DEFS[key]
    const p = priceOf(key)
    return {
      key,
      title: moduleTitle(key),
      requiresTargets: !!def.requiresTargets,
      targetLabel: def.targetLabel || null,
      pricing: { subscriptionPerMonth: p.month, perAction: p.action, currency: eff.currency || '$', coinsPer1kTokens: eff.coinsPer1kTokens },
      run: {
        method: 'POST',
        path: `/api/v1/modules/${key}/run`,
        body: {
          accountIds: 'string[] — аккаунты, которыми работать (обязательно)',
          ...(def.requiresTargets ? { targets: `string[] — ${def.targetLabel || 'цели'} (обязательно)` } : {}),
          maxActions: 'number — сколько действий (лимит)',
          goalId: 'string? — под какой целью',
          campaignId: 'string? — под какой кампанией',
        },
      },
    }
  })
}

/** §10.3(2): что умеет каждый модуль. */
apiV1Router.get('/capabilities', async (_req, res) => {
  try { res.json({ ok: true, modules: await capabilities() }) }
  catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})

/**
 * MCP-манифест: те же возможности, оформленные как список инструментов. Внешний
 * оркестратор может брать отсюда tools, а вызывать — обычными POST ниже.
 */
apiV1Router.get('/mcp', async (_req, res) => {
  try {
    const caps = await capabilities()
    const tools = [
      { name: 'create_goal', description: 'Создать цель (измеримый результат)', method: 'POST', path: '/api/v1/goals', input: { name: 'string', metric: 'string?', target: 'number?', deadline: 'YYYY-MM-DD?' } },
      { name: 'create_campaign', description: 'Создать кампанию под цель', method: 'POST', path: '/api/v1/campaigns', input: { name: 'string', modules: 'string[]', goalId: 'string?' } },
      { name: 'estimate', description: 'Оценить стоимость и время до запуска', method: 'POST', path: '/api/v1/modules/:key/estimate', input: { actions: 'number', accounts: 'number?' } },
      ...caps.map((c) => ({ name: `run_${c.key.replace(/-/g, '_')}`, description: `Запустить модуль «${c.title}»`, method: 'POST', path: c.run.path, input: c.run.body })),
    ]
    res.json({ ok: true, name: 'murmex', version: '1', tools })
  } catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})

/** §10.3(1): цели. */
apiV1Router.get('/goals', async (_req, res) => {
  try { const { listGoals } = await import('./goals.js'); res.json({ ok: true, goals: await listGoals() }) }
  catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})
apiV1Router.post('/goals', async (req, res) => {
  try { const { createGoal } = await import('./goals.js'); res.json({ ok: true, goal: await createGoal(req.body || {}) }) }
  catch (err) { res.status(400).json({ ok: false, error: msg(err) }) }
})

/** §10.3(1): кампании. */
apiV1Router.get('/campaigns', async (_req, res) => {
  try { const { listCampaigns } = await import('./campaigns.js'); res.json({ ok: true, campaigns: await listCampaigns() }) }
  catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})
apiV1Router.post('/campaigns', async (req, res) => {
  try { const { createCampaign } = await import('./campaigns.js'); res.json({ ok: true, campaign: await createCampaign(req.body || {}) }) }
  catch (err) { res.status(400).json({ ok: false, error: msg(err) }) }
})

/** §10.3 + §10.1: estimate стоимости и времени ДО запуска. */
apiV1Router.post('/modules/:key/estimate', async (req, res) => {
  try {
    const key = req.params.key
    if (!MODULE_DEFS[key]) return res.status(404).json({ ok: false, error: 'Неизвестный модуль' })
    const actions = Math.max(0, Math.round(Number(req.body?.actions) || 0))
    const accounts = Math.max(1, Math.round(Number(req.body?.accounts) || 1))
    const { effectivePrices } = await import('./priceStore.js')
    const eff = await effectivePrices()
    const perAction = eff.actionMap[key] || 0
    const actionsCost = Math.round(perAction * actions * 1000) / 1000
    // Время: действия делятся между аккаунтами, задержка 30–120 c (как в модулях).
    const perAcc = Math.ceil(actions / accounts)
    const time = { minSec: perAcc * 30, maxSec: perAcc * 120 }
    res.json({
      ok: true,
      module: key,
      actions,
      accounts,
      cost: { actionsCoins: actionsCost, currency: eff.currency || '$', note: 'Токены ИИ добавятся по факту — их расход заранее неизвестен.' },
      time,
    })
  } catch (err) { res.status(500).json({ ok: false, error: msg(err) }) }
})

/** §10.3(3): запуск модуля. Та же функция, что у UI, — валидации те же. */
apiV1Router.post('/modules/:key/run', async (req, res) => {
  try {
    const key = req.params.key
    if (!MODULE_DEFS[key]) return res.status(404).json({ ok: false, error: 'Неизвестный модуль' })
    const settings = { ...(req.body || {}), initiator: 'api' }
    const { store, task, worker } = startModuleTask(key, settings)
    // Запуск воркера — тем же способом, что и UI-роут (modules/routes.js).
    const { startWorker } = await import('./modules/workers.js')
    startWorker(task.id, store, worker)
    res.json({ ok: true, taskId: task.id, module: key, status: task.status })
  } catch (err) { res.status(400).json({ ok: false, error: msg(err) }) }
})

function msg(err) { return err instanceof Error ? err.message : 'Ошибка' }
