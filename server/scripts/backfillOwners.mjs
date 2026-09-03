/**
 * Разовая атрибуция: проставить владельца записям, заведённым до владельческой модели.
 *
 * Зачем. Разграничение доступа (аудит 21.08) устроено так: запись без владельца видит
 * только админ — угадать задним числом, чья она, нельзя, а показывать всем «на всякий
 * случай» это и есть та дыра, которую чинили. Но на боевом сервере такие записи уже
 * накоплены, и после выката клиент просто перестанет видеть СВОИ лиды и персоны.
 * Хуже того, правило автоматизации без владельца продолжит запускаться по расписанию,
 * а выключателя у клиента не будет.
 *
 * Как выводим владельца. Не гадаем, а идём по связям, у которых владелец есть:
 *   задача (`task.userId`) → её цель и кампания → лиды этой цели/кампании;
 *   кампания → её цель и персона;
 *   журнал (`audit.log.jsonl`) → `initiator` записи о создании.
 * Что не вывелось — оставляем как есть и печатаем списком: пусть решает человек.
 *
 * Работает и на файловом хранилище, и на Supabase: зовём сторы приложения, а не файлы.
 *
 * Запуск (по умолчанию только показывает, ничего не меняя):
 *   node server/scripts/backfillOwners.mjs
 *   node server/scripts/backfillOwners.mjs --apply
 */
import fs from 'node:fs'
import { dataPath } from '../lib/jsonStore.js'

const APPLY = process.argv.includes('--apply')
const log = (...a) => console.log(...a)

/** Карты «id сущности → владелец», собранные из всего, где владелец уже проставлен. */
const owners = { goal: new Map(), campaign: new Map(), task: new Map(), account: new Map() }

/** Владелец записи: поддерживаем оба имени поля, как в ownedForRequest. */
const ownerOf = (r) => String(r?.userId || r?.user_id || r?.ownerId || '') || ''

/**
 * Кому принадлежит лид. Порядок — по убыванию точности:
 * задача (её владелец известен наверняка) → кампания → цель → аккаунт, которым с этим
 * человеком говорили. Последнее слабее прочего лишь формально: аккаунт мог сменить
 * хозяина, но на практике это самый плотно заполненный признак — `accountId` есть почти
 * у каждого лида, а у аккаунта владелец проставляется при заведении.
 */
const leadOwner = (l) =>
  (l.taskId && owners.task.get(l.taskId)) ||
  (l.campaignId && owners.campaign.get(l.campaignId)) ||
  (l.goalId && owners.goal.get(l.goalId)) ||
  (l.accountId && owners.account.get(l.accountId)) || ''

/** Записи, для которых владельца вывести не удалось: их разбирает человек. */
const orphans = []

/** Цели и кампании, у которых владелец уже есть, — источник истины для остального. */
async function collectFromEntities() {
  const { listGoals } = await import('../goals.js')
  const { listCampaigns } = await import('../campaigns.js')
  for (const g of await listGoals()) if (ownerOf(g)) owners.goal.set(g.id, ownerOf(g))
  for (const c of await listCampaigns()) {
    const who = ownerOf(c)
    if (!who) continue
    owners.campaign.set(c.id, who)
    // Кампания знает свою цель — значит цель того же клиента.
    if (c.goalId && !owners.goal.has(c.goalId)) owners.goal.set(c.goalId, who)
  }
  log(`Целей с владельцем: ${owners.goal.size}, кампаний: ${owners.campaign.size}`)
}

/** Аккаунты: у них владелец лежит прямо в метаданных (`meta.ownerId`). */
async function collectFromAccounts() {
  const { loadAllMeta } = await import('../accountsMeta.js')
  const meta = await loadAllMeta()
  for (const [id, m] of Object.entries(meta)) {
    const who = String(m?.ownerId || '')
    if (who) owners.account.set(id, who)
  }
  log(`Аккаунтов с владельцем: ${owners.account.size} из ${Object.keys(meta).length}`)
}

async function collectFromTasks() {
  const { listModuleKeys, getModuleStore } = await import('../modules/registry.js')
  let seen = 0
  for (const key of listModuleKeys()) {
    const store = getModuleStore(key)
    if (!store) continue
    let tasks = []
    try { tasks = await store.listTasks() } catch { continue }
    for (const t of tasks) {
      seen += 1
      const who = ownerOf(t)
      if (!who) continue
      owners.task.set(t.id, who)
      const s = t.settings || {}
      if (s.goalId && !owners.goal.has(s.goalId)) owners.goal.set(s.goalId, who)
      if (s.campaignId && !owners.campaign.has(s.campaignId)) owners.campaign.set(s.campaignId, who)
    }
  }
  log(`Задач просмотрено: ${seen}, из них с владельцем: ${owners.task.size}`)
}

/**
 * Журнал — последний источник: в нём записано, КТО создал запись. Читаем построчно:
 * файл растёт бесконечно, и грузить его целиком незачем.
 */
function collectFromAudit() {
  const file = dataPath('audit.log.jsonl')
  if (!fs.existsSync(file)) return
  let added = 0
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    const who = String(e.initiator || '')
    // `operator` — «человек за пультом» без личности: владельца из него не вывести.
    if (!who || who === 'operator' || who === 'system') continue
    const goalId = e.scope?.goalId || e.meta?.goalId
    const campaignId = e.scope?.campaignId || e.meta?.campaignId
    if (goalId && !owners.goal.has(goalId)) { owners.goal.set(goalId, who); added += 1 }
    if (campaignId && !owners.campaign.has(campaignId)) { owners.campaign.set(campaignId, who); added += 1 }
  }
  if (added) log(`Из журнала добавлено связей: ${added}`)
}

async function backfillLeads() {
  const { listLeads, assignLeadOwner } = await import('../leads.js')
  const all = await listLeads()
  const todo = all.filter((l) => !ownerOf(l))
  let done = 0
  for (const l of todo) {
    const who = leadOwner(l)
    if (!who) { orphans.push(`лид ${l.id} (${l.peer})`); continue }
    if (APPLY) await assignLeadOwner(l.id, who)
    done += 1
  }
  log(`Лиды: без владельца ${todo.length}, определено ${done}, не вывелось ${todo.length - done}`)
}

async function backfillRules() {
  const { listRules, updateRule } = await import('../automation/store.js')
  const all = await listRules()
  const todo = all.filter((r) => !ownerOf(r))
  let done = 0
  for (const r of todo) {
    // У правила есть и кампания, и список аккаунтов — годится любое: аккаунты правила
    // принадлежат тому, кто его завёл (чужие туда положить было нельзя даже раньше).
    const byAccount = (r.accountIds || []).map((id) => owners.account.get(id)).find(Boolean) || ''
    const who = (r.campaignId && owners.campaign.get(r.campaignId)) || byAccount
    if (!who) {
      // Это опаснее прочего: расписание продолжает тратить аккаунты и деньги, а
      // остановить его владелец не может — правило для него невидимо.
      orphans.push(`ПРАВИЛО АВТОМАТИЗАЦИИ ${r.id} «${r.name}»${r.enabled ? ' — ВКЛЮЧЕНО' : ''}`)
      continue
    }
    if (APPLY) await updateRule(r.id, { userId: who })
    done += 1
  }
  log(`Правила автоматизации: без владельца ${todo.length}, определено ${done}`)
}

async function backfillAgents() {
  const { listAgents, updateAgent } = await import('../agents.js')
  const { listCampaigns } = await import('../campaigns.js')
  const camps = await listCampaigns()
  const all = await listAgents()
  const todo = all.filter((a) => !ownerOf(a))
  let done = 0
  for (const a of todo) {
    // Персону выдаёт кампания, которая ею пользуется: `moduleAgents` — карта модуль→агент.
    const camp = camps.find((c) => Object.values(c.moduleAgents || {}).includes(a.id) || c.agentId === a.id)
    const who = camp ? (ownerOf(camp) || owners.campaign.get(camp.id) || '') : ''
    if (!who) { orphans.push(`персона ${a.id} «${a.name}»`); continue }
    if (APPLY) await updateAgent(a.id, { userId: who })
    done += 1
  }
  log(`Персоны: без владельца ${todo.length}, определено ${done}`)
}

async function reportFolders() {
  const { listFolders } = await import('../targetFolders.js')
  const todo = (await listFolders()).filter((f) => !ownerOf(f))
  // У папки нет ни задачи, ни кампании — связи, из которой выводить владельца, просто
  // не существует. Показываем списком: их немного, и человек знает, чьи они.
  for (const f of todo) orphans.push(`папка целей ${f.id} «${f.name}» (${(f.targets || []).length} целей)`)
  log(`Папки целей: без владельца ${todo.length} — выводить не из чего, нужен ручной разбор`)
}

log(APPLY ? '── ПРИМЕНЯЮ изменения ──' : '── Только показываю (запустите с --apply, чтобы записать) ──')
await collectFromEntities()
await collectFromAccounts()
await collectFromTasks()
collectFromAudit()
await backfillLeads()
await backfillRules()
await backfillAgents()
await reportFolders()

if (orphans.length) {
  log(`\nВладелец не вывелся у ${orphans.length} записей — остаются видны только админу:`)
  for (const o of orphans.slice(0, 40)) log('  •', o)
  if (orphans.length > 40) log(`  … и ещё ${orphans.length - 40}`)
}
log(APPLY ? '\nГотово.' : '\nНичего не записано.')
