/**
 * Сущность «Пользователь» (оператор системы) — §8.1. Привязан к роли (RBAC, roles.js).
 * Пароль хранится как scrypt-хэш (salt:hash), в открытом виде — никогда.
 * Хранение — JSON data/users.json; путь через env USERS_FILE (изоляция тестов).
 *
 * ⚠️ Это учётки операторов панели, а не Telegram-аккаунты (те — «Аккаунт»).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'
import { ADMIN_ROLE_ID } from './roles.js'

const USERS_FILE = process.env.USERS_FILE || dataPath('users.json')

/** Хэш пароля: случайная соль + scrypt. Возвращает "salt:hash" (hex). @param {string} password */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex')
  return `${salt}:${hash}`
}

/** Проверить пароль против сохранённого "salt:hash". Константное сравнение. */
export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false
  const [salt, hash] = stored.split(':')
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex')
  const a = Buffer.from(hash, 'hex')
  const b = Buffer.from(test, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Убрать секреты перед отдачей наружу. @param {object} u */
export function publicUser(u) {
  if (!u) return null
  const { passwordHash, ...rest } = u // eslint-disable-line no-unused-vars
  return rest
}

function normEmail(e) {
  return String(e ?? '').trim().toLowerCase()
}

/** Стартовые учётки: главный админ (демо) + тестовый модератор (запрошен заказчиком). */
function defaultUsers() {
  const now = Date.now()
  return [
    {
      // Главный админ (bypass, полный доступ). Почта — illia@incubator.ai.
      id: 'usr_admin',
      email: 'illia@incubator.ai',
      name: 'Администратор',
      roleId: ADMIN_ROLE_ID,
      active: true,
      passwordHash: hashPassword('demo12345'),
      createdAt: now,
      updatedAt: now,
    },
    {
      // Тестовый оператор для проверки выдачи прав — НЕ админ (обычная роль «Модератор»).
      id: 'usr_test',
      email: 'ya.lonk777@gmail.com',
      name: 'Тестовый модератор',
      roleId: 'role_moderator',
      active: true,
      passwordHash: hashPassword('11111111'),
      createdAt: now,
      updatedAt: now,
    },
  ]
}

export async function listUsers() {
  const users = await readJson(USERS_FILE, null)
  if (!Array.isArray(users)) {
    const seed = defaultUsers()
    await writeJson(USERS_FILE, seed)
    return seed
  }
  return users
}

export async function getUser(id) {
  const users = await listUsers()
  return users.find((u) => u.id === id) || null
}

async function findByEmail(email) {
  const users = await listUsers()
  const e = normEmail(email)
  return users.find((u) => normEmail(u.email) === e) || null
}

/** @param {{ email, name, roleId, password, active }} input */
export async function createUser(input = {}) {
  const email = normEmail(input.email)
  if (!email) throw new Error('Укажите e-mail')
  if (!input.password || String(input.password).length < 6) throw new Error('Пароль минимум 6 символов')
  if (await findByEmail(email)) throw new Error('Пользователь с таким e-mail уже есть')
  const users = await listUsers()
  const user = {
    id: `usr_${crypto.randomUUID().slice(0, 8)}`,
    email,
    name: String(input.name ?? '').trim() || email,
    roleId: input.roleId ? String(input.roleId) : 'role_moderator',
    active: input.active !== false,
    passwordHash: hashPassword(input.password),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  users.push(user)
  await writeJson(USERS_FILE, users)
  return user
}

/** @param {string} id @param {{ name, roleId, active, password }} patch */
export async function updateUser(id, patch = {}) {
  const users = await listUsers()
  const i = users.findIndex((u) => u.id === id)
  if (i === -1) return null
  if (patch.name !== undefined) users[i].name = String(patch.name).trim() || users[i].name
  if (patch.roleId !== undefined) users[i].roleId = String(patch.roleId)
  if (patch.active !== undefined) users[i].active = !!patch.active
  if (patch.password) {
    if (String(patch.password).length < 6) throw new Error('Пароль минимум 6 символов')
    users[i].passwordHash = hashPassword(patch.password)
  }
  users[i].updatedAt = Date.now()
  await writeJson(USERS_FILE, users)
  return users[i]
}

export async function deleteUser(id) {
  const users = await listUsers()
  if (id === 'usr_admin') throw new Error('Встроенного администратора удалить нельзя')
  const next = users.filter((u) => u.id !== id)
  if (next.length === users.length) return false
  await writeJson(USERS_FILE, next)
  return true
}

/**
 * Аутентификация: e-mail + пароль. Возвращает публичного юзера (без хэша) или null.
 * @param {string} email @param {string} password
 */
export async function authenticate(email, password) {
  const user = await findByEmail(email)
  if (!user || !user.active) return null
  if (!verifyPassword(password, user.passwordHash)) return null
  return publicUser(user)
}
