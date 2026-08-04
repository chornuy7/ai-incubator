import { apiGet, apiPost, apiPut, apiDelete } from './client'

/** §12: группа (папка) аккаунтов — доступ роли выдаётся сразу на группу, кампания берёт аккаунты папкой. */
export interface AccountGroup {
  id: string
  name: string
  accountIds: string[]
  color: string
  note: string
  userId?: string // §5.4 (MR-37): владелец-создатель группы (для фильтра «мои группы»)
  createdAt: number
  updatedAt: number
}

export interface AccountGroupInput {
  name: string
  accountIds?: string[]
  color?: string
  note?: string
}

/** accountId → группы, в которых он состоит (для меток в UI). */
export type GroupsByAccount = Record<string, { id: string; name: string }[]>

export async function fetchAccountGroups(): Promise<{ groups: AccountGroup[]; byAccount: GroupsByAccount }> {
  const data = await apiGet<{ ok: boolean; groups: AccountGroup[]; byAccount: GroupsByAccount }>('/api/account-groups')
  return { groups: data.groups, byAccount: data.byAccount || {} }
}

export async function createAccountGroup(input: AccountGroupInput): Promise<AccountGroup> {
  const data = await apiPost<{ ok: boolean; group: AccountGroup }>('/api/account-groups', input)
  return data.group
}

export async function updateAccountGroup(id: string, patch: Partial<AccountGroupInput>): Promise<AccountGroup> {
  const data = await apiPut<{ ok: boolean; group: AccountGroup }>(`/api/account-groups/${id}`, patch)
  return data.group
}

export async function deleteAccountGroup(id: string): Promise<void> {
  await apiDelete(`/api/account-groups/${id}`)
}

/** §5/§12: аккаунты выбранных групп без дублей. Зеркало server/accountGroups.js#accountsOfGroups. */
export function accountsOfGroupsLocal(groups: AccountGroup[], groupIds: string[]): string[] {
  const want = new Set(groupIds)
  const out = new Set<string>()
  for (const g of groups) {
    if (!want.has(g.id)) continue
    for (const id of g.accountIds) out.add(id)
  }
  return [...out]
}
