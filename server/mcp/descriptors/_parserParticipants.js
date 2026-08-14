/**
 * Общая основа дескрипторов трёх парсеров ЛЮДЕЙ: участников, по сообщениям, по комментариям.
 *
 * Все три обслуживает один воркер (`runParticipantsParser`), различает их `kind`. Набор
 * настроек общий, но часть полей работает только у одного из них — это отмечено в описаниях,
 * иначе оркестратор будет задавать бессмысленные комбинации.
 *
 * Формат — docs/mcp/MCP-SPEC.md, правила правки — docs/mcp/MCP-CONTRIBUTING.md.
 */

/**
 * @param {{key: string, title: string, summary: string, does: string[], tags: string[],
 *          supportsIntersection?: boolean, usesMessageLimits?: boolean}} cfg
 * @returns {import('./index.js').ModuleDescriptor}
 */
export function buildParticipantsParserDescriptor(cfg) {
  const path = `/api/modules/${cfg.key}/tasks`
  const intersection = !!cfg.supportsIntersection

  const blocks = [
    {
      id: 'accounts',
      title: 'Выберите аккаунты',
      purpose: 'Какими аккаунтами собираем.',
      howItWorks:
        'По умолчанию источники обрабатываются по очереди одним аккаунтом за раз. Параллельный '
        + 'режим ускоряет работу, но нагружает Telegram сильнее — на нём чаще прилетает FloodWait.',
      api: { method: 'POST', path, fills: ['accountIds', 'parallelAccounts'] },
      params: ['accountIds', 'parallelAccounts'],
    },
    {
      id: 'targets',
      title: 'Источники',
      purpose: 'Откуда собираем людей.',
      howItWorks:
        'Аккаунт вступает в источник, если ещё не состоит в нём. Пауза перед вступлением отдельная '
        + 'и не опускается ниже 60 секунд — вступления Telegram считает жёстче остальных действий.',
      api: { method: 'POST', path, fills: ['channels'] },
      params: ['channels'],
    },
    {
      id: 'filters',
      title: 'Фильтры людей',
      purpose: 'Кого оставлять в выдаче.',
      howItWorks: 'Фильтры применяются к каждому найденному человеку по ходу сбора.',
      api: { method: 'POST', path, fills: ['filters', 'keywords'] },
      params: ['filters', 'keywords'],
    },
    {
      id: 'limits',
      title: 'Лимиты',
      purpose: 'Сколько собирать и как глубоко копать.',
      howItWorks: 'По достижении лимита сбор останавливается, даже если источники ещё остались.',
      api: { method: 'POST', path, fills: ['limits', 'resultLimit'] },
      params: ['limits', 'resultLimit'],
    },
    {
      id: 'timings',
      title: 'Тайминги и задержки',
      purpose: 'Паузы между источниками и элементами.',
      howItWorks:
        'Три разные паузы: между источниками, между отдельными элементами и перед вступлением. '
        + 'Первые две задаются числами в секундах, третья — диапазоном.',
      api: { method: 'POST', path, fills: ['delayChat', 'delayItem', 'delays', 'protectionLevel', 'delayPreset'] },
      params: ['delayChat', 'delayItem', 'delays', 'protectionLevel', 'delayPreset'],
    },
  ]

  if (intersection) {
    blocks.splice(3, 0, {
      id: 'intersection',
      title: 'Пересечение аудиторий',
      purpose: 'Оставить только тех, кто состоит в нескольких источниках сразу.',
      howItWorks:
        'Человек попадает в выдачу, только если встретился минимум в заданном числе источников. '
        + 'Это способ найти ядро аудитории вместо случайных участников.',
      api: { method: 'POST', path, fills: ['intersectionMode', 'intersectionMin'] },
      params: ['intersectionMode', 'intersectionMin'],
    })
  }

  const params = [
    {
      name: 'accountIds',
      block: 'accounts',
      title: 'Аккаунты',
      type: 'array',
      items: 'string',
      required: true,
      minItems: 1,
      purpose: 'ID аккаунтов, которыми выполняется сбор.',
      constraints: ['пустой список → задача завершается с предупреждением'],
      examples: [['acc_1'], ['acc_1', 'acc_2']],
      storedAs: 'task.settings.accountIds',
    },
    {
      name: 'parallelAccounts',
      block: 'accounts',
      title: 'Параллельно всеми аккаунтами',
      type: 'boolean',
      default: false,
      purpose: 'Обрабатывать источники одновременно разными аккаунтами.',
      constraints: [
        'ускоряет сбор, но заметно повышает риск FloodWait',
        'включать имеет смысл только когда источников много, а времени мало',
      ],
      storedAs: 'task.settings.parallelAccounts',
    },
    {
      name: 'channels',
      block: 'targets',
      title: 'Источники',
      type: 'array',
      items: 'string',
      required: true,
      minItems: 1,
      aliases: ['targets'],
      purpose: 'Группы и каналы, из которых собираются люди.',
      constraints: [
        'формат: @username или https://t.me/<username>',
        'если корректных источников ноль — задача завершается сразу',
        'аккаунт вступает в источник, если ещё не состоит в нём',
      ],
      examples: [['@some_chat'], ['@chat_one', '@chat_two']],
      storedAs: 'task.settings.channels (сервер принимает и targets)',
    },
    {
      name: 'keywords',
      block: 'filters',
      title: 'Ключевые слова',
      type: 'array',
      items: 'string',
      default: [],
      purpose: 'Слова, по которым отбираются люди или их сообщения.',
      constraints: [
        'сравнение регистронезависимое',
        'пустой список = фильтр по словам не применяется',
      ],
      examples: [['куплю', 'нужен']],
      storedAs: 'task.settings.keywords',
    },
    {
      name: 'filters',
      block: 'filters',
      title: 'Фильтры людей',
      type: 'object',
      purpose: 'Кого включать в выдачу, а кого отбрасывать.',
      properties: [
        { name: 'skipBots', title: 'Пропускать ботов', type: 'boolean', default: true, purpose: 'Не собирать ботов — работать с ними бессмысленно.' },
        { name: 'skipDeleted', title: 'Пропускать удалённые', type: 'boolean', default: true, purpose: 'Не собирать удалённые аккаунты.' },
        { name: 'skipScam', title: 'Пропускать помеченные scam', type: 'boolean', default: true, purpose: 'Не собирать аккаунты с меткой мошенничества от Telegram.' },
        { name: 'onlyUsername', title: 'Только с юзернеймом', type: 'boolean', default: false, purpose: 'Оставить тех, кому можно написать по @username.' },
        { name: 'onlyPhoto', title: 'Только с аватаром', type: 'boolean', default: false, purpose: 'Косвенный признак живого аккаунта.' },
        { name: 'onlyPremium', title: 'Только Premium', type: 'boolean', default: false, purpose: 'Оставить платящую аудиторию.' },
        { name: 'onlyAdmins', title: 'Только администраторы', type: 'boolean', default: false, purpose: 'Собрать владельцев и модераторов источника.' },
        { name: 'includeForwarded', title: 'Учитывать пересланные', type: 'boolean', default: false, purpose: 'Не отбрасывать авторов пересланных сообщений.' },
        { name: 'keepText', title: 'Сохранять текст сообщения', type: 'boolean', default: false, purpose: 'Класть в выдачу текст, по которому человек попал в список.' },
      ],
      storedAs: 'task.settings.filters',
    },
    {
      name: 'limits',
      block: 'limits',
      title: 'Глубина сбора',
      type: 'object',
      purpose: 'Насколько глубоко копать в каждом источнике.',
      constraints: ['часть полей имеет смысл только у отдельных парсеров — см. описание каждого'],
      properties: [
        { name: 'participants', title: 'Участников на источник', type: 'integer', min: 0, purpose: 'Сколько участников максимум забрать из одной группы.' },
        { name: 'posts', title: 'Постов на источник', type: 'integer', min: 0, purpose: 'Сколько последних постов просмотреть (для парсера комментариев).' },
        { name: 'commentsPerPost', title: 'Комментариев на пост', type: 'integer', min: 0, purpose: 'Сколько комментариев брать под одним постом.' },
        { name: 'messages', title: 'Сообщений на источник', type: 'integer', min: 0, purpose: 'Сколько сообщений просмотреть (для парсера по сообщениям).' },
        { name: 'days', title: 'Глубина в днях', type: 'integer', min: 0, purpose: 'Не смотреть сообщения старше указанного числа дней.' },
        { name: 'minCommentLen', title: 'Мин. длина сообщения', type: 'integer', min: 0, purpose: 'Отбросить односложные реплики вроде «+» и «спасибо».' },
      ],
      storedAs: 'task.settings.limits',
    },
    {
      name: 'resultLimit',
      block: 'limits',
      title: 'Всего собрать',
      type: 'integer',
      default: 0,
      min: 0,
      aliases: ['limit'],
      purpose: 'Верхняя граница числа собранных людей за задачу.',
      constraints: ['0 = без ограничения', 'сервер принимает и limit — это одно и то же поле'],
      examples: [0, 500, 5000],
      storedAs: 'task.settings.resultLimit (сервер принимает и limit)',
    },
    {
      name: 'delayChat',
      block: 'timings',
      title: 'Пауза между источниками',
      type: 'number',
      default: 15,
      min: 0,
      unit: 'с',
      purpose: 'Сколько ждать перед переходом к следующему источнику.',
      constraints: ['одно число, не диапазон — в отличие от боевых модулей'],
      examples: [15, 60],
      storedAs: 'task.settings.delayChat',
    },
    {
      name: 'delayItem',
      block: 'timings',
      title: 'Пауза между элементами',
      type: 'number',
      default: 0.5,
      min: 0,
      unit: 'с',
      purpose: 'Сколько ждать между обработкой отдельных людей или сообщений.',
      constraints: ['допускаются дробные значения', 'обнулять не стоит: именно частые обращения дают FloodWait'],
      examples: [0.5, 2],
      storedAs: 'task.settings.delayItem',
    },
    {
      name: 'delays',
      block: 'timings',
      title: 'Задержки вступления',
      type: 'object',
      purpose: 'Пауза перед вступлением в источник.',
      properties: [
        {
          name: 'join',
          title: 'Пауза перед вступлением',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          default: [90, 240],
          unit: 'с',
          purpose: 'Диапазон [мин, макс] паузы перед вступлением в группу или канал.',
          constraints: ['жёсткий пол 60 секунд: ускорить вступления пресетом нельзя'],
        },
      ],
      storedAs: 'task.settings.delays',
    },
    {
      name: 'protectionLevel',
      block: 'timings',
      title: 'Уровень защиты',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Консервативный', means: 'Задержки ×1.8 — медленно, но без FloodWait.' },
        { value: 1, label: 'Сбалансированный', means: 'Задержки ×1.' },
        { value: 2, label: 'Агрессивный', means: 'Задержки ×0.75 — заметно выше риск FloodWait на сборе.' },
      ],
      purpose: 'Множитель пауз.',
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
        { value: 3, label: 'Custom', means: 'Без масштабирования.' },
      ],
      purpose: 'Ещё один множитель пауз.',
      constraints: ['ВНИМАНИЕ: нумерация ОБРАТНА protectionLevel — здесь 0 самый быстрый'],
      seeAlso: ['protectionLevel'],
      storedAs: 'task.settings.delayPreset',
    },
  ]

  if (intersection) {
    params.push(
      {
        name: 'intersectionMode',
        block: 'intersection',
        title: 'Режим пересечения',
        type: 'boolean',
        default: false,
        purpose: 'Оставлять только тех, кто состоит сразу в нескольких источниках.',
        constraints: [
          'работает только при двух и более источниках',
          'доступно ТОЛЬКО у парсера пользователей: у парсеров по сообщениям и комментариям поле игнорируется',
        ],
        seeAlso: ['intersectionMin', 'channels'],
        storedAs: 'task.settings.intersectionMode',
      },
      {
        name: 'intersectionMin',
        block: 'intersection',
        title: 'Минимум источников',
        type: 'integer',
        default: 0,
        min: 0,
        effectiveWhen: { intersectionMode: true },
        purpose: 'В скольких источниках человек должен состоять, чтобы попасть в выдачу.',
        constraints: [
          '0 или не задано = во ВСЕХ источниках сразу',
          'работает только при intersectionMode = true',
        ],
        examples: [0, 2, 3],
        seeAlso: ['intersectionMode'],
        storedAs: 'task.settings.intersectionMin',
      },
    )
  }

  return {
    key: cfg.key,
    version: 1,
    title: cfg.title,
    platform: 'telegram',
    tags: ['парсинг', 'parsing', 'аудитория', 'люди', 'база', ...cfg.tags],

    whoAmI: {
      summary: cfg.summary,
      does: cfg.does,
      doesNot: [
        'ничего не публикует и не пишет — это чистый сбор данных',
        'не ищет источники сам: список задаёте вы, а найти его помогают парсеры каналов и групп',
        'не обращается к ИИ и не тратит токены',
      ],
      requires: ['минимум один аккаунт с рабочим прокси', 'минимум один источник'],
      risks:
        'Сбор участников — операция, на которой чаще всего прилетает FloodWait: аккаунт вступает '
        + 'в источники и много читает. Паузы и параллельность влияют на риск сильнее всего.',
      costModel: 'Списывается за действие по прайсу модуля. Токены ИИ не расходуются.',
    },

    blocks,
    params,

    presets: [
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
      {
        param: 'delayPreset',
        title: 'Пресет темпа',
        source: 'server/lib/protection.js — PRESET_MUL',
        values: [
          { value: 0, label: 'Агрессивный', multiplier: 0.6, means: 'Паузы ×0.6.', useWhen: 'мало источников, нужен объём' },
          { value: 1, label: 'Сбалансированный', multiplier: 1, means: 'Базовые паузы.', useWhen: 'обычный сбор' },
          { value: 2, label: 'Консервативный', multiplier: 1.8, means: 'Паузы ×1.8.', useWhen: 'много источников подряд' },
          { value: 3, label: 'Custom', multiplier: 1, means: 'Без масштабирования.', useWhen: 'ручная настройка' },
        ],
      },
    ],

    examples: cfg.examples,

    contract: {
      sources: [
        { file: 'server/modules/workers.js', symbols: ['runParticipantsParser', 'targets'] },
      ],
      // Воркер общий на три парсера, и поля пересечения он читает всегда — но применяет
      // только при kind === 'parsing-users'. У остальных значение просто отбрасывается,
      // поэтому в их схеме этих полей нет: обещать «мозгам» неработающий рычаг нельзя.
      ignore: ['initiator', 'userId', ...(intersection ? [] : ['intersectionMode', 'intersectionMin'])],
    },
  }
}
