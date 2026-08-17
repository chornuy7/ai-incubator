/** CRUD + аутентификация операторов (§8.1). Монтируется в /api/users. */
import { Router } from 'express'
import { listUsers, getUser, createUser, updateUser, deleteUser, authenticate, authenticateSupabase, verifyPassword, publicUser, isBlockedByOwner, listSubs } from './users.js'
import { rolesForUser, mergePermissions, userRoleIds, hasAdminRole, ADMIN_ROLE_ID } from './roles.js'
import { capModules, applyDirectGrants } from './subAccess.js'
import { getBalance } from './balance.js'
import { requesterContext } from './lib/accessGuard.js'
import { appendAudit } from './lib/auditLog.js'
import { clockIn, clockOut, summariesFor } from './workLog.js'
import { signSession } from './lib/session.js'

/** §4.1 (MR-29): владелец не может назначать субу админ-роль (эскалация прав). */
function sanitizeRoleIds(roleIds) {
  if (roleIds === undefined) return undefined
  return (Array.isArray(roleIds) ? roleIds : []).filter((r) => r !== ADMIN_ROLE_ID)
}

/**
 * Эффективные права пользователя (union ролей) + §4.1 (MR-28) обрезка модулей суба до
 * оплаченных владельцем. Централизовано, чтобы вход и `/me` считали одинаково.
 * freeAccess-роль (тест/модератор) — доступ в обход подписки, её не режем.
 */
async function effectivePermissions(user, roles, isAdmin) {
  let permissions = isAdmin || roles.length === 0 ? null : mergePermissions(roles)
  const freeAccess = roles.some((r) => r?.permissions?.freeAccess)
  if (permissions && user.parentId && !freeAccess) {
    const bal = await getBalance(user.id).catch(() => null)
    permissions = capModules(permissions, bal?.modules)
  }
  // §5.4 (MR-37): прямые выдачи аккаунтов/групп субу — в эффективные права.
  if (permissions) permissions = applyDirectGrants(permissions, user)
  return permissions
}

/** Собрать ответ входа: публичный юзер + роль (для гейта UI) + подписанный токен. */
async function sessionPayload(user) {
  const ids = userRoleIds(user)
  const roles = await rolesForUser(user)
  const isAdmin = hasAdminRole(ids)
  const permissions = await effectivePermissions(user, roles, isAdmin)
  const role = { id: user.roleId || '', name: roles.map((r) => r.name).join(' + '), permissions }
  const isOwner = !isAdmin && (await listSubs(user.id)).length > 0 // §4.1 (MR-29): доступ к «Команде»
  return { user, role, roles, isOwner, token: signSession(user.id) }
}

export const usersRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

usersRouter.get('/', async (req, res) => {
  try {
    const ctx = await requesterContext(req)
    if (ctx.blocked) return res.status(403).json({ ok: false, error: 'Пользователь отключён' })
    const users = await listUsers()
    // §4.1 (MR-29): владелец видит только своих субпользователей (+ себя); админ/дев — всех.
    const visible = (ctx.noSession || ctx.isAdmin) ? users : users.filter((u) => u.parentId === ctx.id || u.id === ctx.id)
    res.json({ ok: true, users: visible.map(publicUser) })
  } catch (err) { fail(res, err, 500) }
})

/** Логин: публичный юзер + роль (гейт UI) + подписанный токен сессии. */
usersRouter.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body ?? {}
    // §11.9: пишем IP входа — по звонку 29.07 надо понимать, откуда заходят
    // (сценарий: доступ забрал уволенный сотрудник). За прокси берём первый
    // адрес из x-forwarded-for, иначе — сокет.
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || ''
    // §11.3 этап 4/4: вход ТОЛЬКО через Supabase Auth (источник истины паролей). Legacy
    // scrypt-вход (по users.password_hash) снят. Аварийный рычаг: если после выката кто-то
    // не может войти, выставить env AUTH_ALLOW_LEGACY=1 и перезапустить — вернёт fallback на
    // legacy без отката кода (таблица users живёт как точка отката до этапа drop).
    let via = 'supabase'
    let user = await authenticateSupabase(email, password)
    if (!user && process.env.AUTH_ALLOW_LEGACY) { user = await authenticate(email, password); via = 'legacy' }
    if (!user) {
      await appendAudit({ action: 'user.login.fail', module: 'auth', initiator: 'system', reason: `Неудачный вход: ${String(email || '').slice(0, 60)}`, meta: { ip } })
      return res.status(401).json({ ok: false, error: 'Неверный e-mail или пароль' })
    }
    // §4.1 (MR-28): зависимые статусы — если владелец отключён, суб внутрь не входит.
    if (await isBlockedByOwner(user)) {
      return res.status(403).json({ ok: false, error: 'Доступ закрыт: рабочее пространство владельца отключено' })
    }
    await clockIn(user.id) // учёт рабочего времени (§8.1): старт сессии труда
    await appendAudit({ action: 'user.login', module: 'auth', initiator: user.email, reason: `Вход: ${user.name}`, meta: { userId: user.id, roleIds: userRoleIds(user), ip, via } })
    res.json({ ok: true, ...(await sessionPayload(user)) })
  } catch (err) { fail(res, err, 500) }
})

/**
 * Самостоятельная регистрация с лендинга.
 *
 * Заводит юзера БЕЗ ролей — то есть без доступа к модулям, пока админ не выдаст его
 * вручную (фокус-группа: «зарегался → админ дал бесплатно на его аккаунты»). Сразу
 * логиним (возвращаем токен), чтобы человек попал в кабинет и ждал выдачи, а не входил
 * повторно. Пароль/почта проверяются в createUser (scrypt-хэш, уникальность e-mail).
 */
/** §10.2: включена ли капча + site-key — фронт спрашивает, показывать ли виджет. */
usersRouter.get('/auth-config', async (_req, res) => {
  const { turnstileConfig } = await import('./lib/turnstile.js')
  res.json({ ok: true, captcha: turnstileConfig() })
})

usersRouter.post('/register', async (req, res) => {
  try {
    const { email, password, name, captchaToken } = req.body ?? {}
    // §10.2: капча (если настроена) — до создания юзера. Не настроена → verifyTurnstile=true.
    const { verifyTurnstile } = await import('./lib/turnstile.js')
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress
    if (!(await verifyTurnstile(captchaToken, ip))) {
      return res.status(400).json({ ok: false, error: 'Проверка «я не робот» не пройдена — обновите страницу и попробуйте снова.' })
    }
    const user = await createUser({ email, password, name, roleIds: [], active: true })
    await appendAudit({ action: 'user.register', module: 'auth', initiator: user.email, reason: `Регистрация: ${user.name}`, meta: { userId: user.id } })
    const pub = publicUser(user)
    res.json({ ok: true, ...(await sessionPayload(pub)) })
  } catch (err) { fail(res, err, 400) }
})

/**
 * Кто я сейчас — с АКТУАЛЬНЫМИ правами.
 *
 * Права снимались снимком при входе и лежали в localStorage: админ выдавал роли
 * доступ к модулю, а человек продолжал видеть «Нет доступа к разделу», пока не
 * перезайдёт — и никакой подсказки об этом не было. Отзыв доступа так же
 * не срабатывал до перелогина, что уже вопрос безопасности, а не удобства.
 */
usersRouter.get('/me', async (req, res) => {
  try {
    const userId = req.header('x-user-id')
    if (!userId) return res.status(401).json({ ok: false, error: 'Нет сессии' })
    const user = await getUser(userId)
    if (!user || !user.active) return res.status(401).json({ ok: false, error: 'Пользователь отключён' })
    // §4.1 (MR-28): отключили владельца — суб теряет доступ, не дожидаясь перелогина.
    if (await isBlockedByOwner(user)) return res.status(403).json({ ok: false, error: 'Рабочее пространство владельца отключено' })
    const ids = userRoleIds(user)
    const roles = await rolesForUser(user)
    const isAdmin = hasAdminRole(ids)
    const permissions = await effectivePermissions(user, roles, isAdmin)
    const role = { id: user.roleId || '', name: roles.map((r) => r.name).join(' + '), permissions }
    // §4.1 (MR-29): владелец = у кого есть субпользователи → ему открыта «Команда».
    const isOwner = !isAdmin && (await listSubs(user.id)).length > 0
    res.json({ ok: true, user: publicUser(user), role, roles, isOwner })
  } catch (err) { fail(res, err, 500) }
})

/**
 * Смена собственного пароля (правка 14.08). Раньше это была демо-заглушка на фронте
 * (просто тост, без проверки). Теперь:
 *   - текущий пароль проверяется в БД (Supabase-вход; для файлового бэкенда — scrypt-хэш);
 *   - лимит надёжности нового пароля (≥8, буквы+цифры) — как на фронте;
 *   - обновление идёт через updateUser → Supabase Auth (или scrypt-хэш).
 */
usersRouter.post('/me/password', async (req, res) => {
  try {
    const userId = req.header('x-user-id')
    if (!userId) return res.status(401).json({ ok: false, error: 'Нет сессии' })
    const user = await getUser(userId)
    if (!user || !user.active) return res.status(401).json({ ok: false, error: 'Пользователь отключён' })
    const { currentPassword, newPassword } = req.body ?? {}
    const nw = String(newPassword ?? '')
    // Правка 14.08: валидация в ОБРАТНОМ порядке — СНАЧАЛА сверяем ТЕКУЩИЙ пароль с БД
    // (Supabase-вход, затем scrypt-хэш для файлового бэкенда), и только потом правила нового.
    let ok = false
    try { ok = !!(await authenticateSupabase(user.email, String(currentPassword ?? ''))) } catch { ok = false }
    if (!ok && user.passwordHash) ok = verifyPassword(String(currentPassword ?? ''), user.passwordHash)
    if (!ok) return res.status(403).json({ ok: false, error: 'Текущий пароль неверный' })
    // Затем — надёжность нового: 8–64 символа, буквы+цифры, не совпадает с текущим.
    if (nw.length < 8) return res.status(400).json({ ok: false, error: 'Новый пароль слишком короткий — минимум 8 символов' })
    if (nw.length > 64) return res.status(400).json({ ok: false, error: 'Новый пароль слишком длинный — максимум 64 символа' })
    if (!/[0-9]/.test(nw) || !/[a-zA-Zа-яА-Я]/.test(nw)) return res.status(400).json({ ok: false, error: 'Пароль должен содержать и буквы, и цифры' })
    if (nw === String(currentPassword ?? '')) return res.status(400).json({ ok: false, error: 'Новый пароль совпадает с текущим' })
    await updateUser(user.id, { password: nw })
    await appendAudit({ action: 'user.password', module: 'auth', initiator: user.id, reason: 'Смена пароля', meta: { userId: user.id } })
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})

/** Выход: закрыть сессию рабочего времени. */
usersRouter.post('/logout', async (req, res) => {
  try {
    const { userId } = req.body ?? {}
    const closed = userId ? await clockOut(userId) : null
    if (closed) await appendAudit({ action: 'user.logout', module: 'auth', initiator: userId, reason: 'Выход', meta: { userId, durationMs: closed.durationMs } })
    res.json({ ok: true, session: closed })
  } catch (err) { fail(res, err, 500) }
})

/** Сводка рабочего времени по всем пользователям (§8.1). */
usersRouter.get('/worktime', async (_req, res) => {
  try {
    const users = await listUsers()
    res.json({ ok: true, worktime: await summariesFor(users.map((u) => u.id)) })
  } catch (err) { fail(res, err, 500) }
})

usersRouter.post('/', async (req, res) => {
  try {
    const ctx = await requesterContext(req)
    if (ctx.blocked) return res.status(403).json({ ok: false, error: 'Нет прав на создание пользователей' })
    const body = { ...(req.body ?? {}) }
    // §4.1 (MR-29): владелец заводит суба ТОЛЬКО под собой и без админ-роли.
    if (!ctx.noSession && !ctx.isAdmin) {
      body.parentId = ctx.id
      body.roleIds = sanitizeRoleIds(body.roleIds)
    }
    const user = await createUser(body)
    await appendAudit({ action: 'user.create', module: 'rbac', initiator: ctx.id || 'operator', reason: `Создан пользователь ${user.email}`, meta: { userId: user.id, roleId: user.roleId, parentId: user.parentId } })
    res.json({ ok: true, user: publicUser(user) })
  } catch (err) { fail(res, err) }
})

usersRouter.put('/:id', async (req, res) => {
  try {
    const ctx = await requesterContext(req)
    if (ctx.blocked) return res.status(403).json({ ok: false, error: 'Нет прав' })
    let patch = req.body ?? {}
    // §4.1 (MR-29): владелец правит ТОЛЬКО своих субов и ограниченный набор полей
    // (роли/активность/имя/выдачи аккаунтов). parentId и пароль владельцу недоступны.
    if (!ctx.noSession && !ctx.isAdmin) {
      const target = await getUser(req.params.id)
      if (!target || target.parentId !== ctx.id) return res.status(403).json({ ok: false, error: 'Можно управлять только своими субпользователями' })
      const { name, active, roleIds, accountIds, accountGroupIds } = patch
      patch = { name, active, roleIds: sanitizeRoleIds(roleIds), accountIds, accountGroupIds }
    }
    const user = await updateUser(req.params.id, patch)
    if (!user) return res.status(404).json({ ok: false, error: 'Пользователь не найден' })
    await appendAudit({ action: 'user.update', module: 'rbac', initiator: ctx.id || 'operator', reason: `Изменён пользователь ${user.email}`, meta: { userId: user.id, roleId: user.roleId } })
    res.json({ ok: true, user: publicUser(user) })
  } catch (err) { fail(res, err) }
})

usersRouter.delete('/:id', async (req, res) => {
  try {
    const ctx = await requesterContext(req)
    if (ctx.blocked) return res.status(403).json({ ok: false, error: 'Нет прав' })
    if (!ctx.noSession && !ctx.isAdmin) {
      const target = await getUser(req.params.id)
      if (!target || target.parentId !== ctx.id) return res.status(403).json({ ok: false, error: 'Можно удалять только своих субпользователей' })
    }
    const ok = await deleteUser(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Пользователь не найден' })
    await appendAudit({ action: 'user.delete', module: 'rbac', initiator: ctx.id || 'operator', reason: 'Удалён пользователь', meta: { userId: req.params.id } })
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})
