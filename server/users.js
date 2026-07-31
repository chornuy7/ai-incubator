/**
 * Сущность «Пользователь» (оператор системы) — §8.1. Привязан к роли (RBAC, roles.js).
 *
 * ПЕРЕЕЗД НА profiles (кол 29.07, «profile вместо user»). В Supabase-режиме источник
 * операторов — таблица `profiles` (профиль/роли/тип/вложенность), а e-mail и пароль
 * живут в `auth.users` (как просил замовник). Рабочий id остаётся `usr_…` — берём его
 * из `profiles.legacy_id`, чтобы не переписывать owner-ссылки в 13 таблицах данных.
 *
 * ПЕРЕХОДНЫЙ ПЕРИОД (пока таблица `users` не удалена): пишем ПАРАЛЛЕЛЬНО и в `users`
 * (dual-write) — она остаётся валидной точкой отката и FK-целью, а вход умеет
 * падать на её `password_hash`, пока люди не задали пароль в Auth. На финальном шаге
 * (drop users) dual-write и legacy-мостик убираются.
 *
 * Файловый бэкенд (тесты, dev без Supabase) — БЕЗ изменений: старые users.json + scrypt.
 *
 * ⚠️ Это учётки операторов панели, а не Telegram-аккаунты (те — «Аккаунт»).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled, verifyAuthPassword } from './lib/supabase.js'
import { ADMIN_ROLE_ID } from './roles.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }

// ── Файловый формат (тесты/dev) ─────────────────────────────────────────────
const rowToUser = (r) => ({
  id: r.id, email: r.email, name: r.name || '',
  roleId: (r.role_ids || [])[0] || '', roleIds: r.role_ids || [],
  active: r.active !== false, passwordHash: r.password_hash || null,
  parentId: r.parent_id || null,
  createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
  updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0,
})
const userToRow = (u) => ({
  id: u.id, email: u.email, name: u.name || '', password_hash: u.passwordHash || null,
  role_ids: u.roleIds || (u.roleId ? [u.roleId] : []), active: u.active !== false,
  parent_id: u.parentId || null,
  created_at: new Date(u.createdAt || Date.now()).toISOString(),
  updated_at: new Date(u.updatedAt || Date.now()).toISOString(),
})

const USERS_FILE = () => process.env.USERS_FILE || dataPath('users.json')

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

/**
 * Нормализовать роли пользователя (мульти-роль). Принимает roleIds (массив) или старый
 * одиночный roleId. Возвращает { roleIds, roleId }, где roleId — «первичная» роль. §8.1.
 * @param {{roleIds?: string[], roleId?: string}} input
 */
function normUserRoles(input = {}, fallback = []) {
  const raw = Array.isArray(input.roleIds) ? input.roleIds : (input.roleId != null ? [input.roleId] : [])
  let list = [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))]
  if (!list.length) list = [...fallback]
  const roleId = list.includes(ADMIN_ROLE_ID) ? ADMIN_ROLE_ID : (list[0] || '')
  return { roleIds: list, roleId }
}

/** Стартовые учётки (только файловый бэкенд): админ + тестовый модератор. */
function defaultUsers() {
  const now = Date.now()
  return [
    { id: 'usr_admin', email: 'illia@incubator.ai', name: 'Администратор', roleId: ADMIN_ROLE_ID, roleIds: [ADMIN_ROLE_ID], active: true, passwordHash: hashPassword('demo12345'), createdAt: now, updatedAt: now },
    { id: 'usr_test', email: 'ya.lonk777@gmail.com', name: 'Тестовый модератор', roleId: 'role_moderator', roleIds: ['role_moderator'], active: true, passwordHash: hashPassword('11111111'), createdAt: now, updatedAt: now },
  ]
}

// ── Supabase: e-mail из auth.users ──────────────────────────────────────────
/** Карта uuid→email из Supabase Auth (e-mail в profiles не держим). */
async function authEmailMap(db) {
  const map = new Map()
  try {
    const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
    for (const u of data?.users || []) map.set(u.id, normEmail(u.email))
  } catch { /* Auth недоступен — отдадим без e-mail, не роняя список */ }
  return map
}

/** Профиль + e-mail (+ маппинг parent uuid→legacy) → объект оператора (id = legacy_id). */
function profileToUser(p, emailMap, legacyByUuid) {
  const { roleIds, roleId } = normUserRoles({ roleIds: p.role_ids })
  return {
    id: p.legacy_id,
    email: emailMap.get(p.id) || '',
    name: p.name || '',
    roleId, roleIds,
    active: p.active !== false,
    parentId: p.parent_id ? (legacyByUuid.get(p.parent_id) || null) : null,
    user_type_id: p.user_type_id ?? null,
    createdAt: p.created_at ? new Date(p.created_at).getTime() : 0,
    updatedAt: p.updated_at ? new Date(p.updated_at).getTime() : 0,
    passwordHash: null, // пароль в auth.users, не здесь
  }
}

/** @returns {Promise<object[]>} операторы: из profiles (+e-mail из auth) или из файла. */
export async function listUsers() {
  const db = sb()
  if (db) {
    const [{ data: profs }, emailMap] = await Promise.all([
      db.from('profiles').select('*').order('created_at', { ascending: true }),
      authEmailMap(db),
    ])
    const rows = (profs || []).filter((p) => p.legacy_id) // без legacy_id оператор не адресуем
    const legacyByUuid = new Map(rows.map((p) => [p.id, p.legacy_id]))
    return rows.map((p) => profileToUser(p, emailMap, legacyByUuid))
  }
  const users = await readJson(USERS_FILE(), null)
  if (!Array.isArray(users)) {
    const seed = defaultUsers()
    await writeJson(USERS_FILE(), seed)
    return seed
  }
  let changed = false
  for (const u of users) {
    if (!Array.isArray(u.roleIds)) {
      const { roleIds, roleId } = normUserRoles(u)
      u.roleIds = roleIds; u.roleId = roleId; changed = true
    }
  }
  if (changed) await writeJson(USERS_FILE(), users)
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

/** Supabase: найти профиль по legacy_id (для правок/удаления). */
async function profileByLegacy(db, legacyId) {
  const { data } = await db.from('profiles').select('*').eq('legacy_id', legacyId).maybeSingle()
  return data || null
}

/** @param {{ email, name, roleId, password, active, parentId }} input */
export async function createUser(input = {}) {
  const email = normEmail(input.email)
  if (!email) throw new Error('Укажите e-mail')
  if (!input.password || String(input.password).length < 6) throw new Error('Пароль минимум 6 символов')
  if (await findByEmail(email)) throw new Error('Пользователь с таким e-mail уже есть')

  const hasExplicitRoles = Array.isArray(input.roleIds) || input.roleId != null
  const { roleIds, roleId } = normUserRoles(input, hasExplicitRoles ? [] : ['role_moderator'])
  const parentId = input.parentId ? String(input.parentId) : null
  const name = String(input.name ?? '').trim() || email
  const now = Date.now()

  const db = sb()
  if (db) {
    if (parentId && !(await profileByLegacy(db, parentId))) throw new Error('Родительский пользователь не найден')
    // 1. Заводим в Supabase Auth (email+пароль) — триггер создаёт profile с legacy_id.
    const { data: created, error } = await db.auth.admin.createUser({
      email, password: String(input.password), email_confirm: true, user_metadata: { name },
    })
    if (error || !created?.user) throw new Error(error?.message || 'Не удалось создать пользователя')
    const authId = created.user.id
    // 2. Читаем сгенерированный legacy_id и дозаполняем профиль (роли/имя/parent).
    const { data: prof } = await db.from('profiles').select('legacy_id, parent_id').eq('id', authId).maybeSingle()
    const legacyId = prof?.legacy_id || `usr_${authId.replace(/-/g, '').slice(0, 12)}`
    let parentUuid = null
    if (parentId) { const pp = await profileByLegacy(db, parentId); parentUuid = pp?.id || null }
    await db.from('profiles').update({ legacy_id: legacyId, name, active: input.active !== false, role_ids: roleIds, parent_id: parentUuid, updated_at: new Date().toISOString() }).eq('id', authId)
    // 3. Dual-write: строка в users (FK-цель + откат), пока таблица не удалена.
    await db.from('users').insert(userToRow({ id: legacyId, email, name, roleIds, active: input.active !== false, parentId, passwordHash: hashPassword(input.password), createdAt: now, updatedAt: now })).select('id').maybeSingle().then(() => {}, () => {})
    return { id: legacyId, email, name, roleId, roleIds, active: input.active !== false, parentId, createdAt: now, updatedAt: now }
  }

  const users = await listUsers()
  if (parentId && !users.some((u) => u.id === parentId)) throw new Error('Родительский пользователь не найден')
  const user = { id: `usr_${crypto.randomUUID().slice(0, 8)}`, email, name, roleId, roleIds, active: input.active !== false, parentId, passwordHash: hashPassword(input.password), createdAt: now, updatedAt: now }
  users.push(user)
  await writeJson(USERS_FILE(), users)
  return user
}

/** @param {string} id @param {{ name, roleId, roleIds, active, password, parentId }} patch */
export async function updateUser(id, patch = {}) {
  const db = sb()
  if (db) {
    const users = await listUsers()
    const cur = users.find((u) => u.id === id)
    if (!cur) return null
    const prof = await profileByLegacy(db, id)
    if (!prof) return null
    const next = { ...cur }
    if (patch.name !== undefined) next.name = String(patch.name).trim() || next.name
    if (patch.roleIds !== undefined || patch.roleId !== undefined) {
      const { roleIds, roleId } = normUserRoles({ roleIds: patch.roleIds, roleId: patch.roleId })
      next.roleIds = roleIds; next.roleId = roleId
    }
    if (patch.active !== undefined) next.active = !!patch.active
    if (patch.parentId !== undefined) {
      const pid = patch.parentId ? String(patch.parentId) : null
      if (pid) {
        if (pid === id) throw new Error('Пользователь не может быть родителем сам себе')
        if (!users.some((u) => u.id === pid)) throw new Error('Родительский пользователь не найден')
        let cursor = users.find((u) => u.id === pid); const seen = new Set()
        while (cursor?.parentId && !seen.has(cursor.parentId)) {
          if (cursor.parentId === id) throw new Error('Нельзя создать цикл подчинения')
          seen.add(cursor.parentId); cursor = users.find((u) => u.id === cursor.parentId)
        }
      }
      next.parentId = pid
    }
    // profiles — источник правды: роли/имя/активность/parent (uuid).
    let parentUuid = null
    if (next.parentId) { const pp = await profileByLegacy(db, next.parentId); parentUuid = pp?.id || null }
    await db.from('profiles').update({ name: next.name, active: next.active, role_ids: next.roleIds, parent_id: parentUuid, updated_at: new Date().toISOString() }).eq('id', prof.id)
    // Пароль — только в auth.users.
    if (patch.password) {
      if (String(patch.password).length < 6) throw new Error('Пароль минимум 6 символов')
      await db.auth.admin.updateUserById(prof.id, { password: String(patch.password) })
    }
    // Dual-write в users (откат + FK): роли/имя/активность/parent, и хэш пароля для legacy-входа.
    const mirror = { name: next.name, active: next.active, role_ids: next.roleIds, parent_id: next.parentId, updated_at: new Date().toISOString() }
    if (patch.password) mirror.password_hash = hashPassword(patch.password)
    await db.from('users').update(mirror).eq('id', id).then(() => {}, () => {})
    next.updatedAt = Date.now()
    return next
  }

  const users = await listUsers()
  const i = users.findIndex((u) => u.id === id)
  if (i === -1) return null
  if (patch.name !== undefined) users[i].name = String(patch.name).trim() || users[i].name
  if (patch.roleIds !== undefined || patch.roleId !== undefined) {
    const { roleIds, roleId } = normUserRoles({ roleIds: patch.roleIds, roleId: patch.roleId })
    users[i].roleIds = roleIds; users[i].roleId = roleId
  }
  if (patch.active !== undefined) users[i].active = !!patch.active
  if (patch.parentId !== undefined) {
    const pid = patch.parentId ? String(patch.parentId) : null
    if (pid) {
      if (pid === id) throw new Error('Пользователь не может быть родителем сам себе')
      if (!users.some((u) => u.id === pid)) throw new Error('Родительский пользователь не найден')
      let cur = users.find((u) => u.id === pid); const seen = new Set()
      while (cur?.parentId && !seen.has(cur.parentId)) {
        if (cur.parentId === id) throw new Error('Нельзя создать цикл подчинения')
        seen.add(cur.parentId); cur = users.find((u) => u.id === cur.parentId)
      }
    }
    users[i].parentId = pid
  }
  if (patch.password) {
    if (String(patch.password).length < 6) throw new Error('Пароль минимум 6 символов')
    users[i].passwordHash = hashPassword(patch.password)
  }
  users[i].updatedAt = Date.now()
  await writeJson(USERS_FILE(), users)
  return users[i]
}

export async function deleteUser(id) {
  if (id === 'usr_admin') throw new Error('Встроенного администратора удалить нельзя')
  const db = sb()
  if (db) {
    const prof = await profileByLegacy(db, id)
    if (!prof) return false
    // Удаляем auth-пользователя — profiles.id → auth.users on delete cascade снимет профиль.
    await db.auth.admin.deleteUser(prof.id).catch(() => {})
    await db.from('profiles').delete().eq('id', prof.id).then(() => {}, () => {}) // на случай, если auth-удаление не каскаднуло
    await db.from('users').delete().eq('id', id).then(() => {}, () => {}) // dual-write
    return true
  }
  const users = await listUsers()
  const next = users.filter((u) => u.id !== id)
  if (next.length === users.length) return false
  for (const u of next) if (u.parentId === id) u.parentId = null
  await writeJson(USERS_FILE(), next)
  return true
}

/**
 * Legacy-вход по e-mail + паролю (scrypt). ПЕРЕХОДНЫЙ мостик: пароль в profiles не
 * хранится, поэтому в Supabase-режиме берём `password_hash` напрямую из таблицы users,
 * пока она не удалена. Возвращает публичного оператора или null.
 * @param {string} email @param {string} password
 */
export async function authenticate(email, password) {
  const db = sb()
  if (db) {
    const { data: row } = await db.from('users').select('password_hash, active').eq('email', normEmail(email)).maybeSingle()
    if (!row || row.active === false) return null
    if (!verifyPassword(password, row.password_hash)) return null
    return await findByEmail(email) // объект оператора берём из profiles (источник правды)
  }
  const user = await findByEmail(email)
  if (!user || !user.active) return null
  if (!verifyPassword(password, user.passwordHash)) return null
  return publicUser(user)
}

/**
 * §11.3 (кол 29.07): вход через Supabase Auth (источник истины паролей). Пароль проверяет
 * GoTrue; при успехе сопоставляем auth-аккаунт с оператором по `profiles.legacy_id`,
 * иначе по e-mail. @returns публичный оператор или null.
 */
export async function authenticateSupabase(email, password) {
  const authUser = await verifyAuthPassword(email, password)
  if (!authUser) return null
  const db = sb()
  let user = null
  if (db) {
    const { data: prof } = await db.from('profiles').select('legacy_id, active').eq('id', authUser.id).maybeSingle()
    if (prof && prof.active === false) return null
    if (prof?.legacy_id) user = await getUser(prof.legacy_id)
  }
  if (!user) user = await findByEmail(email)
  if (!user || !user.active) return null
  return publicUser(user)
}
