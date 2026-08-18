/**
 * MCP-дескриптор модуля «Прогрев».
 *
 * Формат — docs/mcp/MCP-SPEC.md, правила правки — docs/mcp/MCP-CONTRIBUTING.md.
 *
 * Модуль намеренно почти без настроек: прогрев — это не «сделай N действий», а имитация
 * живого поведения. Что именно делать и в какой пропорции, решает сам модуль по уровню;
 * оператор задаёт только уровень и осторожность. Целей у модуля нет вообще.
 */

/** @type {import('./index.js').ModuleDescriptor} */
export default {
  key: 'warming',
  version: 1,
  title: 'Прогрев',
  platform: 'telegram',
  tags: ['прогрев', 'warming', 'разогрев', 'подготовка аккаунтов', 'trust'],

  whoAmI: {
    summary: 'Имитирует живое поведение аккаунта, чтобы поднять его доверие в Telegram перед боевой работой.',
    does: [
      'сам выбирает действие по взвешенной пропорции: просмотр постов 40 %, реакции 20 %, чтение диалогов 20 %, вступления 10 %, подписки 10 %',
      'выполняет НАСТОЯЩИЕ действия — реакции и вступления в публичные каналы, а не имитацию в логах',
      'при достижении суточного лимита §6 действия деградируют в безопасный просмотр',
    ],
    doesNot: [
      'не работает по вашим целям: каналов и групп у модуля нет, он выбирает публичные площадки сам',
      'не пишет текст и не обращается к ИИ',
      'не даёт выбрать конкретное действие: пропорция зашита и меняется только уровнем',
    ],
    requires: ['минимум один аккаунт с рабочим прокси'],
    knownLimits:
      'ВАЖНО, реальное поведение на 18.08. Уровень прогрева меняет ТОЛЬКО множитель задержек '
      + '(×0.8 / ×1.3 / ×2.0). Заявленные «2 дня», «3–7 дней», «7–14 дней» и норма действий в день '
      + '(40 / 20 / 10) нигде не применяются: actionsPerDay попадает только в строку лога, а '
      + 'дневного окна активности у воркера нет вовсе. Задача заканчивается по достижении цели '
      + 'по числу действий, а не по календарю: при настройках по умолчанию это ~50 действий с '
      + 'паузой 13–39 с, то есть 20–35 минут — независимо от выбранного уровня. Многодневный '
      + 'прогрев нужно запускать расписанием или задавать длительность вручную.',
    risks:
      'Риск ниже, чем у боевых модулей, но действия настоящие: слишком агрессивный уровень на новом '
      + 'аккаунте даёт обратный эффект. Прогрев ПОЛНОСТЬЮ блокирует аккаунт для других модулей — '
      + 'занятый прогревом профиль в боевую задачу не выдаётся.',
    costModel: 'Списывается за действие по прайсу модуля. Токены ИИ не расходуются.',
  },

  blocks: [
    {
      id: 'accounts',
      title: 'Выберите аккаунты',
      purpose: 'Какие аккаунты прогреваются.',
      howItWorks:
        'Аккаунты перебираются по кругу. На время прогрева профиль недоступен другим модулям — '
        + 'это приоритетная блокировка, а не обычный лок.',
      api: { method: 'POST', path: '/api/modules/warming/tasks', fills: ['accountIds'] },
      params: ['accountIds'],
    },
    {
      id: 'level',
      title: 'Уровень прогрева',
      purpose: 'Насколько быстро и интенсивно греем.',
      howItWorks:
        'Уровень задаёт ТОЛЬКО множитель задержек (×0.8 / ×1.3 / ×2.0). Подписи с днями и '
        + 'норма действий в день — замысел, а не поведение: длительность определяется лимитом '
        + 'действий или режимом «по времени».',
      api: { method: 'POST', path: '/api/modules/warming/tasks', fills: ['warmLevel'] },
      params: ['warmLevel'],
    },
    {
      id: 'limits',
      title: 'Лимиты',
      purpose: 'Сколько действий сделать за задачу.',
      howItWorks:
        'Фактическая цель — случайное число из [min, max], детерминированное по ID задачи. '
        + 'Это и есть главный регулятор длительности прогрева. Поверх работает только общий '
        + 'суточный лимит аккаунта §6; нормы уровня нет.',
      api: { method: 'POST', path: '/api/modules/warming/tasks', fills: ['maxActions', 'minActions'] },
      params: ['maxActions', 'minActions'],
    },
    {
      id: 'modes',
      title: 'Режим работы',
      purpose: 'Чем ограничена задача — числом действий или временем.',
      howItWorks:
        'Пока календарного растягивания нет, режим «по времени» — единственный способ '
        + 'заставить прогрев идти долго одной задачей.',
      api: { method: 'POST', path: '/api/modules/warming/tasks', fills: ['workMode', 'durationMinutes'] },
      params: ['workMode', 'durationMinutes'],
    },
    {
      id: 'protection',
      title: 'Защита аккаунтов',
      purpose: 'Дополнительный множитель задержек поверх уровня прогрева.',
      howItWorks: 'Итоговая пауза = базовая × множитель защиты × множитель пресета × множитель уровня прогрева.',
      api: { method: 'POST', path: '/api/modules/warming/tasks', fills: ['protectionLevel', 'delayPreset'] },
      params: ['protectionLevel', 'delayPreset'],
    },
    {
      id: 'timings',
      title: 'FloodWait',
      purpose: 'Поведение при ограничениях Telegram.',
      howItWorks: 'Пауза на длительность флуда плюс запас; после N подряд аккаунт уходит в карантин.',
      api: { method: 'POST', path: '/api/modules/warming/tasks', fills: ['delays'] },
      params: ['delays'],
    },
    {
      id: 'binding',
      title: 'Привязка',
      purpose: 'Когда работа прекращается.',
      howItWorks: 'Просроченный дедлайн останавливает уже идущий прогрев.',
      api: { method: 'POST', path: '/api/modules/warming/tasks', fills: ['goalId', 'deadline'] },
      params: ['goalId', 'deadline'],
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
      purpose: 'ID аккаунтов, которые прогреваются.',
      constraints: ['пустой список → отказ «Выберите хотя бы один аккаунт»'],
      examples: [['acc_1'], ['acc_1', 'acc_2']],
      storedAs: 'task.settings.accountIds',
    },
    {
      name: 'warmLevel',
      block: 'level',
      title: 'Уровень прогрева',
      type: 'integer',
      default: 1,
      enum: [
        {
          value: 0,
          label: 'Быстрый (2 дня)',
          means: 'Задержки ×0.8 — паузы 8–24 с между действиями. Норма «40 действий в день» пока '
            + 'НЕ применяется: длительность задаётся лимитом действий или режимом «по времени».',
        },
        {
          value: 1,
          label: 'Нормальный (3–7 дней)',
          means: 'Задержки ×1.3 — паузы 13–39 с между действиями. Норма «20 действий в день» пока НЕ применяется.',
        },
        {
          value: 2,
          label: 'Стандартный (7–14 дней)',
          means: 'Задержки ×2.0 — паузы 20–60 с между действиями. Норма «10 действий в день» пока НЕ применяется.',
        },
      ],
      purpose: 'Темп прогрева и суточная норма действий.',
      constraints: [
        'множитель уровня перемножается с защитой и пресетом, а не заменяет их',
        'подписи «2 дня / 3–7 дней / 7–14 дней» описывают ЗАМЫСЕЛ, а не поведение: календарного '
        + 'растягивания у модуля нет, задача заканчивается по числу действий',
      ],
      seeAlso: ['protectionLevel', 'delayPreset'],
      storedAs: 'task.settings.warmLevel',
    },
    {
      name: 'maxActions',
      block: 'limits',
      title: 'Макс. действий',
      type: 'integer',
      default: 100,
      min: 1,
      aliases: ['maxComments'],
      purpose: 'Верхняя граница числа действий прогрева за задачу.',
      constraints: [
        'должен быть ≥ minActions',
        'ИМЕННО ЭТО определяет, сколько прогрев продлится: без явного лимита цель — случайное '
        + 'число до 100, и задача завершается за десятки минут',
      ],
      examples: [40, 200],
      seeAlso: ['minActions', 'warmLevel'],
      storedAs: 'task.settings.maxActions',
    },
    {
      name: 'minActions',
      block: 'limits',
      title: 'Мин. действий',
      type: 'integer',
      default: 0,
      min: 0,
      aliases: ['minComments'],
      purpose: 'Нижняя граница цели задачи.',
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
        { value: 0, label: 'По количеству', means: 'До достижения цели по числу действий.' },
        { value: 1, label: 'По времени', means: 'До истечения durationMinutes.' },
      ],
      purpose: 'Чем ограничена задача.',
      constraints: ['при workMode = 1 обязателен durationMinutes'],
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
      purpose: 'Сколько задача греет аккаунты.',
      constraints: [
        'трактуется как МАКСИМУМ: фактическая длительность — случайное число из [min, durationMinutes], '
        + 'где min задаёт уровень защиты (60 / 45 / 30 минут)',
        'дневного окна активности у модуля нет: если нужен прогрев «как у человека», '
        + 'запускайте расписанием по дням, а не одной длинной задачей',
      ],
      examples: [480, 1440],
      seeAlso: ['workMode', 'protectionLevel'],
      storedAs: 'task.settings.durationMinutes',
    },
    {
      name: 'protectionLevel',
      block: 'protection',
      title: 'Уровень защиты',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Консервативный', means: 'Задержки ×1.8, минимальная длительность 60 мин.' },
        { value: 1, label: 'Сбалансированный', means: 'Задержки ×1, минимальная длительность 45 мин.' },
        { value: 2, label: 'Агрессивный', means: 'Задержки ×0.75, минимальная длительность 30 мин.' },
      ],
      purpose: 'Дополнительная осторожность поверх уровня прогрева.',
      constraints: ['ВНИМАНИЕ: нумерация ОБРАТНА delayPreset — здесь 0 самый безопасный'],
      seeAlso: ['warmLevel', 'delayPreset'],
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
      purpose: 'Ещё один множитель задержек.',
      constraints: ['ВНИМАНИЕ: нумерация ОБРАТНА protectionLevel — здесь 0 самый быстрый'],
      seeAlso: ['protectionLevel', 'warmLevel'],
      storedAs: 'task.settings.delayPreset',
    },
    {
      name: 'delays',
      block: 'timings',
      title: 'Задержки',
      type: 'object',
      purpose: 'Поведение при FloodWait.',
      constraints: [
        'паузы между действиями прогрева задаются уровнем и множителями, а не этим полем — '
        + 'здесь только реакция на ограничения Telegram',
      ],
      properties: [
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
      purpose: 'Цель, к которой формально относится задача.',
      constraints: ['на поведение прогрева не влияет — используется для дедлайна и отчётности'],
      seeAlso: ['deadline'],
      storedAs: 'task.settings.goalId',
    },
    {
      name: 'deadline',
      block: 'binding',
      title: 'Дедлайн',
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      purpose: 'Дата, после которой прогрев прекращается.',
      constraints: ['формат YYYY-MM-DD', 'останавливает УЖЕ ИДУЩУЮ задачу'],
      examples: ['2026-09-01'],
      seeAlso: ['goalId'],
      storedAs: 'task.settings.deadline',
    },
  ],

  presets: [
    {
      param: 'warmLevel',
      title: 'Уровень прогрева',
      source: 'server/lib/workerLoop.js — warmingPace',
      values: [
        { value: 0, label: 'Быстрый (2 дня)', multiplier: 0.8, actionsPerDayDeclared: 40, actionsPerDayEnforced: false, means: 'Задержки ×0.8. Норма в день объявлена, но не применяется.', useWhen: 'аккаунт нужен срочно' },
        { value: 1, label: 'Нормальный (3–7 дней)', multiplier: 1.3, actionsPerDayDeclared: 20, actionsPerDayEnforced: false, means: 'Задержки ×1.3. Норма в день объявлена, но не применяется.', useWhen: 'обычный случай' },
        { value: 2, label: 'Стандартный (7–14 дней)', multiplier: 2.0, actionsPerDayDeclared: 10, actionsPerDayEnforced: false, means: 'Задержки ×2.0. Норма в день объявлена, но не применяется.', useWhen: 'дорогие аккаунты, спешить некуда' },
      ],
    },
    {
      param: 'protectionLevel',
      title: 'Уровень защиты',
      source: 'server/lib/protection.js — LEVEL_MUL; server/lib/workModeDuration.js',
      values: [
        { value: 0, label: 'Консервативный', multiplier: 1.8, minDurationMinutes: 60, means: 'Задержки ×1.8.' },
        { value: 1, label: 'Сбалансированный', multiplier: 1, minDurationMinutes: 45, means: 'Задержки ×1.' },
        { value: 2, label: 'Агрессивный', multiplier: 0.75, minDurationMinutes: 30, means: 'Задержки ×0.75.' },
      ],
    },
  ],

  examples: [
    {
      title: 'Долгий прогрев новых аккаунтов',
      when: 'аккаунты только куплены, впереди боевая работа',
      input: {
        accountIds: ['acc_1', 'acc_2', 'acc_3'],
        warmLevel: 2,
        workMode: 1,
        durationMinutes: 1440,
        protectionLevel: 0,
        delayPreset: 2,
      },
    },
    {
      title: 'Срочный прогрев перед запуском',
      when: 'аккаунт нужен в работу через пару дней',
      input: { accountIds: ['acc_1'], warmLevel: 0, maxActions: 80, protectionLevel: 1, delayPreset: 1 },
    },
  ],

  contract: {
    sources: [
      { file: 'server/modules/workers.js', symbols: ['runWarming', 'goalExpired'] },
      { file: 'server/lib/targets.js', symbols: ['resolveTotalTarget'] },
      // perAccountLimitReached модуль не вызывает — maxPerAccount у прогрева не работает.
      { file: 'server/lib/accountRunner.js', symbols: ['totalLimitReached', 'handleFlood'] },
      { file: 'server/lib/workModeDuration.js', symbols: ['resolveDurationPeriodMinutes'] },
    ],
    ignore: ['initiator', 'userId'],
  },
}
