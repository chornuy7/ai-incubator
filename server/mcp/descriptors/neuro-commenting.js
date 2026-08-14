/**
 * MCP-дескриптор модуля «Нейрокомментинг».
 *
 * Это НЕ документация о коде — это источник правды. Отсюда собираются: `inputSchema`
 * для MCP-инструмента, ответ `/api/v1/modules/neuro-commenting/describe`, help по блокам.
 * Contract-тест (`server/__tests__/mcpDescriptors.test.js`) сверяет список ниже с полями,
 * которые реально читает воркер, — рассинхрон роняет тесты.
 *
 * Причина такой строгости: манифест `/api/v1/mcp` обещал «мозгам» 5 полей на модуль при
 * реальных 32, и оркестратор по нему собирал нерабочие задачи (созвон 14.08).
 *
 * Формат — docs/mcp/MCP-SPEC.md. Человекочитаемая карта — docs/mcp/MCP-MAP.md.
 */

/** @type {import('./index.js').ModuleDescriptor} */
export default {
  key: 'neuro-commenting',
  version: 1,
  title: 'Нейрокомментинг',
  platform: 'telegram',
  // Штатного поля тегов в протоколе MCP нет — кладём в `_meta.tags` и дублируем
  // ключевые слова в description, чтобы поиск по инструментам их находил.
  tags: ['комментарии', 'comments', 'каналы', 'channels', 'ии', 'ai', 'вовлечение', 'engagement'],

  whoAmI: {
    summary: 'Пишет ИИ-комментарии под постами публичных каналов от имени управляемых Telegram-аккаунтов.',
    does: [
      'подписывается на канал и его группу обсуждения, если аккаунт ещё не подписан',
      'берёт окно последних постов и отбирает подходящие по режиму и фильтрам',
      'генерирует текст комментария моделью с учётом цели, базы знаний и агента',
      'публикует комментарий и фиксирует его в логах и истории задачи',
    ],
    doesNot: [
      'не пишет в личные сообщения — это модули «Мейлинг» и «Нейродиалоги»',
      'не постит в собственные каналы — это «Автопостинг»',
      'не ставит реакции — это «Массовые реакции»',
    ],
    requires: [
      'минимум один аккаунт в статусе, допускающем работу, с рабочим прокси',
      'минимум один канал-цель',
      'рабочий ключ OpenAI: без него задача останавливается, а не публикует шаблоны',
    ],
    risks:
      'Реальные публикации в Telegram. Слишком короткие задержки и высокая вероятность → FloodWait → '
      + 'карантин аккаунта → спамблок. Начинать на новых аккаунтах следует с консервативных настроек.',
    costModel:
      'Списывается за действие по прайсу модуля; генерация текста включена в цену действия. '
      + 'Анализ картинок (analyzeImages) биллится отдельно с множителем imageMultiplier и только '
      + 'после успешной отправки комментария.',
  },

  blocks: [
    {
      id: 'accounts',
      title: 'Выберите аккаунты',
      purpose: 'Какими управляемыми аккаунтами выполняется задача.',
      howItWorks:
        'Аккаунты перебираются по кругу и делят работу между собой. Занятый другой задачей аккаунт '
        + 'не выдаётся (один аккаунт = одна задача). Аккаунты в карантине, спамблоке, невалидные, '
        + 'замороженные и требующие переавторизации пропускаются с записью в лог. Если полный круг '
        + 'аккаунтов оказался недоступен, задача корректно завершается с указанием причины.',
      api: { method: 'POST', path: '/api/modules/neuro-commenting/tasks', fills: ['accountIds'] },
      params: ['accountIds'],
    },
    {
      id: 'targets',
      title: 'Каналы',
      purpose: 'Куда комментируем и какую глубину истории канала рассматриваем.',
      howItWorks:
        'На каждой итерации канал выбирается случайно из списка. Перед первым действием аккаунт '
        + 'вступает в канал и в его группу обсуждения. Цели из чёрного списка отсеиваются до любых действий.',
      api: { method: 'POST', path: '/api/modules/neuro-commenting/tasks', fills: ['channels', 'postWindow'] },
      params: ['channels', 'postWindow'],
    },
    {
      id: 'modes',
      title: 'Режимы',
      purpose: 'Как выбирается пост для комментария и чем ограничена задача — количеством или временем.',
      howItWorks:
        'Режим комментирования решает, сколько постов из окна станут кандидатами. Фильтр постов '
        + 'дополнительно отсекает по новизне. Режим работы определяет условие завершения задачи.',
      api: { method: 'POST', path: '/api/modules/neuro-commenting/tasks', fills: ['commentMode', 'workMode', 'postFilter'] },
      params: ['commentMode', 'workMode', 'postFilter'],
    },
    {
      id: 'filters',
      title: 'Фильтры постов',
      purpose: 'Отсев постов ДО генерации текста: по словам, объёму, вероятности и смысловой близости к цели.',
      howItWorks:
        'Порядок отсева: минимум слов → ключевые слова (только в режиме «По ключевым словам») → '
        + 'стоп-слова → фильтр новизны → вероятность → семантика. Каждый шаг пишет в лог причину пропуска, '
        + 'чтобы нулевой результат не читался как поломка.',
      api: {
        method: 'POST',
        path: '/api/modules/neuro-commenting/tasks',
        fills: ['keywords', 'stopWords', 'minWords', 'probability', 'semanticFilter', 'semanticThreshold'],
      },
      params: ['keywords', 'stopWords', 'minWords', 'probability', 'semanticFilter', 'semanticThreshold'],
    },
    {
      id: 'limits',
      title: 'Лимиты',
      purpose: 'Сколько действий сделать всего и сколько на один аккаунт; при работе по времени — длительность.',
      howItWorks:
        'Фактическая цель задачи — случайное число из диапазона [min, max], детерминированное по ID задачи. '
        + 'Две задачи с одинаковыми настройками получат разные цели: ровные круглые числа выдают автоматизацию. '
        + 'Прогресс считается к этой цели, а не к максимуму.',
      api: {
        method: 'POST',
        path: '/api/modules/neuro-commenting/tasks',
        fills: ['maxComments', 'minComments', 'maxPerAccount', 'minPerAccount', 'durationMinutes'],
      },
      params: ['maxComments', 'minComments', 'maxPerAccount', 'minPerAccount', 'durationMinutes'],
    },
    {
      id: 'prompts',
      title: 'Промпты и генерация',
      purpose: 'Каким тоном и по какому шаблону пишется комментарий.',
      howItWorks:
        'Приоритет источников текста промпта: promptText (свой текст) → promptOverrides[promptIndex] → '
        + 'встроенная карточка promptIndex. Если задано распределение typeWeights, тип выбирается взвешенным '
        + 'жребием на каждый комментарий и promptIndex не используется. Поверх всегда добавляется глобальный '
        + 'системный промпт, контекст цели с базой знаний и контекст агента.',
      api: {
        method: 'POST',
        path: '/api/modules/neuro-commenting/tasks',
        fills: ['promptIndex', 'promptText', 'promptOverrides', 'typeWeights', 'analyzeImages'],
      },
      params: ['promptIndex', 'promptText', 'promptOverrides', 'typeWeights', 'analyzeImages'],
    },
    {
      id: 'protection',
      title: 'Защита аккаунтов',
      purpose: 'Множитель задержек и верхний потолок вероятности действий.',
      howItWorks:
        'Уровень защиты умножает все задержки и ограничивает вероятность сверху. Он же задаёт нижнюю '
        + 'границу длительности при работе по времени (консервативный 60 мин, сбалансированный 45, агрессивный 30).',
      api: { method: 'POST', path: '/api/modules/neuro-commenting/tasks', fills: ['aiProtection', 'protectionLevel'] },
      params: ['aiProtection', 'protectionLevel'],
    },
    {
      id: 'timings',
      title: 'Тайминги и задержки',
      purpose: 'Паузы между действиями и поведение при FloodWait.',
      howItWorks:
        'Итоговая пауза = случайное число из диапазона × множитель уровня защиты × множитель пресета темпа, '
        + 'но не меньше 5 секунд. Ровных интервалов не бывает — по ним вычисляют ботов.',
      api: { method: 'POST', path: '/api/modules/neuro-commenting/tasks', fills: ['delayPreset', 'delays'] },
      params: ['delayPreset', 'delays'],
    },
    {
      id: 'binding',
      title: 'Привязка',
      purpose: 'К какой цели, кампании и агенту относится задача.',
      howItWorks:
        'Цель подмешивает свой текст и базу знаний в системный промпт и включает семантический фильтр. '
        + 'Просроченная цель останавливает уже идущую задачу, а не только новые запуски. Кампания нужна '
        + 'для отчётности и биллинга. Агент задаёт тон, роль, запреты и манеру общения.',
      api: { method: 'POST', path: '/api/modules/neuro-commenting/tasks', fills: ['goalId', 'campaignId', 'agentId'] },
      params: ['goalId', 'campaignId', 'agentId'],
    },
  ],

  params: [
    // ── accounts ──────────────────────────────────────────────────────────────
    {
      name: 'accountIds',
      block: 'accounts',
      title: 'Аккаунты',
      type: 'array',
      items: 'string',
      required: true,
      minItems: 1,
      purpose: 'ID управляемых аккаунтов, которыми выполняется задача.',
      constraints: ['пустой список → отказ «Выберите хотя бы один аккаунт»'],
      examples: [['acc_1'], ['acc_1', 'acc_2', 'acc_3']],
      storedAs: 'task.settings.accountIds',
    },

    // ── targets ───────────────────────────────────────────────────────────────
    {
      name: 'channels',
      block: 'targets',
      title: 'Каналы-цели',
      type: 'array',
      items: 'string',
      required: true,
      minItems: 1,
      aliases: ['targets'],
      purpose: 'Публичные каналы, под постами которых публикуются комментарии.',
      constraints: [
        'формат: @username или https://t.me/<username>; ведущая @ отбрасывается',
        'каналы из чёрного списка отсеиваются до любых действий',
      ],
      examples: [['@durov'], ['https://t.me/telegram', '@durov']],
      storedAs: 'task.settings.channels (сервер принимает и targets)',
    },
    {
      name: 'postWindow',
      block: 'targets',
      title: 'Окно постов',
      type: 'integer',
      default: 20,
      min: 1,
      max: 50,
      purpose: 'Сколько последних постов канала рассматривать как кандидатов. Не вся история — окно.',
      constraints: ['значение вне 1…50 жёстко приводится к границе, ошибки не будет'],
      examples: [5, 20, 50],
      storedAs: 'task.settings.postWindow',
    },

    // ── modes ─────────────────────────────────────────────────────────────────
    {
      name: 'commentMode',
      block: 'modes',
      title: 'Режим комментирования',
      type: 'integer',
      default: 0,
      enum: [
        { value: 0, label: 'Случайный', means: 'Из отфильтрованных кандидатов берётся один случайный пост.' },
        { value: 1, label: 'По ключевым словам', means: 'Остаются только посты, содержащие хотя бы одно слово из keywords.' },
        { value: 2, label: 'Все посты', means: 'Комментируются все кандидаты окна, прошедшие фильтры.' },
      ],
      purpose: 'Правило, по которому из окна постов выбираются кандидаты на комментарий.',
      seeAlso: ['keywords', 'postWindow'],
      storedAs: 'task.settings.commentMode',
    },
    {
      name: 'workMode',
      block: 'modes',
      title: 'Режим работы',
      type: 'integer',
      default: 0,
      enum: [
        { value: 0, label: 'По количеству', means: 'Задача идёт, пока не достигнута цель по числу комментариев.' },
        { value: 1, label: 'По времени', means: 'Задача идёт, пока не истечёт durationMinutes.' },
      ],
      purpose: 'Чем ограничена задача — числом действий или временем.',
      constraints: ['при workMode = 1 обязателен durationMinutes: иначе у задачи нет условия завершения'],
      seeAlso: ['durationMinutes', 'maxComments'],
      storedAs: 'task.settings.workMode',
    },
    {
      name: 'postFilter',
      block: 'modes',
      title: 'Какие посты комментировать',
      type: 'integer',
      default: 0,
      enum: [
        { value: 0, label: 'Только новые', means: 'Остаётся только самый свежий пост окна.' },
        { value: 1, label: 'Только существующие', means: 'Остаются все посты окна, КРОМЕ самого свежего.' },
        { value: 2, label: 'Все посты', means: 'Фильтр новизны не применяется.' },
      ],
      purpose: 'Дополнительный отсев кандидатов по новизне поста.',
      storedAs: 'task.settings.postFilter',
    },

    // ── filters ───────────────────────────────────────────────────────────────
    {
      name: 'keywords',
      block: 'filters',
      title: 'Ключевые слова',
      type: 'array',
      items: 'string',
      default: [],
      purpose: 'Слова, по которым отбираются посты в режиме «По ключевым словам».',
      effectiveWhen: { commentMode: 1 },
      constraints: [
        'работают ТОЛЬКО при commentMode = 1, в остальных режимах игнорируются',
        'совпадение по вхождению подстроки, регистр не важен',
        'пустой список = фильтр ничего не режет',
      ],
      examples: [['крипта', 'биткоин'], ['ai']],
      seeAlso: ['commentMode'],
      storedAs: 'task.settings.keywords',
    },
    {
      name: 'stopWords',
      block: 'filters',
      title: 'Стоп-слова',
      type: 'array',
      items: 'string',
      default: [],
      purpose: 'Нежелательные темы и тон: пост с любым из этих слов не комментируется.',
      constraints: ['работают ВСЕГДА, независимо от режима комментирования'],
      examples: [['политика', 'война']],
      storedAs: 'task.settings.stopWords',
    },
    {
      name: 'minWords',
      block: 'filters',
      title: 'Минимум слов в посте',
      type: 'integer',
      default: 0,
      min: 0,
      purpose: 'Не комментировать слишком короткие посты — по ним нечего сказать по существу.',
      constraints: ['0 = фильтр выключен'],
      examples: [0, 5, 20],
      storedAs: 'task.settings.minWords',
    },
    {
      name: 'probability',
      block: 'filters',
      title: 'Вероятность комментария',
      type: 'integer',
      default: 30,
      min: 0,
      max: 100,
      unit: '%',
      purpose: 'Доля подходящих постов, по которым бот реально действует. Сплошной перебор выглядит машинно.',
      constraints: [
        'при aiProtection = true потолок урезается уровнем защиты: консервативный ≤25 %, сбалансированный ≤45 %, агрессивный без ограничения',
        'заданные 80 % при консервативной защите превратятся в 25 % — это не баг',
      ],
      examples: [10, 30, 100],
      seeAlso: ['aiProtection', 'protectionLevel'],
      storedAs: 'task.settings.probability',
    },
    {
      name: 'semanticFilter',
      block: 'filters',
      title: 'Семантический фильтр к цели',
      type: 'boolean',
      default: false,
      effectiveWhen: { goalId: '*' },
      purpose: 'Комментировать только посты, смысловально близкие к тексту цели.',
      constraints: [
        'требует goalId — без выбранной цели молча выключается с записью в лог',
        'если embeddings недоступны, работа продолжается без фильтра',
      ],
      seeAlso: ['goalId', 'semanticThreshold'],
      storedAs: 'task.settings.semanticFilter',
    },
    {
      name: 'semanticThreshold',
      block: 'filters',
      title: 'Порог близости',
      type: 'number',
      default: 0.2,
      min: 0,
      max: 1,
      effectiveWhen: { semanticFilter: true },
      purpose: 'Минимальная косинусная близость поста к цели, ниже которой пост пропускается.',
      constraints: ['на живых данных: релевантный пост ≈0.52, офтоп ≈0.09 — порог 0.2 режет офтоп'],
      examples: [0.15, 0.2, 0.4],
      seeAlso: ['semanticFilter'],
      storedAs: 'task.settings.semanticThreshold',
    },

    // ── limits ────────────────────────────────────────────────────────────────
    {
      name: 'maxComments',
      block: 'limits',
      title: 'Макс. комментариев',
      type: 'integer',
      default: 100,
      min: 1,
      aliases: ['maxActions'],
      purpose: 'Верхняя граница числа комментариев за всю задачу.',
      constraints: ['должен быть ≥ minComments, иначе запуск отклоняется («Минимум больше максимума»)'],
      examples: [5, 100, 1000],
      seeAlso: ['minComments', 'maxPerAccount'],
      storedAs: 'task.settings.maxComments (сервер принимает и maxActions)',
    },
    {
      name: 'minComments',
      block: 'limits',
      title: 'Мин. комментариев',
      type: 'integer',
      default: 0,
      min: 0,
      aliases: ['minActions'],
      purpose: 'Нижняя граница цели задачи. Фактическая цель — случайное число из [min, max].',
      constraints: [
        'должен быть ≤ maxComments',
        'цель детерминирована по ID задачи: один и тот же запуск всегда даёт одно число',
        'при maxComments ≥ 1 цель не может получиться нулевой',
      ],
      examples: [0, 20],
      seeAlso: ['maxComments'],
      storedAs: 'task.settings.minComments (сервер принимает и minActions)',
    },
    {
      name: 'maxPerAccount',
      block: 'limits',
      title: 'Макс. на аккаунт',
      type: 'integer',
      default: 0,
      min: 0,
      purpose: 'Потолок комментариев одним аккаунтом за задачу.',
      constraints: [
        '0 = ограничения на аккаунт нет',
        'должен быть ≥ minPerAccount',
        'независимо от него действует суточный лимит §6 на уровне аккаунта, общий для всех модулей',
      ],
      examples: [0, 5, 20],
      storedAs: 'task.settings.maxPerAccount',
    },
    {
      name: 'minPerAccount',
      block: 'limits',
      title: 'Мин. на аккаунт',
      type: 'integer',
      default: 0,
      min: 0,
      effectiveWhen: { maxPerAccount: '*' },
      purpose: 'Нижняя граница цели на один аккаунт (та же логика случайного числа из диапазона).',
      constraints: ['должен быть ≤ maxPerAccount', 'работает только когда maxPerAccount > 0'],
      storedAs: 'task.settings.minPerAccount',
    },
    {
      name: 'durationMinutes',
      block: 'limits',
      title: 'Длительность',
      type: 'integer',
      default: 60,
      min: 1,
      unit: 'мин',
      requiredWhen: { workMode: 1 },
      effectiveWhen: { workMode: 1 },
      purpose: 'Сколько задача работает в режиме «По времени».',
      constraints: [
        'игнорируется при workMode = 0',
        'трактуется как МАКСИМУМ: фактическая длительность — случайное число из [min, durationMinutes], '
        + 'где min задаёт уровень защиты (консервативный 60, сбалансированный 45, агрессивный 30 минут)',
      ],
      examples: [60, 180, 1440],
      seeAlso: ['workMode', 'protectionLevel'],
      storedAs: 'task.settings.durationMinutes',
    },

    // ── prompts ───────────────────────────────────────────────────────────────
    {
      name: 'promptIndex',
      block: 'prompts',
      title: 'Тип комментария',
      type: 'integer',
      default: 0,
      enum: [
        { value: 0, label: 'Позитивный комментарий', means: 'Доброжелательная поддержка мысли автора.' },
        { value: 1, label: 'Интимный', means: 'Личный, доверительный тон.' },
        { value: 2, label: 'Эмоциональный отклик', means: 'Выражение эмоции по поводу поста.' },
        { value: 3, label: 'Вопрос автору', means: 'Уточняющий вопрос — провоцирует ответ и диалог.' },
        { value: 4, label: 'Краткий отзыв', means: 'Одна-две фразы по существу.' },
        { value: 5, label: 'Аналитический подход', means: 'Разбор по сути с аргументом.' },
      ],
      supersededBy: ['promptText', 'typeWeights'],
      purpose: 'Какая встроенная карточка промпта используется для генерации.',
      constraints: ['игнорируется, если задан promptText или непустой typeWeights'],
      seeAlso: ['promptText', 'promptOverrides', 'typeWeights'],
      storedAs: 'task.settings.promptIndex',
    },
    {
      name: 'promptText',
      block: 'prompts',
      title: 'Свой системный промпт',
      type: 'string',
      default: '',
      purpose: 'Собственная инструкция модели вместо встроенной карточки.',
      constraints: ['непустое значение имеет наивысший приоритет — перекрывает promptIndex и promptOverrides'],
      examples: ['Пиши коротко, по-русски, без эмодзи, максимум одно предложение.'],
      storedAs: 'task.settings.promptText',
    },
    {
      name: 'promptOverrides',
      block: 'prompts',
      title: 'Переопределение карточек',
      type: 'array',
      items: 'string',
      default: [],
      supersededBy: ['promptText'],
      purpose: 'Заменить текст конкретных карточек, не отказываясь от выбора по индексу.',
      constraints: ['индекс элемента соответствует promptIndex; пустая строка = используется встроенный текст'],
      storedAs: 'task.settings.promptOverrides',
    },
    {
      name: 'typeWeights',
      block: 'prompts',
      title: 'Распределение типов, %',
      type: 'array',
      items: 'number',
      default: [],
      purpose: 'Смешивать типы комментариев в заданной пропорции, чтобы аккаунты не писали в одном тоне.',
      constraints: [
        'индекс элемента соответствует promptIndex',
        'если хотя бы один вес > 0, promptIndex НЕ используется — тип выбирается взвешенным жребием на каждый комментарий',
        'веса нормируются автоматически, сумма 100 не обязательна',
      ],
      examples: [[50, 0, 0, 30, 20, 0]],
      seeAlso: ['promptIndex'],
      storedAs: 'task.settings.typeWeights',
    },
    {
      name: 'analyzeImages',
      block: 'prompts',
      title: 'Анализ изображений',
      type: 'boolean',
      default: false,
      purpose: 'Описывать фото поста моделью и комментировать по сути изображения, а не по «[медиа]».',
      constraints: [
        'биллится отдельно с множителем imageMultiplier и только после успешной отправки комментария',
        'на семантический фильтр не влияет — близость считается по исходному тексту поста',
      ],
      storedAs: 'task.settings.analyzeImages',
    },

    // ── protection ────────────────────────────────────────────────────────────
    {
      name: 'aiProtection',
      block: 'protection',
      title: 'ИИ-защита',
      type: 'boolean',
      default: true,
      purpose: 'Включает потолок вероятности действий по уровню защиты.',
      constraints: ['выключена — probability берётся как задано, без потолка'],
      seeAlso: ['protectionLevel', 'probability'],
      storedAs: 'task.settings.aiProtection',
    },
    {
      name: 'protectionLevel',
      block: 'protection',
      title: 'Уровень защиты',
      type: 'integer',
      default: 1,
      enum: [
        {
          value: 0,
          label: 'Консервативный',
          means: 'Задержки ×1.8, вероятность не выше 25 %, минимальная длительность по времени 60 мин. Максимум безопасности.',
        },
        {
          value: 1,
          label: 'Сбалансированный',
          means: 'Задержки ×1, вероятность не выше 45 %, минимальная длительность 45 мин. Режим повседневной работы.',
        },
        {
          value: 2,
          label: 'Агрессивный',
          means: 'Задержки ×0.75, вероятность без ограничения, минимальная длительность 30 мин. Быстро и рискованно.',
        },
      ],
      purpose: 'Насколько осторожно ведёт себя аккаунт: множитель задержек и потолок вероятности.',
      constraints: [
        'ВНИМАНИЕ: нумерация ОБРАТНА delayPreset. Здесь 0 — самый безопасный, у delayPreset 0 — самый быстрый.',
      ],
      seeAlso: ['delayPreset', 'probability'],
      storedAs: 'task.settings.protectionLevel',
    },

    // ── timings ───────────────────────────────────────────────────────────────
    {
      name: 'delayPreset',
      block: 'timings',
      title: 'Пресет темпа',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Агрессивный', means: 'Паузы ×0.6 (чаще), длительность ×0.75. Быстрее, выше шанс FloodWait.' },
        { value: 1, label: 'Сбалансированный', means: 'Базовые задержки ×1. Рекомендуемый режим.' },
        { value: 2, label: 'Консервативный', means: 'Паузы ×1.8 (реже), длительность ×1.5. Медленно и безопасно.' },
        { value: 3, label: 'Custom', means: 'Задержки берутся как заданы, без масштабирования. Только здесь поля разблокированы в интерфейсе.' },
      ],
      purpose: 'Масштабирует все задержки задачи.',
      constraints: [
        'ВНИМАНИЕ: нумерация ОБРАТНА protectionLevel — здесь 0 самый быстрый',
        'итоговый множитель = множитель уровня защиты × множитель пресета × глобальный множитель ИИ-безопасности',
      ],
      seeAlso: ['protectionLevel', 'delays'],
      storedAs: 'task.settings.delayPreset',
    },
    {
      name: 'delays',
      block: 'timings',
      title: 'Задержки',
      type: 'object',
      purpose: 'Базовые интервалы, к которым применяются множители защиты и пресета.',
      properties: [
        {
          name: 'comment',
          title: 'Пауза между комментариями',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          default: [30, 120],
          unit: 'с',
          purpose: 'Диапазон [мин, макс] паузы перед публикацией комментария.',
          constraints: ['фактическая пауза — случайная из диапазона × множители, но не меньше 5 секунд'],
        },
        {
          name: 'join',
          title: 'Пауза перед вступлением',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          default: [84, 156],
          unit: 'с',
          purpose: 'Диапазон [мин, макс] паузы перед вступлением в канал или группу обсуждения.',
          constraints: [
            'жёсткий пол 60 секунд: Telegram считает вступления отдельно и жёстче остальных действий, '
            + 'ускорить их пресетом нельзя — множители агрессивных настроек срезали 90–240 с до 32 с, '
            + 'после чего аккаунты уходили в FloodWait и карантин',
          ],
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

    // ── binding ───────────────────────────────────────────────────────────────
    {
      name: 'goalId',
      block: 'binding',
      title: 'Цель',
      type: 'string',
      purpose: 'Цель, к которой ведётся работа: её текст и база знаний подмешиваются в системный промпт.',
      constraints: [
        'должна существовать; получить список — GET /api/v1/goals',
        'просроченная цель останавливает уже идущую задачу, а не только новые запуски',
      ],
      seeAlso: ['semanticFilter', 'campaignId'],
      storedAs: 'task.settings.goalId',
    },
    {
      name: 'campaignId',
      block: 'binding',
      title: 'Кампания',
      type: 'string',
      purpose: 'Кампания, в рамках которой идёт задача — нужна для отчётности и привязки расхода токенов.',
      constraints: ['должна существовать; получить список — GET /api/v1/campaigns'],
      storedAs: 'task.settings.campaignId',
    },
    {
      name: 'agentId',
      block: 'binding',
      title: 'Агент',
      type: 'string',
      purpose: 'Агент задаёт тон, роль, запреты и манеру общения при генерации.',
      constraints: ['без агента остаётся только контекст цели — генерация работает как раньше'],
      storedAs: 'task.settings.agentId',
    },
  ],

  presets: [
    {
      param: 'delayPreset',
      title: 'Пресет темпа',
      source: 'server/lib/protection.js — PRESET_MUL, множители UI обязаны совпадать',
      values: [
        { value: 0, label: 'Агрессивный', multiplier: 0.6, means: 'Паузы ×0.6, длительность ×0.75.', useWhen: 'прогретые «расходные» аккаунты' },
        { value: 1, label: 'Сбалансированный', multiplier: 1, means: 'Базовые задержки.', useWhen: 'повседневная работа' },
        { value: 2, label: 'Консервативный', multiplier: 1.8, means: 'Паузы ×1.8, длительность ×1.5.', useWhen: 'новые и дорогие аккаунты' },
        { value: 3, label: 'Custom', multiplier: 1, means: 'Без масштабирования, значения как заданы.', useWhen: 'ручная тонкая настройка' },
      ],
    },
    {
      param: 'protectionLevel',
      title: 'Уровень защиты',
      source: 'server/lib/protection.js — LEVEL_MUL + effectiveProbability; server/lib/workModeDuration.js — MIN_BY_PROTECTION_LEVEL',
      values: [
        { value: 0, label: 'Консервативный', multiplier: 1.8, probabilityCap: 25, minDurationMinutes: 60, means: 'Задержки ×1.8, вероятность ≤25 %.' },
        { value: 1, label: 'Сбалансированный', multiplier: 1, probabilityCap: 45, minDurationMinutes: 45, means: 'Задержки ×1, вероятность ≤45 %.' },
        { value: 2, label: 'Агрессивный', multiplier: 0.75, probabilityCap: 100, minDurationMinutes: 30, means: 'Задержки ×0.75, вероятность без ограничения.' },
      ],
    },
  ],

  examples: [
    {
      title: 'Мягкая проверка связки аккаунт + прокси',
      when: 'первый прогон на живом канале, важно не сжечь аккаунт',
      input: {
        accountIds: ['acc_1'],
        channels: ['@durov'],
        commentMode: 0,
        postFilter: 0,
        maxComments: 3,
        maxPerAccount: 3,
        aiProtection: true,
        protectionLevel: 0,
        delayPreset: 2,
      },
    },
    {
      title: 'Тематическая работа по ключевым словам к цели',
      when: 'есть цель и база знаний, нужно комментировать только релевантные посты',
      input: {
        accountIds: ['acc_1', 'acc_2'],
        channels: ['@crypto_channel', '@fintech_news'],
        commentMode: 1,
        keywords: ['крипта', 'биткоин'],
        stopWords: ['политика'],
        postWindow: 30,
        minWords: 10,
        maxComments: 50,
        maxPerAccount: 25,
        probability: 40,
        goalId: 'goal_123',
        semanticFilter: true,
        semanticThreshold: 0.25,
        protectionLevel: 1,
        delayPreset: 1,
      },
    },
    {
      title: 'Работа по времени со смешанным тоном',
      when: 'нужно ровно распределить активность на несколько часов',
      input: {
        accountIds: ['acc_1', 'acc_2', 'acc_3'],
        channels: ['@durov'],
        commentMode: 2,
        postFilter: 2,
        workMode: 1,
        durationMinutes: 240,
        typeWeights: [50, 0, 0, 30, 20, 0],
        protectionLevel: 1,
        delayPreset: 3,
        delays: { comment: [45, 180], join: [90, 200], floodWait: 150, floodQuarantine: 2 },
      },
    },
  ],

  /**
   * Где contract-тест ищет реальные обращения к настройкам. Если модуль начал читать поле
   * в новом месте — файл добавляется сюда, иначе тест это место просто не увидит.
   */
  contract: {
    sources: [
      { file: 'server/modules/workers.js', symbols: ['runNeuroCommenting', 'targets'] },
      { file: 'server/lib/workerLoop.js', symbols: ['pickCommentCandidates'] },
      { file: 'server/lib/targets.js', symbols: ['resolveTotalTarget', 'resolvePerAccountTarget'] },
      { file: 'server/lib/accountRunner.js', symbols: ['totalLimitReached', 'perAccountLimitReached', 'handleFlood'] },
      { file: 'server/lib/workModeDuration.js', symbols: ['resolveDurationPeriodMinutes'] },
      { file: 'server/neuroCommenting/commentGenerator.js', symbols: ['resolveSystemPrompt'] },
    ],
    /**
     * Служебные ключи задачи: их пишет платформа, а не оператор и не «мозги», поэтому в
     * MCP-схеме им не место — но воркер их читает, и без этого списка тест ругался бы.
     */
    ignore: ['initiator', 'userId'],
  },
}
