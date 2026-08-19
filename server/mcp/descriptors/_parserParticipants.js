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
      title: 'Select accounts',
      purpose: 'Which accounts do we collect?.',
      howItWorks:
        'By default, sources are processed one at a time by one account at a time..Parallel'
        + 'the mode speeds up work, but loads Telegram more - FloodWait arrives more often on it.',
      api: { method: 'POST', path, fills: ['accountIds', 'parallelAccounts'] },
      params: ['accountIds', 'parallelAccounts'],
    },
    {
      id: 'targets',
      title: 'Sources',
      purpose: 'Where do we gather people from?.',
      howItWorks:
        'The account joins the source if it is not already a member of it.Separate pause before introduction'
        + 'and does not fall below 60 seconds - Telegram considers introductions more harsh than other actions.',
      api: { method: 'POST', path, fills: ['channels'] },
      params: ['channels'],
    },
    {
      id: 'filters',
      title: 'People filters',
      purpose: 'Who to leave in the search results.',
      howItWorks: 'Filters are applied to each person found as the collection progresses.',
      api: { method: 'POST', path, fills: ['filters', 'keywords'] },
      params: ['filters', 'keywords'],
    },
    {
      id: 'limits',
      title: 'Limits',
      purpose: 'How much to collect and how deep to dig.',
      howItWorks: 'Once the limit is reached, collection stops, even if there are still sources left..',
      api: { method: 'POST', path, fills: ['limits', 'resultLimit'] },
      params: ['limits', 'resultLimit'],
    },
    {
      id: 'timings',
      title: 'Timings and delays',
      purpose: 'Pauses between sources and elements.',
      howItWorks:
        'Three different pauses:between sources, between individual elements and before the introduction. '
        + 'The first two are given by numbers in seconds, the third by a range.',
      api: { method: 'POST', path, fills: ['delayChat', 'delayItem', 'delays', 'protectionLevel', 'delayPreset'] },
      params: ['delayChat', 'delayItem', 'delays', 'protectionLevel', 'delayPreset'],
    },
  ]

  if (intersection) {
    blocks.splice(3, 0, {
      id: 'intersection',
      title: 'Crossing Audiences',
      purpose: 'Leave only those who are members of several sources at once.',
      howItWorks:
        'A person appears in the search results only if he appears in at least a given number of sources.. '
        + 'This is a way to find a core audience instead of random participants.',
      api: { method: 'POST', path, fills: ['intersectionMode', 'intersectionMin'] },
      params: ['intersectionMode', 'intersectionMin'],
    })
  }

  const params = [
    {
      name: 'accountIds',
      block: 'accounts',
      title: 'Accounts',
      type: 'array',
      items: 'string',
      required: true,
      minItems: 1,
      purpose: 'Account IDs used to collect.',
      constraints: ['empty list → task ends with a warning'],
      examples: [['acc_1'], ['acc_1', 'acc_2']],
      storedAs: 'task.settings.accountIds',
    },
    {
      name: 'parallelAccounts',
      block: 'accounts',
      title: 'Parallel to all accounts',
      type: 'boolean',
      default: false,
      purpose: 'Process sources simultaneously by different accounts.',
      constraints: [
        'speeds up collection, but significantly increases the risk of FloodWait',
        'It makes sense to include only when there are many sources and little time',
      ],
      storedAs: 'task.settings.parallelAccounts',
    },
    {
      name: 'channels',
      block: 'targets',
      title: 'Sources',
      type: 'array',
      items: 'string',
      required: true,
      minItems: 1,
      aliases: ['targets'],
      purpose: 'Groups and channels from which people gather.',
      constraints: [
        'format:@username or https://t.me/<username>',
        'if there are zero correct sources, the task is completed immediately',
        'the account joins the source if it is not already a member of it',
      ],
      examples: [['@some_chat'], ['@chat_one', '@chat_two']],
      storedAs: 'task.settings.channels (server accepts and targets)',
    },
    {
      name: 'keywords',
      block: 'filters',
      title: 'Keywords',
      type: 'array',
      items: 'string',
      default: [],
      purpose: 'Words by which people or their messages are selected.',
      constraints: [
        'case-insensitive comparison',
        'empty list = no word filter applied',
      ],
      examples: [["I'll buy", "needed"]],
      storedAs: 'task.settings.keywords',
    },
    {
      name: 'filters',
      block: 'filters',
      title: 'People filters',
      type: 'object',
      purpose: 'Who to include in search results and who to discard.',
      properties: [
        { name: 'skipBots', title: 'Skip bots', type: 'boolean', default: true, purpose: "Don't collect bots - working with them is pointless." },
        { name: 'skipDeleted', title: 'Skip deleted ones', type: 'boolean', default: true, purpose: 'Do not collect deleted accounts.' },
        { name: 'skipScam', title: 'Skip those flagged as scam', type: 'boolean', default: true, purpose: 'Do not collect accounts with a fraud flag from Telegram.' },
        { name: 'onlyUsername', title: 'Only with username', type: 'boolean', default: false, purpose: 'Leave those you can write to @username.' },
        { name: 'onlyPhoto', title: 'Only with an avatar', type: 'boolean', default: false, purpose: 'Indirect sign of a live account.' },
        { name: 'onlyPremium', title: 'Premium only', type: 'boolean', default: false, purpose: 'Leave a paying audience.' },
        { name: 'onlyAdmins', title: 'Administrators only', type: 'boolean', default: false, purpose: 'Gather source owners and moderators.' },
        { name: 'includeForwarded', title: 'Take into account forwarded', type: 'boolean', default: false, purpose: 'Do not discard the authors of forwarded messages.' },
        { name: 'keepText', title: 'Save message text', type: 'boolean', default: false, purpose: 'Put in the search results the text that got the person on the list.' },
      ],
      storedAs: 'task.settings.filters',
    },
    {
      name: 'limits',
      block: 'limits',
      title: 'Collection depth',
      type: 'object',
      purpose: 'How deep to dig in each source.',
      constraints: ['some fields make sense only for certain parsers - see.description of each'],
      properties: [
        { name: 'participants', title: 'Participants per source', type: 'integer', min: 0, purpose: 'How many participants can you take from one group?.' },
        { name: 'posts', title: 'Posts per source', type: 'integer', min: 0, purpose: 'How many recent posts to view (for comment parser).' },
        { name: 'commentsPerPost', title: 'Comments per post', type: 'integer', min: 0, purpose: 'How many comments should I take under one post?.' },
        { name: 'messages', title: 'Messages per source', type: 'integer', min: 0, purpose: 'How many messages to view (for parser by message).' },
        { name: 'days', title: 'Depth in days', type: 'integer', min: 0, purpose: 'Do not view messages older than the specified number of days.' },
        { name: 'minCommentLen', title: 'Min.message length', type: 'integer', min: 0, purpose: 'Discard monosyllabic remarks like “+” and “thank you”.' },
      ],
      storedAs: 'task.settings.limits',
    },
    {
      name: 'resultLimit',
      block: 'limits',
      title: 'Total to collect',
      type: 'integer',
      default: 0,
      min: 0,
      aliases: ['limit'],
      purpose: 'Upper limit on the number of people gathered per task.',
      constraints: ['0 = no limit', 'the server accepts and limit are the same field'],
      examples: [0, 500, 5000],
      storedAs: 'task.settings.resultLimit (server accepts and limit)',
    },
    {
      name: 'delayChat',
      block: 'timings',
      title: 'Pause between sources',
      type: 'number',
      default: 15,
      min: 0,
      unit: 'With',
      purpose: 'How long to wait before moving on to the next source.',
      constraints: ['one number, not a range - unlike combat modules'],
      examples: [15, 60],
      storedAs: 'task.settings.delayChat',
    },
    {
      name: 'delayItem',
      block: 'timings',
      title: 'Pause between elements',
      type: 'number',
      default: 0.5,
      min: 0,
      unit: 'With',
      purpose: 'How long to wait between processing individual people or messages.',
      constraints: ['Fractional values ​​are allowed', 'no need to reset:it is frequent calls that give FloodWait'],
      examples: [0.5, 2],
      storedAs: 'task.settings.delayItem',
    },
    {
      name: 'delays',
      block: 'timings',
      title: 'Entry delays',
      type: 'object',
      purpose: 'Pause before entering the source.',
      properties: [
        {
          name: 'join',
          title: 'Pause before introduction',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          default: [90, 240],
          unit: 'With',
          purpose: 'Range [min, max] of pause before joining a group or channel.',
          constraints: ['hard floor 60 seconds:You can’t speed up intros with a preset'],
        },
      ],
      storedAs: 'task.settings.delays',
    },
    {
      name: 'protectionLevel',
      block: 'timings',
      title: 'Protection level',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Conservative', means: 'Delays ×1.8 - slow, but without FloodWait.' },
        { value: 1, label: 'Balanced', means: 'Delays ×1.' },
        { value: 2, label: 'Aggressive', means: 'Delays ×0.75 - significantly higher risk of FloodWait during the gathering.' },
      ],
      purpose: 'Pause multiplier.',
      constraints: ['ATTENTION:numbering is REVERSED delayPreset - here 0 is the safest'],
      seeAlso: ['delayPreset'],
      storedAs: 'task.settings.protectionLevel',
    },
    {
      name: 'delayPreset',
      block: 'timings',
      title: 'Tempo preset',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Aggressive', means: 'Pauses ×0.6.' },
        { value: 1, label: 'Balanced', means: 'Basic delays ×1.' },
        { value: 2, label: 'Conservative', means: 'Pauses ×1.8.' },
        { value: 3, label: 'Custom', means: 'No scaling.' },
      ],
      purpose: 'Another pause multiplier.',
      constraints: ['ATTENTION:numbering is REVERSE protectionLevel - here 0 is the fastest'],
      seeAlso: ['protectionLevel'],
      storedAs: 'task.settings.delayPreset',
    },
  ]

  if (intersection) {
    params.push(
      {
        name: 'intersectionMode',
        block: 'intersection',
        title: 'Intersection mode',
        type: 'boolean',
        default: false,
        purpose: 'Leave only those who are members of several sources at once.',
        constraints: [
          'only works with two or more sources',
          'available ONLY from the user parser:For parsers, the field is ignored for messages and comments',
        ],
        seeAlso: ['intersectionMin', 'channels'],
        storedAs: 'task.settings.intersectionMode',
      },
      {
        name: 'intersectionMin',
        block: 'intersection',
        title: 'Minimum sources',
        type: 'integer',
        default: 0,
        min: 0,
        effectiveWhen: { intersectionMode: true },
        purpose: 'How many sources must a person be a member of to be included in the search results?.',
        constraints: [
          '0 or not specified = in ALL sources at once',
          'only works when intersectionMode = true',
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
    tags: ['parsing', 'parsing', 'audience', 'People', 'base', ...cfg.tags],

    whoAmI: {
      summary: cfg.summary,
      does: cfg.does,
      doesNot: [
        'does not publish or write anything - this is pure data collection',
        'does not look for sources himself:you specify the list, and channel and group parsers help you find it',
        'does not contact AI and does not spend tokens',
      ],
      requires: ['at least one account with a working proxy', 'at least one source'],
      risks:
        'Gathering participants is the operation in which FloodWait most often arrives:account enters'
        + 'to sources and reads a lot.Pauses and parallelism affect risk the most.',
      costModel: 'Charged per action according to the price list of the module.AI tokens are not consumed.',
    },

    blocks,
    params,

    presets: [
      {
        param: 'protectionLevel',
        title: 'Protection level',
        source: 'server/lib/protection.js — LEVEL_MUL',
        values: [
          { value: 0, label: 'Conservative', multiplier: 1.8, means: 'Delays ×1.8.' },
          { value: 1, label: 'Balanced', multiplier: 1, means: 'Delays ×1.' },
          { value: 2, label: 'Aggressive', multiplier: 0.75, means: 'Delays ×0.75.' },
        ],
      },
      {
        param: 'delayPreset',
        title: 'Tempo preset',
        source: 'server/lib/protection.js — PRESET_MUL',
        values: [
          { value: 0, label: 'Aggressive', multiplier: 0.6, means: 'Pauses ×0.6.', useWhen: 'few sources, volume needed' },
          { value: 1, label: 'Balanced', multiplier: 1, means: 'Basic pauses.', useWhen: 'regular fee' },
          { value: 2, label: 'Conservative', multiplier: 1.8, means: 'Pauses ×1.8.', useWhen: 'many sources in a row' },
          { value: 3, label: 'Custom', multiplier: 1, means: 'No scaling.', useWhen: 'manual setting' },
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
