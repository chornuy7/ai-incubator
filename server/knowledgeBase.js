/**
 * База знаний к цели (KnowledgeBase, §3.6, docs/ARCH-goals-crm.md).
 * MVP: текстовые записи, привязанные к goalId. Файлы/OCR — §6 (открытый вопрос).
 * Хранение — JSON data/knowledge.json; путь через env KB_FILE (тесты).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

const KB_FILE = process.env.KB_FILE || dataPath('knowledge.json')

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
  const all = await readJson(KB_FILE, [])
  return goalId ? all.filter((k) => k.goalId === goalId) : all
}

/** @param {string} goalId @param {object} input */
export async function createKb(goalId, input) {
  if (!goalId) throw new Error('Не указана цель (goalId)')
  const clean = normalizeKb(input)
  if (clean.kind === 'text' && !clean.content.trim() && !clean.title) {
    throw new Error('Пустая запись базы знаний')
  }
  const all = await readJson(KB_FILE, [])
  const item = {
    id: `kb_${crypto.randomUUID().slice(0, 8)}`,
    goalId,
    ...clean,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  all.unshift(item)
  await writeJson(KB_FILE, all)
  return item
}

/** @param {string} id @param {object} patch */
export async function updateKb(id, patch = {}) {
  const all = await readJson(KB_FILE, [])
  const i = all.findIndex((k) => k.id === id)
  if (i === -1) return null
  const clean = normalizeKb({ ...all[i], ...patch })
  all[i] = { ...all[i], ...clean, version: (all[i].version || 1) + 1, updatedAt: Date.now() }
  await writeJson(KB_FILE, all)
  return all[i]
}

/** @param {string} id */
export async function deleteKb(id) {
  const all = await readJson(KB_FILE, [])
  const next = all.filter((k) => k.id !== id)
  if (next.length === all.length) return false
  await writeJson(KB_FILE, next)
  return true
}

/** Удалить всю базу знаний цели (при удалении цели). @param {string} goalId */
export async function deleteKbByGoal(goalId) {
  const all = await readJson(KB_FILE, [])
  const next = all.filter((k) => k.goalId !== goalId)
  if (next.length !== all.length) await writeJson(KB_FILE, next)
}
