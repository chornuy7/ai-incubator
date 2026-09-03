/**
 * MCP-дескриптор модуля «Нейрочаттинг».
 *
 * Формат — docs/mcp/MCP-SPEC.md, правила правки — docs/mcp/MCP-CONTRIBUTING.md.
 * Список полей сверяется с кодом contract-тестом: то, что читает воркер, обязано быть здесь.
 *
 * Модуль похож на нейрокомментинг, но отличий больше, чем кажется, и оркестратор на них
 * спотыкается: цель — ГРУППЫ, а не каналы; окна постов нет (всегда последние 15 сообщений);
 * задержка называется `delays.action`, а не `delays.comment`; фильтров по словам и семантике
 * нет вовсе — отбор идёт только вероятностью.
 */

/** @type {import('./index.js').ModuleDescriptor} */
export default {
  key: 'neuro-chatting',
  version: 1,
  // Генерирует текст через ИИ — на этих модулях расход на ИИ реален.
  usesAi: true,
  title: 'Neurochatting',
  platform: 'telegram',
  tags: ['chats', 'groups', 'group chat', 'ai', 'dialogue', 'conversation', 'engagement'],

  whoAmI: {
    summary: 'Replies with AI messages to participants’ remarks in Telegram groups on behalf of managed accounts.',
    does: [
      'joins the group if the account is not already a member',
      'takes a random message from the last 15 in the chat',
      'generates a response from the model taking into account the goal, knowledge base and agent',
      'maintains a human pace - a pause for reading and time for typing along the length of the text',
      'replies with a replay to the selected message and saves both sides of the correspondence',
    ],
    doesNot: [
      'does not write comments under channel posts - this is “Neurocommenting”',
      'does not write in private messages - this is “Mailing” and “Neurodialogues”',
      'does not select messages by keywords and meaning: the module does not have content filters, '
      + 'selection occurs only by probability',
    ],
    requires: [
      'at least one account in a working status with a working proxy',
      'at least one target group',
    ],
    risks:
      'Real messages in live chats. The answer is off topic or too frequent messages → complaints, '
      + 'FloodWait, spam block. Messages in groups are counted against the same daily limit as comments.',
    costModel:
      'Charged per action according to the price list of the module; text generation is included in the price of the action.'
      + 'AI generation runs on model access provided by the platform: the caller supplies no key, token or provider credential, and there is no field for one — it works out of the box.',
  },

  blocks: [
    {
      id: 'accounts',
      title: 'Select accounts',
      purpose: 'Which managed accounts perform the task.',
      howItWorks:
        'Accounts are moving in a circle. Busy with another task is not displayed (one account = one task); '
        + 'problematic statuses, fatigue, routine and daily limit are skipped and recorded in the log.',
      api: { method: 'POST', path: '/api/modules/neuro-chatting/tasks', fills: ['accountIds'] },
      params: ['accountIds'],
    },
    {
      id: 'targets',
      title: 'Groups',
      purpose: 'In which groups the module responds to participants.',
      howItWorks:
        'At each iteration, a group is selected randomly. Before the first action, the account enters into it. '
        + 'The last 15 messages are read from the chat, and one is taken at random - there is no depth setting.',
      api: { method: 'POST', path: '/api/modules/neuro-chatting/tasks', fills: ['channels'] },
      params: ['channels'],
    },
    {
      id: 'modes',
      title: 'Operating mode',
      purpose: 'Is the task limited by the number of messages or time?',
      howItWorks: 'By quantity - until the goal is achieved; by time - until the duration expires.',
      api: { method: 'POST', path: '/api/modules/neuro-chatting/tasks', fills: ['workMode', 'durationMinutes'] },
      params: ['workMode', 'durationMinutes'],
    },
    {
      id: 'filters',
      title: 'Selection of messages',
      purpose: 'How often the module enters into conversation.',
      howItWorks:
        'The only selection is probability: the message is selected randomly, and with a given probability '
        + 'the answer is written. The module has no keywords, no stop words, no semantics.',
      api: { method: 'POST', path: '/api/modules/neuro-chatting/tasks', fills: ['probability'] },
      params: ['probability'],
    },
    {
      id: 'limits',
      title: 'Limits',
      purpose: 'How many messages to send in total and how many with one account.',
      howItWorks:
        'The actual target is a random number from [min, max], determined by the task ID: '
        + 'identical round numbers indicate automation.',
      api: { method: 'POST', path: '/api/modules/neuro-chatting/tasks', fills: ['maxActions', 'minActions', 'maxPerAccount', 'minPerAccount'] },
      params: ['maxActions', 'minActions', 'maxPerAccount', 'minPerAccount'],
    },
    {
      id: 'prompts',
      title: 'Prompts and generation',
      purpose: 'What tone is the answer written in?',
      howItWorks:
        'Priority: promptText → promptOverrides[promptIndex] → built-in card promptIndex. '
        + 'A global system prompt, a target context with a knowledge base, and an agent context are added on top. '
        + 'The last 50 texts sent are remembered so that different accounts do not write the same thing.',
      api: { method: 'POST', path: '/api/modules/neuro-chatting/tasks', fills: ['promptIndex', 'promptText', 'promptOverrides'] },
      params: ['promptIndex', 'promptText', 'promptOverrides', 'typeWeights'],
    },
    {
      id: 'protection',
      title: 'Account protection',
      purpose: 'Delay multiplier and action probability ceiling.',
      howItWorks: 'The protection level multiplies delays and limits the probability from above.',
      api: { method: 'POST', path: '/api/modules/neuro-chatting/tasks', fills: ['aiProtection', 'protectionLevel'] },
      params: ['aiProtection', 'protectionLevel'],
    },
    {
      id: 'timings',
      title: 'Timings and delays',
      purpose: 'Pauses between actions and behavior during FloodWait.',
      howItWorks:
        'On top of the specified delays, the module ALWAYS maintains a human pace: a pause to read the original '
        + 'messages and the time to type a response according to its length. Instant response and “100 words in half a second” - '
        + 'this is how Telegram recognizes the bot and bans similar accounts in waves. This cannot be disabled.',
      api: { method: 'POST', path: '/api/modules/neuro-chatting/tasks', fills: ['delayPreset', 'delays'] },
      params: ['delayPreset', 'delays'],
    },
    {
      id: 'binding',
      title: 'Binding',
      purpose: 'Which goal, campaign, and agent the task belongs to.',
      howItWorks:
        'The target and its knowledge base are mixed into the system prompt; an overdue goal stops one already in progress '
        + 'task. The agent sets the tone, role and prohibitions. The campaign is needed for reporting and billing.',
      api: { method: 'POST', path: '/api/modules/neuro-chatting/tasks', fills: ['goalId', 'campaignId', 'agentId', 'deadline'] },
      params: ['goalId', 'campaignId', 'agentId', 'deadline'],
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
      purpose: 'ID of the managed accounts that are running the task.',
      constraints: ['empty list → refusal “Select at least one account”'],
      examples: [['acc_1'], ['acc_1', 'acc_2']],
      storedAs: 'task.settings.accountIds',
    },
    {
      name: 'channels',
      block: 'targets',
      title: 'Target groups',
      type: 'array',
      items: 'string',
      required: true,
      minItems: 1,
      aliases: ['targets'],
      purpose: 'Groups in which the module responds to participants.',
      constraints: [
        'format: @username or https://t.me/<username>; leading @ is discarded',
        'targets from the blacklist are eliminated before any action is taken',
      ],
      examples: [['@some_chat'], ['https://t.me/some_chat', '@another_chat']],
      storedAs: 'task.settings.channels (server accepts targets)',
    },
    {
      name: 'workMode',
      block: 'modes',
      title: 'Operating mode',
      type: 'integer',
      default: 0,
      enum: [
        { value: 0, label: 'By quantity', means: 'The task continues until the goal for the number of messages is reached.' },
        { value: 1, label: 'By time', means: 'The task continues until durationMinutes expires.' },
      ],
      purpose: 'Is the task limited by the number of actions or time?',
      constraints: ['when workMode = 1 durationMinutes is required: otherwise the task does not have a termination condition'],
      seeAlso: ['durationMinutes', 'maxActions'],
      storedAs: 'task.settings.workMode',
    },
    {
      name: 'durationMinutes',
      block: 'modes',
      title: 'Duration',
      type: 'integer',
      default: 60,
      min: 1,
      unit: 'min',
      requiredWhen: { workMode: 1 },
      effectiveWhen: { workMode: 1 },
      purpose: 'How long does the task run in the “Timed” mode?',
      constraints: [
        'treated as a MAXIMUM: the actual duration is a random value from [min, durationMinutes], '
        + 'where min comes from the protection level (conservative 60, balanced 45, aggressive 30 minutes)',
      ],
      examples: [60, 240],
      seeAlso: ['workMode', 'protectionLevel'],
      storedAs: 'task.settings.durationMinutes',
    },
    {
      name: 'probability',
      block: 'filters',
      title: 'Probability of response',
      type: 'integer',
      default: 30,
      min: 0,
      max: 100,
      unit: '%',
      purpose: 'How likely is it that a response will be written to the selected message?',
      constraints: [
        'with aiProtection = true, the ceiling is reduced by the level of protection: conservative ≤25%, balanced ≤45%, aggressive without limitation',
      ],
      examples: [10, 30, 100],
      seeAlso: ['aiProtection', 'protectionLevel'],
      storedAs: 'task.settings.probability',
    },
    {
      name: 'maxActions',
      block: 'limits',
      title: 'Max. messages',
      type: 'integer',
      default: 100,
      min: 1,
      aliases: ['maxComments'],
      purpose: 'The upper limit on the number of messages for the entire task.',
      constraints: ['must be ≥ minActions, otherwise the launch is rejected (“Minimum is greater than maximum”)'],
      examples: [10, 100],
      seeAlso: ['minActions', 'maxPerAccount'],
      storedAs: 'task.settings.maxActions',
    },
    {
      name: 'minActions',
      block: 'limits',
      title: 'Min. messages',
      type: 'integer',
      default: 0,
      min: 0,
      aliases: ['minComments'],
      purpose: 'The lower bound of the goal of the task. The actual target is a random number from [min, max].',
      constraints: ['must be ≤ maxActions', 'the goal is determined by the task ID'],
      seeAlso: ['maxActions'],
      storedAs: 'task.settings.minActions',
    },
    {
      name: 'maxPerAccount',
      block: 'limits',
      title: 'Max. to account',
      type: 'integer',
      default: 0,
      min: 0,
      purpose: 'Limit messages to one account per task.',
      constraints: [
        '0 = no account restrictions',
        'Regardless of this, the daily limit §6 applies to the account, common to all modules',
      ],
      examples: [0, 10],
      storedAs: 'task.settings.maxPerAccount',
    },
    {
      name: 'minPerAccount',
      block: 'limits',
      title: 'Min. to account',
      type: 'integer',
      default: 0,
      min: 0,
      effectiveWhen: { maxPerAccount: '*' },
      purpose: 'The lower limit of the goal per account.',
      constraints: ['must be ≤ maxPerAccount', 'only works when maxPerAccount > 0'],
      storedAs: 'task.settings.minPerAccount',
    },
    {
      name: 'typeWeights',
      block: 'prompts',
      title: 'Tone distribution, %',
      type: 'array',
      items: 'number',
      default: [],
      purpose: 'Mix message tones in a given proportion so accounts do not all write in the same voice.',
      constraints: [
        'the element index corresponds to promptIndex',
        'if at least one weight is > 0, promptIndex is NOT used — the tone is drawn by weighted lottery for every action',
        'weights are normalised automatically; they do not have to add up to 100',
      ],
      examples: [[50, 0, 0, 30, 20, 0]],
      seeAlso: ['promptIndex'],
      storedAs: 'task.settings.typeWeights',
    },
    {
      name: 'promptIndex',
      block: 'prompts',
      title: 'Response type',
      type: 'integer',
      default: 0,
      enum: [
        { value: 0, label: 'Positive', means: 'Friendly support of the interlocutor.' },
        { value: 1, label: 'Intimate', means: 'Personal, confidential tone.' },
        { value: 2, label: 'Emotional response', means: 'Expressing emotion about a cue.' },
        { value: 3, label: 'Question to the interlocutor', means: 'A clarifying question continues the conversation.' },
        { value: 4, label: 'Brief review', means: 'One or two sentences to the point.' },
        { value: 5, label: 'Analytical approach', means: 'Analysis is essentially an argument.' },
      ],
      supersededBy: ['promptText'],
      purpose: 'Which built-in prompt card is used to generate the response.',
      storedAs: 'task.settings.promptIndex',
    },
    {
      name: 'promptText',
      block: 'prompts',
      title: 'Your system prompt',
      type: 'string',
      default: '',
      purpose: "The model's own instructions instead of the built-in card.",
      constraints: ['a non-empty value overrides promptIndex and promptOverrides'],
      examples: ['Keep your answers short and to the point, without emojis, two sentences maximum.'],
      storedAs: 'task.settings.promptText',
    },
    {
      name: 'promptOverrides',
      block: 'prompts',
      title: 'Overriding cards',
      type: 'array',
      items: 'string',
      default: [],
      supersededBy: ['promptText'],
      purpose: 'Replace the text of specific cards without giving up the selection by index.',
      constraints: ['element index corresponds to promptIndex'],
      storedAs: 'task.settings.promptOverrides',
    },
    {
      name: 'aiProtection',
      block: 'protection',
      title: 'AI protection',
      type: 'boolean',
      default: true,
      purpose: 'Includes the probability ceiling from the protection level.',
      seeAlso: ['protectionLevel', 'probability'],
      storedAs: 'task.settings.aiProtection',
    },
    {
      name: 'protectionLevel',
      block: 'protection',
      title: 'Protection level',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Conservative', means: 'Delays ×1.8, probability ≤25%, minimum duration 60 min.' },
        { value: 1, label: 'Balanced', means: 'Delays ×1, probability ≤45%, minimum duration 45 min.' },
        { value: 2, label: 'Aggressive', means: 'Delays ×0.75, probability unlimited, minimum duration 30 min.' },
      ],
      purpose: 'How carefully the account behaves.',
      constraints: ['ATTENTION: the numbering is REVERSED delayPreset - here 0 is the safest'],
      seeAlso: ['delayPreset', 'probability'],
      storedAs: 'task.settings.protectionLevel',
    },
    {
      name: 'delayPreset',
      block: 'timings',
      title: 'Tempo preset',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Aggressive', means: 'Pauses ×0.6, duration ×0.75. Faster, higher chance of FloodWait.' },
        { value: 1, label: 'Balanced', means: 'Basic delays ×1.' },
        { value: 2, label: 'Conservative', means: 'Pauses ×1.8, duration ×1.5.' },
        { value: 3, label: 'Custom', means: 'Delays are taken as specified, without scaling.' },
      ],
      purpose: 'Scales all task delays.',
      constraints: ['ATTENTION: the numbering is REVERSED protectionLevel - here 0 is the fastest'],
      seeAlso: ['protectionLevel', 'delays'],
      storedAs: 'task.settings.delayPreset',
    },
    {
      name: 'delays',
      block: 'timings',
      title: 'Delays',
      type: 'object',
      purpose: 'The base intervals to which the protection and preset multipliers are applied.',
      constraints: [
        'in this module the pause between actions is called `action` (in neurocommenting - `comment`)',
      ],
      properties: [
        {
          name: 'action',
          title: 'Pause before answering',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          default: [42, 78],
          unit: 's',
          purpose: 'Range [min, max] pause before sending a response.',
          constraints: [
            'the actual pause is random from the range × multipliers, but not less than 5 seconds',
            'human pace is always added on top of it: reading the original message + typing a response',
          ],
        },
        {
          name: 'join',
          title: 'Pause before introduction',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          default: [50, 120],
          unit: 's',
          purpose: 'Pause range [min, max] before joining a group.',
          constraints: ['hard floor 60 seconds: Telegram considers introductions harsher than other actions'],
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
          purpose: 'How many consecutive FloodWaits an account can withstand before being sent to quarantine.',
        },
      ],
      storedAs: 'task.settings.delays',
    },
    {
      name: 'deadline',
      block: 'binding',
      title: 'Deadline',
      type: 'string',
      pattern: '^\d{4}-\d{2}-\d{2}$',
      purpose: 'The date after which work on the task stops.',
      constraints: [
        'format YYYY-MM-DD; deadline includes the entire specified day (expires at the end of the day)',
        'comes from campaign; if not specified, the goal deadline is taken by goalId',
        'stops an ALREADY RUNNING task, not just new starts',
      ],
      examples: ['2026-09-01'],
      seeAlso: ['goalId', 'campaignId'],
      storedAs: 'task.settings.deadline',
    },
    {
      name: 'goalId',
      block: 'binding',
      title: 'Target',
      type: 'string',
      purpose: 'The goal towards which the conversation is being conducted: its text and knowledge base go to the system prompt.',
      constraints: [
        'must exist; get the list - GET /api/v1/goals',
        'an overdue goal stops a task already in progress',
      ],
      seeAlso: ['campaignId'],
      storedAs: 'task.settings.goalId',
    },
    {
      name: 'campaignId',
      block: 'binding',
      title: 'Campaign',
      type: 'string',
      purpose: 'Campaign for reporting and linking token consumption.',
      constraints: ['must exist; get the list - GET /api/v1/campaigns'],
      storedAs: 'task.settings.campaignId',
    },
    {
      name: 'agentId',
      block: 'binding',
      title: 'Agent',
      type: 'string',
      purpose: 'The agent sets the tone, role, prohibitions and manner of communication.',
      constraints: ['without an agent, only the context of the goal remains'],
      storedAs: 'task.settings.agentId',
    },
  ],

  presets: [
    {
      param: 'delayPreset',
      title: 'Tempo preset',
      source: 'server/lib/protection.js — PRESET_MUL',
      values: [
        { value: 0, label: 'Aggressive', multiplier: 0.6, means: 'Pauses ×0.6, duration ×0.75.', useWhen: 'warmed up “expenditure” accounts' },
        { value: 1, label: 'Balanced', multiplier: 1, means: 'Basic delays.', useWhen: 'daily work' },
        { value: 2, label: 'Conservative', multiplier: 1.8, means: 'Pauses ×1.8, duration ×1.5.', useWhen: 'new and expensive accounts' },
        { value: 3, label: 'Custom', multiplier: 1, means: 'No scaling.', useWhen: 'manual setting' },
      ],
    },
    {
      param: 'protectionLevel',
      title: 'Protection level',
      source: 'server/lib/protection.js — LEVEL_MUL + effectiveProbability; server/lib/workModeDuration.js',
      values: [
        { value: 0, label: 'Conservative', multiplier: 1.8, probabilityCap: 25, minDurationMinutes: 60, means: 'Delays ×1.8, probability ≤25%.' },
        { value: 1, label: 'Balanced', multiplier: 1, probabilityCap: 45, minDurationMinutes: 45, means: 'Delays ×1, probability ≤45%.' },
        { value: 2, label: 'Aggressive', multiplier: 0.75, probabilityCap: 100, minDurationMinutes: 30, means: 'Delays ×0.75, unlimited probability.' },
      ],
    },
  ],

  examples: [
    {
      title: 'Careful presence in one chat',
      when: 'checking the account + proxy combination on a live group',
      input: {
        accountIds: ['acc_1'],
        channels: ['@some_chat'],
        maxActions: 3,
        maxPerAccount: 3,
        probability: 100,
        aiProtection: true,
        protectionLevel: 0,
        delayPreset: 2,
      },
    },
    {
      title: 'Working toward goals on multiple accounts',
      when: 'there is a goal and a knowledge base, you need to gain a presence in thematic chats',
      input: {
        accountIds: ['acc_1', 'acc_2', 'acc_3'],
        channels: ['@chat_one', '@chat_two'],
        goalId: 'goal_123',
        agentId: 'agent_1',
        maxActions: 60,
        maxPerAccount: 20,
        probability: 40,
        protectionLevel: 1,
        delayPreset: 1,
      },
    },
  ],

  contract: {
    sources: [
      { file: 'server/modules/workers.js', symbols: ['runNeuroChatting', 'targets', 'goalExpired'] },
      { file: 'server/lib/targets.js', symbols: ['resolveTotalTarget', 'resolvePerAccountTarget'] },
      { file: 'server/lib/accountRunner.js', symbols: ['totalLimitReached', 'perAccountLimitReached', 'handleFlood'] },
      { file: 'server/lib/workModeDuration.js', symbols: ['resolveDurationPeriodMinutes'] },
      { file: 'server/neuroCommenting/commentGenerator.js', symbols: ['resolveSystemPrompt'] },
    ],
    ignore: ['initiator', 'userId'],
  },
}
