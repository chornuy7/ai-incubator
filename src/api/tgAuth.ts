import { COUNTRIES } from '@/shared/config/countries'
import { apiPost } from './client'

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

// Через authed-клиент (X-User-Id + Bearer) — добавление аккаунтов идёт от имени владельца.
async function post<T>(path: string, body: Record<string, unknown>): Promise<T> { return apiPost<T>(path, body) }

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
