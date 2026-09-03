/**
 * Оркестрация кампании (§3.9): одна цель → несколько модулей на общем пуле аккаунтов.
 * Аккаунты распределяются между модулями непересекающимися подмножествами (round-robin),
 * чтобы модули не конфликтовали за один аккаунт (лок = 1 аккаунт = 1 задача).
 * Чистые функции — юнит-тестируются.
 */

/**
 * Распределить аккаунты по модулям round-robin (непересекающиеся подмножества).
 * @param {string[]} accountIds @param {string[]} moduleKeys
 * @returns {Record<string, string[]>}
 */
export function splitAccounts(accountIds = [], moduleKeys = []) {
  /** @type {Record<string, string[]>} */
  const map = {}
  for (const k of moduleKeys) map[k] = []
  if (!moduleKeys.length) return map
  accountIds.forEach((id, i) => {
    map[moduleKeys[i % moduleKeys.length]].push(id)
  })
  return map
}

/**
 * Построить план кампании: для каждого модуля — свои аккаунты + общие цели/каналы + goalId.
 * `settings` — общие настройки кампании (лимиты/задержки/probability) прокидываются во все
 * модули; `m.settings` — переопределение на конкретный модуль.
 * @param {{ goalId?: string, accountIds?: string[], targets?: string[], settings?: object, modules?: {moduleKey:string, targets?:string[], settings?:object}[], initiator?: string }} input
 * @returns {{ moduleKey: string, settings: object }[]}
 */
export function buildCampaignPlan(input = {}) {
  const modules = Array.isArray(input.modules) ? input.modules : []
  const keys = modules.map((m) => m.moduleKey)
  const split = splitAccounts(input.accountIds || [], keys)
  return modules.map((m) => ({
    moduleKey: m.moduleKey,
    settings: {
      ...(input.settings || {}), // общие лимиты/задержки кампании
      ...(m.settings || {}), // переопределение модуля
      accountIds: split[m.moduleKey] || [],
      targets: m.targets || input.targets || [],
      channels: m.targets || input.targets || [],
      goalId: input.goalId || null,
      // Id СОХРАНЁННОЙ кампании (cmp_) — чтобы лиды и токены в CRM/статистике привязались
      // к кампании-сущности, а не терялись. Раньше в план не прокидывался, и s.campaignId
      // у задач кампании был пуст (лиды/токены без кампании).
      campaignId: input.campaignId || null,
      initiator: input.initiator || 'operator',
      // Дедлайн и дожим — свойства КАМПАНИИ (24.07). Кладём их в настройки задачи,
      // иначе воркер знал бы только про цель, а там этих полей больше нет.
      deadline: input.deadline || null,
      followUp: input.followUp || null,
    },
  }))
}
