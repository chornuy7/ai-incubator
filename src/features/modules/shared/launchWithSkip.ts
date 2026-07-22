import { ApiError } from '@/api/client'
import type { UnavailablePayload, BlockedAccount } from '@/api/modulesApi'
import { confirmDialog } from '@/shared/lib/dialog'

/** Человеческое название статуса — в диалоге «acc_1 (spamblock)» ничего не говорит. */
const STATUS_RU: Record<string, string> = {
  spamblock: 'спамблок',
  quarantine: 'карантин',
  floodwait: 'FloodWait',
  invalid: 'невалидный',
  frozen: 'заморожен',
  reauth: 'нужна реавторизация',
  pause: 'на паузе',
  warming: 'на прогреве',
  working: 'занят задачей',
}

/** Свернуть список в «карантин — 9, спамблок — 19». */
export function summarizeBlocked(blocked: BlockedAccount[] = []): string {
  const by = new Map<string, number>()
  for (const b of blocked) {
    const label = b.reason && b.reason !== 'статус' ? b.reason : STATUS_RU[b.status] || b.status
    by.set(label, (by.get(label) || 0) + 1)
  }
  return [...by.entries()].map(([label, n]) => `${label} — ${n}`).join(', ')
}

/**
 * Запустить задачу, а если часть аккаунтов недоступна — спросить и запустить на оставшихся.
 *
 * Один профиль в карантине валил весь запуск: человек шёл в менеджер аккаунтов, искал
 * виноватого, правил набор и возвращался. При трёх десятках аккаунтов, часть которых
 * постоянно в спамблоке, это тупик — а решение всегда одно и то же: «запусти без них».
 * Поэтому спрашиваем прямо здесь.
 *
 * @param run функция запуска; `skip=true` — повтор с исключением недоступных
 * @returns результат запуска или null, если человек отказался
 */
export async function launchWithSkip<T>(run: (skip: boolean) => Promise<T>): Promise<T | null> {
  try {
    return await run(false)
  } catch (err) {
    const payload = err instanceof ApiError ? (err.data as unknown as UnavailablePayload) : null
    // Исключать нечего или некого оставить — обычная ошибка, пусть её покажет вызывающий.
    if (!payload?.canSkip || !payload.usableCount) throw err

    const ok = await confirmDialog({
      title: 'Часть аккаунтов сейчас недоступна',
      message: `${summarizeBlocked(payload.blocked)}. Запустить на оставшихся (${payload.usableCount})?`,
      confirmLabel: `Исключить и запустить (${payload.usableCount})`,
      cancelLabel: 'Отмена',
    })
    if (!ok) return null
    return await run(true)
  }
}
