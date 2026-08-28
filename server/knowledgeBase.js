/**
 * База знаний к цели (KnowledgeBase, §3.6, docs/ARCH-goals-crm.md).
 *
 * С 27.08 (MR-186) хранится в ОБЩЕЙ БАЗЕ (`knowledge_base`). До этого стор писал только
 * в data/knowledge.json, ветки Supabase не было. Это контент кампании, введённый руками:
 * пропал диск — пропала вся база знаний, а при втором инстансе запись добавили на одном
 * сервере, а кампания читает с другого и уносит в промпт неполные факты.
 *
 * Файловый режим оставлен для локального запуска и тестов.
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

/**
 * Путь считаем ЛЕНИВО, при каждом обращении: тест, выставивший KB_FILE после того, как
 * модуль подтянулся по цепочке импортов, иначе писал бы в БОЕВОЙ файл (см. goals.js).
 */
const kbFile = () => process.env.KB_FILE || dataPath('knowledge.json')
function sb() { return supabaseEnabled() ? getSupabase() : null }

/** Таблицы ещё нет (миграция не накатана) — отдаём пустую базу знаний, а не падаем. */
const isMissingTable = (error) =>
  !!error && /knowledge_base|schema cache|does not exist|relation .* does not exist/i.test(String(error.message || ''))

const fromRow = (r) => ({
  id: r.id,
  goalId: r.goal_id,
  kind: r.kind,
  title: r.title || '',
  content: r.content || '',
  fileRef: r.file_ref ?? null,
  url: r.url ?? null,
  scope: r.scope || 'all',
  version: Number(r.version) || 1,
  createdAt: Number(r.created_at) || 0,
  updatedAt: Number(r.updated_at) || 0,
})

const toRow = (k) => ({
  id: k.id,
  goal_id: k.goalId,
  kind: k.kind,
  title: k.title || '',
  content: k.content || '',
  file_ref: k.fileRef ?? null,
  url: k.url ?? null,
  scope: k.scope || 'all',
  version: Number(k.version) || 1,
  created_at: Number(k.createdAt) || Date.now(),
  updated_at: Number(k.updatedAt) || Date.now(),
})

/** @param {object} input */
export function normalizeKb(input = {}) {
  // `link` — страница/ссылка: её текст вытягивается при добавлении, чтобы в промпт
  // попали факты, а не голый URL (модель по ссылке не ходит).
  const kind = ['text', 'file', 'image', 'link'].includes(input.kind) ? input.kind : 'text'
  return {
    kind,
    title: String(input.title ?? '').trim(),
    content: String(input.content ?? ''),
    fileRef: input.fileRef ? String(input.fileRef) : null,
    // Исходная ссылка — чтобы страницу можно было открыть и перечитать руками.
    url: input.url ? String(input.url).trim().slice(0, 2000) : null,
    scope: String(input.scope ?? 'all'),
  }
}

/** Все записи (опц. по цели). @param {string} [goalId] */
export async function listKb(goalId) {
  const db = sb()
  if (db) {
    let q = db.from('knowledge_base').select('*').order('created_at', { ascending: false })
    if (goalId) q = q.eq('goal_id', goalId)
    const { data, error } = await q
    if (error) {
      if (isMissingTable(error)) return []
      throw new Error(`Не удалось прочитать базу знаний: ${error.message}`)
    }
    return (data || []).map(fromRow)
  }
  const all = await readJson(kbFile(), [])
  return goalId ? all.filter((k) => k.goalId === goalId) : all
}

/** @param {string} goalId @param {object} input */
export async function createKb(goalId, input) {
  if (!goalId) throw new Error('Не указана цель (goalId)')
  const clean = normalizeKb(input)
  if (clean.kind === 'text' && !clean.content.trim() && !clean.title) {
    throw new Error('Пустая запись базы знаний')
  }
  const now = Date.now()
  const item = {
    id: `kb_${crypto.randomUUID().slice(0, 8)}`,
    goalId,
    ...clean,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
  const db = sb()
  if (db) {
    const { error } = await db.from('knowledge_base').insert(toRow(item))
    if (error) {
      if (isMissingTable(error)) throw new Error('База знаний временно недоступна: не применена миграция базы')
      throw new Error(`Не удалось сохранить запись базы знаний: ${error.message}`)
    }
    return item
  }
  const all = await readJson(kbFile(), [])
  all.unshift(item)
  await writeJson(kbFile(), all)
  return item
}

/** @param {string} id @param {object} patch */
export async function updateKb(id, patch = {}) {
  const db = sb()
  if (db) {
    const { data, error } = await db.from('knowledge_base').select('*').eq('id', id).limit(1)
    if (error && !isMissingTable(error)) throw new Error(`Не удалось прочитать запись: ${error.message}`)
    if (!data?.length) return null
    const current = fromRow(data[0])
    const clean = normalizeKb({ ...current, ...patch })
    const next = { ...current, ...clean, version: (current.version || 1) + 1, updatedAt: Date.now() }
    const { error: updErr } = await db.from('knowledge_base').update(toRow(next)).eq('id', id)
    if (updErr && !isMissingTable(updErr)) throw new Error(`Не удалось изменить запись: ${updErr.message}`)
    return next
  }
  const all = await readJson(kbFile(), [])
  const i = all.findIndex((k) => k.id === id)
  if (i === -1) return null
  const clean = normalizeKb({ ...all[i], ...patch })
  all[i] = { ...all[i], ...clean, version: (all[i].version || 1) + 1, updatedAt: Date.now() }
  await writeJson(kbFile(), all)
  return all[i]
}

/** @param {string} id */
export async function deleteKb(id) {
  const db = sb()
  if (db) {
    // `select` после удаления возвращает то, что реально удалилось: по нему и отвечаем
    // «была такая запись или нет» — иначе роут не отличит удаление от промаха по id.
    const { data, error } = await db.from('knowledge_base').delete().eq('id', id).select('id')
    if (error) {
      if (isMissingTable(error)) return false
      throw new Error(`Не удалось удалить запись: ${error.message}`)
    }
    return (data || []).length > 0
  }
  const all = await readJson(kbFile(), [])
  const next = all.filter((k) => k.id !== id)
  if (next.length === all.length) return false
  await writeJson(kbFile(), next)
  return true
}

/** Удалить всю базу знаний цели (при удалении цели). @param {string} goalId */
export async function deleteKbByGoal(goalId) {
  const db = sb()
  if (db) {
    const { error } = await db.from('knowledge_base').delete().eq('goal_id', goalId)
    if (error && !isMissingTable(error)) throw new Error(`Не удалось удалить базу знаний цели: ${error.message}`)
    return
  }
  const all = await readJson(kbFile(), [])
  const next = all.filter((k) => k.goalId !== goalId)
  if (next.length !== all.length) await writeJson(kbFile(), next)
}
