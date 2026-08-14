/**
 * MCP-дескриптор модуля «Нейродиалоги».
 *
 * Формат — docs/mcp/MCP-SPEC.md, правила правки — docs/mcp/MCP-CONTRIBUTING.md.
 *
 * Модуль устроен иначе всех остальных, и это надо держать в голове:
 *  - он ОТВЕЧАЕТ, а не пишет первым: целей-каналов у него нет вообще;
 *  - он не завершается по достижении лимита, а простаивает, ожидая новых входящих;
 *  - вероятности у него нет — отвечает всем, кто написал;
 *  - `protectionLevel` тут имеет ДОПОЛНИТЕЛЬНЫЙ смысл: он задаёт, сколько ЛС аккаунт
 *    отвечает за один заход, прежде чем уступить очередь.
 */

/** @type {import('./index.js').ModuleDescriptor} */
export default {
  key: 'neuro-dialogs',
  version: 1,
  title: 'Нейродиалоги',
  platform: 'telegram',
  tags: ['лс', 'личные сообщения', 'dm', 'диалоги', 'dialogs', 'crm', 'лиды', 'leads', 'ии', 'ai'],

  whoAmI: {
    summary: 'Отвечает ИИ на входящие личные сообщения от имени управляемых аккаунтов и ведёт лида по воронке до целевого действия.',
    does: [
      'следит за входящими ЛС аккаунтов и отвечает на них',
      'ведёт разговор к цели: подмешивает цель кампании, этап воронки и статус лида в промпт',
      'сам определяет, что цель достигнута, благодарит и закрывает диалог — не давит дальше',
      'двигает статус лида в CRM по ходу переписки',
      'по желанию дожимает тех, кто написал сам после закрытия диалога',
      'умеет работать в несколько параллельных потоков с расфазировкой стартов',
    ],
    doesNot: [
      'НЕ ПИШЕТ ПЕРВЫМ никогда — только отвечает. Холодная рассылка это «Мейлинг»',
      'не работает по списку целей: каналов и групп у модуля нет в принципе',
      'не пишет в группы — это «Нейрочаттинг»',
      'не отвечает ботам и служебным чатам Telegram — пропускает их',
    ],
    requires: [
      'минимум один аккаунт в статусе, допускающем работу, с рабочим прокси',
      'рабочий ключ OpenAI',
      'входящие сообщения: без них модуль просто ждёт и ничего не делает — это нормально',
    ],
    risks:
      'Личная переписка с живыми людьми. Пачка ответов подряд с одного номера — самый быстрый '
      + 'путь к PEER_FLOOD и репортам, поэтому число ответов за заход ограничено уровнем защиты. '
      + 'Аккаунт в спамблоке продолжает читать входящие, но не отвечает.',
    costModel: 'Списывается за действие по прайсу модуля; генерация текста включена. Анализ картинок биллится отдельно.',
  },

  blocks: [
    {
      id: 'accounts',
      title: 'Выберите аккаунты',
      purpose: 'Чьи входящие ЛС обслуживает задача.',
      howItWorks:
        'Аккаунты перебираются по кругу. Занятый другой задачей не выдаётся; проблемные статусы '
        + 'и суточный лимит ЛС пропускаются. При достижении суточного лимита модуль НЕ завершается, '
        + 'а тихо простаивает — он ответчик, а не пакетная рассылка.',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['accountIds'] },
      params: ['accountIds'],
    },
    {
      id: 'behaviour',
      title: 'На что отвечать',
      purpose: 'Какие диалоги модуль берёт в работу.',
      howItWorks:
        'Режим «непрочитанные» — только новые входящие. Режим «все» — включая уже прочитанные ЛС, '
        + 'где последнее слово за собеседником. На одно и то же сообщение дважды не отвечает: '
        + 'ответ повторится, только когда собеседник напишет новое.',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['replyScope'] },
      params: ['replyScope'],
    },
    {
      id: 'limits',
      title: 'Лимиты на диалог',
      purpose: 'Сколько сообщений писать одному человеку и сколько всего.',
      howItWorks:
        'Либо пишем, пока лид не выполнит целевое действие (ограничивают только суточные лимиты), '
        + 'либо не больше заданного числа ответов на лида. Общий лимит задачи считается как у всех '
        + 'модулей — случайным числом из [min, max].',
      api: {
        method: 'POST',
        path: '/api/modules/neuro-dialogs/tasks',
        fills: ['replyLimitMode', 'maxRepliesPerLead', 'maxActions', 'minActions'],
      },
      params: ['replyLimitMode', 'maxRepliesPerLead', 'maxActions', 'minActions'],
    },
    {
      id: 'modes',
      title: 'Режим работы',
      purpose: 'Чем ограничена задача — числом ответов или временем.',
      howItWorks:
        'Модуль-ответчик обычно ставят по времени: он работает смену и ждёт входящие, '
        + 'а не «отрабатывает пачку и завершается».',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['workMode', 'durationMinutes'] },
      params: ['workMode', 'durationMinutes'],
    },
    {
      id: 'followup',
      title: 'Дожим',
      purpose: 'Что делать, когда диалог закрыт, а человек написал сам.',
      howItWorks:
        'Дожим включается только на ВХОДЯЩИЙ интерес: диалог уже закрыт (цель достигнута или '
        + 'человек отказался), но он написал снова. Тон отдельный — продавать то же самое повторно '
        + 'верный способ получить блокировку. У дожима свой счётчик и свой потолок.',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['followUp'] },
      params: ['followUp'],
    },
    {
      id: 'prompts',
      title: 'Промпты и генерация',
      purpose: 'Что модель знает о разговоре и каким тоном отвечает.',
      howItWorks:
        'Системный промпт собирается слоями: свой промпт (или карточка) → жёсткие правила переписки '
        + '(коротко, на языке собеседника, не представляться заново, никогда не признаваться, что это ИИ) '
        + '→ правила завершения → стадия лида → этап воронки из цели → ссылка из цели целиком → '
        + 'цель кампании → инструкция диалога.',
      api: {
        method: 'POST',
        path: '/api/modules/neuro-dialogs/tasks',
        fills: ['dialogGoal', 'promptIndex', 'promptText', 'promptOverrides', 'analyzeImages'],
      },
      params: ['dialogGoal', 'promptIndex', 'promptText', 'promptOverrides', 'analyzeImages'],
    },
    {
      id: 'performance',
      title: 'Параллельность',
      purpose: 'Сколько потоков обслуживают аккаунты одновременно.',
      howItWorks:
        'Аккаунты делятся между потоками по кругу. У каждого потока своя случайная фаза и джиттер: '
        + 'без расфазировки потоки выравниваются и начинают стучать в Telegram синхронно, а ровный '
        + 'машинный ритм от нескольких аккаунтов и есть кластер, который видно со стороны.',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['threads'] },
      params: ['threads'],
    },
    {
      id: 'protection',
      title: 'Защита аккаунтов',
      purpose: 'Множитель задержек и сколько ЛС аккаунт отвечает за один заход.',
      howItWorks:
        'У этого модуля уровень защиты решает не только скорость: он задаёт размер пачки ответов '
        + 'за заход (2 / 4 / 6). Вероятности у модуля нет — он отвечает всем, кто написал.',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['protectionLevel'] },
      params: ['protectionLevel'],
    },
    {
      id: 'timings',
      title: 'Тайминги и задержки',
      purpose: 'Паузы между ответами и поведение при FloodWait.',
      howItWorks: 'Пауза = случайная из диапазона × множитель защиты × множитель пресета, но не меньше 5 секунд.',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['delayPreset', 'delays'] },
      params: ['delayPreset', 'delays'],
    },
    {
      id: 'binding',
      title: 'Привязка',
      purpose: 'К какой цели и кампании относится задача.',
      howItWorks:
        'Цель даёт классификатору статусов понимание, что считать «выполнено», а промпту — этапы '
        + 'воронки и ссылку. Просроченный дедлайн останавливает уже идущую задачу.',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['goalId', 'campaignId', 'deadline'] },
      params: ['goalId', 'campaignId', 'deadline'],
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
      purpose: 'ID аккаунтов, чьи входящие ЛС обслуживает задача.',
      constraints: ['пустой список → отказ «Выберите хотя бы один аккаунт»'],
      examples: [['acc_1'], ['acc_1', 'acc_2', 'acc_3']],
      storedAs: 'task.settings.accountIds',
    },
    {
      name: 'replyScope',
      block: 'behaviour',
      title: 'На что отвечать',
      type: 'string',
      default: 'unread',
      enum: [
        { value: 'unread', label: 'Только непрочитанные', means: 'Отвечаем только на новые входящие ЛС.' },
        { value: 'all', label: 'Всем, кто писал', means: 'Отвечаем и на уже прочитанные диалоги, где последнее слово за собеседником.' },
      ],
      purpose: 'Какие диалоги брать в работу.',
      constraints: [
        'на одно и то же сообщение дважды не отвечаем — только когда собеседник напишет новое',
        'служебные чаты Telegram и боты пропускаются в любом режиме',
      ],
      storedAs: 'task.settings.replyScope',
    },
    {
      name: 'replyLimitMode',
      block: 'limits',
      title: 'Лимит на лида',
      type: 'string',
      default: 'untilTarget',
      enum: [
        {
          value: 'untilTarget',
          label: 'До целевого действия',
          means: 'Пишем, пока лид не выполнит целевое действие или не откажется. Ограничивают только суточные лимиты и стоп-лист.',
        },
        {
          value: 'count',
          label: 'Не больше N ответов',
          means: 'После maxRepliesPerLead ответов диалог с этим человеком не продолжаем.',
        },
      ],
      purpose: 'Чем ограничено число сообщений одному человеку.',
      seeAlso: ['maxRepliesPerLead'],
      storedAs: 'task.settings.replyLimitMode',
    },
    {
      name: 'maxRepliesPerLead',
      block: 'limits',
      title: 'Ответов на лида',
      type: 'integer',
      default: 0,
      min: 0,
      effectiveWhen: { replyLimitMode: 'count' },
      purpose: 'Сколько сообщений максимум писать одному человеку.',
      constraints: ['0 = без ограничения', 'работает только при replyLimitMode = count'],
      examples: [0, 3, 10],
      seeAlso: ['replyLimitMode'],
      storedAs: 'task.settings.maxRepliesPerLead',
    },
    {
      name: 'maxActions',
      block: 'limits',
      title: 'Макс. ответов за задачу',
      type: 'integer',
      default: 100,
      min: 1,
      aliases: ['maxComments'],
      purpose: 'Верхняя граница числа отправленных ответов за всю задачу.',
      constraints: ['должен быть ≥ minActions'],
      examples: [50, 200],
      seeAlso: ['minActions', 'workMode'],
      storedAs: 'task.settings.maxActions',
    },
    {
      name: 'minActions',
      block: 'limits',
      title: 'Мин. ответов за задачу',
      type: 'integer',
      default: 0,
      min: 0,
      aliases: ['minComments'],
      purpose: 'Нижняя граница цели задачи. Фактическая цель — случайное число из [min, max].',
      constraints: ['должен быть ≤ maxActions'],
      seeAlso: ['maxActions'],
      storedAs: 'task.settings.minActions',
    },
    {
      name: 'workMode',
      block: 'modes',
      title: 'Режим работы',
      type: 'integer',
      default: 0,
      enum: [
        { value: 0, label: 'По количеству', means: 'Задача идёт, пока не достигнута цель по числу ответов.' },
        { value: 1, label: 'По времени', means: 'Задача идёт заданное время и всё это время ждёт входящие.' },
      ],
      purpose: 'Чем ограничена задача.',
      constraints: [
        'при workMode = 1 обязателен durationMinutes',
        'для модуля-ответчика режим по времени обычно уместнее: входящие приходят когда придут',
      ],
      seeAlso: ['durationMinutes'],
      storedAs: 'task.settings.workMode',
    },
    {
      name: 'durationMinutes',
      block: 'modes',
      title: 'Длительность',
      type: 'integer',
      default: 60,
      min: 1,
      unit: 'мин',
      requiredWhen: { workMode: 1 },
      effectiveWhen: { workMode: 1 },
      purpose: 'Сколько задача дежурит на входящих.',
      constraints: [
        'трактуется как МАКСИМУМ: фактическая длительность — случайное число из [min, durationMinutes], '
        + 'где min задаёт уровень защиты (60 / 45 / 30 минут)',
      ],
      examples: [240, 480],
      seeAlso: ['workMode', 'protectionLevel'],
      storedAs: 'task.settings.durationMinutes',
    },
    {
      name: 'followUp',
      block: 'followup',
      title: 'Дожим',
      type: 'object',
      purpose: 'Отвечать ли тем, кто написал сам после закрытия диалога.',
      constraints: [
        'срабатывает ТОЛЬКО на входящее сообщение — сам модуль дожим не инициирует',
        'если не задан, берутся настройки дожима из цели (для кампаний, заведённых раньше)',
      ],
      properties: [
        {
          name: 'enabled',
          title: 'Включён',
          type: 'boolean',
          default: false,
          purpose: 'Отвечать ли на входящие в закрытых диалогах.',
        },
        {
          name: 'limit',
          title: 'Потолок дожима',
          type: 'integer',
          default: 0,
          min: 0,
          purpose: 'Сколько раз максимум дожимать одного человека.',
          constraints: ['0 = без ограничения; счётчик отдельный от maxRepliesPerLead'],
        },
        {
          name: 'instructions',
          title: 'Инструкция дожима',
          type: 'string',
          default: '',
          purpose: 'Чем тон дожима отличается от основного разговора.',
          constraints: ['добавляется к системному промпту только в дожиме'],
        },
      ],
      storedAs: 'task.settings.followUp',
    },
    {
      name: 'dialogGoal',
      block: 'prompts',
      title: 'Инструкция и цель диалога',
      type: 'string',
      default: '',
      purpose: 'Свободный текст: к чему вести разговор и как себя вести.',
      constraints: [
        'добавляется последним слоем системного промпта — перебивает более общие указания',
        'это НЕ цель из справочника: она задаётся отдельно через goalId',
      ],
      examples: ['Мягко подвести к записи на бесплатную консультацию, ссылку давать только после явного интереса.'],
      seeAlso: ['goalId'],
      storedAs: 'task.settings.dialogGoal',
    },
    {
      name: 'promptIndex',
      block: 'prompts',
      title: 'Тип ответа',
      type: 'integer',
      default: 0,
      enum: [
        { value: 0, label: 'Позитивный', means: 'Доброжелательный тон.' },
        { value: 1, label: 'Интимный', means: 'Личный, доверительный тон.' },
        { value: 2, label: 'Эмоциональный отклик', means: 'Выражение эмоции.' },
        { value: 3, label: 'Вопрос собеседнику', means: 'Уточняющий вопрос — продолжает разговор.' },
        { value: 4, label: 'Краткий отзыв', means: 'Одна-две фразы по существу.' },
        { value: 5, label: 'Аналитический подход', means: 'Разбор по сути с аргументом.' },
      ],
      supersededBy: ['promptText'],
      purpose: 'Базовая карточка тона, поверх которой накладываются правила переписки.',
      storedAs: 'task.settings.promptIndex',
    },
    {
      name: 'promptText',
      block: 'prompts',
      title: 'Свой системный промпт',
      type: 'string',
      default: '',
      purpose: 'Собственная инструкция модели вместо встроенной карточки.',
      constraints: [
        'непустое значение перекрывает promptIndex и promptOverrides',
        'жёсткие правила переписки (не признаваться, что это ИИ; отвечать коротко и на языке '
        + 'собеседника; не здороваться повторно) добавляются ПОВЕРХ и не отключаются',
      ],
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
      purpose: 'Заменить текст конкретных карточек тона.',
      constraints: ['индекс элемента соответствует promptIndex'],
      storedAs: 'task.settings.promptOverrides',
    },
    {
      name: 'analyzeImages',
      block: 'prompts',
      title: 'Анализ изображений',
      type: 'boolean',
      default: false,
      purpose: 'Описывать присланные собеседником фото и отвечать по их сути.',
      constraints: ['биллится отдельно с множителем imageMultiplier', 'применяется только к последнему входящему сообщению'],
      storedAs: 'task.settings.analyzeImages',
    },
    {
      name: 'threads',
      block: 'performance',
      title: 'Потоков',
      type: 'integer',
      default: 1,
      min: 1,
      purpose: 'Сколько наборов аккаунтов обслуживаются параллельно.',
      constraints: [
        'больше числа аккаунтов не бывает — значение обрезается: пустой поток крутил бы цикл вхолостую',
        'это ОДНА задача: общий прогресс, общие логи, одна кнопка «Стоп»',
        'старты потоков разводятся случайной паузой — одновременный залп читается как ферма',
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
        {
          value: 0,
          label: 'Консервативный',
          means: 'Задержки ×1.8, не более 2 ответов за заход одним аккаунтом, минимальная длительность 60 мин.',
        },
        {
          value: 1,
          label: 'Сбалансированный',
          means: 'Задержки ×1, до 4 ответов за заход, минимальная длительность 45 мин.',
        },
        {
          value: 2,
          label: 'Агрессивный',
          means: 'Задержки ×0.75, до 6 ответов за заход, минимальная длительность 30 мин.',
        },
      ],
      purpose: 'Скорость и размер пачки ответов с одного номера.',
      constraints: [
        'у ЭТОГО модуля уровень защиты дополнительно ограничивает число ответов за один заход (2 / 4 / 6)',
        'пачка ответов подряд с одного номера — самый быстрый путь к PEER_FLOOD и репортам',
        'ВНИМАНИЕ: нумерация ОБРАТНА delayPreset — здесь 0 самый безопасный',
      ],
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
        { value: 0, label: 'Агрессивный', means: 'Паузы ×0.6, длительность ×0.75.' },
        { value: 1, label: 'Сбалансированный', means: 'Базовые задержки ×1.' },
        { value: 2, label: 'Консервативный', means: 'Паузы ×1.8, длительность ×1.5.' },
        { value: 3, label: 'Custom', means: 'Задержки берутся как заданы, без масштабирования.' },
      ],
      purpose: 'Масштабирует все задержки задачи.',
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
        'задержки здесь короче, чем в других модулях: ответ в переписке ждут, и пауза в две '
        + 'минуты выглядит страннее, чем пауза в двадцать секунд',
      ],
      properties: [
        {
          name: 'action',
          title: 'Пауза перед ответом',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          default: [5, 30],
          unit: 'с',
          purpose: 'Диапазон [мин, макс] паузы перед отправкой ответа.',
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
      purpose: 'Цель кампании: даёт этапы воронки, целевое действие и ссылку для отправки.',
      constraints: [
        'должна существовать; получить список — GET /api/v1/goals',
        'по ней классификатор понимает, что считать «выполнено», и двигает статус лида в CRM',
        'ссылка из цели вставляется в сообщение целиком — модель не подставляет заглушки',
      ],
      seeAlso: ['dialogGoal', 'deadline'],
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
      name: 'deadline',
      block: 'binding',
      title: 'Дедлайн',
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      purpose: 'Дата, после которой работа по задаче прекращается.',
      constraints: [
        'формат YYYY-MM-DD; дедлайн включает указанный день целиком',
        'приезжает из кампании; если не задан — берётся дедлайн цели по goalId',
        'останавливает УЖЕ ИДУЩУЮ задачу',
      ],
      examples: ['2026-09-01'],
      seeAlso: ['goalId'],
      storedAs: 'task.settings.deadline',
    },
  ],

  presets: [
    {
      param: 'delayPreset',
      title: 'Пресет темпа',
      source: 'server/lib/protection.js — PRESET_MUL',
      values: [
        { value: 0, label: 'Агрессивный', multiplier: 0.6, means: 'Паузы ×0.6, длительность ×0.75.', useWhen: 'прогретые аккаунты, много входящих' },
        { value: 1, label: 'Сбалансированный', multiplier: 1, means: 'Базовые задержки.', useWhen: 'повседневная работа' },
        { value: 2, label: 'Консервативный', multiplier: 1.8, means: 'Паузы ×1.8, длительность ×1.5.', useWhen: 'новые и дорогие аккаунты' },
        { value: 3, label: 'Custom', multiplier: 1, means: 'Без масштабирования.', useWhen: 'ручная настройка' },
      ],
    },
    {
      param: 'protectionLevel',
      title: 'Уровень защиты',
      source: 'server/lib/protection.js — LEVEL_MUL; server/lib/workModeDuration.js; perPassCap [2,4,6] в runNeuroDialogs',
      values: [
        { value: 0, label: 'Консервативный', multiplier: 1.8, repliesPerPass: 2, minDurationMinutes: 60, means: 'Задержки ×1.8, до 2 ответов за заход.' },
        { value: 1, label: 'Сбалансированный', multiplier: 1, repliesPerPass: 4, minDurationMinutes: 45, means: 'Задержки ×1, до 4 ответов за заход.' },
        { value: 2, label: 'Агрессивный', multiplier: 0.75, repliesPerPass: 6, minDurationMinutes: 30, means: 'Задержки ×0.75, до 6 ответов за заход.' },
      ],
    },
  ],

  examples: [
    {
      title: 'Дежурство на входящих под цель',
      when: 'идёт кампания, люди пишут сами, надо доводить их до целевого действия',
      input: {
        accountIds: ['acc_1', 'acc_2'],
        replyScope: 'unread',
        replyLimitMode: 'untilTarget',
        workMode: 1,
        durationMinutes: 480,
        goalId: 'goal_123',
        dialogGoal: 'Довести до записи на бесплатную консультацию. Ссылку давать только после явного интереса.',
        protectionLevel: 1,
        delayPreset: 1,
      },
    },
    {
      title: 'Осторожный разбор накопившихся ЛС',
      when: 'в аккаунтах лежат непрочитанные сообщения, надо ответить всем без риска',
      input: {
        accountIds: ['acc_1'],
        replyScope: 'all',
        replyLimitMode: 'count',
        maxRepliesPerLead: 2,
        maxActions: 20,
        protectionLevel: 0,
        delayPreset: 2,
        delays: { action: [20, 60], floodWait: 180, floodQuarantine: 2 },
      },
    },
    {
      title: 'Много аккаунтов в несколько потоков с дожимом',
      when: 'большой поток входящих, надо обрабатывать параллельно и возвращать тех, кто написал снова',
      input: {
        accountIds: ['acc_1', 'acc_2', 'acc_3', 'acc_4', 'acc_5', 'acc_6'],
        threads: 3,
        replyScope: 'unread',
        workMode: 1,
        durationMinutes: 600,
        followUp: { enabled: true, limit: 2, instructions: 'Не продавать повторно. Коротко спросить, остались ли вопросы.' },
        analyzeImages: true,
        goalId: 'goal_123',
        protectionLevel: 1,
      },
    },
  ],

  contract: {
    sources: [
      { file: 'server/modules/workers.js', symbols: ['runNeuroDialogs', 'dialogSystemPrompt', 'goalExpired'] },
      { file: 'server/lib/targets.js', symbols: ['resolveTotalTarget'] },
      // perAccountLimitReached здесь НЕ указан намеренно: модуль-ответчик его не вызывает,
      // и maxPerAccount у него не работает — обещать это поле «мозгам» нельзя.
      { file: 'server/lib/accountRunner.js', symbols: ['totalLimitReached', 'handleFlood'] },
      { file: 'server/lib/workModeDuration.js', symbols: ['resolveDurationPeriodMinutes'] },
      { file: 'server/neuroCommenting/commentGenerator.js', symbols: ['resolveSystemPrompt'] },
    ],
    ignore: ['initiator', 'userId'],
  },
}
