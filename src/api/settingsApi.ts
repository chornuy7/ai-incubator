import { apiGet, apiPut } from './client'

/** §6: настройки безопасности. Читать может кто угодно, менять — только админ. */
export interface AppSettings {
  /**
   * Минимальный trust аккаунта для рассылки. Аккаунты ниже порога в рассылку не берутся;
   * админ может разрешить запуск осознанно — тогда это пишется в лог задачи.
   */
  mailingMinTrust: number
}

export async function fetchSettings(): Promise<AppSettings> {
  const data = await apiGet<{ settings: AppSettings }>('/api/settings')
  return data.settings
}

/** Сохранить настройки. Сервер вернёт 403, если запрос не от админа. */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const data = await apiPut<{ settings: AppSettings }>('/api/settings', patch)
  return data.settings
}
