// Data-driven конфиг модулей 004–015. Единый движок ModuleRunner рендерит их все.
// Расширять НУЖНО этот файл (+ ветку в движке), а не плодить отдельные страницы.

export interface ToggleGroup {
  label: string
  options: string[]
  defaultIndex?: number
}

export interface SourceTabs {
  label: string
  tabs: string[]
  addLabel: string // "Добавить"
  clearLabel?: string // "Очистить все" / "Очистить всё"
  placeholder: string
  emptyRows: string // "Строк: 0"
}

export interface SpeedPresets {
  label: string
  options: string[]
  values: string[]
}

export interface LimitField {
  label: string
  value: number
}

export interface ResultStat {
  label: string
  value: string
  accent?: boolean
}

export interface ResultsConfig {
  kind: 'channel' | 'group' | 'user'
  toolbar: string[]
  sortOptions: string[]
  languageFilter?: boolean
  pageSizes?: number[]
  stats: ResultStat[]
  emptyText: string
}

export interface ModuleConfig {
  key: string
  title: string
  subtitle: string
  badge?: string
  accent: 'spark' | 'iris'

  accountPicker: boolean
  accountActions?: string[] // ["Добавить все","Удалить все","Импорт JSON"]
  accountFilters?: boolean // страны/роли

  sourceTabs?: SourceTabs
  sourceButtons?: string[] // ["Из истории групп"]

  toggleGroups?: ToggleGroup[]
  prompts?: string // "Системные (6)"
  modeToggle?: ToggleGroup // Авто/Ручной
  speedPresets?: SpeedPresets
  reactionPalette?: string[]

  limitChips?: (number | '∞')[]
  limitChipDefault?: number
  limitField?: LimitField

  templateButtons?: string[] // ["Новый шаблон","Применить"]
  extraButtons?: string[]
  counters?: { label: string; value: string }[]
  intervalValue?: string
  timer?: { current: string; total: string }

  // warming-специфика
  warmingWindows?: boolean
  timezone?: string
  durationMin?: number

  // ggr-специфика
  ggr?: boolean
  ggrSources?: string[]
  ggrStatuses?: string[]

  results?: ResultsConfig

  // ── Богатые секции (neuro-commenting / neuro-chatting и подобные) ──
  richLayout?: boolean
  settingsTitle?: string // "Настройки комментирования" / "Настройки чаттинга"
  selectedTitle?: string // "Выбрано для комментирования" / "Выбрано для чаттинга"
  unit?: { gen: string; title: string; maxLabel: string } // каналов/Каналы/Макс. комментариев
  aiProtection?: boolean
  protectionLevels?: { label: string; desc: string }[] // Conservative/Balanced/Aggressive
  probabilitySlider?: { label: string; value: number }
  probabilityAlways?: boolean // показывать всегда (не только для режима 0)
  workModeFields?: { maxLabel: string; maxValue: number; perAccount?: boolean; minWords?: boolean; slider?: boolean }
  importScheme?: boolean
  subscriptionsToggle?: boolean
  channelHeaderCount?: number // "233" / "153"
  targetChips?: boolean // отображать добавленные цели чипами
  seedTargetCount?: number // предзаполнить чипы
  messagePrompts?: string[] // System Prompts карточками
  aiPromptToggle?: boolean
  channelToggles?: string[]
  languageDetection?: boolean
  activeHours?: boolean
  autoResponder?: string[]
  conversationContext?: { label: string; value: number; max: number; hint: string }
  organicPromotion?: boolean
  // mass-react специфика
  reactionSettings?: {
    modes: string[]
    duration: { label: string; value: number; hint: string }
    max: { label: string; value: number }
    perAccount: { label: string }
    probability: { label: string; value: number }
    rules: string[]
  }
  postLinks?: { label: string; placeholder: string; hint?: string }
  emojiMode?: string[] // Режим эмодзи: Случайный/Последовательный
  channelReactions?: boolean // "Реакции от канала"
  historySection?: string // "История реакций"
  blacklistSection?: string // "Чёрный список каналов" как отдельная секция
  // mass-looking специфика
  lookingLayout?: boolean
  targetHint?: string
  lookModeLabel?: string
  lookModeOptions?: { label: string; value: 'stories' | 'posts' | 'both' }[]
  lookPostsLabel?: string
  lookPostsPresets?: { label: string; value: number }[]
  lookPostsDefault?: number
  // warming специфика
  warmingLayout?: boolean
  // neuro-dialogs специфика
  dialogsLayout?: boolean
  // ggr специфика
  ggrLayout?: boolean
  // parser специфика
  parserLayout?: boolean
  methodTabs?: string[]
  resultLabel?: string
  templates?: { name: string; desc: string; kw: number; chips: string[]; extra: number }[]
  templatesTitle?: string
  templatesBadge?: string
  templatesCollapsed?: boolean
  commentFilter?: boolean
  resultsTitle?: string
  defaultKeywords?: string[]
  aiKeywords?: { w: string; p: number }[]
  endLangDefault?: string
  defaultMinMembers?: number
  defaultLimit?: number | '∞'
  defaultActivity?: number
  // participants parser (users/messages/comments)
  participantsLayout?: boolean
  participants?: {
    sourceTitle: string
    sourceHint: string
    formatHint?: string
    historyBtn?: string
    keywords?: { label: string; hint: string }
    limits?: { label: string; value: number; hint: string }[]
    baseFilters: { label: string; on?: boolean }[]
    profileFilters: { label: string; premium?: boolean; admin?: boolean }[]
    activityFilter?: boolean
    extraOptions?: { label: string; on?: boolean }[]
    activeStories?: boolean
    delays: { label: string; value: number }[]
    unit: { title: string; count: number; limitLabel: string; limitValue: number }
    resultCount: number
  }
  delays?: { label: string; from: number; to?: number; unit?: string }[]
  delayPresets?: string[]
  settingsPresets?: boolean
  launchStats?: boolean
  progressBar?: boolean

  primaryAction: string
  secondaryAction?: string
  stopAction?: string

  logSeedCount: number
  logEmpty: string
  blacklistEmpty?: string
}

const ACC_ACTIONS = ['Добавить все', 'Удалить все']
const LOG_EMPTY = 'Логов пока нет. Запустите модуль, чтобы увидеть логи выполнения.'
const BL_EMPTY = 'В чёрном списке нет групп. Группы будут автоматически добавлены при возникновении ошибок.'

export const MODULES: Record<string, ModuleConfig> = {
  'neuro-commenting': {
    key: 'neuro-commenting',
    title: 'Нейрокомментинг',
    subtitle: 'ИИ-комментарии под постами каналов. Мониторинг каналов и автоматическая генерация умных комментариев нейросетью.',
    accent: 'spark',
    richLayout: true,
    settingsTitle: 'Настройки комментирования',
    selectedTitle: 'Выбрано для комментирования',
    unit: { gen: 'каналов', title: 'Каналы', maxLabel: 'Макс. комментариев' },
    accountPicker: true,
    accountActions: ACC_ACTIONS,
    accountFilters: true,
    aiProtection: true,
    protectionLevels: [
      { label: 'Консервативный', desc: 'Максимальная защита' },
      { label: 'Сбалансированный', desc: 'Оптимальный баланс' },
      { label: 'Агрессивный', desc: 'Высокая скорость' },
    ],
    toggleGroups: [
      { label: 'Режим комментирования', options: ['Случайный', 'По ключевым словам', 'Все посты'] },
      { label: 'Режим работы', options: ['По количеству', 'По времени'] },
      { label: 'Какие посты комментировать', options: ['Только новые', 'Только существующие', 'Сначала существующие, потом новые'] },
    ],
    probabilitySlider: { label: 'Вероятность комментария', value: 30 },
    workModeFields: { maxLabel: 'Макс. комментариев', maxValue: 100, perAccount: true, minWords: true },
    importScheme: true,
    channelHeaderCount: 233,
    targetChips: true,
    seedTargetCount: 233,
    subscriptionsToggle: true,
    progressBar: true,
    sourceTabs: {
      label: 'Целевые каналы', tabs: ['Юзернейм/Ссылка', 'Прошлые задачи', 'Папка'],
      addLabel: 'Добавить', clearLabel: 'Очистить все',
      placeholder: '@username или https://t.me/channel_name\nМожно вводить несколько ссылок (каждая с новой строки)', emptyRows: 'Строк: 0',
    },
    aiPromptToggle: true,
    messagePrompts: ['Позитивный комментарий', 'Интимный', 'Эмоциональный отклик', 'Вопрос автору', 'Краткий отзыв', 'Аналитический подход'],
    channelToggles: ['Писать от имени канала', 'Отслеживание удаления комментариев'],
    languageDetection: true,
    activeHours: true,
    autoResponder: ['Выкл', 'Текст', 'НейроДиалоги'],
    delays: [
      { label: 'Задержка комментария', from: 30, to: 120, unit: 'с' },
      { label: 'Задержка вступления в канал', from: 84, to: 156, unit: 'с' },
      { label: 'FloodWait задержка (сек)', from: 120 },
      { label: 'Кол-во FloodWait до карантина', from: 3 },
    ],
    delayPresets: ['Мин', 'Рекомендуемые', 'Макс'],
    settingsPresets: true,
    launchStats: true,
    counters: [{ label: 'каналов', value: '233' }, { label: 'интервал', value: '120с' }, { label: 'макс. комм.', value: '100' }],
    primaryAction: 'Начать',
    secondaryAction: 'Сохранить',
    stopAction: 'Остановить',
    logSeedCount: 32,
    logEmpty: LOG_EMPTY,
    blacklistEmpty: BL_EMPTY,
  },
  'neuro-chatting': {
    key: 'neuro-chatting',
    title: 'Нейрочаттинг',
    subtitle: 'ИИ-ответы в группах и чатах. Мониторинг диалогов в группах и автоматические умные ответы нейросетью.',
    accent: 'spark',
    richLayout: true,
    settingsTitle: 'Настройки чаттинга',
    selectedTitle: 'Выбрано для чаттинга',
    unit: { gen: 'групп', title: 'Группы', maxLabel: 'Макс. сообщений' },
    accountPicker: true,
    accountActions: ACC_ACTIONS,
    accountFilters: true,
    aiProtection: true,
    protectionLevels: [
      { label: 'Консервативный', desc: 'Максимальная защита' },
      { label: 'Сбалансированный', desc: 'Оптимальный баланс' },
      { label: 'Агрессивный', desc: 'Высокая скорость' },
    ],
    toggleGroups: [
      { label: 'Режим реакции', options: ['По интервалу', 'На триггеры'] },
      { label: 'Режим работы', options: ['По количеству', 'По времени'] },
    ],
    probabilitySlider: { label: 'Вероятность ответа', value: 30 },
    probabilityAlways: true,
    workModeFields: { maxLabel: 'Макс. сообщений', maxValue: 100, slider: true },
    channelHeaderCount: 153,
    targetChips: true,
    seedTargetCount: 153,
    subscriptionsToggle: true,
    sourceTabs: {
      label: 'Целевые группы', tabs: ['Юзернейм/Ссылка', 'Прошлые задачи', 'Папка'],
      addLabel: 'Добавить', clearLabel: 'Очистить все',
      placeholder: '@group или https://t.me/group\nМожно вводить несколько ссылок (каждая с новой строки)', emptyRows: 'Строк: 0',
    },
    aiPromptToggle: true,
    messagePrompts: ['Дружелюбный собеседник', 'Интимный', 'Экспертный тон', 'Краткие ответы', 'Юмористический подход', 'Формальный тон'],
    languageDetection: true,
    activeHours: true,
    autoResponder: ['Выкл', 'Текст', 'НейроДиалоги'],
    conversationContext: { label: 'Глубина контекста', value: 10, max: 30, hint: '0 = без контекста (legacy-режим). Больше сообщений — точнее ответы.' },
    organicPromotion: true,
    delays: [
      { label: 'Задержка вступления в группу', from: 50, to: 120, unit: 'с' },
      { label: 'Задержка отправки', from: 42, to: 78, unit: 'с' },
      { label: 'FloodWait задержка (сек)', from: 120 },
      { label: 'Кол-во FloodWait до карантина', from: 3 },
    ],
    delayPresets: ['Мин', 'Рекомендуемые', 'Макс'],
    settingsPresets: true,
    launchStats: true,
    progressBar: true,
    counters: [{ label: 'групп', value: '153' }, { label: 'интервал', value: '98с' }, { label: 'макс. сообщ.', value: '100' }],
    primaryAction: 'Начать',
    secondaryAction: 'Сохранить',
    stopAction: 'Остановить',
    logSeedCount: 46,
    logEmpty: LOG_EMPTY,
    blacklistEmpty: BL_EMPTY,
  },
  'mass-react': {
    key: 'mass-react',
    title: 'Массовые Реакции',
    subtitle: 'Автоматические реакции на посты в каналах и группах. Мониторинг новых постов или реакции на существующие с настраиваемыми эмодзи.',
    accent: 'spark',
    richLayout: true,
    settingsTitle: 'Настройки реакций',
    selectedTitle: 'Выбрано для реакций',
    unit: { gen: 'групп', title: 'Группы', maxLabel: 'Цель' },
    accountPicker: true,
    accountActions: ['Добавить все', 'Удалить все', 'Импорт JSON'],
    accountFilters: true,
    aiProtection: true,
    reactionSettings: {
      modes: ['Мониторинг', 'Существующие сообщения'],
      duration: { label: 'Длительность (минуты)', value: 60, hint: '0 = без лимита' },
      max: { label: 'Максимум реакций', value: 100 },
      perAccount: { label: 'Максимум реакций на 1 аккаунт' },
      probability: { label: 'Вероятность реакции', value: 50 },
      rules: ['Не реагировать, если уже больше 2 реакций', 'Реагировать только на первые N комментариев под постом'],
    },
    importScheme: true,
    channelHeaderCount: 93,
    targetChips: true,
    seedTargetCount: 93,
    subscriptionsToggle: true,
    sourceTabs: {
      label: 'Цели', tabs: ['Username / Ссылка', 'Из заданий', 'Папка'],
      addLabel: 'Добавить', clearLabel: 'Очистить',
      placeholder: 'Введите username или ссылку на группу\nПо одному на строку', emptyRows: 'Строк: 0',
    },
    postLinks: {
      label: 'Посты для реакций',
      placeholder: 'https://t.me/channel/123\nhttps://t.me/c/1234567890/42',
      hint: 'Ссылка на конкретный пост. Если указано — реакции только на эти посты (группы выше не обязательны).',
    },
    reactionPalette: ['👍', '❤️', '🔥', '😁', '🤨', '👏', '🙏', '🎉', '😂', '🤣', '🐷', '💩', '😗', '🤮', '😡'],
    emojiMode: ['Случайный', 'Последовательный'],
    delays: [
      { label: 'Задержка между реакциями', from: 30, to: 120, unit: 'сек' },
      { label: 'Задержка входа', from: 21, to: 39, unit: 'сек' },
      { label: 'Задержка при FloodWait (сек)', from: 120 },
      { label: 'Кол-во FloodWait до карантина', from: 3 },
    ],
    channelReactions: true,
    settingsPresets: true,
    launchStats: true,
    historySection: 'История реакций',
    blacklistSection: 'Чёрный список каналов',
    counters: [{ label: 'групп', value: '93' }, { label: 'интервал', value: '120с' }, { label: 'цель', value: '100' }],
    primaryAction: 'Запустить реакции',
    secondaryAction: 'Сохранить текущие настройки',
    stopAction: 'Остановить реакции',
    logSeedCount: 142,
    logEmpty: LOG_EMPTY,
    blacklistEmpty: BL_EMPTY,
  },
  'mass-looking': {
    key: 'mass-looking',
    title: 'Масслукинг',
    subtitle: 'Массовый просмотр историй у каналов и пользователей от лица ваших аккаунтов.',
    accent: 'spark',
    lookingLayout: true,
    selectedTitle: 'Выбрано для масслукинга',
    accountPicker: true,
    accountActions: ACC_ACTIONS,
    accountFilters: true,
    aiProtection: true,
    seedTargetCount: 95,
    targetHint: 'юзеры — цель; каналы/чаты соберём в аудиторию на запуске',
    lookModeLabel: 'Что смотреть',
    lookModeOptions: [
      { label: 'Истории', value: 'stories' },
      { label: 'Посты', value: 'posts' },
      { label: 'Истории + посты', value: 'both' },
    ],
    lookPostsLabel: 'Сколько последних постов смотреть',
    lookPostsPresets: [
      { label: 'Самый новый', value: 1 },
      { label: 'Последние 3', value: 3 },
      { label: 'Последние 10', value: 10 },
    ],
    lookPostsDefault: 3,
    primaryAction: 'Запустить просмотр',
    stopAction: 'Остановить',
    logSeedCount: 0,
    logEmpty: '',
  },
  warming: {
    key: 'warming',
    title: 'Прогрев аккаунтов',
    subtitle: 'Модуль прогрева аккаунтов имитирует естественную активность, чтобы ваши Telegram-аккаунты выглядели более достоверно и снижали риск ограничений.',
    accent: 'spark',
    warmingLayout: true,
    aiProtection: true,
    selectedTitle: 'Выбрано для прогрева',
    accountPicker: true,
    accountActions: ['Добавить все', 'Удалить все'],
    accountFilters: true,
    seedTargetCount: 93,
    primaryAction: 'Начать прогрев',
    stopAction: 'Остановить',
    logSeedCount: 48,
    logEmpty: LOG_EMPTY,
  },
  'neuro-dialogs': {
    key: 'neuro-dialogs',
    title: 'НейроДиалоги',
    badge: '56',
    subtitle: 'Мониторинг входящих ЛС · ИИ авто-ответы · Переписка через аккаунты',
    accent: 'iris',
    dialogsLayout: true,
    selectedTitle: 'Выбрано для НейроДиалогов',
    accountPicker: true,
    accountActions: ACC_ACTIONS,
    accountFilters: true,
    messagePrompts: ['Дружелюбный', 'Деловой', 'Продающий', 'Нейтральный'],
    primaryAction: 'Запустить',
    stopAction: 'Остановить',
    logSeedCount: 53,
    logEmpty: LOG_EMPTY,
  },
  ggr: {
    key: 'ggr',
    title: 'GGR · GramGPT Рейтинг™',
    subtitle: 'Оценка качества Telegram-аккаунта',
    badge: 'БЕТА',
    accent: 'iris',
    ggrLayout: true,
    settingsTitle: 'Как считается GGR',
    accountPicker: false,
    ggrSources: ['Из панели', 'Аудит сетки', '.session', 'tdata'],
    ggrStatuses: ['Все статусы', 'Валидный', 'Заморожен', 'Разавторизирован', 'Невалидный'],
    primaryAction: 'Проверить все',
    logSeedCount: 0,
    logEmpty: 'Запусков проверки ещё не было.',
  },
  parsing: {
    key: 'parsing',
    title: 'Парсинг каналов',
    subtitle: 'Модуль для поиска каналов и парсинга данных из Telegram. Найдите нужные каналы по ключевым словам и спарсите участников или сообщения.',
    accent: 'iris',
    parserLayout: true,
    selectedTitle: 'Выбрано для парсинга',
    accountPicker: true,
    accountActions: ACC_ACTIONS,
    accountFilters: true,
    aiProtection: true,
    methodTabs: ['Поиск по ключевым словам', 'Похожие каналы', 'Теги', 'Промпт'],
    resultLabel: 'КАНАЛ',
    templatesTitle: 'Шаблоны',
    resultsTitle: 'Результаты поиска',
    commentFilter: true,
    defaultKeywords: ['массаж', 'СТО', 'нужен разработчик', 'создать бота', 'massage', 'need developer'],
    aiKeywords: [{ w: 'car service', p: 88 }, { w: 'auto repair', p: 85 }, { w: 'hire developer', p: 87 }, { w: 'create bot', p: 82 }, { w: 'wellness', p: 79 }, { w: 'spa massage', p: 84 }],
    endLangDefault: 'en',
    defaultLimit: '∞',
    defaultActivity: 1,
    defaultMinMembers: 100,
    templates: [
      { name: 'Маркетинг и SMM', desc: 'Каналы о digital-маркетинге…', kw: 20, chips: ['маркетинг', 'marketing', 'smm'], extra: 17 },
      { name: 'IT и программирование', desc: 'Технологические каналы и…', kw: 18, chips: ['программирование', 'програмування', 'programming'], extra: 15 },
      { name: 'Крипто и блокчейн', desc: 'Поиск каналов о криптова…', kw: 16, chips: ['крипто', 'криптовалюта', 'bitcoin'], extra: 13 },
    ],
    primaryAction: 'Запустить парсинг',
    logSeedCount: 0,
    logEmpty: LOG_EMPTY,
  },
  'parsing-groups': {
    key: 'parsing-groups',
    title: 'Парсер групп Telegram',
    subtitle: 'Поиск и парсинг Telegram-групп по ключевым словам с расширенными фильтрами по количеству участников, активности и типу доступа. ИИ-подсказки для подбора релевантных ключевых слов.',
    accent: 'iris',
    parserLayout: true,
    selectedTitle: 'Выбрано для парсинга',
    accountPicker: true,
    accountActions: ACC_ACTIONS,
    accountFilters: true,
    aiProtection: true,
    resultLabel: 'ГРУППА',
    templatesTitle: 'Управление шаблонами',
    templatesBadge: 'опционально',
    templatesCollapsed: true,
    resultsTitle: 'Результаты парсинга',
    commentFilter: false,
    defaultKeywords: ['машина', 'сто', 'жк', 'барбер', 'фуд корт'],
    aiKeywords: [{ w: 'car', p: 95 }, { w: 'hundred', p: 80 }, { w: 'residential complex', p: 88 }, { w: 'barber', p: 92 }, { w: 'food court', p: 86 }],
    endLangDefault: 'ru',
    defaultLimit: 100,
    defaultActivity: 0,
    defaultMinMembers: 10,
    templates: [
      { name: 'Маркетинг и SMM', desc: 'Группы о digital-маркетинге…', kw: 20, chips: ['маркетинг', 'marketing', 'smm'], extra: 17 },
      { name: 'Авто и услуги', desc: 'Чаты об авто и сервисе…', kw: 14, chips: ['авто', 'машина', 'сто'], extra: 11 },
      { name: 'Недвижимость', desc: 'Группы о недвижимости…', kw: 12, chips: ['жк', 'квартиры', 'аренда'], extra: 9 },
    ],
    primaryAction: 'Начать',
    logSeedCount: 0,
    logEmpty: LOG_EMPTY,
  },
  'parsing-users': {
    key: 'parsing-users',
    title: 'Парсер пользователей Telegram',
    subtitle: 'Быстрый парсинг списков участников из открытых Telegram-чатов и групп. Экспорт данных в JSON/CSV/Excel с фильтрацией ботов и удаленных пользователей.',
    accent: 'iris',
    participantsLayout: true,
    selectedTitle: 'Выбрано для парсинга',
    accountPicker: true,
    accountActions: ACC_ACTIONS,
    accountFilters: true,
    aiProtection: true,
    resultsTitle: 'Результаты парсинга',
    primaryAction: 'Начать',
    logSeedCount: 0,
    logEmpty: LOG_EMPTY,
    participants: {
      sourceTitle: 'Список групп',
      sourceHint: 'Введите username, ссылки или ID групп (по одному на строку)',
      baseFilters: [{ label: 'Пропустить ботов', on: true }, { label: 'Пропустить удаленных', on: true }, { label: 'Пропустить заблокированных/scam' }, { label: 'Только активные пользователи' }],
      profileFilters: [{ label: 'Только с username' }, { label: 'Только с фото' }, { label: 'Только Premium', premium: true }, { label: 'Собирать только админов', admin: true }],
      activeStories: true,
      delays: [{ label: 'Задержка между чатами', value: 5 }, { label: 'Задержка между пользователями', value: 0.5 }],
      unit: { title: 'Группы', count: 93, limitLabel: 'Лимит участников', limitValue: 1000 },
      resultCount: 5,
    },
  },
  'parsing-messages': {
    key: 'parsing-messages',
    title: 'Парсер по сообщениям Telegram',
    subtitle: 'Парсинг пользователей по ключевым словам в сообщениях с фильтрацией по датам. Получите статистику активности: количество сообщений, даты первого и последнего сообщения каждого пользователя.',
    accent: 'iris',
    participantsLayout: true,
    selectedTitle: 'Выбрано для парсинга',
    accountPicker: true,
    accountActions: ACC_ACTIONS,
    accountFilters: true,
    aiProtection: true,
    resultsTitle: 'Результаты парсинга',
    primaryAction: 'Начать',
    logSeedCount: 18,
    logEmpty: LOG_EMPTY,
    participants: {
      sourceTitle: 'Список чатов',
      sourceHint: 'Введите username, ссылки, ID или инвайт-ссылки на приватные чаты (по одному на строку)',
      formatHint: 'Форматы: @username, t.me/group, t.me/+hash, -1001234567890',
      historyBtn: 'Из истории групп',
      keywords: { label: 'Ключевые слова', hint: 'Сообщения, содержащие хотя бы одно из этих слов, будут найдены' },
      limits: [{ label: 'Лимит сообщений', value: 1000, hint: 'Максимальное количество сообщений для анализа в каждом чате (1-50000)' }, { label: 'Фильтр по дням', value: 30, hint: 'Искать сообщения за последние N дней (1-365)' }],
      baseFilters: [{ label: 'Пропустить ботов', on: true }, { label: 'Пропустить удаленных', on: true }, { label: 'Пропустить заблокированных/scam' }],
      profileFilters: [{ label: 'Только с username' }, { label: 'Только с фото' }, { label: 'Только Premium', premium: true }],
      activityFilter: true,
      extraOptions: [{ label: 'Включить ответы', on: true }, { label: 'Включить пересланные сообщения' }],
      delays: [{ label: 'Задержка между чатами', value: 5 }, { label: 'Задержка между сообщениями', value: 0.5 }],
      unit: { title: 'Чаты', count: 21, limitLabel: 'Лимит сообщений', limitValue: 1000 },
      resultCount: 1,
    },
  },
  'parsing-comments': {
    key: 'parsing-comments',
    title: 'Парсер комментариев Telegram',
    subtitle: 'Парсинг пользователей из комментариев к постам Telegram-каналов. Фильтрация по ключевым словам, настройка лимитов постов и комментариев, минимальная длина комментария.',
    accent: 'iris',
    participantsLayout: true,
    selectedTitle: 'Выбрано для парсинга',
    accountPicker: true,
    accountActions: ACC_ACTIONS,
    accountFilters: true,
    aiProtection: true,
    resultsTitle: 'Результаты парсинга',
    primaryAction: 'Начать',
    logSeedCount: 0,
    logEmpty: LOG_EMPTY,
    participants: {
      sourceTitle: 'Список каналов',
      sourceHint: 'Введите username, ссылки или инвайт-ссылки на приватные каналы (по одному на строку)',
      formatHint: 'Форматы: @channel, t.me/channel, t.me/+hash, -1001234567890',
      historyBtn: 'Из истории каналов',
      keywords: { label: 'Ключевые слова', hint: 'Фильтровать комментарии по ключевым словам. Если не указано, парсятся все комментарии' },
      limits: [{ label: 'Лимит постов', value: 50, hint: 'Количество последних постов для анализа в каждом канале (1-500)' }, { label: 'Комментариев на пост', value: 100, hint: 'Максимальное количество комментариев для чтения под каждым постом (1-1000)' }, { label: 'Минимальная длина комментария', value: 10, hint: 'Игнорировать короткие комментарии (символов)' }],
      baseFilters: [{ label: 'Пропустить ботов', on: true }, { label: 'Пропустить удаленных', on: true }, { label: 'Пропустить заблокированных/scam' }, { label: 'Сохранять текст комментария' }],
      profileFilters: [{ label: 'Только с username' }, { label: 'Только с фото' }, { label: 'Только Premium', premium: true }],
      activityFilter: true,
      delays: [{ label: 'Задержка между каналами', value: 5 }, { label: 'Задержка между постами', value: 1 }],
      unit: { title: 'Каналы', count: 21, limitLabel: 'Лимит постов', limitValue: 50 },
      resultCount: 289,
    },
  },
}

export const ROLES = ['Все роли', 'Чаттинг', 'Комментинг', 'Парсинг', 'Реакции', 'Резерв']
export const COUNTRIES_FILTER = [
  { code: 'all', flag: '', label: 'Все страны' },
  { code: 'ua', flag: '🇺🇦', label: 'Украина' },
  { code: 'ru', flag: '🇷🇺', label: 'Россия' },
  { code: 'kz', flag: '🇰🇿', label: 'Казахстан' },
  { code: 'pl', flag: '🇵🇱', label: 'Польша' },
]
export const LANGUAGES = [
  { code: 'en', flag: '🇬🇧', label: 'English' },
  { code: 'ru', flag: '🇷🇺', label: 'Русский' },
  { code: 'ua', flag: '🇺🇦', label: 'Українська' },
]
