/**
 * MCP-дескриптор модуля «Снятие спамблока».
 *
 * Формат — docs/mcp/MCP-SPEC.md, правила правки — docs/mcp/MCP-CONTRIBUTING.md.
 *
 * Служебная задача восстановления, а не боевой модуль: аккаунты идут в @SpamBot просить
 * снятие ограничений. Паузы задаются СВОИМИ полями (`delayMin`/`delayMax`), а не общей
 * структурой `delays` — на этом оркестратор спотыкается.
 */

/** @type {import('./index.js').ModuleDescriptor} */
export default {
  key: 'spam-unblock',
  version: 1,
  title: 'Снятие спамблока',
  platform: 'telegram',
  tags: ['спамблок', 'spamblock', 'разблокировка', 'восстановление', 'spambot'],

  whoAmI: {
    summary: 'Обращается к @SpamBot от имени заблокированных аккаунтов и просит снять ограничения.',
    does: [
      'по очереди пишет в @SpamBot с каждого выбранного аккаунта',
      'разбирает ответ бота и определяет, сняты ли ограничения',
      'считает, скольким аккаунтам спамблок сняли',
      'выдерживает случайные паузы между аккаунтами',
    ],
    doesNot: [
      'не гарантирует снятие: решение принимает Telegram, а не мы',
      'не выполняет никаких других действий в Telegram',
      'не работает по целям — каналов и групп у модуля нет',
    ],
    requires: ['аккаунты с живой сессией, попавшие под ограничения'],
    risks:
      'Низкий. Но повторять слишком часто бессмысленно: если бот отказал, спамблок снимается '
      + 'по времени, и повторные обращения этого не ускоряют.',
    costModel: 'Служебная задача. Токены ИИ не расходуются.',
  },

  blocks: [
    {
      id: 'accounts',
      title: 'Выберите аккаунты',
      purpose: 'Какие аккаунты пытаемся разблокировать.',
      howItWorks: 'Аккаунты обрабатываются строго по очереди, по одному — залп в @SpamBot смысла не имеет.',
      api: { method: 'POST', path: '/api/modules/spam-unblock/tasks', fills: ['accountIds'] },
      params: ['accountIds'],
    },
    {
      id: 'timings',
      title: 'Паузы между аккаунтами',
      purpose: 'Через сколько браться за следующий аккаунт.',
      howItWorks:
        'Пауза выбирается случайно из диапазона: ровный интервал между обращениями к одному и '
        + 'тому же боту с разных аккаунтов читается как ферма.',
      api: { method: 'POST', path: '/api/modules/spam-unblock/tasks', fills: ['delayMin', 'delayMax'] },
      params: ['delayMin', 'delayMax'],
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
      purpose: 'ID аккаунтов, для которых запрашивается снятие ограничений.',
      constraints: ['обрабатываются по очереди, по одному'],
      examples: [['acc_1'], ['acc_1', 'acc_2', 'acc_3']],
      storedAs: 'task.settings.accountIds',
    },
    {
      name: 'delayMin',
      block: 'timings',
      title: 'Мин. пауза',
      type: 'number',
      default: 30,
      min: 5,
      unit: 'с',
      purpose: 'Нижняя граница паузы между аккаунтами.',
      constraints: [
        'значение ниже 5 секунд поднимается до 5',
        'у этого модуля СВОИ поля пауз — общей структуры delays здесь нет',
      ],
      examples: [30, 60],
      seeAlso: ['delayMax'],
      storedAs: 'task.settings.delayMin',
    },
    {
      name: 'delayMax',
      block: 'timings',
      title: 'Макс. пауза',
      type: 'number',
      default: 120,
      min: 5,
      unit: 'с',
      purpose: 'Верхняя граница паузы между аккаунтами.',
      constraints: ['если меньше delayMin, поднимается до него — задача не упадёт, но разброса не будет'],
      examples: [120, 300],
      seeAlso: ['delayMin'],
      storedAs: 'task.settings.delayMax',
    },
  ],

  presets: [],

  examples: [
    {
      title: 'Разблокировать несколько аккаунтов',
      when: 'после жёсткой кампании часть аккаунтов ушла в спамблок',
      input: { accountIds: ['acc_1', 'acc_2', 'acc_3'], delayMin: 60, delayMax: 300 },
    },
  ],

  contract: {
    sources: [{ file: 'server/spamUnblock.js', symbols: ['runSpamUnblock'] }],
    ignore: ['initiator', 'userId'],
  },
}
