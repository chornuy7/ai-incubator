/**
 * Сущность «Пользователь» (оператор системы) — §8.1. Привязан к роли (RBAC, roles.js).
 *
 * ПЕРЕЕЗД НА profiles (кол 29.07, «profile вместо user»). В Supabase-режиме источник
 * операторов — таблица `profiles` (профиль/роли/тип/вложенность), а e-mail и пароль
 * живут в `auth.users` (как просил замовник). Рабочий id остаётся `usr_…` — берём его
 * из `profiles.legacy_id`, чтобы не переписывать owner-ссылки в 13 таблицах данных.
 *
 * ЭТАП 4/4 (03.08): dual-write в `users` СНЯТ, вход — только через Supabase Auth.
 * Таблица `users` больше не пишется и не читается для входа; остаётся лишь как точка
 * отката до её drop (см. supabase/migrations/2026-08-03-drop-users-stage4.sql). Legacy
 * scrypt-вход (`authenticate`) вызывается только по аварийному флагу env AUTH_ALLOW_LEGACY.
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
  // §5.4 (MR-37): выданные субу аккаунты/группы из пула владельца.
  accountIds: r.account_ids || [], accountGroupIds: r.account_group_ids || [],
  // §4.2 (MR-30): режим баланса суба и лимит токенов.
  balanceMode: r.balance_mode || 'shared', tokenLimit: r.token_limit ?? null,
  createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
  updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0,
})

/** Нормализовать список id (уникальные непустые строки). */
function normIds(v) {
  if (!Array.isArray(v)) return undefined
  return [...new Set(v.map((x) => String(x || '').trim()).filter(Boolean))]
}
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
    accountIds: p.account_ids || [], accountGroupIds: p.account_group_ids || [], // §5.4 (MR-37)
    balanceMode: p.balance_mode || 'shared', tokenLimit: p.token_limit ?? null, // §4.2 (MR-30)
    user_type_id: p.user_type_id ?? null,
    createdAt: p.created_at ? new Date(p.created_at).getTime() : 0,
    updatedAt: p.updated_at ? new Date(p.updated_at).getTime() : 0,
    passwordHash: null, // пароль в auth.users, не здесь
  }
}

/** @returns {Promise<object[]>} операторы: из profiles (+e-mail из auth) или из файла. */
// Перф (созвон 17.08 «тёмная сторона луны»): listUsers на ГОРЯЧЕМ пути — accessGate на
// КАЖДЫЙ /api-запрос зовёт getUser → listUsers, а тот в supabase-режиме тянет ВСЕ профили
// + карту auth-e-mail. Без кэша это два тяжёлых запроса на каждый вызов API (заказчик
// показал флуд `profile profile user user`). Короткий TTL-кэш: повторные вызовы в окне
// берут готовый список; любая мутация юзеров сбрасывает кэш сразу (invalidateUsersCache),
// поэтому смена active/роли видна без задержки там, где меняем сами.
let _usersCache = null // { data, ts }
let _usersInflight = null
const USERS_CACHE_TTL = 8000
/** Сбросить кэш списка пользователей — звать после любой мутации (create/update/delete/active). */
export function invalidateUsersCache() { _usersCache = null; _usersInflight = null }

export async function listUsers() {
  // Кэшируем только в supabase-режиме: именно там listUsers = два тяжёлых запроса (все
  // профили + auth-e-mail) на горячем пути. Файловый режим (дев/тесты) читает локальный JSON
  // быстро, а один общий кэш на процесс мешал бы изоляции тестов (у каждого свой файл).
  if (!sb()) return loadUsers()
  // Свежий кэш → мгновенно, без запроса. Параллельные вызовы делят один inflight-запрос,
  // чтобы «холодный» момент не породил десяток одинаковых загрузок разом.
  if (_usersCache && Date.now() - _usersCache.ts < USERS_CACHE_TTL) return _usersCache.data
  if (_usersInflight) return _usersInflight
  _usersInflight = loadUsers()
    .then((data) => { _usersCache = { data, ts: Date.now() }; _usersInflight = null; return data })
    .catch((e) => { _usersInflight = null; throw e })
  return _usersInflight
}

async function loadUsers() {
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

/** §4.1 (MR-28): субпользователи владельца — все, у кого parentId === ownerId. */
export async function listSubs(ownerId, all) {
  const users = all || await listUsers()
  return users.filter((u) => u.parentId === ownerId)
}

/**
 * §4.2 (MR-30): чей кошелёк использовать для монет/денег пользователя. По умолчанию
 * баланс ОБЩИЙ с владельцем — суб с `balanceMode!=='individual'` тратит из кошелька
 * владельца (идём вверх по parentId, пока текущий делит баланс с владельцем). Как только
 * встречаем `individual` или верхнего владельца — это и есть кошелёк.
 *
 * Лёгкий запрос: в Supabase тянем только profiles (без auth-e-mail, в отличие от listUsers) —
 * функция на горячем пути (getBalance/списания). При росте — закэшировать.
 * @param {string} userId @returns {Promise<string>} id владельца кошелька (или сам userId)
 */
export async function resolveWalletOwner(userId) {
  const id = String(userId || '')
  if (!id || id === '__default') return id
  let byId = new Map()
  const db = sb()
  if (db) {
    const { data } = await db.from('profiles').select('id, legacy_id, parent_id, balance_mode')
    const rows = (data || []).filter((p) => p.legacy_id)
    const legacyByUuid = new Map(rows.map((p) => [p.id, p.legacy_id]))
    byId = new Map(rows.map((p) => [p.legacy_id, { id: p.legacy_id, parentId: p.parent_id ? (legacyByUuid.get(p.parent_id) || null) : null, balanceMode: p.balance_mode || 'shared' }]))
  } else {
    const users = await readJson(USERS_FILE(), [])
    byId = new Map((Array.isArray(users) ? users : []).map((u) => [u.id, { id: u.id, parentId: u.parentId || null, balanceMode: u.balanceMode || 'shared' }]))
  }
  let cur = byId.get(id)
  const seen = new Set()
  while (cur && cur.parentId && cur.balanceMode !== 'individual' && !seen.has(cur.id)) {
    seen.add(cur.id)
    const parent = byId.get(cur.parentId)
    if (!parent) break
    cur = parent
  }
  return cur ? cur.id : id
}

/**
 * §4.1 (MR-28): чья ПОДПИСКА определяет набор модулей пользователя.
 *
 * Модули покупает рабочее пространство, а не сотрудник, поэтому здесь идём вверх до
 * самого владельца ВСЕГДА — в отличие от кошелька, где `individual` обрывает подъём:
 * суб может тратить свои монеты, но купить себе модуль вне пула владельца не может.
 *
 * Без этого суб без личной подписки проваливался на общий набор `workspace` — то есть
 * получал модули, которых владелец не покупал (прогон 18.08: владельцу оплачены три
 * модуля, субу открывался нейрокомментинг из чужого набора).
 * @param {string} userId @returns {Promise<string>} id владельца подписки (или сам userId)
 */
export async function resolveSubscriptionOwner(userId) {
  const id = String(userId || '')
  if (!id || id === '__default') return id
  let byId = new Map()
  const db = sb()
  if (db) {
    const { data } = await db.from('profiles').select('id, legacy_id, parent_id')
    const rows = (data || []).filter((p) => p.legacy_id)
    const legacyByUuid = new Map(rows.map((p) => [p.id, p.legacy_id]))
    byId = new Map(rows.map((p) => [p.legacy_id, { id: p.legacy_id, parentId: p.parent_id ? (legacyByUuid.get(p.parent_id) || null) : null }]))
  } else {
    const users = await readJson(USERS_FILE(), [])
    byId = new Map((Array.isArray(users) ? users : []).map((u) => [u.id, { id: u.id, parentId: u.parentId || null }]))
  }
  let cur = byId.get(id)
  const seen = new Set()
  while (cur && cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id)
    const parent = byId.get(cur.parentId)
    if (!parent) break
    cur = parent
  }
  return cur ? cur.id : id
}

/** §4.2 (MR-30): нормализовать режим баланса. */
function normBalanceMode(v) {
  return v === 'individual' ? 'individual' : 'shared'
}

/**
 * §4.1 (MR-28): «синхронизировать зависимые статусы владельца и субов». Суб теряет
 * доступ, если отключён любой владелец выше по цепочке — блокировка владельца каскадит
 * на всех его субов. Возвращает true, если доступ должен быть закрыт из-за владельца.
 * (На проде это же делает триггер БД 2026-08-04-owner-sync.sql; здесь — надёжный
 *  runtime-барьер, работающий в обоих бэкендах и до срабатывания триггера.)
 * @param {object|null} user @param {object[]} [all] заранее загруженный список (без лишнего чтения)
 */
export async function isBlockedByOwner(user, all) {
  if (!user?.parentId) return false
  const users = all || await listUsers()
  const byId = new Map(users.map((u) => [u.id, u]))
  const seen = new Set([user.id])
  let cur = byId.get(user.parentId)
  while (cur && !seen.has(cur.id)) {
    if (cur.active === false) return true
    seen.add(cur.id)
    cur = cur.parentId ? byId.get(cur.parentId) : null
  }
  return false
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
    const balanceMode = normBalanceMode(input.balanceMode) // §4.2 (MR-30)
    const tokenLimit = input.tokenLimit == null ? null : Math.max(0, Number(input.tokenLimit) || 0)
    await db.from('profiles').update({ legacy_id: legacyId, name, active: input.active !== false, role_ids: roleIds, parent_id: parentUuid, balance_mode: balanceMode, token_limit: tokenLimit, updated_at: new Date().toISOString() }).eq('id', authId)
    // §11.3 этап 4/4: dual-write в `users` снят — источник истины profiles + auth.users.
    invalidateUsersCache()
    return { id: legacyId, email, name, roleId, roleIds, active: input.active !== false, parentId, accountIds: [], accountGroupIds: [], balanceMode, tokenLimit, createdAt: now, updatedAt: now }
  }

  const users = await listUsers()
  if (parentId && !users.some((u) => u.id === parentId)) throw new Error('Родительский пользователь не найден')
  const user = { id: `usr_${crypto.randomUUID().slice(0, 8)}`, email, name, roleId, roleIds, active: input.active !== false, parentId, accountIds: normIds(input.accountIds) || [], accountGroupIds: normIds(input.accountGroupIds) || [], balanceMode: normBalanceMode(input.balanceMode), tokenLimit: input.tokenLimit == null ? null : Math.max(0, Number(input.tokenLimit) || 0), passwordHash: hashPassword(input.password), createdAt: now, updatedAt: now }
  users.push(user)
  await writeJson(USERS_FILE(), users)
  invalidateUsersCache()
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
    if (patch.accountIds !== undefined) next.accountIds = normIds(patch.accountIds) || [] // §5.4 (MR-37)
    if (patch.accountGroupIds !== undefined) next.accountGroupIds = normIds(patch.accountGroupIds) || []
    if (patch.balanceMode !== undefined) next.balanceMode = normBalanceMode(patch.balanceMode) // §4.2 (MR-30)
    if (patch.tokenLimit !== undefined) next.tokenLimit = patch.tokenLimit == null ? null : Math.max(0, Number(patch.tokenLimit) || 0)
    // profiles — источник правды: роли/имя/активность/parent (uuid) + выдачи + режим баланса.
    let parentUuid = null
    if (next.parentId) { const pp = await profileByLegacy(db, next.parentId); parentUuid = pp?.id || null }
    await db.from('profiles').update({ name: next.name, active: next.active, role_ids: next.roleIds, parent_id: parentUuid, account_ids: next.accountIds || [], account_group_ids: next.accountGroupIds || [], balance_mode: next.balanceMode || 'shared', token_limit: next.tokenLimit ?? null, updated_at: new Date().toISOString() }).eq('id', prof.id)
    // Пароль — только в auth.users.
    if (patch.password) {
      if (String(patch.password).length < 6) throw new Error('Пароль минимум 6 символов')
      await db.auth.admin.updateUserById(prof.id, { password: String(patch.password) })
    }
    // §11.3 этап 4/4: dual-write в `users` снят — профиль в profiles, пароль в auth.users.
    next.updatedAt = Date.now()
    invalidateUsersCache()
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
  if (patch.accountIds !== undefined) users[i].accountIds = normIds(patch.accountIds) || [] // §5.4 (MR-37)
  if (patch.accountGroupIds !== undefined) users[i].accountGroupIds = normIds(patch.accountGroupIds) || []
  if (patch.balanceMode !== undefined) users[i].balanceMode = normBalanceMode(patch.balanceMode) // §4.2 (MR-30)
  if (patch.tokenLimit !== undefined) users[i].tokenLimit = patch.tokenLimit == null ? null : Math.max(0, Number(patch.tokenLimit) || 0)
  if (patch.password) {
    if (String(patch.password).length < 6) throw new Error('Пароль минимум 6 символов')
    users[i].passwordHash = hashPassword(patch.password)
  }
  users[i].updatedAt = Date.now()
  await writeJson(USERS_FILE(), users)
  invalidateUsersCache()
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
    // §11.3 этап 4/4: dual-write в `users` снят.
    invalidateUsersCache()
    return true
  }
  const users = await listUsers()
  const next = users.filter((u) => u.id !== id)
  if (next.length === users.length) return false
  for (const u of next) if (u.parentId === id) u.parentId = null
  await writeJson(USERS_FILE(), next)
  invalidateUsersCache()
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
