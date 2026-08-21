/** CRUD-роуты сущности «Агент» (§9, спека 22.07). Монтируется в /api/agents. */
import { Router } from 'express'
import { listAgents, getAgent, createAgent, updateAgent, deleteAgent } from './agents.js'
import { ownedForRequest, ownsRecord } from './lib/accessGuard.js'

export const agentsRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

/**
 * Персона под id и право автора запроса на неё.
 *
 * Аудит 21.08: список агентов закрыли по владельцу, а точечные роуты — нет. Агент это
 * тон, запреты и заготовки ПЕРВОГО сообщения, то есть готовый сценарий продаж: по одному
 * id его можно было прочитать целиком. Хуже правка — подменённый `toneOfVoice` или
 * `restrictions` меняет речь всех рассылок владельца, и заметит он это по спамблокам.
 * @returns {Promise<{agent: object|null, allowed: boolean}>}
 */
async function agentAccess(req, id) {
  const agent = await getAgent(id)
  if (!agent) return { agent: null, allowed: false }
  return { agent, allowed: await ownsRecord(req, agent) }
}

/** Единый отказ: агента нет — 404, агент чужой — 403. */
function denyAgent(res, agent) {
  return agent
    ? res.status(403).json({ ok: false, error: 'Это не ваш агент' })
    : res.status(404).json({ ok: false, error: 'Агент не найден' })
}

/** Гейт для роутов базы знаний агента: пускаем только владельца персоны-контейнера. */
async function guardAgentKb(req, res) {
  const { agent, allowed } = await agentAccess(req, req.params.agentId)
  if (allowed) return true
  denyAgent(res, agent)
  return false
}

// Аудит 20.08: агенты отдавались все всем — фильтруем по владельцу пространства.
agentsRouter.get('/', async (req, res) => {
  try {
    res.json({ ok: true, agents: await ownedForRequest(req, await listAgents()) })
  } catch (err) { fail(res, err, 500) }
})

agentsRouter.get('/:id', async (req, res) => {
  try {
    const { agent, allowed } = await agentAccess(req, req.params.id)
    if (!allowed) return denyAgent(res, agent)
    res.json({ ok: true, agent })
  } catch (err) { fail(res, err, 500) }
})

agentsRouter.post('/', async (req, res) => {
  try {
    // §11.3: персона привязывается к создателю. x-user-id ставит sessionGuard из
    // ПОДПИСАННОЙ сессии, присланный клиентом заголовок он срезает.
    const agent = await createAgent({ ...(req.body ?? {}), userId: req.body?.userId || req.header('x-user-id') || '' })
    res.json({ ok: true, agent })
  } catch (err) { fail(res, err) }
})

agentsRouter.put('/:id', async (req, res) => {
  try {
    const { agent: existing, allowed } = await agentAccess(req, req.params.id)
    if (!allowed) return denyAgent(res, existing)
    const agent = await updateAgent(req.params.id, req.body ?? {})
    if (!agent) return res.status(404).json({ ok: false, error: 'Агент не найден' })
    res.json({ ok: true, agent })
  } catch (err) { fail(res, err) }
})

agentsRouter.delete('/:id', async (req, res) => {
  try {
    const { agent, allowed } = await agentAccess(req, req.params.id)
    if (!allowed) return denyAgent(res, agent)
    const ok = await deleteAgent(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Агент не найден' })
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})

/* ─────────────────────────────────────────────────────────────────────────────
   База знаний АГЕНТА (переезд из цели, решение 24.07).

   База знаний — это факты о продукте, на которые персона опирается в разговоре:
   что говорить, чем подтвердить, куда вести. Это часть ведения диалога, а не
   измеримого результата, поэтому живёт у агента.

   Хранилище общее (`knowledge.json`): запись привязана к id владельца. Поле в
   файле по-прежнему называется `goalId` — переименовывать его значило бы
   мигрировать существующие записи ради косметики. Идентификаторы не пересекаются
   (`goal_…` vs `agent_…`), так что путаницы не будет.
   ───────────────────────────────────────────────────────────────────────────── */
import { listKb, createKb, deleteKb } from './knowledgeBase.js'
import { saveKbFile, deleteKbFile } from './kbFiles.js'
import { fetchPageText } from './lib/pageFetch.js'

// База знаний — это прайсы, условия и внутренние факты о продукте. Читать и пополнять
// её может только владелец персоны: иначе по одному id отдавалась чужая коммерческая
// кухня, а чужая запись в КБ — это ещё и подсунутый агенту «факт», с которым он пойдёт
// в переписку от имени владельца.
agentsRouter.get('/:agentId/kb', async (req, res) => {
  try {
    if (!(await guardAgentKb(req, res))) return
    res.json({ ok: true, items: await listKb(req.params.agentId) })
  } catch (err) { fail(res, err, 500) }
})

agentsRouter.post('/:agentId/kb', async (req, res) => {
  try {
    if (!(await guardAgentKb(req, res))) return
    res.json({ ok: true, item: await createKb(req.params.agentId, req.body ?? {}) })
  } catch (err) { fail(res, err) }
})

// Файл приходит data-URL'ом; на диск кладём отдельно, в записи остаётся только fileRef.
agentsRouter.post('/:agentId/kb/upload', async (req, res) => {
  try {
    if (!(await guardAgentKb(req, res))) return
    const { name, dataUrl, title } = req.body ?? {}
    const saved = await saveKbFile(name, dataUrl)
    const item = await createKb(req.params.agentId, {
      kind: saved.kind,
      title: String(title || saved.name),
      content: `${saved.name} · ${Math.max(1, Math.round(saved.size / 1024))} КБ`,
      fileRef: saved.ref,
    })
    res.json({ ok: true, item, file: saved })
  } catch (err) { fail(res, err) }
})

/**
 * Ссылки и страницы ПАЧКОЙ: список URL, по одному в строке.
 *
 * Текст страницы забираем сразу — модель по ссылке не ходит, и голый URL в промпте
 * бесполезен. Одна недоступная страница не отменяет остальные: по каждой возвращаем
 * свой исход, чтобы оператор видел, что именно не подтянулось.
 */
agentsRouter.post('/:agentId/kb/links', async (req, res) => {
  try {
    if (!(await guardAgentKb(req, res))) return
    const raw = Array.isArray(req.body?.urls) ? req.body.urls : String(req.body?.text || '').split(/[\s,]+/)
    const urls = [...new Set(raw.map((u) => String(u || '').trim()).filter(Boolean))].slice(0, 50)
    if (!urls.length) return res.status(400).json({ ok: false, error: 'Не указано ни одной ссылки' })

    const added = []
    const failed = []
    // По 4 страницы разом: последовательно 50 ссылок — это минуты ожидания в форме.
    for (let i = 0; i < urls.length; i += 4) {
      const batch = await Promise.all(urls.slice(i, i + 4).map(async (url) => ({ url, r: await fetchPageText(url) })))
      for (const { url, r } of batch) {
        if (!r.ok) { failed.push({ url, reason: r.reason }); continue }
        try {
          added.push(await createKb(req.params.agentId, {
            kind: 'link', url, title: r.title || url, content: r.text,
          }))
        } catch (e) {
          failed.push({ url, reason: e instanceof Error ? e.message : 'не сохранено' })
        }
      }
    }
    res.json({ ok: true, added, failed })
  } catch (err) { fail(res, err) }
})

agentsRouter.delete('/:agentId/kb/:kbId', async (req, res) => {
  try {
    if (!(await guardAgentKb(req, res))) return
    // Вместе с записью убираем и сам файл, чтобы не копить мусор на диске.
    const items = await listKb(req.params.agentId)
    const target = items.find((i) => i.id === req.params.kbId)
    // Запись обязана принадлежать ИМЕННО этому агенту: deleteKb ищет по своему id и про
    // агента в адресе не знает, так что со своим agentId в пути сносилась чужая запись.
    if (!target) return res.status(404).json({ ok: false, error: 'Запись не найдена' })
    const ok = await deleteKb(req.params.kbId)
    if (!ok) return res.status(404).json({ ok: false, error: 'Запись не найдена' })
    if (target.fileRef) await deleteKbFile(target.fileRef)
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})
