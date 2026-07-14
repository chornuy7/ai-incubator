import type { LucideIcon } from 'lucide-react'
import {
  LayoutGrid, BarChart3, LifeBuoy, MessageSquareText, Bot, Sparkles, Eye,
  Flame, MessagesSquare, Trophy, Radar, Users, Search, MessageCircle,
  Hash, History, UserCog, CalendarClock, Target, ListChecks, Contact, TrendingUp, Rocket, Radio,
} from 'lucide-react'

export interface RouteDef {
  path: string
  label: string
  icon: LucideIcon
  group: 'main' | 'modules' | 'parsing' | 'account'
  badge?: string
}

export const ROUTES: RouteDef[] = [
  { path: '/panel', label: 'Менеджер аккаунтов', icon: LayoutGrid, group: 'main' },
  { path: '/panel/automation', label: 'Автоматизация', icon: CalendarClock, group: 'main' },
  { path: '/panel/goals', label: 'Цели', icon: Target, group: 'main' },
  { path: '/panel/campaign', label: 'Кампания', icon: Rocket, group: 'main' },
  { path: '/panel/tasks', label: 'Задачи', icon: ListChecks, group: 'main' },
  { path: '/panel/crm', label: 'CRM · Лиды', icon: Contact, group: 'main' },
  { path: '/panel/analytics', label: 'Аналитика', icon: TrendingUp, group: 'main' },
  { path: '/panel/my-statistics', label: 'Моя статистика', icon: BarChart3, group: 'main' },
  { path: '/panel/support', label: 'Поддержка', icon: LifeBuoy, group: 'main' },

  { path: '/panel/modules/neuro-commenting', label: 'Нейрокомментинг', icon: MessageSquareText, group: 'modules' },
  { path: '/panel/modules/neuro-chatting', label: 'Нейрочаттинг', icon: Bot, group: 'modules' },
  { path: '/panel/modules/mass-react', label: 'Массовые Реакции', icon: Sparkles, group: 'modules' },
  { path: '/panel/modules/mass-looking', label: 'Масслукинг', icon: Eye, group: 'modules' },
  { path: '/panel/modules/warming', label: 'Прогрев Аккаунтов', icon: Flame, group: 'modules' },
  { path: '/panel/modules/neuro-dialogs', label: 'НейроДиалоги', icon: MessagesSquare, group: 'modules' },
  { path: '/panel/modules/ggr', label: 'GGR · Рейтинг', icon: Trophy, group: 'modules', badge: 'БЕТА' },

  { path: '/panel/modules/parsing', label: 'Парсер каналов', icon: Radar, group: 'parsing' },
  { path: '/panel/modules/parsing-groups', label: 'Парсер групп', icon: Users, group: 'parsing' },
  { path: '/panel/modules/parsing-users', label: 'Парсер пользователей', icon: Search, group: 'parsing' },
  { path: '/panel/modules/parsing-messages', label: 'Парсер по сообщениям', icon: MessageCircle, group: 'parsing' },
  { path: '/panel/modules/parsing-comments', label: 'Парсер комментариев', icon: Hash, group: 'parsing' },
  { path: '/panel/channels', label: 'Каналы (база)', icon: Radio, group: 'parsing' },
  { path: '/panel/parsing-history', label: 'История парсинга', icon: History, group: 'parsing' },

  { path: '/panel/user/profile', label: 'Мой аккаунт', icon: UserCog, group: 'account' },
]

export const GROUP_LABELS: Record<RouteDef['group'], string> = {
  main: 'Главная',
  modules: 'Модули',
  parsing: 'Парсинг',
  account: 'Аккаунт',
}
