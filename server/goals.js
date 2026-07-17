/**
 * Сущность «Цель» (Goal) — слой Целей/KB/Лидов (§3.6, docs/ARCH-goals-crm.md).
 * MVP: бэкенд-скелет CRUD. Хранение — JSON в server/data/goals.json (как папки целей).
 * Путь переопределяется env GOALS_FILE (изоляция в тестах).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

const GOALS_FILE = process.env.GOALS_FILE || dataPath('goals.json')

/** Поля, которые можно задавать/менять (остальное — служебное). */
const FIELDS = ['name', 'description', 'targetAction', 'stages', 'completionCriteria', 'audience', 'channels']

/** Нормализовать список каналов/групп цели: trim, без @, без дублей. @param {*} v */
function normChannels(v) {
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((x) => String(x || '').trim().replace(/^@/, '')).filter(Boolean))]
}

/** Нормализовать вход в чистую цель. @param {object} input */
export function normalizeGoal(input = {}) {
  return {
    name: String(input.name ?? '').trim(),
    description: String(input.description ?? ''),
    targetAction: String(input.targetAction ?? ''),
    stages: Array.isArray(input.stages) ? input.stages.map((s) => String(s)) : [],
    completionCriteria: String(input.completionCriteria ?? ''),
    audience: String(input.audience ?? ''),
    channels: normChannels(input.channels),
  }
}

export async function listGoals() {
  return readJson(GOALS_FILE, [])
}

export async function getGoal(id) {
  const goals = await listGoals()
  return goals.find((g) => g.id === id) || null
}

/** @param {object} input @throws если пустое имя */
export async function createGoal(input) {
  const clean = normalizeGoal(input)
  if (!clean.name) throw new Error('Укажите название цели')
  const goals = await listGoals()
  const goal = {
    id: `goal_${crypto.randomUUID().slice(0, 8)}`,
    ...clean,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  goals.unshift(goal)
  await writeJson(GOALS_FILE, goals)
  return goal
}

/** @param {string} id @param {object} patch @returns {Promise<object|null>} */
export async function updateGoal(id, patch = {}) {
  const goals = await listGoals()
  const i = goals.findIndex((g) => g.id === id)
  if (i === -1) return null
  for (const k of FIELDS) {
    if (patch[k] !== undefined) {
      goals[i][k] = k === 'stages'
        ? (Array.isArray(patch[k]) ? patch[k].map((s) => String(s)) : goals[i].stages)
        : k === 'channels'
          ? normChannels(patch[k])
          : (k === 'name' ? String(patch[k]).trim() : String(patch[k]))
    }
  }
  if (!goals[i].name) throw new Error('Название цели не может быть пустым')
  goals[i].updatedAt = Date.now()
  await writeJson(GOALS_FILE, goals)
  return goals[i]
}

/** @param {string} id @returns {Promise<boolean>} */
export async function deleteGoal(id) {
  const goals = await listGoals()
  const next = goals.filter((g) => g.id !== id)
  if (next.length === goals.length) return false
  await writeJson(GOALS_FILE, next)
  return true
}
