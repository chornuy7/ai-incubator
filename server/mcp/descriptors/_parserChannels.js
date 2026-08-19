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
    tags: ['parsing', 'parsing', 'search', 'search', cfg.what, 'channel database'],

    whoAmI: {
      summary: `Looking for${cfg.whatMany}in Telegram using keywords and collects them into a database with filters based on audience size.`,
      does: [
        'builds search queries from keywords and endings',
        `searches through requests from different accounts and collects those found${cfg.whatMany}`,
        'filters by the number of participants and the presence of comments',
        'removes duplicates and previously collected',
        'can intersect (AND):leave only what was found for ALL keywords',
        'continues from where it stopped - progress on requests is saved',
      ],
      doesNot: [
        'does not publish or write anything - this is pure data collection',
        'does not gather participants:There are parsers for users, messages and comments for this',
        'does not contact AI and does not spend tokens',
      ],
      requires: ['at least one account with a working proxy', 'at least one keyword'],
      risks:
        'Telegram limits search queries:too frequent requests give FloodWait. '
        + 'Delays between requests are small by default, but not zero - do not reset them.',
      costModel: 'Charged per action according to the price list of the module.AI tokens are not consumed.',
    },

    blocks: [
      {
        id: 'accounts',
        title: 'Select accounts',
        purpose: 'Which accounts are searched?.',
        howItWorks: 'Requests are distributed between accounts in a circle - this way search limits are spent evenly.',
        api: { method: 'POST', path, fills: ['accountIds'] },
        params: ['accountIds'],
      },
      {
        id: 'query',
        title: 'Search query',
        purpose: 'What words to search for.',
        howItWorks:
          'A separate query is collected from each keyword and each ending.Keywords'
          + 'ten and ending with five is fifty requests, and they are executed sequentially.',
        api: { method: 'POST', path, fills: ['keywords', 'endings', 'intersect'] },
        params: ['keywords', 'endings', 'intersect'],
      },
      {
        id: 'filters',
        title: 'Result filters',
        purpose: 'What to keep from what you find.',
        howItWorks:
          'Filters are applied to each result found during the search, except for intersection -'
          + 'it is considered AT THE END when all requests have been completed.',
        api: { method: 'POST', path, fills: ['minMembers', 'maxMembers', 'commentFilter', 'alreadyParsed'] },
        params: ['minMembers', 'maxMembers', 'commentFilter', 'alreadyParsed'],
      },
      {
        id: 'limits',
        title: 'Limits',
        purpose: 'How many results to collect?.',
        howItWorks: 'When the limit is reached, the search stops, even if there are still queries left..',
        api: { method: 'POST', path, fills: ['resultLimit'] },
        params: ['resultLimit'],
      },
      {
        id: 'timings',
        title: 'Timings and delays',
        purpose: 'Pauses between search queries.',
        howItWorks:
          'Two different pauses:between search queries and between processing individual results. '
          + 'Both are multiplied by defense and tempo preset.',
        api: { method: 'POST', path, fills: ['delays', 'protectionLevel', 'delayPreset'] },
        params: ['delays', 'protectionLevel', 'delayPreset'],
      },
    ],

    params: [
      {
        name: 'accountIds',
        block: 'accounts',
        title: 'Accounts',
        type: 'array',
        items: 'string',
        required: true,
        minItems: 1,
        purpose: 'Account IDs used to search.',
        constraints: ['empty list → task ends with a warning'],
        examples: [['acc_1'], ['acc_1', 'acc_2']],
        storedAs: 'task.settings.accountIds',
      },
      {
        name: 'keywords',
        block: 'query',
        title: 'Keywords',
        type: 'array',
        items: 'string',
        required: true,
        minItems: 1,
        purpose: 'Search words.',
        constraints: [
          'empty lines are discarded;if there are no valid words left, the task ends',
          'each word gives a separate search query',
        ],
        examples: [['crypt'], ['crypt', 'trading']],
        seeAlso: ['endings', 'intersect'],
        storedAs: 'task.settings.keywords',
      },
      {
        name: 'endings',
        block: 'query',
        title: 'Endings',
        type: 'array',
        items: 'string',
        default: [],
        purpose: 'Keyword additions - expand search coverage.',
        constraints: ['each combination of word and ending gives another query:words × query endings'],
        examples: [['chat', 'news', 'ua']],
        seeAlso: ['keywords'],
        storedAs: 'task.settings.endings',
      },
      {
        name: 'intersect',
        block: 'query',
        title: 'Intersection (AND)',
        type: 'boolean',
        default: false,
        purpose: `Leave only those${cfg.whatMany}that were found for ALL keywords at once.`,
        constraints: [
          'only works with two or more keywords',
          'applied AT THE END, when all requests have been completed:before this, the results show a union',
          'sharply reduces output - this is expected',
        ],
        seeAlso: ['keywords'],
        storedAs: 'task.settings.intersect',
      },
      {
        name: 'minMembers',
        block: 'filters',
        title: 'Min.participants',
        type: 'integer',
        default: 0,
        min: 0,
        purpose: 'Discard results that are too small.',
        constraints: ['0 = filter disabled'],
        examples: [0, 500, 5000],
        seeAlso: ['maxMembers'],
        storedAs: 'task.settings.minMembers',
      },
      {
        name: 'maxMembers',
        block: 'filters',
        title: 'Max.participants',
        type: 'integer',
        default: 0,
        min: 0,
        purpose: 'Discard results that are too large.',
        constraints: ['0 = filter disabled'],
        examples: [0, 100000],
        seeAlso: ['minMembers'],
        storedAs: 'task.settings.maxMembers',
      },
      {
        name: 'commentFilter',
        block: 'filters',
        title: 'Comments',
        type: 'integer',
        default: 0,
        enum: [
          { value: 0, label: 'Any', means: 'Comments are not taken into account during selection.' },
          { value: 1, label: 'Only with open', means: 'Leave those where comments are available - you can work there with neurocommenting.' },
          { value: 2, label: 'Only with closed', means: 'Leave those where comments are disabled.' },
        ],
        purpose: 'Selection if possible comment.',
        constraints: ['for neurocommenting the value 1 makes sense:without open comments the module will not work there'],
        storedAs: 'task.settings.commentFilter',
      },
      {
        name: 'alreadyParsed',
        block: 'filters',
        title: 'Exclude what has already been collected',
        type: 'array',
        items: 'string',
        default: [],
        purpose: 'List of usernames that do not need to be collected again.',
        constraints: ['case-insensitive comparison', 'Usually the results of past tasks are transferred here'],
        storedAs: 'task.settings.alreadyParsed',
      },
      {
        name: 'resultLimit',
        block: 'limits',
        title: 'How much to collect',
        type: 'integer',
        default: 0,
        min: 0,
        aliases: ['limit'],
        purpose: 'Upper limit on the number of results collected.',
        constraints: [
          '0 = no limit:complete all requests',
          'the server accepts and limit are the same field',
        ],
        examples: [0, 100, 1000],
        storedAs: 'task.settings.resultLimit (server accepts and limit)',
      },
      {
        name: 'protectionLevel',
        block: 'timings',
        title: 'Protection level',
        type: 'integer',
        default: 1,
        enum: [
          { value: 0, label: 'Conservative', means: 'Delays ×1.8 - slower, but the search will not run into limits.' },
          { value: 1, label: 'Balanced', means: 'Delays ×1.' },
          { value: 2, label: 'Aggressive', means: 'Delays ×0.75 – higher chance of FloodWait on search.' },
        ],
        purpose: 'Pause multiplier between requests.',
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
        seeAlso: ['protectionLevel', 'delays'],
        storedAs: 'task.settings.delayPreset',
      },
      {
        name: 'delays',
        block: 'timings',
        title: 'Delays',
        type: 'object',
        purpose: 'Basic Search Intervals.',
        constraints: [
          'the parser has its own delay names - `request` and `channel`, and not `action`, as in combat modules',
        ],
        properties: [
          {
            name: 'request',
            title: 'Pause between search queries',
            type: 'array',
            items: 'number',
            minItems: 2,
            maxItems: 2,
            default: [2, 2],
            unit: 'With',
            purpose: 'Range [min, max] pause between search queries.',
            constraints: ['if one number is given, the second is taken equal to it'],
          },
          {
            name: 'channel',
            title: 'Pause between results',
            type: 'array',
            items: 'number',
            minItems: 2,
            maxItems: 2,
            default: [1, 1],
            unit: 'With',
            purpose: 'Range [min, max] of pause between processing of found results.',
          },
        ],
        storedAs: 'task.settings.delays',
      },
    ],

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
          { value: 0, label: 'Aggressive', multiplier: 0.6, means: 'Pauses ×0.6.', useWhen: 'need volume quickly' },
          { value: 1, label: 'Balanced', multiplier: 1, means: 'Basic pauses.', useWhen: 'normal search' },
          { value: 2, label: 'Conservative', multiplier: 1.8, means: 'Pauses ×1.8.', useWhen: 'large list of keys' },
          { value: 3, label: 'Custom', multiplier: 1, means: 'No scaling.', useWhen: 'manual setting' },
        ],
      },
    ],

    examples: [
      {
        title: 'Quick collection one word at a time',
        when: 'you need to understand what is on the topic in general',
        input: { accountIds: ['acc_1'], keywords: ['crypt'], resultLimit: 100, protectionLevel: 1 },
      },
      {
        title: 'Narrow selection for neurocommenting',
        when: `only needed${cfg.whatMany}with open comments and live audience`,
        input: {
          accountIds: ['acc_1', 'acc_2'],
          keywords: ['crypt', 'trading'],
          endings: ['chat', 'news'],
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
