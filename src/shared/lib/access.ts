import type { RolePermissions, Perm } from '@/api/rolesApi'

export type PermKind = 'module' | 'block' | 'section' | 'account' | 'accountGroup' | 'folder' | 'channel' | 'timers' | 'searchTemplates'

/**
 * Клиентская проверка доступа (зеркало server/roles.js#can). Админ (isAdmin) — всегда true;
 * отсутствующий ключ — deny (безопасный дефолт). §8.1.
 */
export function can(permissions: RolePermissions | null, isAdmin: boolean, kind: PermKind, key?: string): boolean {
  if (isAdmin) return true
  if (!permissions) return false
  const val = (v?: Perm) => v === 'allow'
  switch (kind) {
    case 'module': return val(permissions.modules[key ?? ''])
    case 'block': return val(permissions.blocks[key ?? ''])
    case 'section': return val(permissions.sections?.[key ?? ''])
    case 'account': return val(permissions.resources.accounts?.[key ?? ''])
    case 'accountGroup': return val(permissions.resources.accountGroups?.[key ?? ''])
    case 'folder': return val(permissions.resources.folders[key ?? ''])
    case 'channel': return val(permissions.resources.channels[key ?? ''])
    case 'timers': return val(permissions.resources.timers)
    case 'searchTemplates': return val(permissions.resources.searchTemplates)
    default: return false
  }
}

/**
 * Отфильтровать аккаунты по доступу роли (R4): не-админ видит только выданные ему аккаунты.
 * Админ → полный список; по умолчанию (нет выдач) не-админ видит пусто.
 * Случай «нет сессии» (демо) сюда НЕ доезжает — вызывающие показывают полный список
 * до фильтра (см. AccountsPage / AccountPicker), иначе демо было бы пустым.
 */
export function filterAccountsByAccess<T extends { id: string }>(
  list: T[], permissions: RolePermissions | null, isAdmin: boolean,
  groups: { id: string; accountIds: string[] }[] = [],
): T[] {
  if (isAdmin) return list
  return list.filter((a) => isAccountAllowed(permissions, a.id, groups))
}

/**
 * §12: аккаунт доступен роли напрямую ИЛИ через разрешённую группу.
 * Точечный deny сильнее группового allow. Зеркало server/accountGroups.js.
 */
export function isAccountAllowed(
  permissions: RolePermissions | null, accountId: string,
  groups: { id: string; accountIds: string[] }[] = [],
): boolean {
  if (!permissions) return false
  const direct = permissions.resources.accounts?.[accountId]
  if (direct === 'deny') return false // точечный запрет важнее
  if (direct === 'allow') return true
  return groups.some((g) => can(permissions, false, 'accountGroup', g.id) && g.accountIds.includes(accountId))
}

/**
 * Извлечь ключ модуля из пути роутинга (/panel/modules/<key>[/...]).
 * Вложенные страницы модуля — часть модуля: доступ к ним даёт то же право.
 */
export function moduleKeyFromPath(path: string): string | null {
  const m = path.match(/^\/panel\/modules\/([^/]+)/)
  return m ? m[1] : null
}

/**
 * Может ли роль УПРАВЛЯТЬ задачей модуля (запуск/пауза/стоп/правка).
 *
 * Спрашиваем именно доступ к модулю, а не блок `<key>:run`: блоки применяются
 * не на всех типах страниц (парсеры их не гейтят), и в Дашборде это давало бы
 * расхождение — человек запускает парсер с его страницы, но кнопок у своей же
 * задачи не видит.
 *
 * Нет сессии — дев/демо, как и в остальных гейтах.
 */
export function canControlModule(permissions: RolePermissions | null, isAdmin: boolean, moduleKey: string): boolean {
  if (isAdmin) return true
  return can(permissions, false, 'module', moduleKey)
}

/**
 * Страницы управления доступом: роли и пользователи. Обычной роли они закрыты; исключения
 * для владельца пространства перечислены в OWNER_ADMIN_PATHS. Подписка сюда НЕ входит:
 * клиент сам заходит в «Мои модули» и покупает свой набор — личная покупка
 * перекрывает общий набор только для него. §8.1 / §5.4
 */
export const ADMIN_ONLY_PATHS = new Set(['/panel/roles', '/panel/users'])
/**
 * §4.1 (MR-29): «Пользователи и роли» — раздел управления субпользователями, открыт владельцу.
 * С 21.08 это ОДНА страница с двумя вкладками (`?tab=roles` — шаблоны доступа), поэтому
 * гейт по пути один на обе: query-параметры сюда не доезжают и доступ не решают.
 */
export const OWNER_TEAM_PATH = '/panel/users'
/**
 * «Роли и доступы» у владельца — редактор ШАБЛОНОВ, а не раздача ролей (уточнение владельца
 * 21.08: «роль это просто как шаблон и все настроек которые уже были выбраны»).
 *
 * Днём 21.08 страницу у владельца убирали: тогда роль была живой связью, и вместе с личными
 * тумблерами суба она давала неразрешимое — владелец гасит модуль, а роль его возвращает.
 * Связь убрана (шаблон КОПИРУЕТСЯ в тумблеры и дальше не участвует), поэтому конфликта
 * больше нет, а место, где шаблон создают и правят, владельцу нужно.
 *
 * Сервер это уже поддерживает: в списке владельцу отдаются только ЕГО роли (ни системных
 * шаблонов, ни персональных ролей субов), править и удалять он может тоже только свои, а
 * каталог модулей урезан его подпиской. Субу страница закрыта: своей команды у него нет.
 *
 * С 21.08 отдельной страницы больше нет — шаблоны стали вкладкой «Пользователей»
 * (OWNER_TEAM_PATH + `?tab=roles`). Путь остаётся В СПИСКЕ РАЗРЕШЁННЫХ, потому что он жив:
 * App.tsx редиректит его на вкладку, а закрытый гейтом путь до редиректа не доживёт —
 * человек со старой закладкой упрётся в «нет доступа» вместо своего же раздела.
 */
export const OWNER_ROLES_PATH = '/panel/roles'
/** Что из ADMIN_ONLY_PATHS открыто владельцу пространства. */
const OWNER_ADMIN_PATHS = new Set([OWNER_TEAM_PATH, OWNER_ROLES_PATH])
/**
 * Минимум, доступный всем всегда — не гейтится ролью: свой профиль, поддержка и
 * «Мои модули». Последнее — витрина, где клиент покупает себе набор: закрывать её
 * ролью значит закрывать саму продажу.
 */
export const ALWAYS_ON_PATHS = new Set([
  '/panel', // Менеджер аккаунтов — базовый «в подарок»; сами аккаунты всё равно фильтрует роль
  '/panel/user/profile', '/panel/support', '/panel/user/subscription', '/panel/my-statistics', '/panel/learning',
])
/** Модули вне /panel/modules/* — их доступ проверяется как 'module' по этому ключу. */
const SPECIAL_MODULE_PATHS: Record<string, string> = {
  '/panel/mailing': 'mailing',
  '/panel/autoposting': 'autoposting',
}

/**
 * Ключ модуля для ЛЮБОГО его пути, включая мейлинг и автопостинг, которые живут
 * не под `/panel/modules/*`. Нужен подписке: без него эти два оставались в меню
 * при любом наборе — человек видел купленным то, чего не покупал, и узнавал об
 * этом только по отказу на запуске.
 */
export function anyModuleKeyFromPath(path: string): string | null {
  return moduleKeyFromPath(path) ?? SPECIAL_MODULE_PATHS[path] ?? null
}

/**
 * Разрешён ли доступ к странице панели для роли (§8.1). Зеркалит сайдбар и guard прямого URL.
 * Порядок: админ-страницы (только админ) → always-on → модули (по ключу) → остальное как 'section'.
 * @param isAdmin — bypass; permissions null трактуется как deny (кроме always-on).
 */
/** Страницы, недоступные субпользователю: деньги пространства — дело владельца. */
export const OWNER_ONLY_PATHS = new Set(['/panel/user/subscription'])

export function canAccessPath(
  permissions: RolePermissions | null, isAdmin: boolean, path: string, isOwner = false, isSub = false,
): boolean {
  // Суб не оформляет подписку и не тратит деньги пространства — страница закрыта даже
  // ему с ролью админа внутри чужого кабинета (правка 18.08). Проверка идёт ДО isAdmin:
  // платформенный админ субом не бывает, так что его это не задевает.
  if (isSub && OWNER_ONLY_PATHS.has(path)) return false
  if (isAdmin) return true
  // §4.1 (MR-29) + уточнение 21.08: владельцу открыты «Команда» (там он выдаёт доступ каждому
  // человеку) и «Роли и доступы» (там он собирает шаблоны этих доступов). Остальные
  // админ-страницы — по-прежнему только платформенному админу.
  if (ADMIN_ONLY_PATHS.has(path)) return isOwner && OWNER_ADMIN_PATHS.has(path)
  if (ALWAYS_ON_PATHS.has(path)) return true
  const mk = moduleKeyFromPath(path) ?? SPECIAL_MODULE_PATHS[path]
  if (mk) return can(permissions, false, 'module', mk)
  if (can(permissions, false, 'section', path)) return true
  // Вложенная страница наследует доступ раздела: карточка задачи живёт по
  // /panel/tasks/<id>, и точное сравнение пути закрывало её даже тому, кому
  // Дашборд открыт — он видел список, но не мог открыть ни одну свою задачу.
  // Корень /panel из наследования исключён: он есть почти у всех, и через него
  // открылась бы вообще любая страница панели.
  return allowedByParentSection(permissions, path)
}

/** Разрешён ли какой-нибудь родительский раздел пути (глубже, чем корень /panel). */
function allowedByParentSection(permissions: RolePermissions | null, path: string): boolean {
  const parts = path.split('/').filter(Boolean) // ['panel','tasks','pr_1']
  for (let i = parts.length - 1; i > 1; i -= 1) {
    const parent = '/' + parts.slice(0, i).join('/')
    // Вложенное в админ-страницу не наследуется никем, включая владельца: доступ к
    // /panel/roles даётся точным путём выше, а не «разделом» — иначе /panel/roles/<id>
    // открылся бы всякому, кому выдали секцию.
    if (ADMIN_ONLY_PATHS.has(parent)) return false
    if (can(permissions, false, 'section', parent)) return true
  }
  return false
}
