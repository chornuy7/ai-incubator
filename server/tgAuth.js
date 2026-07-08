import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/StringSession.js'
import { Api } from 'telegram/tl/index.js'
import { computeCheck } from 'telegram/Password.js'
import { SESSIONS_DIR, API_ID, API_HASH, PENDING_TTL_MS } from './config.js'
import { parseProxy, clientOptions } from './proxy.js'
import { setAccountMeta, countryFromPhone, avatarColor } from './accountsMeta.js'

/** @typedef {{ client: TelegramClient, phone: string, phoneCodeHash: string, proxy?: string, accountId?: string, timer: NodeJS.Timeout }} PendingAuth */

/** @type {Map<string, PendingAuth>} */
const pending = new Map()

async function ensureSessionsDir() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true })
}

function sessionFile(accountId) {
  return path.join(SESSIONS_DIR, `${accountId}.session`)
}

async function saveSession(accountId, sessionString) {
  await ensureSessionsDir()
  await fs.writeFile(sessionFile(accountId), sessionString, 'utf8')
}

export async function loadSessionString(accountId) {
  try {
    return await fs.readFile(sessionFile(accountId), 'utf8')
  } catch {
    return ''
  }
}

function newAccountId(phone) {
  const hash = crypto.createHash('sha256').update(phone + Date.now()).digest('hex').slice(0, 12)
  return `acc_${hash}`
}

function scheduleCleanup(authId) {
  const timer = setTimeout(() => {
    void dropPending(authId)
  }, PENDING_TTL_MS)
  return timer
}

async function dropPending(authId) {
  const p = pending.get(authId)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(authId)
  try {
    await p.client.disconnect()
  } catch {
    /* ignore */
  }
}

export async function createClient(sessionString, proxyRaw) {
  const proxy = parseProxy(proxyRaw)
  const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, clientOptions(proxy))
  await client.connect()
  return client
}

function userPayload(me, accountId, phone, proxy) {
  const first = me.firstName || ''
  const last = me.lastName || ''
  const name = `${first} ${last}`.trim() || phone
  return {
    accountId,
    phone: me.phone || phone,
    name,
    username: me.username || `user_${accountId.slice(-6)}`,
    userId: me.id?.toString?.() ?? '',
    proxy: proxy || '—',
  }
}

/** @param {unknown} err */
function mapError(err) {
  if (err && typeof err === 'object') {
    const e = /** @type {{ errorMessage?: string, message?: string }} */ (err)
    const msg = e.errorMessage || e.message || ''
    if (msg.includes('PHONE_CODE_INVALID')) return 'Неверный код подтверждения'
    if (msg.includes('PHONE_CODE_EXPIRED')) return 'Код истёк — запросите новый'
    if (msg.includes('PHONE_NUMBER_INVALID')) return 'Некорректный номер телефона'
    if (msg.includes('PHONE_NUMBER_FLOOD')) return 'Слишком много попыток — подождите'
    if (msg.includes('PASSWORD_HASH_INVALID')) return 'Неверный пароль 2FA'
    if (msg.includes('SESSION_PASSWORD_NEEDED')) return 'Требуется пароль 2FA'
    if (msg) return msg
  }
  return 'Ошибка Telegram API'
}

export async function tgSendCode({ phone, proxy, accountId }) {
  const normalized = phone.replace(/\s/g, '')
  if (!/^\+\d{8,15}$/.test(normalized)) {
    throw new Error('Номер должен быть в формате +380XXXXXXXXX')
  }

  const authId = crypto.randomUUID()
  const sessionStr = accountId ? await loadSessionString(accountId) : ''
  const client = await createClient(sessionStr, proxy)

  const sent = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, normalized)

  const timer = scheduleCleanup(authId)
  pending.set(authId, {
    client,
    phone: normalized,
    phoneCodeHash: sent.phoneCodeHash,
    proxy,
    accountId,
    timer,
  })

  return {
    ok: true,
    authId,
    isCodeViaApp: sent.isCodeViaApp ?? false,
  }
}

export async function tgVerifyCode({ authId, code }) {
  const p = pending.get(authId)
  if (!p) throw new Error('Сессия авторизации истекла — начните заново')

  try {
    await p.client.signInUser(
      { apiId: API_ID, apiHash: API_HASH },
      {
        phoneNumber: p.phone,
        phoneCode: async () => code.trim(),
        phoneCodeHash: p.phoneCodeHash,
        onError: (err) => {
          throw err
        },
      },
    )
  } catch (err) {
    const e = /** @type {{ errorMessage?: string }} */ (err)
    if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      return { ok: true, needs2fa: true }
    }
    throw new Error(mapError(err))
  }

  return finalizeAuth(authId, p)
}

export async function tgVerify2fa({ authId, password }) {
  const p = pending.get(authId)
  if (!p) throw new Error('Сессия авторизации истекла — начните заново')
  if (!password?.trim()) throw new Error('Введите пароль 2FA')

  try {
    const pwdInfo = await p.client.invoke(new Api.account.GetPassword())
    const check = await computeCheck(pwdInfo, password.trim())
    await p.client.invoke(new Api.auth.CheckPassword({ password: check }))
  } catch (err) {
    throw new Error(mapError(err))
  }

  return finalizeAuth(authId, p)
}

async function finalizeAuth(authId, p) {
  const me = await p.client.getMe()
  const accountId = p.accountId || newAccountId(p.phone)
  const sessionString = p.client.session.save()
  await saveSession(accountId, sessionString)

  const account = userPayload(me, accountId, p.phone, p.proxy)

  await setAccountMeta(accountId, {
    proxy: p.proxy || '—',
    country: countryFromPhone(account.phone),
    status: 'active',
    inTrash: false,
    name: account.name,
    username: account.username,
    phone: account.phone,
    userId: account.userId,
    avatarColor: avatarColor(accountId),
  })

  await dropPending(authId)

  return { ok: true, needs2fa: false, account }
}

export async function tgCheckSession(accountId) {
  const sessionStr = await loadSessionString(accountId)
  if (!sessionStr) return { ok: false, reason: 'no_session' }

  const client = await createClient(sessionStr, undefined)
  try {
    const me = await client.getMe()
    await client.disconnect()
    return { ok: true, userId: me.id?.toString?.() }
  } catch {
    try {
      await client.disconnect()
    } catch {
      /* ignore */
    }
    return { ok: false, reason: 'invalid_session' }
  }
}
