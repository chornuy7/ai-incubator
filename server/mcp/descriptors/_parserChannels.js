/**
 * Общая основа дескрипторов для парсеров КАНАЛОВ и ГРУПП.
 *
 * Оба модуля обслуживает один воркер (`runChannelParser`), отличается только вид искомого:
 * каналы или группы. Плодить две копии описания на 20 параметров — верный способ получить
 * два расходящихся текста, поэтому здесь одна фабрика, а per-модульные файлы тонкие.
 *
 * Формат — docs/mcp/MCP-SPEC.md, правила правки — docs/mcp/MCP-CONTRIBUTING.md.
 */

/**
 * @param {{key: string, title: string, what: string, whatMany: string}} cfg
 * @returns {import('./index.js').ModuleDescriptor}
 */
export function buildChannelParserDescriptor(cfg) {
  const path = `/api/modules/${cfg.key}/tasks`
  return {
    key: cfg.key,
    version: 1,
    title: cfg.title,
    platform: 'telegram',
    tags: ['парсинг', 'parsing', 'поиск', 'search', cfg.what, 'база каналов'],

    whoAmI: {
      summary: `Ищет ${cfg.whatMany} в Telegram по ключевым словам и собирает их в базу с фильтрами по размеру аудитории.`,
      does: [
        'строит поисковые запросы из ключевых слов и окончаний',
        `перебирает запросы разными аккаунтами и собирает найденные ${cfg.whatMany}`,
        'фильтрует по числу участников и по наличию комментариев',
        'убирает дубли и уже собранное ранее',
        'умеет пересечение (AND): оставить только то, что нашлось по ВСЕМ ключевым словам',
        'продолжает с места остановки — прогресс по запросам сохраняется',
      ],
      doesNot: [
        'ничего не публикует и не пишет — это чистый сбор данных',
        'не собирает участников: для этого есть парсеры пользователей, сообщений и комментариев',
        'не обращается к ИИ и не тратит токены',
      ],
      requires: ['минимум один аккаунт с рабочим прокси', 'минимум одно ключевое слово'],
      risks:
        'Поисковые запросы Telegram лимитирует: слишком частые обращения дают FloodWait. '
        + 'Задержки между запросами по умолчанию маленькие, но не нулевые — не обнуляйте их.',
      costModel: 'Списывается за действие по прайсу модуля. Токены ИИ не расходуются.',
    },

    blocks: [
      {
        id: 'accounts',
        title: 'Выберите аккаунты',
        purpose: 'Какими аккаунтами выполняется поиск.',
        howItWorks: 'Запросы распределяются между аккаунтами по кругу — так лимиты поиска расходуются равномерно.',
        api: { method: 'POST', path, fills: ['accountIds'] },
        params: ['accountIds'],
      },
      {
        id: 'query',
        title: 'Поисковый запрос',
        purpose: 'По каким словам искать.',
        howItWorks:
          'Из каждого ключевого слова и каждого окончания собирается отдельный запрос. Ключевых слов '
          + 'десять и окончаний пять — это пятьдесят запросов, и они выполняются последовательно.',
        api: { method: 'POST', path, fills: ['keywords', 'endings', 'intersect'] },
        params: ['keywords', 'endings', 'intersect'],
      },
      {
        id: 'filters',
        title: 'Фильтры результата',
        purpose: 'Что оставить из найденного.',
        howItWorks:
          'Фильтры применяются к каждому найденному результату по ходу поиска, кроме пересечения — '
          + 'оно считается В КОНЦЕ, когда пройдены все запросы.',
        api: { method: 'POST', path, fills: ['minMembers', 'maxMembers', 'commentFilter', 'alreadyParsed'] },
        params: ['minMembers', 'maxMembers', 'commentFilter', 'alreadyParsed'],
      },
      {
        id: 'limits',
        title: 'Лимиты',
        purpose: 'Сколько результатов собрать.',
        howItWorks: 'По достижении лимита поиск останавливается, даже если запросы ещё остались.',
        api: { method: 'POST', path, fills: ['resultLimit'] },
        params: ['resultLimit'],
      },
      {
        id: 'timings',
        title: 'Тайминги и задержки',
        purpose: 'Паузы между поисковыми запросами.',
        howItWorks:
          'Две разные паузы: между поисковыми запросами и между обработкой отдельных результатов. '
          + 'Обе умножаются на защиту и пресет темпа.',
        api: { method: 'POST', path, fills: ['delays', 'protectionLevel', 'delayPreset'] },
        params: ['delays', 'protectionLevel', 'delayPreset'],
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
        purpose: 'ID аккаунтов, которыми выполняется поиск.',
        constraints: ['пустой список → задача завершается с предупреждением'],
        examples: [['acc_1'], ['acc_1', 'acc_2']],
        storedAs: 'task.settings.accountIds',
      },
      {
        name: 'keywords',
        block: 'query',
        title: 'Ключевые слова',
        type: 'array',
        items: 'string',
        required: true,
        minItems: 1,
        purpose: 'Слова, по которым идёт поиск.',
        constraints: [
          'пустые строки отбрасываются; если валидных слов не осталось — задача завершается',
          'каждое слово даёт отдельный поисковый запрос',
        ],
        examples: [['крипта'], ['крипта', 'трейдинг']],
        seeAlso: ['endings', 'intersect'],
        storedAs: 'task.settings.keywords',
      },
      {
        name: 'endings',
        block: 'query',
        title: 'Окончания',
        type: 'array',
        items: 'string',
        default: [],
        purpose: 'Дополнения к ключевым словам — расширяют охват поиска.',
        constraints: ['каждое сочетание слова и окончания даёт ещё один запрос: слов × окончаний запросов'],
        examples: [['чат', 'news', 'ua']],
        seeAlso: ['keywords'],
        storedAs: 'task.settings.endings',
      },
      {
        name: 'intersect',
        block: 'query',
        title: 'Пересечение (AND)',
        type: 'boolean',
        default: false,
        purpose: `Оставить только те ${cfg.whatMany}, что нашлись по ВСЕМ ключевым словам сразу.`,
        constraints: [
          'работает только при двух и более ключевых словах',
          'применяется В КОНЦЕ, когда пройдены все запросы: до этого в результатах видно объединение',
          'резко сокращает выдачу — это ожидаемо',
        ],
        seeAlso: ['keywords'],
        storedAs: 'task.settings.intersect',
      },
      {
        name: 'minMembers',
        block: 'filters',
        title: 'Мин. участников',
        type: 'integer',
        default: 0,
        min: 0,
        purpose: 'Отбросить слишком маленькие результаты.',
        constraints: ['0 = фильтр выключен'],
        examples: [0, 500, 5000],
        seeAlso: ['maxMembers'],
        storedAs: 'task.settings.minMembers',
      },
      {
        name: 'maxMembers',
        block: 'filters',
        title: 'Макс. участников',
        type: 'integer',
        default: 0,
        min: 0,
        purpose: 'Отбросить слишком крупные результаты.',
        constraints: ['0 = фильтр выключен'],
        examples: [0, 100000],
        seeAlso: ['minMembers'],
        storedAs: 'task.settings.maxMembers',
      },
      {
        name: 'commentFilter',
        block: 'filters',
        title: 'Комментарии',
        type: 'integer',
        default: 0,
        enum: [
          { value: 0, label: 'Любые', means: 'Комментарии не учитываются при отборе.' },
          { value: 1, label: 'Только с открытыми', means: 'Оставить те, где комментарии доступны — там можно работать нейрокомментингом.' },
          { value: 2, label: 'Только с закрытыми', means: 'Оставить те, где комментарии отключены.' },
        ],
        purpose: 'Отбор по возможности комментировать.',
        constraints: ['для нейрокомментинга имеет смысл значение 1: без открытых комментариев модуль там не сработает'],
        storedAs: 'task.settings.commentFilter',
      },
      {
        name: 'alreadyParsed',
        block: 'filters',
        title: 'Исключить уже собранное',
        type: 'array',
        items: 'string',
        default: [],
        purpose: 'Список юзернеймов, которые не нужно собирать повторно.',
        constraints: ['сравнение регистронезависимое', 'обычно сюда передают результат прошлых задач'],
        storedAs: 'task.settings.alreadyParsed',
      },
      {
        name: 'resultLimit',
        block: 'limits',
        title: 'Сколько собрать',
        type: 'integer',
        default: 0,
        min: 0,
        aliases: ['limit'],
        purpose: 'Верхняя граница числа собранных результатов.',
        constraints: [
          '0 = без ограничения: пройти все запросы до конца',
          'сервер принимает и limit — это одно и то же поле',
        ],
        examples: [0, 100, 1000],
        storedAs: 'task.settings.resultLimit (сервер принимает и limit)',
      },
      {
        name: 'protectionLevel',
        block: 'timings',
        title: 'Уровень защиты',
        type: 'integer',
        default: 1,
        enum: [
          { value: 0, label: 'Консервативный', means: 'Задержки ×1.8 — медленнее, но поиск не упрётся в лимиты.' },
          { value: 1, label: 'Сбалансированный', means: 'Задержки ×1.' },
          { value: 2, label: 'Агрессивный', means: 'Задержки ×0.75 — выше шанс FloodWait на поиске.' },
        ],
        purpose: 'Множитель пауз между запросами.',
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
        seeAlso: ['protectionLevel', 'delays'],
        storedAs: 'task.settings.delayPreset',
      },
      {
        name: 'delays',
        block: 'timings',
        title: 'Задержки',
        type: 'object',
        purpose: 'Базовые интервалы поиска.',
        constraints: [
          'у парсера СВОИ имена задержек — `request` и `channel`, а не `action`, как в боевых модулях',
        ],
        properties: [
          {
            name: 'request',
            title: 'Пауза между поисковыми запросами',
            type: 'array',
            items: 'number',
            minItems: 2,
            maxItems: 2,
            default: [2, 2],
            unit: 'с',
            purpose: 'Диапазон [мин, макс] паузы между поисковыми запросами.',
            constraints: ['если задано одно число, второе берётся равным ему'],
          },
          {
            name: 'channel',
            title: 'Пауза между результатами',
            type: 'array',
            items: 'number',
            minItems: 2,
            maxItems: 2,
            default: [1, 1],
            unit: 'с',
            purpose: 'Диапазон [мин, макс] паузы между обработкой найденных результатов.',
          },
        ],
        storedAs: 'task.settings.delays',
      },
    ],

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
          { value: 0, label: 'Агрессивный', multiplier: 0.6, means: 'Паузы ×0.6.', useWhen: 'нужен объём быстро' },
          { value: 1, label: 'Сбалансированный', multiplier: 1, means: 'Базовые паузы.', useWhen: 'обычный поиск' },
          { value: 2, label: 'Консервативный', multiplier: 1.8, means: 'Паузы ×1.8.', useWhen: 'большой список ключей' },
          { value: 3, label: 'Custom', multiplier: 1, means: 'Без масштабирования.', useWhen: 'ручная настройка' },
        ],
      },
    ],

    examples: [
      {
        title: 'Быстрый сбор по одному слову',
        when: 'нужно понять, что вообще есть по теме',
        input: { accountIds: ['acc_1'], keywords: ['крипта'], resultLimit: 100, protectionLevel: 1 },
      },
      {
        title: 'Узкая выборка под нейрокомментинг',
        when: `нужны только ${cfg.whatMany} с открытыми комментариями и живой аудиторией`,
        input: {
          accountIds: ['acc_1', 'acc_2'],
          keywords: ['крипта', 'трейдинг'],
          endings: ['чат', 'news'],
          intersect: true,
          minMembers: 1000,
          maxMembers: 200000,
          commentFilter: 1,
          resultLimit: 200,
          protectionLevel: 0,
          delayPreset: 2,
        },
      },
    ],

    contract: {
      sources: [
        { file: 'server/modules/workers.js', symbols: ['runChannelParser'] },
      ],
      ignore: ['initiator', 'userId'],
    },
  }
}
