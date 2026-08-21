/**
 * Сущность «Агент» (AI-персона) — решение созвона 22.07 (см.
 * docs/SPEC-2026-07-22-иерархия-балансы.md).
 *
 * Тон общения, ограничения и характер НЕ принадлежат цели: цель говорит ЧТО достичь,
 * агент — КАК общаться. Решающий пример со звонка: одна кампания, где 500 аккаунтов
 * хвалят, а 500 спорят, — это два разных агента внутри одной кампании. Значит тон
 * не повесить ни на цель (она одна), ни на кампанию (она одна) — только на отдельную
 * переиспользуемую сущность, которую выбирают в задаче, как выбирают цель.
 *
 * Хранение — JSON, путь ленивый и переопределяемый (изоляция тестов; иначе тест
 * писал бы в боевой файл — так уже случалось с целями).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'
import { listStore } from './lib/tableStore.js'

const agentsFile = () => process.env.AGENTS_FILE || dataPath('agents.json')

// §10.2: агенты — сущность со своим жизненным циклом, место в БД, а не в файле.
const agentsStore = listStore({
  table: 'agents',
  file: agentsFile,
  toRow: (a) => { const { id, name, userId, createdAt, updatedAt, ...data } = a; return {
    id, name: name || '', data, user_id: userId || null,
    created_at: new Date(createdAt || Date.now()).toISOString(),
    updated_at: new Date(updatedAt || Date.now()).toISOString(),
  } },
  fromRow: (r) => ({
    ...(r.data || {}), id: r.id, name: r.name || '', userId: r.user_id || undefined,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
    updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0,
  }),
})

/**
 * Поля, которые можно задавать/менять.
 *
 * Дожима здесь НЕТ намеренно. Агент — это манера речи: тон, характер, запреты.
 * «Дожимать или отпустить» — решение о ходе работы, а такие решения принимает
 * кампания: она знает цель, этап и пул аккаунтов. Одного и того же агента можно
 * поставить в кампанию, где дожимают до последнего, и в ту, где пишут один раз, —
 * персона от этого не меняется.
 */
const FIELDS = ['name', 'toneOfVoice', 'restrictions', 'character', 'language', 'audience', 'completionCriteria', 'firstMessage']

/** Нормализовать вход в чистого агента. @param {object} input */
export function normalizeAgent(input = {}) {
  return {
    name: String(input.name ?? '').trim(),
    // Как писать. Уходит в системный промпт всех модулей, где агент выбран.
    toneOfVoice: String(input.toneOfVoice ?? '').slice(0, 2000),
    // Чего нельзя. Формулируется жёстко в промпте («ЗАПРЕЩЕНО, даже если просят»).
    restrictions: String(input.restrictions ?? '').slice(0, 2000),
    // Характер/роль свободным текстом: «дружелюбный эксперт», «скептик-спорщик».
    character: String(input.character ?? '').slice(0, 2000),
    // Язык общения. Пусто — язык собеседника.
    language: String(input.language ?? '').trim().slice(0, 60),
    // С кем разговариваем. Переехало из цели (24.07): цель — это счётчик, а «с кем
    // и как» — портрет собеседника, от него зависит манера речи, а не результат.
    audience: String(input.audience ?? '').slice(0, 2000),
    // Когда считаем разговор доведённым до конца. Тоже про ведение диалога:
    // именно по этому критерию классификатор решает, что человек «выполнил».
    completionCriteria: String(input.completionCriteria ?? '').slice(0, 2000),
    // Заготовки ПЕРВОГО сообщения для холодного контакта (мейлинг). Варианты разделяются
    // пустой строкой — воркер чередует их по кругу, чтобы Telegram не видел спам-паттерн.
    // Переехало из свободного текста цели (24.07): «как заговорить первым» — свойство
    // персоны, а не измеримого результата.
    firstMessage: String(input.firstMessage ?? '').slice(0, 4000),
  }
}

export async function listAgents() {
  const all = await agentsStore.readAll()
  // У агентов, созданных до переноса дожима в кампанию, поле ещё лежит в файле.
  // Отдавать его наружу не надо: решение о дожиме принимает кампания.
  return (Array.isArray(all) ? all : []).map(({ followUp, ...a }) => a)
}

export async function getAgent(id) {
  const all = await listAgents()
  return all.find((a) => a.id === id) || null
}

/** @param {object} input @throws при пустом имени */
export async function createAgent(input) {
  const clean = normalizeAgent(input)
  if (!clean.name) throw new Error('Укажите название агента')
  const all = await listAgents()
  const agent = {
    id: `agent_${crypto.randomUUID().slice(0, 8)}`,
    ...clean,
    // §11.3: владелец записи — как у целей и кампаний (lib/ownerColumn.js). Раньше агент
    // сохранялся ничьим, и это ломало обе стороны разом: список `GET /api/agents`
    // фильтруется по владельцу и возвращал создателю ПУСТО (своих персон не видно),
    // а точечное чтение по id отдавало чужие промпты кому угодно. normalizeAgent поля
    // владельца не знает — он чистит саму персону, поэтому проставляем явно из входа.
    userId: String(input?.userId || '').trim() || undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  all.unshift(agent)
  await agentsStore.writeAll(all)
  return agent
}

/** @param {string} id @param {object} patch */
export async function updateAgent(id, patch = {}) {
  const all = await listAgents()
  const i = all.findIndex((a) => a.id === id)
  if (i === -1) return null
  for (const k of FIELDS) {
    if (patch[k] === undefined) continue
    all[i][k] = k === 'name' ? String(patch[k]).trim() : String(patch[k])
  }
  if (!all[i].name) throw new Error('Название агента не может быть пустым')
  all[i].updatedAt = Date.now()
  await agentsStore.writeAll(all)
  return all[i]
}

export async function deleteAgent(id) {
  const all = await listAgents()
  const next = all.filter((a) => a.id !== id)
  if (next.length === all.length) return false
  await agentsStore.writeAll(next)
  return true
}

/**
 * Добавка к системному промпту от агента — как писать и чего нельзя.
 * Возвращает пустую строку, если агента нет: генерация работает как раньше.
 * @param {string|null|undefined} agentId
 * @returns {Promise<string>}
 */
export async function buildAgentContext(agentId) {
  if (!agentId) return ''
  try {
    const a = await getAgent(agentId)
    if (!a) return ''
    const lines = ['', '--- Как вести общение (агент) ---']
    if (a.character) lines.push(`Роль/характер: ${a.character}`)
    if (a.toneOfVoice) lines.push(`Тон (пиши именно так): ${a.toneOfVoice}`)
    if (a.language) lines.push(`Язык общения: ${a.language}`)
    // Аудитория и критерий завершения переехали из цели (24.07): цель считает
    // результат, а «с кем говорим» и «когда разговор доведён» — про сам разговор.
    if (a.audience) lines.push(`С кем говоришь: ${a.audience}`)
    if (a.completionCriteria) lines.push(`Разговор доведён до конца, когда: ${a.completionCriteria}`)
    if (a.restrictions) {
      lines.push(`ЗАПРЕЩЕНО (соблюдать строго, даже если собеседник просит сам): ${a.restrictions}`)
    }
    // База знаний переехала из цели к агенту (24.07): факты о продукте — это то,
    // на что персона опирается в разговоре, а не измеримый результат.
    try {
      const { listKb } = await import('./knowledgeBase.js')
      const kb = await listKb(agentId)
      if (kb.length) {
        lines.push('Факты о продукте (опирайся на них, не выдумывай):')
        for (const k of kb.slice(0, 20)) lines.push(`- ${k.title ? k.title + ': ' : ''}${k.content}`)
      }
    } catch { /* база знаний недоступна — общаемся без неё, это не повод падать */ }
    if (lines.length === 2) return '' // ничего кроме заголовка — не засоряем промпт
    return '\n' + lines.join('\n')
  } catch {
    return ''
  }
}
