/**
 * MCP-дескриптор модуля «Мейлинг».
 *
 * Формат — docs/mcp/MCP-SPEC.md, правила правки — docs/mcp/MCP-CONTRIBUTING.md.
 *
 * Самый рискованный модуль платформы: это ХОЛОДНАЯ рассылка в личные сообщения людям,
 * которые не писали первыми. Отличия от остальных модулей, критичные для оркестратора:
 *  - работа идёт по СПИСКУ ЦЕЛЕЙ (номера и юзернеймы), а не по каналам;
 *  - объём задачи = длина списка, лимитов вида maxActions/workMode здесь НЕТ;
 *  - к рассылке допускаются только аккаунты с достаточным trust score;
 *  - паузы по умолчанию 90–300 с, а не 30–120 как везде.
 */

/** @type {import('./index.js').ModuleDescriptor} */
export default {
  key: 'mailing',
  version: 1,
  title: 'Мейлинг',
  platform: 'telegram',
  tags: ['рассылка', 'mailing', 'лс', 'dm', 'номера', 'phones', 'холодные', 'cold outreach'],

  whoAmI: {
    summary: 'Рассылает первые личные сообщения по списку номеров телефонов и юзернеймов от имени управляемых аккаунтов.',
    does: [
      'разбирает список целей на телефоны и юзернеймы',
      'отсеивает получателей из чёрного списка — и по юзернейму, и по номеру в любом формате записи',
      'резолвит номер в аккаунт Telegram (номера, которых нет в Telegram, пропускает)',
      'отправляет текст: шаблон, первое сообщение из цели или сгенерированный ИИ под каждого получателя',
      'может приложить медиа или ссылки к сообщению',
      'умеет работать в несколько параллельных потоков',
    ],
    doesNot: [
      'НЕ отвечает на входящие — это «Нейродиалоги»',
      'не пишет в группы и не комментирует каналы',
      'не работает аккаунтами с низким trust score, если явно не разрешить',
      'не имеет лимитов вида «сделать N действий» и работы по времени: объём задачи — это длина списка целей',
    ],
    requires: [
      'минимум один аккаунт с trust score выше порога и рабочим прокси',
      'непустой список целей',
      'текст: либо шаблон, либо первое сообщение в цели, либо включённая ИИ-генерация',
    ],
    risks:
      'САМЫЙ ВЫСОКИЙ РИСК на платформе. Холодные ЛС незнакомым людям — прямой путь к репортам '
      + 'и спамблоку. Поэтому: жёсткий порог trust score, паузы 90–300 секунд, суточный лимит ЛС '
      + 'на аккаунт. Запускать только на прогретых аккаунтах и небольшими партиями.',
    costModel: 'Списывается за действие по прайсу модуля. При ИИ-генерации текст включён в цену действия.',
  },

  blocks: [
    {
      id: 'accounts',
      title: 'Выберите аккаунты',
      purpose: 'Какими аккаунтами идёт рассылка.',
      howItWorks:
        'Перед стартом каждый аккаунт проверяется по trust score, и в лог пишется, сколько из '
        + 'выбранных допущено. Аккаунты ниже порога отсеиваются — обойти это можно только явным флагом. '
        + 'Дополнительно действует суточный лимит ЛС на аккаунт: выбравший его аккаунт пропускается.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: ['accountIds', 'allowLowTrust'] },
      params: ['accountIds', 'allowLowTrust'],
    },
    {
      id: 'targets',
      title: 'Кому писать',
      purpose: 'Список получателей рассылки.',
      howItWorks:
        'Список разбирается на телефоны и юзернеймы, затем из него вычитается чёрный список '
        + '(общий на всю платформу). Телефон резолвится в аккаунт Telegram через импорт контакта; '
        + 'если номера в Telegram нет — цель пропускается. Прогресс задачи считается от длины '
        + 'СПИСКА ПОСЛЕ фильтрации: сколько целей осталось, столько и действий.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: ['targets'] },
      params: ['targets'],
    },
    {
      id: 'message',
      title: 'Текст сообщения',
      purpose: 'Что именно получит человек.',
      howItWorks:
        'Три источника текста по приоритету: свой шаблон → первые сообщения из цели → ИИ-генерация '
        + 'под каждого получателя. Если не задано ничего из трёх, задача не стартует. К тексту можно '
        + 'приложить медиа или ссылки.',
      api: {
        method: 'POST',
        path: '/api/modules/mailing/tasks',
        fills: ['message', 'aiPerRecipient', 'promptIndex', 'promptOverrides', 'mediaUrls'],
      },
      params: ['message', 'aiPerRecipient', 'promptIndex', 'promptOverrides', 'mediaUrls', 'typeWeights'],
    },
    {
      id: 'limits',
      title: 'Лимиты',
      purpose: 'Сколько сообщений отправляет один аккаунт.',
      howItWorks:
        'Общего лимита у задачи нет — она заканчивается, когда кончился список целей. Ограничить '
        + 'можно только нагрузку на аккаунт; если не задано, работает суточный лимит ЛС из настроек безопасности.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: ['maxPerAccount'] },
      params: ['maxPerAccount'],
    },
    {
      id: 'performance',
      title: 'Параллельность',
      purpose: 'Сколько потоков рассылают одновременно.',
      howItWorks:
        'И список целей, и аккаунты делятся между потоками по кругу. Потоков не больше, чем допущенных '
        + 'аккаунтов. Старты потоков разводятся случайной паузой — одновременный залп читается как ферма.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: ['threads'] },
      params: ['threads'],
    },
    {
      id: 'protection',
      title: 'Защита аккаунтов',
      purpose: 'Множитель задержек.',
      howItWorks: 'Уровень защиты умножает паузы между отправками. Вероятности у модуля нет — пишем всем из списка.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: ['protectionLevel'] },
      params: ['protectionLevel'],
    },
    {
      id: 'timings',
      title: 'Тайминги и задержки',
      purpose: 'Паузы между сообщениями и поведение при FloodWait.',
      howItWorks:
        'По умолчанию 90–300 секунд — втрое больше, чем в других модулях. Это не перестраховка: '
        + 'частые ЛС незнакомым людям Telegram отслеживает жёстче всего.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: ['delayPreset', 'delays'] },
      params: ['delayPreset', 'delays'],
    },
    {
      id: 'binding',
      title: 'Привязка',
      purpose: 'К какой цели, кампании и агенту относится рассылка.',
      howItWorks:
        'Цель даёт контекст и базу знаний для ИИ-генерации, а также готовые первые сообщения. '
        + 'Агент задаёт тон и запреты.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: ['goalId', 'campaignId', 'agentId'] },
      params: ['goalId', 'campaignId', 'agentId'],
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
      purpose: 'ID аккаунтов, которыми идёт рассылка.',
      constraints: [
        'пустой список → задача завершается с предупреждением «Не выбраны аккаунты»',
        'аккаунты с trust score ниже порога отсеиваются до старта',
      ],
      examples: [['acc_1'], ['acc_1', 'acc_2']],
      seeAlso: ['allowLowTrust'],
      storedAs: 'task.settings.accountIds',
    },
    {
      name: 'allowLowTrust',
      block: 'accounts',
      title: 'Разрешить аккаунты с низким доверием',
      type: 'boolean',
      default: false,
      purpose: 'Пропустить в рассылку аккаунты, не дотягивающие до порога trust score.',
      constraints: [
        'по умолчанию выключено, и это осознанно: холодные ЛС с непрогретого аккаунта — самый быстрый спамблок',
        'включать только когда аккаунты заведомо расходные',
      ],
      storedAs: 'task.settings.allowLowTrust',
    },
    {
      name: 'targets',
      block: 'targets',
      title: 'Получатели',
      type: 'array',
      items: 'string',
      required: true,
      minItems: 1,
      purpose: 'Кому писать: телефоны и/или юзернеймы.',
      constraints: [
        'телефон в международном формате (+380…, 380…) — резолвится через импорт контакта',
        'юзернейм в виде @name или ссылки https://t.me/name',
        'номер, которого нет в Telegram, пропускается с записью в лог',
        'нераспознанные строки отбрасываются; если корректных целей ноль — задача завершается сразу',
        'получатели из чёрного списка исключаются ДО отправки: юзернейм сверяется как обычно, '
        + 'номер — по цифрам, поэтому «050 123 45 67» в списке ловит «380501234567» в рассылке. '
        + 'Сколько отсеяно, пишется в лог отдельной строкой',
      ],
      examples: [['+380501234567', '@durov'], ['https://t.me/durov']],
      storedAs: 'task.settings.targets',
    },
    {
      name: 'message',
      block: 'message',
      title: 'Текст сообщения',
      type: 'string',
      default: '',
      aliases: ['promptText'],
      purpose: 'Шаблон первого сообщения, одинаковый для всех получателей.',
      constraints: [
        'приоритет источников текста: этот шаблон → первые сообщения из цели → ИИ-генерация',
        'если пусто и нет ни сообщений в цели, ни включённой ИИ-генерации — задача не стартует',
        'сервер принимает и promptText: это одно и то же поле',
      ],
      examples: ['Здравствуйте! Видел ваш профиль — есть короткий вопрос, удобно?'],
      seeAlso: ['aiPerRecipient', 'goalId'],
      storedAs: 'task.settings.message (сервер принимает и promptText)',
    },
    {
      name: 'aiPerRecipient',
      block: 'message',
      title: 'ИИ-текст под каждого',
      type: 'boolean',
      default: false,
      purpose: 'Генерировать первое сообщение моделью отдельно для каждого получателя.',
      constraints: [
        'работает только при доступной ИИ-генерации; иначе молча используется шаблон',
        'снимает проблему «сто одинаковых сообщений подряд», по которой ловят рассылки',
      ],
      seeAlso: ['message', 'promptIndex', 'goalId'],
      storedAs: 'task.settings.aiPerRecipient',
    },
    {
      name: 'typeWeights',
      block: 'message',
      title: 'Распределение типов, %',
      type: 'array',
      items: 'number',
      default: [],
      purpose: 'Смешивать типы сообщений в заданной пропорции, чтобы аккаунты не писали в одном тоне.',
      constraints: [
        'индекс элемента соответствует promptIndex',
        'если хотя бы один вес > 0, promptIndex НЕ используется — тип выбирается взвешенным жребием на каждое действие',
        'веса нормируются автоматически, сумма 100 не обязательна',
      ],
      examples: [[50, 0, 0, 30, 20, 0]],
      seeAlso: ['promptIndex'],
      storedAs: 'task.settings.typeWeights',
    },
    {
      name: 'promptIndex',
      block: 'message',
      title: 'Тон сообщения',
      type: 'integer',
      default: 0,
      enum: [
        { value: 0, label: 'Позитивный', means: 'Доброжелательное обращение.' },
        { value: 1, label: 'Интимный', means: 'Личный, доверительный тон.' },
        { value: 2, label: 'Эмоциональный отклик', means: 'Живое эмоциональное обращение.' },
        { value: 3, label: 'Вопрос собеседнику', means: 'Начать с вопроса — повышает шанс ответа.' },
        { value: 4, label: 'Краткий отзыв', means: 'Одна-две фразы по существу.' },
        { value: 5, label: 'Аналитический подход', means: 'Содержательное обращение с аргументом.' },
      ],
      effectiveWhen: { aiPerRecipient: true },
      purpose: 'Какая карточка промпта используется при ИИ-генерации.',
      constraints: ['имеет смысл только при aiPerRecipient = true: для шаблона тон задаётся самим текстом'],
      seeAlso: ['aiPerRecipient'],
      storedAs: 'task.settings.promptIndex',
    },
    {
      name: 'promptOverrides',
      block: 'message',
      title: 'Переопределение карточек тона',
      type: 'array',
      items: 'string',
      default: [],
      effectiveWhen: { aiPerRecipient: true },
      supersededBy: ['message'],
      purpose: 'Заменить текст конкретных карточек тона при ИИ-генерации.',
      constraints: [
        'индекс элемента соответствует promptIndex',
        'перекрывается непустым message: заданный шаблон отменяет генерацию целиком',
      ],
      seeAlso: ['promptIndex', 'aiPerRecipient'],
      storedAs: 'task.settings.promptOverrides',
    },
    {
      name: 'mediaUrls',
      block: 'message',
      title: 'Медиа и ссылки',
      type: 'array',
      items: 'string',
      default: [],
      purpose: 'Что приложить к сообщению помимо текста.',
      constraints: ['принимаются только http/https-ссылки, остальное отбрасывается'],
      examples: [['https://example.com/promo.jpg']],
      storedAs: 'task.settings.mediaUrls',
    },
    {
      name: 'maxPerAccount',
      block: 'limits',
      title: 'Макс. сообщений на аккаунт',
      type: 'integer',
      default: 0,
      min: 0,
      purpose: 'Сколько сообщений отправляет один аккаунт за задачу.',
      constraints: [
        '0 = ограничения на уровне задачи нет, работает только суточный лимит ЛС из настроек безопасности',
        'общего лимита на задачу у модуля НЕТ: она заканчивается, когда кончился список целей',
      ],
      examples: [0, 15, 25],
      storedAs: 'task.settings.maxPerAccount',
    },
    {
      name: 'threads',
      block: 'performance',
      title: 'Потоков',
      type: 'integer',
      default: 1,
      min: 1,
      purpose: 'Сколько параллельных потоков рассылают одновременно.',
      constraints: [
        'больше числа ДОПУЩЕННЫХ аккаунтов не бывает — значение обрезается',
        'цели и аккаунты делятся между потоками по кругу',
        'старты разводятся случайной паузой: одновременный залп читается как ферма',
      ],
      examples: [1, 3],
      storedAs: 'task.settings.threads',
    },
    {
      name: 'protectionLevel',
      block: 'protection',
      title: 'Уровень защиты',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Консервативный', means: 'Задержки ×1.8 — паузы между ЛС порядка 3–9 минут.' },
        { value: 1, label: 'Сбалансированный', means: 'Задержки ×1 — паузы 90–300 секунд.' },
        { value: 2, label: 'Агрессивный', means: 'Задержки ×0.75. Для холодных ЛС рискованно.' },
      ],
      purpose: 'Насколько осторожно идёт рассылка.',
      constraints: ['ВНИМАНИЕ: нумерация ОБРАТНА delayPreset — здесь 0 самый безопасный'],
      seeAlso: ['delayPreset'],
      storedAs: 'task.settings.protectionLevel',
    },
    {
      name: 'delayPreset',
      block: 'timings',
      title: 'Пресет темпа',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Агрессивный', means: 'Паузы ×0.6.' },
        { value: 1, label: 'Сбалансированный', means: 'Базовые задержки ×1.' },
        { value: 2, label: 'Консервативный', means: 'Паузы ×1.8.' },
        { value: 3, label: 'Custom', means: 'Задержки берутся как заданы, без масштабирования.' },
      ],
      purpose: 'Масштабирует паузы между сообщениями.',
      constraints: ['ВНИМАНИЕ: нумерация ОБРАТНА protectionLevel — здесь 0 самый быстрый'],
      seeAlso: ['protectionLevel', 'delays'],
      storedAs: 'task.settings.delayPreset',
    },
    {
      name: 'delays',
      block: 'timings',
      title: 'Задержки',
      type: 'object',
      purpose: 'Базовые интервалы, к которым применяются множители защиты и пресета.',
      constraints: [
        'пауза рассылки задаётся полем `dm`; для совместимости принимается и `action`',
        'значения по умолчанию 90–300 с намеренно втрое больше, чем в остальных модулях',
      ],
      properties: [
        {
          name: 'dm',
          title: 'Пауза между сообщениями',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          default: [90, 300],
          unit: 'с',
          purpose: 'Диапазон [мин, макс] паузы между личными сообщениями.',
          constraints: ['фактическая пауза — случайная из диапазона × множители, но не меньше 5 секунд'],
        },
        {
          name: 'action',
          title: 'Пауза между сообщениями (синоним)',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          unit: 'с',
          purpose: 'То же, что dm — используется, если dm не задан.',
          constraints: ['оставлено для совместимости с общей формой настроек; предпочитайте dm'],
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
          purpose: 'Сколько FloodWait подряд выдерживает аккаунт до отправки в карантин.',
        },
      ],
      storedAs: 'task.settings.delays',
    },
    {
      name: 'goalId',
      block: 'binding',
      title: 'Цель',
      type: 'string',
      purpose: 'Цель кампании: даёт контекст и базу знаний для генерации и готовые первые сообщения.',
      constraints: [
        'должна существовать; получить список — GET /api/v1/goals',
        'если в цели заданы первые сообщения, они используются, когда свой шаблон пуст',
      ],
      seeAlso: ['message', 'aiPerRecipient'],
      storedAs: 'task.settings.goalId',
    },
    {
      name: 'campaignId',
      block: 'binding',
      title: 'Кампания',
      type: 'string',
      purpose: 'Кампания для отчётности и привязки расхода токенов.',
      constraints: ['должна существовать; получить список — GET /api/v1/campaigns'],
      storedAs: 'task.settings.campaignId',
    },
    {
      name: 'agentId',
      block: 'binding',
      title: 'Агент',
      type: 'string',
      purpose: 'Агент задаёт тон, роль и запреты при ИИ-генерации.',
      constraints: ['без агента остаётся контекст цели'],
      seeAlso: ['aiPerRecipient'],
      storedAs: 'task.settings.agentId',
    },
  ],

  presets: [
    {
      param: 'delayPreset',
      title: 'Пресет темпа',
      source: 'server/lib/protection.js — PRESET_MUL',
      values: [
        { value: 0, label: 'Агрессивный', multiplier: 0.6, means: 'Паузы ×0.6 — для холодных ЛС рискованно.', useWhen: 'расходные аккаунты' },
        { value: 1, label: 'Сбалансированный', multiplier: 1, means: 'Базовые паузы 90–300 с.', useWhen: 'обычная рассылка' },
        { value: 2, label: 'Консервативный', multiplier: 1.8, means: 'Паузы ×1.8 — 3–9 минут между сообщениями.', useWhen: 'дорогие аккаунты, первая рассылка' },
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
      title: 'Пробная рассылка на пять номеров',
      when: 'первый прогон, важно убедиться, что номера резолвятся и сообщения доходят',
      input: {
        accountIds: ['acc_1'],
        targets: ['+380501234567', '+380501234568', '@durov'],
        message: 'Здравствуйте! Видел ваш профиль — есть короткий вопрос, удобно?',
        maxPerAccount: 5,
        protectionLevel: 0,
        delayPreset: 2,
      },
    },
    {
      title: 'Рассылка с ИИ-текстом под каждого к цели',
      when: 'есть цель и база знаний, нужны разные тексты вместо ста одинаковых',
      input: {
        accountIds: ['acc_1', 'acc_2', 'acc_3'],
        targets: ['+380501234567', '+380501234568', '+380501234569'],
        aiPerRecipient: true,
        promptIndex: 3,
        goalId: 'goal_123',
        agentId: 'agent_1',
        threads: 2,
        maxPerAccount: 20,
        protectionLevel: 1,
        delays: { dm: [120, 360], floodWait: 180, floodQuarantine: 2 },
      },
    },
  ],

  contract: {
    sources: [
      // goalExpired у мейлинга НЕ вызывается — поля deadline у модуля нет, и обещать
      // его «мозгам» нельзя: дедлайн кампании эту рассылку не остановит.
      { file: 'server/modules/workers.js', symbols: ['runMailing'] },
      { file: 'server/lib/accountRunner.js', symbols: ['handleFlood'] },
      { file: 'server/neuroCommenting/commentGenerator.js', symbols: ['resolveSystemPrompt'] },
    ],
    ignore: ['initiator', 'userId'],
  },
}
