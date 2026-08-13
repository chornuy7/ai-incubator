import { apiGet, apiPut } from './client'

/** §6: настройки безопасности. Читать может кто угодно, менять — только админ. */
export interface AppSettings {
  /**
   * Минимальный trust аккаунта для рассылки. Аккаунты ниже порога в рассылку не берутся;
   * админ может разрешить запуск осознанно — тогда это пишется в лог задачи.
   */
  mailingMinTrust: number
  /** MR-144: сколько задач выполняется одновременно (остальные ждут в очереди). */
  maxParallelTasks: number
}

export async function fetchSettings(): Promise<AppSettings> {
  const data = await apiGet<{ settings: AppSettings }>('/api/settings')
  return data.settings
}

/** MR-144: текущее состояние очереди задач — работает / ждёт / лимит. */
export interface ConcurrencyState { running: number; waiting: number; max: number }
export async function fetchConcurrency(): Promise<ConcurrencyState> {
  return apiGet<ConcurrencyState & { ok: boolean }>('/api/tasks/concurrency')
}

/** Сохранить настройки. Сервер вернёт 403, если запрос не от админа. */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const data = await apiPut<{ settings: AppSettings }>('/api/settings', patch)
  return data.settings
}
