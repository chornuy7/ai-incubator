import type { LucideIcon } from 'lucide-react'
import {
  LayoutGrid, BarChart3, LifeBuoy, MessageSquareText, Bot, Sparkles, Eye,
  Flame, MessagesSquare, Trophy, Radar, Users, Search, MessageCircle,
  Hash, History, UserCog, CalendarClock, Target, ListChecks, Contact, TrendingUp, Rocket, Radio, ScrollText, Inbox, Users2, Network, Mail, Megaphone, Package, GraduationCap } from 'lucide-react'

export interface RouteDef {
  path: string
  label: string
  icon: LucideIcon
  group: 'main' | 'modules' | 'parsing' | 'account'
  badge?: string
  /**
   * §10 (MR-49): раздел скрыт из меню, но НЕ удалён — маршрут остаётся рабочим по
   * прямой ссылке, код на месте. Так прячем недоделанные разделы до готовности; чтобы
   * вернуть — просто снять флаг. Фильтруется в сайдбаре (AppSidebar).
   */
  hidden?: boolean
  /** MR-137: раздел показан «серым» — виден, но визуально приглушён (в работе / второстепенный). */
  muted?: boolean
}

export const ROUTES: RouteDef[] = [
  { path: '/panel', label: 'Менеджер аккаунтов', icon: LayoutGrid, group: 'main' },
  { path: '/panel/proxies', label: 'Прокси', icon: Network, group: 'main' },
  { path: '/panel/automation', label: 'Автоматизация', icon: CalendarClock, group: 'main', hidden: true }, // MR-137: скрыть (пока)
  // §10 (MR-49): «Цели», «Агенты», «Кампания» и «Аналитика» скрыты из меню до готовности
  // (не удаляем — маршрут и код остаются, снять `hidden` = вернуть в меню).
  { path: '/panel/goals', label: 'Цели', icon: Target, group: 'main', hidden: true },
  { path: '/panel/agents', label: 'Агенты', icon: Bot, group: 'main', hidden: true },
  { path: '/panel/campaign', label: 'Кампания', icon: Rocket, group: 'main', hidden: true },
  { path: '/panel/tasks', label: 'Дашборд задач', icon: ListChecks, group: 'main' },
  { path: '/panel/crm', label: 'CRM · Лиды', icon: Contact, group: 'main', muted: true }, // MR-137: серым (второстепенное)
  { path: '/panel/analytics', label: 'Аналитика', icon: TrendingUp, group: 'main', hidden: true },
  { path: '/panel/my-statistics', label: 'Статистика', icon: BarChart3, group: 'main' }, // MR-158: вернули в цвет (полноценный раздел)
  // §5.3 (E1/E2): полная админ-панель живёт ОТДЕЛЬНОЙ ссылкой /admin со своим входом
  // (см. AdminEntry), а не пунктом сайдбара — здесь её намеренно нет.
  // MR-137: Обзор аккаунта / Логи / Поддержка — вниз, в раздел «Аккаунт».
  { path: '/panel/logs', label: 'Логи', icon: ScrollText, group: 'account' },
  { path: '/panel/inbox', label: 'Обзор аккаунта', icon: Inbox, group: 'account' },
  { path: '/panel/support', label: 'Поддержка', icon: LifeBuoy, group: 'account' },
  { path: '/panel/learning', label: 'Обучение', icon: GraduationCap, group: 'main' },

  { path: '/panel/modules/neuro-commenting', label: 'Нейрокомментинг', icon: MessageSquareText, group: 'modules' },
  { path: '/panel/modules/neuro-chatting', label: 'Нейрочаттинг', icon: Bot, group: 'modules' },
  { path: '/panel/modules/mass-react', label: 'Массовые Реакции', icon: Sparkles, group: 'modules' },
  { path: '/panel/modules/mass-looking', label: 'Масслукинг', icon: Eye, group: 'modules' },
  { path: '/panel/modules/warming', label: 'Прогрев Аккаунтов', icon: Flame, group: 'modules' },
  { path: '/panel/modules/neuro-dialogs', label: 'НейроДиалоги', icon: MessagesSquare, group: 'modules' },
  { path: '/panel/mailing', label: 'Мейлинг', icon: Mail, group: 'modules' },
  { path: '/panel/autoposting', label: 'Автопостинг', icon: Megaphone, group: 'modules' },
  // §20 (RATING-001): AI Rating недоделан/не протестирован — временно скрыт из меню (код остаётся).
  { path: '/panel/modules/ggr', label: 'AIR — AI Rating', icon: Trophy, group: 'modules', badge: 'БЕТА', hidden: true },

  { path: '/panel/modules/parsing', label: 'Парсер каналов', icon: Radar, group: 'parsing' },
  { path: '/panel/modules/parsing-groups', label: 'Парсер групп', icon: Users, group: 'parsing' },
  { path: '/panel/modules/parsing-users', label: 'Парсер пользователей', icon: Search, group: 'parsing' },
  { path: '/panel/modules/parsing-messages', label: 'Парсер по сообщениям', icon: MessageCircle, group: 'parsing' },
  { path: '/panel/modules/parsing-comments', label: 'Парсер комментариев', icon: Hash, group: 'parsing' },
  { path: '/panel/channels', label: 'Каналы (база)', icon: Radio, group: 'parsing' },
  { path: '/panel/parsing-history', label: 'Логи парсинга', icon: History, group: 'parsing' },

  { path: '/panel/user/profile', label: 'Мой аккаунт', icon: UserCog, group: 'account' },
  { path: '/panel/user/subscription', label: 'Мои модули', icon: Package, group: 'account' },
  // §10.4 (созвон): управление ролями — ТОЛЬКО из sudo-админки (вкладка «Роли»),
  // из кабинета убрали. Сам маршрут /panel/roles остаётся доступным по прямой ссылке.
  { path: '/panel/users', label: 'Пользователи', icon: Users2, group: 'account' },
]

/**
 * §10 (MR-49): скрыт ли раздел по прямому пути. Единый источник правды — флаг `hidden`
 * в ROUTES: и меню, и ссылки внутри страниц (напр. «+ Создать кампанию» в модуле)
 * сверяются с ним, поэтому снятие флага возвращает раздел везде разом.
 */
export function isHidden(path: string): boolean {
  return ROUTES.find((r) => r.path === path)?.hidden === true
}

export const GROUP_LABELS: Record<RouteDef['group'], string> = {
  main: 'Главная',
  modules: 'Модули',
  parsing: 'Парсинг',
  account: 'Аккаунт',
}
