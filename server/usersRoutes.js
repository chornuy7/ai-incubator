/** CRUD + аутентификация операторов (§8.1). Монтируется в /api/users. */
import { Router } from 'express'
import { listUsers, getUser, createUser, updateUser, deleteUser, authenticate, authenticateSupabase, authSupabaseResult, verifyPassword, publicUser, isBlockedByOwner } from './users.js'
import { rolesForUser, mergePermissions, unrestrictedPermissions, userRoleIds, hasAdminRole, ADMIN_ROLE_ID } from './roles.js'
import { BLOCKS, listRoles, createRole, updateRole, ALLOW, DENY } from './roles.js'
import { MODULE_LABELS } from './lib/accountLocks.js'
import { modulesAllow } from './balance.js'
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
  // `null` = «правами не ограничен», и так это понимает сервер. Но клиентский `can()`
  // читает null как «прав нет» и закрывает всё — из-за этого владелец без роли (обычная
  // самостоятельная регистрация) видел пустое меню, хотя модули оплачены. Админу null
  // безопасен: у него отдельный обход (isAdmin), а вот роль-less ВЛАДЕЛЬЦУ выдаём явные
  // права. Суб без роли остаётся без прав — сотруднику доступ выдаёт владелец.
  const { listModuleKeys } = await import('./modules/registry.js')
  let permissions = isAdmin
    ? null
    : roles.length === 0
      ? (user.parentId ? mergePermissions([]) : unrestrictedPermissions(listModuleKeys()))
      : mergePermissions(roles)
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
  // Верхнеуровневый пользователь без роли — ВЛАДЕЛЕЦ своего пространства, а не «роль не
  // задана» (правка 18.08). Полный доступ внутри своего кабинета у него уже есть, не
  // хватало только имени: интерфейс показывал «Роль: Роль не задана» человеку, который
  // только что зарегистрировался и купил модуль. Платформенным админом он при этом НЕ
  // становится — sudo остаётся за ADMIN_ROLE_ID.
  const isSub = !!user.parentId
  const name = roles.length ? roles.map((r) => r.name).join(' + ') : (isAdmin ? 'Администратор' : (isSub ? '' : 'Владелец'))
  const role = { id: user.roleId || '', name, permissions }
  // §4.1 (MR-29): «Команда» — любому владельцу пространства, а не только тому, у кого
  // субы УЖЕ есть: иначе первого суба некому было создать.
  const isOwner = !isAdmin && !isSub
  return { user, role, roles, isOwner, isSub, token: signSession(user.id) }
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
    // §4.1 (MR-29): владелец видит только своих субпользователей (+ себя).
    //
    // Правка 18.08: под это правило попал и АДМИН. Раньше ему отдавался весь список
    // платформы — 65 юзеров, из них 59 чужих самостоятельных регистраций — прямо на
    // странице «Команда» в рабочей панели. Своё рабочее пространство и управление
    // платформой смешивались в одном экране.
    //
    // Возможность управлять всеми не отобрана, она стала явной: `?scope=all` (только
    // админу) — переключатель в интерфейсе. По умолчанию любой видит только своих.
    const wantAll = String(req.query.scope || '') === 'all' && (ctx.noSession || ctx.isAdmin)
    // Себя в списке команды нет (правка 18.08): страница про сотрудников, а собственная
    // карточка только мешала — ролями себя не ограничивают, а клик по ним упирался в отказ.
    const visible = wantAll ? users : users.filter((u) => u.parentId === ctx.id)
    res.json({ ok: true, users: visible.map(publicUser) })
  } catch (err) { fail(res, err, 500) }
})

/** Логин: публичный юзер + роль (гейт UI) + подписанный токен сессии. */
/**
 * §5.3 (MR-36): «зайти под аккаунтом клиента и проверить доступы».
 *
 * Владелец платформы открывает панель ГЛАЗАМИ клиента — иначе проверить, что человеку
 * видно и что разрешено, можно только с его паролем. Выдаём обычную панельную сессию
 * этого пользователя: интерфейс не знает про «особый режим» и показывает ровно то же,
 * что увидел бы сам клиент.
 *
 * Ограничения намеренные:
 *  - только платформенный админ (не владелец пространства): это чужой кабинет;
 *  - под другим админом входить нельзя — иначе один админ тихо получает права другого;
 *  - каждый вход пишется в аудит: под кого, кто и когда. Смотреть чужой кабинет —
 *    нормально, делать это незаметно — нет.
 */
usersRouter.post('/impersonate', async (req, res) => {
  try {
    const { isAdminRequest } = await import('./lib/accessGuard.js')
    if (!(await isAdminRequest(req))) return fail(res, new Error('Доступно только администратору'), 403)
    const targetId = String(req.body?.userId || '')
    if (!targetId) return fail(res, new Error('Не указан пользователь'), 400)
    const target = await getUser(targetId).catch(() => null)
    if (!target) return fail(res, new Error('Пользователь не найден'), 404)
    if (hasAdminRole(userRoleIds(target))) return fail(res, new Error('Под другим администратором входить нельзя'), 403)

    const payload = await sessionPayload(target)
    const { appendAudit } = await import('./lib/auditLog.js')
    await appendAudit({
      action: 'user.impersonate',
      initiator: req.header('x-user-id') || '',
      targetId,
      reason: `Вход под пользователем ${target.email || targetId}`,
    }).catch(() => {})
    res.json({ ok: true, ...payload, user: publicUser(target) })
  } catch (err) { fail(res, err) }
})

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
    const attempt = await authSupabaseResult(email, password)
    let user = attempt.user
    let reason = attempt.reason
    if (!user && process.env.AUTH_ALLOW_LEGACY) {
      user = await authenticate(email, password)
      if (user) { via = 'legacy'; reason = null }
    }
    if (!user) {
      await appendAudit({ action: 'user.login.fail', module: 'auth', initiator: 'system', reason: `Неудачный вход: ${String(email || '').slice(0, 60)}`, meta: { ip, why: reason } })
      // Созвон 17.08: отключённому нельзя отвечать «неверный пароль» — пароль-то верный.
      // Человек должен понять, что дело в доступе, и пойти к администратору, а не крутить
      // восстановление пароля по кругу.
      // Код ACCESS_DISABLED здесь НЕ шлём намеренно: фронт поднимает по нему поп-ап-блок
      // поверх панели (MR-153), а тут человек ещё снаружи — ему нужен текст в форме входа.
      if (reason === 'disabled') {
        return res.status(403).json({ ok: false, error: 'Доступ отключён администратором. Обратитесь к администратору или в поддержку.' })
      }
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
    // Та же сборка, что и при входе: расхождение «вошёл с одними правами, обновил
    // страницу — с другими» ловится тяжелее всего.
    const { role, roles, isOwner, isSub } = await sessionPayload(user)
    res.json({ ok: true, user: publicUser(user), role, roles, isOwner, isSub })
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

/**
 * Сводка рабочего времени (§8.1) — только по СВОИМ людям.
 *
 * Роут был объявлен как `(_req, res)` и отдавал часы всех пользователей платформы: по
 * ним читается и состав чужой команды (id тех, кто вообще есть), и когда сосед работает.
 * Правило то же, что у `GET /api/users`: владелец видит своих субов, админ и дев-режим —
 * всех. Себя оставляем в выдаче: собственные часы человек видеть вправе.
 */
usersRouter.get('/worktime', async (req, res) => {
  try {
    const ctx = await requesterContext(req)
    if (ctx.blocked) return res.status(403).json({ ok: false, error: 'Пользователь отключён' })
    const users = await listUsers()
    const visible = (ctx.noSession || ctx.isAdmin)
      ? users
      : users.filter((u) => u.parentId === ctx.id || u.id === ctx.id)
    res.json({ ok: true, worktime: await summariesFor(visible.map((u) => u.id)) })
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

/**
 * Доступ субпользователя к модулям и блокам — в ЕГО карточке (уточнение владельца 21.08:
 * «при создании пользователя он настраивает, какой модуль показывать, какой нет, но
 * только из тех, какие подписки у него куплены, и дальше уже блоки»).
 *
 * Под капотом это по-прежнему роль — гейт доступа (`accessGuard`) умеет только роли, —
 * но владельцу про роли знать не нужно: у каждого суба заводится СВОЯ, невидимая в
 * интерфейсе. Отдельная страница «Роли и доступы» остаётся админской.
 *
 * @param {object} owner @param {object} sub
 * @returns {Promise<object|null>} персональная роль суба или null
 */
async function personalRole(sub) {
  const ids = userRoleIds(sub)
  const all = await listRoles()
  return all.find((r) => ids.includes(r.id) && r.personalFor === sub.id) || null
}

/** Кто может настраивать доступ этого суба: админ платформы или ЕГО владелец. */
async function accessGate(req, res) {
  const ctx = await requesterContext(req)
  if (ctx.blocked) { res.status(403).json({ ok: false, error: 'Нет прав' }); return null }
  const target = await getUser(req.params.id)
  if (!target) { res.status(404).json({ ok: false, error: 'Пользователь не найден' }); return null }
  if (!ctx.noSession && !ctx.isAdmin && target.parentId !== ctx.id) {
    res.status(403).json({ ok: false, error: 'Можно управлять только своими субпользователями' })
    return null
  }
  return { ctx, target }
}

/** Модули, которые владелец вправе раздавать: строго его оплаченная подписка. */
async function ownerModules(ctx, target) {
  if (ctx.noSession || ctx.isAdmin) return Object.keys(MODULE_LABELS)
  const b = await getBalance(target.parentId || ctx.id)
  return Object.keys(MODULE_LABELS).filter((k) => modulesAllow(b.modules, k, b.expiresAt ?? null))
}

usersRouter.get('/:id/access', async (req, res) => {
  try {
    const g = await accessGate(req, res)
    if (!g) return
    const role = await personalRole(g.target)
    const keys = await ownerModules(g.ctx, g.target)
    res.json({
      ok: true,
      modules: role?.permissions?.modules || {},
      blocks: role?.permissions?.blocks || {},
      catalog: {
        modules: keys.map((k) => ({ key: k, label: MODULE_LABELS[k] || k })),
        blocks: BLOCKS,
      },
    })
  } catch (err) { fail(res, err) }
})

usersRouter.put('/:id/access', async (req, res) => {
  try {
    const g = await accessGate(req, res)
    if (!g) return
    const allowed = new Set(await ownerModules(g.ctx, g.target))
    const wantMods = req.body?.modules || {}
    // Выдать можно только оплаченное. Форма и так показывает лишь свои модули, но прямой
    // запрос её обходит, а цена ошибки — «доступ выдан» на бумаге и отказ при запуске.
    const outside = Object.entries(wantMods).filter(([k, v]) => v === ALLOW && !allowed.has(k)).map(([k]) => k)
    if (outside.length) {
      return res.status(403).json({ ok: false, error: `Нельзя выдать то, что не оплачено: ${outside.join(', ')}` })
    }
    const modules = {}
    for (const k of allowed) modules[k] = wantMods[k] === ALLOW ? ALLOW : DENY
    // Блоки держим только у разрешённых модулей: у скрытого модуля они не значат ничего,
    // а в хранилище копились бы мусором после каждой правки подписки.
    const blocks = {}
    for (const [k, v] of Object.entries(req.body?.blocks || {})) {
      const [mod] = String(k).split(':')
      if (modules[mod] === ALLOW) blocks[k] = v === ALLOW ? ALLOW : DENY
    }

    const existing = await personalRole(g.target)
    const permissions = { ...(existing?.permissions || {}), modules, blocks }
    let role = existing
    if (role) {
      role = await updateRole(role.id, { permissions })
    } else {
      role = await createRole({
        name: `Доступ · ${g.target.name || g.target.email}`,
        userId: g.target.parentId || g.ctx.id,
        personalFor: g.target.id,
        permissions,
      })
      // Персональная роль ЗАМЕНЯЕТ прежние: две роли суммировались бы, и выключенный
      // владельцем модуль остался бы открыт через старую роль — «выключил, а работает».
      await updateUser(g.target.id, { roleIds: [role.id], roleId: role.id })
    }
    await appendAudit({
      action: 'user.access', module: 'rbac', initiator: g.ctx.id || 'operator',
      reason: `Доступ ${g.target.email}: ${Object.values(modules).filter((v) => v === ALLOW).length} модул.`,
      meta: { userId: g.target.id, roleId: role?.id },
    })
    res.json({ ok: true })
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
