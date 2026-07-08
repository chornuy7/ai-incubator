import { COUNTRIES } from '@/shared/config/countries'

export { COUNTRIES }

export interface SendCodeResult {
  ok: boolean
  authId: string
  isCodeViaApp: boolean
}

export interface TgAccountPayload {
  accountId: string
  phone: string
  name: string
  username: string
  userId: string
  proxy: string
}

export interface VerifyCodeResult {
  ok: boolean
  needs2fa?: boolean
  account?: TgAccountPayload
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return data as T
}

/** Отправка реального SMS/Telegram-кода через MTProto API. proxy — опционально. */
export async function sendCode(phone: string, proxy?: string, accountId?: string): Promise<SendCodeResult> {
  return post('/api/tg/send-code', {
    phone,
    ...(proxy ? { proxy } : {}),
    ...(accountId ? { accountId } : {}),
  })
}

/** Проверка кода из SMS / Telegram */
export async function verifyCode(authId: string, code: string): Promise<VerifyCodeResult> {
  return post('/api/tg/verify-code', { authId, code })
}

/** Проверка облачного пароля 2FA */
export async function verify2fa(authId: string, password: string): Promise<{ ok: boolean; account: TgAccountPayload }> {
  return post('/api/tg/verify-2fa', { authId, password })
}

/** Мок-проверка прокси (локально, без сети) */
export async function checkProxy(_proxy: string): Promise<{ ok: boolean; ping: number }> {
  await new Promise((r) => setTimeout(r, 400))
  return { ok: true, ping: 40 + Math.floor(Math.random() * 120) }
}
