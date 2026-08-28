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
  // ИИ не участвует: генерации нет, токены модели не тратятся (см. costModel).
  usesAi: false,
  title: 'Autoposting',
  platform: 'telegram',
  tags: ['posting', 'autoposting', 'publish', 'own channels', 'content', 'scheduling'],

  whoAmI: {
    summary: 'Publishes the same post to the listed channels on behalf of managed accounts.',
    does: [
      'goes through the list of channels and publishes to each given text',
      'can attach media or links to post',
      'keeps a history of publications for each channel',
    ],
    doesNot: [
      'doesn’t write to other people’s channels: you need an administrator account with publishing rights',
      'does not comment or respond - these are other modules',
      'does not generate text for each channel: there is only one post for the entire task',
      'has no limits of “do N actions” and no time work - the volume of the task is the number of channels',
    ],
    requires: [
      'at least one account with a working proxy, which is the ADMINISTRATOR of the target channels',
      'at least one channel',
      'non-empty post text',
    ],
    risks:
      'The publication is visible to all subscribers of the channel and is not automatically recalled - there is an error in the text '
      + 'goes on air. Without administrator rights, Telegram will return CHAT_ADMIN_REQUIRED.',
    costModel: 'Charged per action according to the price list of the module. AI tokens are not consumed - the text is set manually.',
  },

  blocks: [
    {
      id: 'accounts',
      title: 'Select accounts',
      purpose: 'On whose behalf are we publishing?',
      howItWorks:
        'Accounts are moved in a circle across channels. The account must be a channel admin with the right '
        + 'publication, otherwise the publication in this channel will not go through.',
      api: { method: 'POST', path: '/api/modules/autoposting/tasks', fills: ['accountIds'] },
      params: ['accountIds'],
    },
    {
      id: 'targets',
      title: 'Channels',
      purpose: 'Where do we publish?',
      howItWorks:
        'The progress of a task is calculated based on the number of channels: how many channels, so many publications. '
        + 'Targets from the blacklist are eliminated.',
      api: { method: 'POST', path: '/api/modules/autoposting/tasks', fills: ['channels'] },
      params: ['channels'],
    },
    {
      id: 'content',
      title: 'Post content',
      purpose: 'What we publish.',
      howItWorks: 'There is only one text for the entire task. You can attach media or links to it.',
      api: { method: 'POST', path: '/api/modules/autoposting/tasks', fills: ['message', 'mediaUrls'] },
      params: ['message', 'mediaUrls'],
    },
    {
      id: 'protection',
      title: 'Account protection',
      purpose: 'Multiplier of delays between publications.',
      howItWorks: 'The protection level and tempo preset are multiplied and scale the pause between channels.',
      api: { method: 'POST', path: '/api/modules/autoposting/tasks', fills: ['protectionLevel', 'delayPreset'] },
      params: ['protectionLevel', 'delayPreset'],
    },
    {
      id: 'timings',
      title: 'Timings and delays',
      purpose: 'Pauses between publications and FloodWait behavior.',
      howItWorks: 'Pause = random from the range × multipliers, but not less than 5 seconds.',
      api: { method: 'POST', path: '/api/modules/autoposting/tasks', fills: ['delays'] },
      params: ['delays'],
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
      purpose: 'Account IDs on whose behalf posts are published.',
      constraints: [
        'empty list → task ends with the warning “No accounts selected”',
        'the account must be a channel administrator with publishing rights',
      ],
      examples: [['acc_1']],
      storedAs: 'task.settings.accountIds',
    },
    {
      name: 'channels',
      block: 'targets',
      title: 'Channels',
      type: 'array',
      items: 'string',
      required: true,
      minItems: 1,
      aliases: ['targets'],
      purpose: 'Channels in which the post is published.',
      constraints: [
        'format: @username or https://t.me/<username>',
        'if there are zero correct channels, the task ends immediately with a warning',
        'the volume of the task is equal to the number of channels: one channel - one publication',
      ],
      examples: [['@my_channel'], ['@my_channel', '@my_second_channel']],
      storedAs: 'task.settings.channels (server accepts targets)',
    },
    {
      name: 'message',
      block: 'content',
      title: 'Post text',
      type: 'string',
      required: true,
      aliases: ['promptText'],
      purpose: 'What exactly is published.',
      constraints: [
        'one text for the entire task - it does not adapt to each channel',
        'the server accepts both promptText: they are the same field',
        'empty text → there is nothing to publish, the task will end without action',
      ],
      examples: ['Today at 19:00 - broadcast about automation. The link is in the pin.'],
      storedAs: 'task.settings.message (server accepts promptText)',
    },
    {
      name: 'mediaUrls',
      block: 'content',
      title: 'Media and links',
      type: 'array',
      items: 'string',
      default: [],
      purpose: 'What to attach to the post besides the text.',
      constraints: ['Only http/https links are accepted, the rest are discarded'],
      examples: [['https://example.com/banner.jpg']],
      storedAs: 'task.settings.mediaUrls',
    },
    {
      name: 'protectionLevel',
      block: 'protection',
      title: 'Protection level',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Conservative', means: 'Delays ×1.8 between publications.' },
        { value: 1, label: 'Balanced', means: 'Delays ×1.' },
        { value: 2, label: 'Aggressive', means: 'Delays ×0.75.' },
      ],
      purpose: 'How fast are publications on the list of channels?',
      constraints: ['ATTENTION: the numbering is REVERSED delayPreset - here 0 is the safest'],
      seeAlso: ['delayPreset'],
      storedAs: 'task.settings.protectionLevel',
    },
    {
      name: 'delayPreset',
      block: 'protection',
      title: 'Tempo preset',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Aggressive', means: 'Pauses ×0.6.' },
        { value: 1, label: 'Balanced', means: 'Basic delays ×1.' },
        { value: 2, label: 'Conservative', means: 'Pauses ×1.8.' },
        { value: 3, label: 'Custom', means: 'No scaling.' },
      ],
      purpose: 'Scales pauses between publications.',
      constraints: ['ATTENTION: the numbering is REVERSED protectionLevel - here 0 is the fastest'],
      seeAlso: ['protectionLevel', 'delays'],
      storedAs: 'task.settings.delayPreset',
    },
    {
      name: 'delays',
      block: 'timings',
      title: 'Delays',
      type: 'object',
      purpose: 'The base intervals to which the multipliers are applied.',
      properties: [
        {
          name: 'action',
          title: 'Pause between posts',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          default: [30, 120],
          unit: 's',
          purpose: 'Range [min, max] of pause before next publication.',
          constraints: ['the actual pause is random from the range × multipliers, but not less than 5 seconds'],
        },
        {
          name: 'floodWait',
          title: 'Stock after FloodWait',
          type: 'number',
          default: 120,
          min: 0,
          unit: 's',
          purpose: 'How long to wait beyond the duration returned by Telegram.',
        },
        {
          name: 'floodQuarantine',
          title: 'FloodWait before quarantine',
          type: 'integer',
          default: 3,
          min: 1,
          purpose: 'How many consecutive FloodWaits the account can withstand before quarantine.',
        },
      ],
      storedAs: 'task.settings.delays',
    },
  ],

  presets: [
    {
      param: 'delayPreset',
      title: 'Tempo preset',
      source: 'server/lib/protection.js — PRESET_MUL',
      values: [
        { value: 0, label: 'Aggressive', multiplier: 0.6, means: 'Pauses ×0.6.', useWhen: 'many channels, need it quickly' },
        { value: 1, label: 'Balanced', multiplier: 1, means: 'Basic delays.', useWhen: 'regular publication' },
        { value: 2, label: 'Conservative', multiplier: 1.8, means: 'Pauses ×1.8.', useWhen: 'new admin accounts' },
        { value: 3, label: 'Custom', multiplier: 1, means: 'No scaling.', useWhen: 'manual setting' },
      ],
    },
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
  ],

  examples: [
    {
      title: 'Announcement to your channels',
      when: 'one text must be sent across the network of your own channels',
      input: {
        accountIds: ['acc_admin'],
        channels: ['@my_channel', '@my_second_channel'],
        message: 'Today at 19:00 - broadcast about automation. The link is in the pin.',
        protectionLevel: 1,
        delayPreset: 1,
      },
    },
    {
      title: 'Post with a picture',
      when: 'need a publication with media',
      input: {
        accountIds: ['acc_admin'],
        channels: ['@my_channel'],
        message: 'New analysis - follow the link below.',
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
