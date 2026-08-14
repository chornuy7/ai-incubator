/**
 * MCP-дескриптор модуля «Автопостинг».
 *
 * Формат — docs/mcp/MCP-SPEC.md, правила правки — docs/mcp/MCP-CONTRIBUTING.md.
 *
 * Единственный модуль, который публикует в СВОИ каналы. Отсюда главное ограничение,
 * о котором оркестратор обязан знать заранее: аккаунт должен быть админом канала с правом
 * публикации, иначе Telegram отвечает CHAT_ADMIN_REQUIRED и задача не сделает ничего.
 * Объём задачи равен числу каналов: лимитов вида «сделать N действий» здесь нет.
 */

/** @type {import('./index.js').ModuleDescriptor} */
export default {
  key: 'autoposting',
  version: 1,
  title: 'Автопостинг',
  platform: 'telegram',
  tags: ['постинг', 'autoposting', 'публикация', 'свои каналы', 'контент'],

  whoAmI: {
    summary: 'Публикует один и тот же пост в перечисленные каналы от имени управляемых аккаунтов.',
    does: [
      'проходит по списку каналов и публикует в каждый заданный текст',
      'может приложить медиа или ссылки к посту',
      'ведёт историю публикаций по каждому каналу',
    ],
    doesNot: [
      'не пишет в чужие каналы: нужен аккаунт-администратор с правом публикации',
      'не комментирует и не отвечает — это другие модули',
      'не генерирует текст под каждый канал: пост один на всю задачу',
      'не имеет лимитов «сделать N действий» и работы по времени — объём задачи это число каналов',
    ],
    requires: [
      'минимум один аккаунт с рабочим прокси, являющийся АДМИНИСТРАТОРОМ целевых каналов',
      'минимум один канал',
      'непустой текст поста',
    ],
    risks:
      'Публикация видна всем подписчикам канала и не отзывается автоматически — ошибка в тексте '
      + 'уходит в эфир. Без прав администратора Telegram вернёт CHAT_ADMIN_REQUIRED.',
    costModel: 'Списывается за действие по прайсу модуля. Токены ИИ не расходуются — текст задаётся вручную.',
  },

  blocks: [
    {
      id: 'accounts',
      title: 'Выберите аккаунты',
      purpose: 'От чьего имени публикуем.',
      howItWorks:
        'Аккаунты перебираются по кругу по каналам. Аккаунт обязан быть админом канала с правом '
        + 'публикации, иначе публикация в этот канал не пройдёт.',
      api: { method: 'POST', path: '/api/modules/autoposting/tasks', fills: ['accountIds'] },
      params: ['accountIds'],
    },
    {
      id: 'targets',
      title: 'Каналы',
      purpose: 'Куда публикуем.',
      howItWorks:
        'Прогресс задачи считается от числа каналов: сколько каналов, столько и публикаций. '
        + 'Цели из чёрного списка отсеиваются.',
      api: { method: 'POST', path: '/api/modules/autoposting/tasks', fills: ['channels'] },
      params: ['channels'],
    },
    {
      id: 'content',
      title: 'Содержимое поста',
      purpose: 'Что публикуем.',
      howItWorks: 'Текст один на всю задачу. К нему можно приложить медиа или ссылки.',
      api: { method: 'POST', path: '/api/modules/autoposting/tasks', fills: ['message', 'mediaUrls'] },
      params: ['message', 'mediaUrls'],
    },
    {
      id: 'protection',
      title: 'Защита аккаунтов',
      purpose: 'Множитель задержек между публикациями.',
      howItWorks: 'Уровень защиты и пресет темпа перемножаются и масштабируют паузу между каналами.',
      api: { method: 'POST', path: '/api/modules/autoposting/tasks', fills: ['protectionLevel', 'delayPreset'] },
      params: ['protectionLevel', 'delayPreset'],
    },
    {
      id: 'timings',
      title: 'Тайминги и задержки',
      purpose: 'Паузы между публикациями и поведение при FloodWait.',
      howItWorks: 'Пауза = случайная из диапазона × множители, но не меньше 5 секунд.',
      api: { method: 'POST', path: '/api/modules/autoposting/tasks', fills: ['delays'] },
      params: ['delays'],
    },
  ],

  params: [
    {
      name: 'accountIds',
      block: 'accounts',
      title: 'Аккаунты',
      type: 'array',
      items: 'string',
      required: true,
      minItems: 1,
      purpose: 'ID аккаунтов, от чьего имени публикуются посты.',
      constraints: [
        'пустой список → задача завершается с предупреждением «Не выбраны аккаунты»',
        'аккаунт должен быть администратором канала с правом публикации',
      ],
      examples: [['acc_1']],
      storedAs: 'task.settings.accountIds',
    },
    {
      name: 'channels',
      block: 'targets',
      title: 'Каналы',
      type: 'array',
      items: 'string',
      required: true,
      minItems: 1,
      aliases: ['targets'],
      purpose: 'Каналы, в которые публикуется пост.',
      constraints: [
        'формат: @username или https://t.me/<username>',
        'если корректных каналов ноль — задача завершается сразу с предупреждением',
        'объём задачи равен числу каналов: один канал — одна публикация',
      ],
      examples: [['@my_channel'], ['@my_channel', '@my_second_channel']],
      storedAs: 'task.settings.channels (сервер принимает и targets)',
    },
    {
      name: 'message',
      block: 'content',
      title: 'Текст поста',
      type: 'string',
      required: true,
      aliases: ['promptText'],
      purpose: 'Что именно публикуется.',
      constraints: [
        'один текст на всю задачу — под каждый канал он не подстраивается',
        'сервер принимает и promptText: это одно и то же поле',
        'пустой текст → публиковать нечего, задача завершится без действий',
      ],
      examples: ['Сегодня в 19:00 — эфир про автоматизацию. Ссылка в закрепе.'],
      storedAs: 'task.settings.message (сервер принимает и promptText)',
    },
    {
      name: 'mediaUrls',
      block: 'content',
      title: 'Медиа и ссылки',
      type: 'array',
      items: 'string',
      default: [],
      purpose: 'Что приложить к посту помимо текста.',
      constraints: ['принимаются только http/https-ссылки, остальное отбрасывается'],
      examples: [['https://example.com/banner.jpg']],
      storedAs: 'task.settings.mediaUrls',
    },
    {
      name: 'protectionLevel',
      block: 'protection',
      title: 'Уровень защиты',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Консервативный', means: 'Задержки ×1.8 между публикациями.' },
        { value: 1, label: 'Сбалансированный', means: 'Задержки ×1.' },
        { value: 2, label: 'Агрессивный', means: 'Задержки ×0.75.' },
      ],
      purpose: 'Насколько быстро идут публикации по списку каналов.',
      constraints: ['ВНИМАНИЕ: нумерация ОБРАТНА delayPreset — здесь 0 самый безопасный'],
      seeAlso: ['delayPreset'],
      storedAs: 'task.settings.protectionLevel',
    },
    {
      name: 'delayPreset',
      block: 'protection',
      title: 'Пресет темпа',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Агрессивный', means: 'Паузы ×0.6.' },
        { value: 1, label: 'Сбалансированный', means: 'Базовые задержки ×1.' },
        { value: 2, label: 'Консервативный', means: 'Паузы ×1.8.' },
        { value: 3, label: 'Custom', means: 'Без масштабирования.' },
      ],
      purpose: 'Масштабирует паузы между публикациями.',
      constraints: ['ВНИМАНИЕ: нумерация ОБРАТНА protectionLevel — здесь 0 самый быстрый'],
      seeAlso: ['protectionLevel', 'delays'],
      storedAs: 'task.settings.delayPreset',
    },
    {
      name: 'delays',
      block: 'timings',
      title: 'Задержки',
      type: 'object',
      purpose: 'Базовые интервалы, к которым применяются множители.',
      properties: [
        {
          name: 'action',
          title: 'Пауза между публикациями',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          default: [30, 120],
          unit: 'с',
          purpose: 'Диапазон [мин, макс] паузы перед следующей публикацией.',
          constraints: ['фактическая пауза — случайная из диапазона × множители, но не меньше 5 секунд'],
        },
        {
          name: 'floodWait',
          title: 'Запас после FloodWait',
          type: 'number',
          default: 120,
          min: 0,
          unit: 'с',
          purpose: 'Сколько ждать сверх длительности, которую вернул Telegram.',
        },
        {
          name: 'floodQuarantine',
          title: 'FloodWait до карантина',
          type: 'integer',
          default: 3,
          min: 1,
          purpose: 'Сколько FloodWait подряд выдерживает аккаунт до карантина.',
        },
      ],
      storedAs: 'task.settings.delays',
    },
  ],

  presets: [
    {
      param: 'delayPreset',
      title: 'Пресет темпа',
      source: 'server/lib/protection.js — PRESET_MUL',
      values: [
        { value: 0, label: 'Агрессивный', multiplier: 0.6, means: 'Паузы ×0.6.', useWhen: 'много каналов, надо быстро' },
        { value: 1, label: 'Сбалансированный', multiplier: 1, means: 'Базовые задержки.', useWhen: 'обычная публикация' },
        { value: 2, label: 'Консервативный', multiplier: 1.8, means: 'Паузы ×1.8.', useWhen: 'новые аккаунты-админы' },
        { value: 3, label: 'Custom', multiplier: 1, means: 'Без масштабирования.', useWhen: 'ручная настройка' },
      ],
    },
    {
      param: 'protectionLevel',
      title: 'Уровень защиты',
      source: 'server/lib/protection.js — LEVEL_MUL',
      values: [
        { value: 0, label: 'Консервативный', multiplier: 1.8, means: 'Задержки ×1.8.' },
        { value: 1, label: 'Сбалансированный', multiplier: 1, means: 'Задержки ×1.' },
        { value: 2, label: 'Агрессивный', multiplier: 0.75, means: 'Задержки ×0.75.' },
      ],
    },
  ],

  examples: [
    {
      title: 'Анонс в свои каналы',
      when: 'один текст надо разослать по сетке собственных каналов',
      input: {
        accountIds: ['acc_admin'],
        channels: ['@my_channel', '@my_second_channel'],
        message: 'Сегодня в 19:00 — эфир про автоматизацию. Ссылка в закрепе.',
        protectionLevel: 1,
        delayPreset: 1,
      },
    },
    {
      title: 'Пост с картинкой',
      when: 'нужна публикация с медиа',
      input: {
        accountIds: ['acc_admin'],
        channels: ['@my_channel'],
        message: 'Новый разбор — по ссылке ниже.',
        mediaUrls: ['https://example.com/banner.jpg'],
        protectionLevel: 0,
        delayPreset: 2,
      },
    },
  ],

  contract: {
    sources: [
      // goalExpired автопостинг не вызывает — дедлайна у модуля нет.
      // Лимитов и работы по времени тоже: объём задачи это число каналов.
      { file: 'server/modules/workers.js', symbols: ['runAutoPosting', 'targets'] },
      { file: 'server/lib/accountRunner.js', symbols: ['handleFlood'] },
    ],
    ignore: ['initiator', 'userId'],
  },
}
