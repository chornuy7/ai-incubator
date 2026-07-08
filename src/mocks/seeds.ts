import type {
  AppData, BackgroundTask, UserState,
  Ticket, ParsingHistoryItem, Stats, Proxy, Notification,
} from '@/shared/types'

const withDataTasks: BackgroundTask[] = [
  { id: 't1', module: 'neuro-commenting', title: 'Нейрокомментинг · 3 канала', status: 'running', progress: 62, accountsCount: 4, createdAt: Date.now() - 3_600_000, logCount: 32 },
  { id: 't2', module: 'mass-react', title: 'Массовые Реакции · подборка', status: 'paused', progress: 40, accountsCount: 2, createdAt: Date.now() - 7_200_000, logCount: 142 },
]

const withDataStats: Stats = {
  comments: 1240, reactions: 458, messages: 312, views: 8940, pm: 176, spamGroups: 63,
  series: [
    { label: 'Пн', comments: 120, reactions: 45, messages: 30, views: 980 },
    { label: 'Вт', comments: 210, reactions: 62, messages: 51, views: 1420 },
    { label: 'Ср', comments: 180, reactions: 70, messages: 44, views: 1180 },
    { label: 'Чт', comments: 240, reactions: 55, messages: 62, views: 1610 },
    { label: 'Пт', comments: 160, reactions: 80, messages: 38, views: 1320 },
    { label: 'Сб', comments: 90, reactions: 40, messages: 47, views: 760 },
    { label: 'Вс', comments: 240, reactions: 106, messages: 40, views: 1670 },
  ],
  history: [
    { key: 'comments', label: 'История комментариев', count: 1240 },
    { key: 'reactions', label: 'История реакций', count: 458 },
    { key: 'messages', label: 'История сообщений', count: 312 },
    { key: 'views', label: 'История просмотров', count: 8940 },
    { key: 'pm', label: 'История ЛС-Рассылки', count: 176 },
    { key: 'spam', label: 'История Спамер по Группам', count: 63 },
    { key: 'dialogs', label: 'НейроДиалоги', count: 53 },
  ],
}

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

const baseTickets: Ticket[] = [
  { id: 'TK-1042', subject: 'Не проходит авторизация по номеру +380…', status: 'open', updatedAt: '2 часа назад', messages: 3, preview: 'Здравствуйте! При добавлении аккаунта SMS-код не приходит второй раз подряд.' },
]

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
    accounts: [], tasks: withDataTasks, tickets: baseTickets,
    parsingHistory, stats: withDataStats, proxies, notifications,
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
