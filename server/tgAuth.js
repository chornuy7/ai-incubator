import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/StringSession.js'
import { Api } from 'telegram/tl/index.js'
import { computeCheck } from 'telegram/Password.js'
import { SESSIONS_DIR, API_ID, API_HASH, PENDING_TTL_MS } from './config.js'
import { parseProxy, clientOptions } from './proxy.js'
import { tcpPing } from './proxies.js'
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

/** Записать строку-сессию под accountId. Экспортируется для §2 (массовый импорт). */
export async function saveSession(accountId, sessionString) {
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

/** Новый id аккаунта. Экспортируется для §2 (массовый импорт). */
export function newAccountId(phone) {
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

/**
 * Клиент по строке-сессии.
 *
 * `fingerprint` — отпечаток устройства, под которым сессия РОЖДЕНА (приходит из json
 * рядом с купленным аккаунтом: app_id/app_hash, модель устройства, версия системы и
 * приложения, язык). Подключаться чужим отпечатком — это для Telegram смена устройства
 * на живой авторизации, самый быстрый способ получить к себе внимание антифрода.
 * Поэтому если отпечаток известен — идём именно с ним, а свои API-креды берём только
 * когда своих данных нет.
 * @param {string} sessionString
 * @param {string} [proxyRaw]
 * @param {{apiId?:number, apiHash?:string, device?:string, system?:string, appVersion?:string, langCode?:string, systemLangCode?:string}} [fingerprint]
 */
export async function createClient(sessionString, proxyRaw, fingerprint) {
  const proxy = parseProxy(proxyRaw)
  // MR-129: быстрый TCP-пинг прокси ПЕРЕД тяжёлым TG-коннектом. Мёртвый прокси отсекаем
  // за ~2.5с с понятной ошибкой «Прокси не отвечает», а не ждём таймаут подключения 12с.
  // Ускоряет карточку, каналы и группы; ошибку ловит UI и показывает «прокси недоступен».
  if (proxy && proxy.ip && proxy.port) {
    const reachable = await tcpPing(proxy.ip, proxy.port, 2500)
    if (!reachable) throw new Error('Прокси не отвечает — проверьте прокси или назначьте рабочий')
  }
  const fp = fingerprint || {}
  const opts = clientOptions(proxy)
  if (fp.device) opts.deviceModel = fp.device
  if (fp.system) opts.systemVersion = fp.system
  if (fp.appVersion) opts.appVersion = fp.appVersion
  if (fp.langCode) opts.langCode = fp.langCode
  if (fp.systemLangCode) opts.systemLangCode = fp.systemLangCode
  const apiId = Number(fp.apiId) || API_ID
  const apiHash = fp.apiHash || API_HASH
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, opts)
  await connectWithTimeout(client)
  return client
}

/**
 * MR-129: жёсткий предел на подключение. Без него мёртвый/медленный прокси с
 * connectionRetries:5 держал соединение десятки секунд, и карточка аккаунта висела
 * на «Загрузка данных из Telegram…» (вечный лоадер). Теперь через TG_CONNECT_TIMEOUT_MS
 * (по умолчанию 12с — рабочий прокси коннектится за 1–3с, мёртвый падает быстро) падаем
 * с понятной ошибкой — её ловит accountStats и показывает «прокси/сессия недоступны»
 * вместо бесконечной загрузки.
 */
async function connectWithTimeout(client) {
  const ms = Math.max(5000, Number(process.env.TG_CONNECT_TIMEOUT_MS) || 12000)
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Не удалось подключиться за ${Math.round(ms / 1000)}с — проверьте прокси/сеть`)), ms)
  })
  try {
    await Promise.race([client.connect(), timeout])
  } catch (err) {
    // НЕ ждём disconnect бесконечно: на битом socks-прокси (Socks5 auth failed и т.п.)
    // client.disconnect() может зависнуть — и тогда весь воркер застревает ЗДЕСЬ, не
    // доходя до точки проверки «Стоп» (breakableDelay), из-за чего стоп игнорируется
    // десятками секунд. Гасим соединение в фоне с собственным лимитом и сразу пробрасываем ошибку.
    void Promise.race([
      Promise.resolve().then(() => client.disconnect()).catch(() => {}),
      new Promise((r) => setTimeout(r, 3000)),
    ])
    throw err
  } finally {
    clearTimeout(timer)
  }
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
