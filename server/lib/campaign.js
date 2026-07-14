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
 * @param {{ goalId?: string, accountIds?: string[], targets?: string[], modules?: {moduleKey:string, targets?:string[]}[], initiator?: string }} input
 * @returns {{ moduleKey: string, settings: object }[]}
 */
export function buildCampaignPlan(input = {}) {
  const modules = Array.isArray(input.modules) ? input.modules : []
  const keys = modules.map((m) => m.moduleKey)
  const split = splitAccounts(input.accountIds || [], keys)
  return modules.map((m) => ({
    moduleKey: m.moduleKey,
    settings: {
      accountIds: split[m.moduleKey] || [],
      targets: m.targets || input.targets || [],
      channels: m.targets || input.targets || [],
      goalId: input.goalId || null,
      initiator: input.initiator || 'operator',
    },
  }))
}
