import { apiGet, apiPost, apiPut, apiDelete } from './client'

export type Perm = 'allow' | 'deny'

export interface RolePermissions {
  /** Роль «без оплаты» (тест/модератор): доступ к модулям даёт роль в обход подписки. */
  freeAccess?: boolean
  modules: Record<string, Perm>
  blocks: Record<string, Perm> // ключ = `${moduleKey}:${blockKey}`
  sections: Record<string, Perm> // ключ = путь раздела (напр. '/panel/proxies')
  resources: {
    accounts: Record<string, Perm> // ключ = accountId (кто виден роли в менеджере/пикере)
    /** §12: groupId → allow/deny. Доступ выдаётся сразу на группу аккаунтов. */
    accountGroups?: Record<string, Perm>
    folders: Record<string, Perm>
    channels: Record<string, Perm>
    /** Какие каналы внутри папки выданы роли: folderId → список ссылок. Пусто = все каналы папки. */
    folderChannels: Record<string, string[]>
    timers: Perm
    searchTemplates: Perm
    /** Видеть и вести в Дашборде ЧУЖИЕ задачи. По умолчанию человек видит только свои. */
    allTasks?: Perm
    /** Поддержка: видеть все тикеты пользователей и отвечать в них «как поддержка». */
    support?: Perm
  }
}

export interface Role {
  id: string
  name: string
  builtin?: boolean
  isTemplate?: boolean
  /**
   * Персональная роль-контейнер конкретного суба (её заводит PUT /api/users/:id/access).
   * В списке шаблонов таким не место: человек их не создавал и применять «Доступ · Иван»
   * к другому сотруднику бессмысленно. Владельцу сервер их и не отдаёт — фильтр нужен
   * админу платформы, который видит все роли разом.
   */
  personalFor?: string
  permissions: RolePermissions
  createdAt: number
  updatedAt: number
}

export interface CatalogModule { key: string; label: string }
export interface CatalogBlock { key: string; label: string }
export interface CatalogSection { key: string; label: string }
export interface CatalogResourceItem { id: string; label: string; channels?: string[] }
export interface CatalogResource {
  type: 'accounts' | 'accountGroups' | 'folders' | 'channels' | 'timers' | 'searchTemplates' | 'allTasks' | 'support'
  label: string
  perItem: boolean
  items?: CatalogResourceItem[]
}
export interface RbacCatalog {
  modules: CatalogModule[]
  blocks: CatalogBlock[]
  /**
   * Блоки КАЖДОГО модуля его же словами (правка 26.08). Плоский `blocks` остаётся для
   * строки «блок во всех модулях», а рисовать под модулем нужно только то, что у него
   * действительно есть: у парсера нет промптов, у прогрева нет целей.
   */
  blocksByModule?: Record<string, CatalogBlock[]>
  sections: CatalogSection[]
  resources: CatalogResource[]
}

export async function fetchRoles(): Promise<Role[]> {
  const data = await apiGet<{ roles: Role[] }>('/api/roles')
  return data.roles
}

export async function fetchRbacCatalog(): Promise<RbacCatalog> {
  const data = await apiGet<{ catalog: RbacCatalog }>('/api/roles/catalog')
  return data.catalog
}

export async function createRole(input: { name: string; isTemplate?: boolean; permissions?: Partial<RolePermissions> }): Promise<Role> {
  const data = await apiPost<{ role: Role }>('/api/roles', input)
  return data.role
}

export async function updateRole(id: string, patch: { name?: string; isTemplate?: boolean; permissions?: RolePermissions }): Promise<Role> {
  const data = await apiPut<{ role: Role }>(`/api/roles/${id}`, patch)
  return data.role
}

export async function deleteRole(id: string): Promise<void> {
  await apiDelete(`/api/roles/${id}`)
}

/** Пустые права (всё deny) — для новой роли. */
export function emptyPermissions(): RolePermissions {
  return { freeAccess: false, modules: {}, blocks: {}, sections: {}, resources: { accounts: {}, accountGroups: {}, folders: {}, channels: {}, folderChannels: {}, timers: 'deny', searchTemplates: 'deny', allTasks: 'deny' } }
}

/**
 * Роль → значения тумблеров «Доступ к модулям» в карточке пользователя.
 *
 * Уточнение владельца 21.08: «роль это просто как шаблон и все настроек которые уже были
 * выбраны». Поэтому здесь именно КОПИЯ, а не ссылка: применённый шаблон дальше не участвует
 * в жизни доступа — владелец правит тумблеры руками, и роль его правку уже не перебьёт.
 *
 * Результат покрывает ВЕСЬ каталог (не только то, что было в роли): выставляем каждому
 * модулю явное значение, иначе применение второго шаблона поверх первого оставляло бы
 * включённым то, чего во втором нет, — «применил „Наблюдатель“, а нейрочатинг всё ещё горит».
 *
 * Модули роли, которых в каталоге нет, игнорируются молча: каталог уже урезан подпиской,
 * а шаблон мог быть собран, когда модуль был оплачен. Выдать его сейчас всё равно нельзя —
 * сервер откажет на сохранении.
 */
/**
 * Сигнал «список шаблонов изменился».
 *
 * Список шаблонов живёт в ДВУХ местах одного экрана: в выпадающем списке карточки
 * сотрудника и в разделе шаблонов ниже. Каждый держит своё состояние, поэтому удалённый
 * шаблон продолжал предлагаться в выпадающем списке до перезагрузки страницы — и его
 * можно было применить, получив ошибку от сервера на ровном месте.
 *
 * Поднимать состояние наверх нельзя без переделки: страница шаблонов открывается ещё и
 * сама по себе (sudo-админка). Поэтому маленький сигнал: кто меняет — зовёт
 * `notifyRolesChanged`, кто показывает — подписывается через `onRolesChanged`.
 */
const rolesListeners = new Set<() => void>()

/** Сообщить всем спискам, что шаблоны изменились (создали, переименовали, удалили). */
export function notifyRolesChanged(): void {
  for (const cb of rolesListeners) cb()
}

/** Подписаться на изменения. Возвращает функцию отписки — для useEffect. */
export function onRolesChanged(cb: () => void): () => void {
  rolesListeners.add(cb)
  return () => { rolesListeners.delete(cb) }
}

/**
 * MR-245: «создать роль» из формы нового пользователя.
 *
 * Владелец 30.08: «Когда ты в новом пользователе нажимаешь „создать роль“, создаётся новая
 * роль. По-хорошему она должна не создаться, а закрыться эта херь и начаться создание
 * роли». Форма пользователя и раздел ролей — два соседних компонента одной страницы,
 * поэтому связываем их тем же маленьким сигналом, что и список шаблонов, а не общим
 * состоянием: раздел ролей открывается ещё и сам по себе, в админке.
 */
const newRoleListeners = new Set<() => void>()
const roleCreatedListeners = new Set<(role: Role) => void>()

/** Попросить раздел ролей открыть создание новой роли. */
export function requestNewRole(): void {
  for (const cb of newRoleListeners) cb()
}
export function onNewRoleRequest(cb: () => void): () => void {
  newRoleListeners.add(cb)
  return () => { newRoleListeners.delete(cb) }
}

/** Сообщить, что роль создана — форма пользователя вернётся и подставит её. */
export function notifyRoleCreated(role: Role): void {
  for (const cb of roleCreatedListeners) cb(role)
}
export function onRoleCreated(cb: (role: Role) => void): () => void {
  roleCreatedListeners.add(cb)
  return () => { roleCreatedListeners.delete(cb) }
}

export function accessFromRole(
  role: Role, modules: { key: string }[], blocks: { key: string }[],
): { modules: Record<string, Perm>; blocks: Record<string, Perm> } {
  const src = role.permissions
  const outMods: Record<string, Perm> = {}
  const outBlocks: Record<string, Perm> = {}
  for (const m of modules) {
    const on = src?.modules?.[m.key] === 'allow'
    outMods[m.key] = on ? 'allow' : 'deny'
    for (const b of blocks) {
      const bk = `${m.key}:${b.key}`
      // Блок включён только внутри включённого модуля: у выключенного он не значит ничего,
      // а сервер такие пары всё равно выбрасывает при сохранении.
      outBlocks[bk] = on && src?.blocks?.[bk] === 'allow' ? 'allow' : 'deny'
    }
  }
  return { modules: outMods, blocks: outBlocks }
}
