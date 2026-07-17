import type {
  AppData, UserState,
  Ticket, ParsingHistoryItem, Stats, Proxy, Notification,
} from '@/shared/types'

const emptyStats: Stats = {
  comments: 0, reactions: 0, messages: 0, views: 0, pm: 0, spamGroups: 0,
  series: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((label) => ({ label, comments: 0, reactions: 0, messages: 0, views: 0 })),
  history: [
    { key: 'comments', label: 'История комментариев', count: 0 },
    { key: 'reactions', label: 'История реакций', count: 0 },
    { key: 'messages', label: 'История сообщений', count: 0 },
    { key: 'views', label: 'История просмотров', count: 0 },
    { key: 'pm', label: 'История ЛС-Рассылки', count: 0 },
    { key: 'spam', label: 'История Спамер по Группам', count: 0 },
    { key: 'dialogs', label: 'НейроДиалоги', count: 0 },
  ],
}

const emptyTickets: Ticket[] = []

const parsingHistory: ParsingHistoryItem[] = []

const proxies: Proxy[] = []

const notifications: Notification[] = [
  { id: 'n1', key: 'tasks', label: 'Статусы задач', desc: 'Уведомлять о завершении и ошибках задач модулей', enabled: true },
  { id: 'n2', key: 'accounts', label: 'Здоровье аккаунтов', desc: 'Спамблоки, карантин, разлогины', enabled: true },
  { id: 'n3', key: 'billing', label: 'Баланс монет', desc: 'Когда монет остаётся меньше 10 ⚡', enabled: true },
]

const baseUser = { firstName: 'Илья', lastName: 'Кравец', nick: 'incubator_ai', email: 'illia@incubator.ai' }

/** UI-сид без аккаунтов — аккаунты только с TG API сервера */
export const seeds: Record<Exclude<UserState, 'guest'>, AppData> = {
  empty: {
    plan: { name: 'Базовая', accountLimit: 50 },
    coins: 31, workspace: 'incubator_ai', user: baseUser,
    accounts: [], tasks: [], tickets: emptyTickets, parsingHistory: [],
    stats: emptyStats, proxies: [], notifications,
  },
  'with-data': {
    plan: { name: 'Базовая', accountLimit: 50 },
    coins: 80, workspace: 'incubator_ai', user: baseUser,
    accounts: [], tasks: [], tickets: emptyTickets,
    parsingHistory, stats: emptyStats, proxies, notifications,
  },
  'no-sub': {
    plan: { name: 'Нет подписки', accountLimit: 3 },
    coins: 0, workspace: 'incubator_ai', user: baseUser,
    accounts: [], tasks: [], tickets: emptyTickets, parsingHistory: [],
    stats: emptyStats, proxies: [], notifications,
  },
}

export function cloneSeed(state: Exclude<UserState, 'guest'>): AppData {
  return structuredClone(seeds[state])
}
