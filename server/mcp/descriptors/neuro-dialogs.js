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
  // Генерирует текст через ИИ — на этих модулях расход на ИИ реален.
  usesAi: true,
  title: 'Neurodialogues',
  platform: 'telegram',
  tags: ['dm', 'direct messages', 'private messages', 'dialogs', 'conversation', 'crm', 'leads', 'ai', 'inbound'],

  whoAmI: {
    summary: 'AI responds to incoming personal messages on behalf of managed accounts and guides the lead through the funnel to the target action.',
    does: [
      'monitors incoming DMs of accounts and responds to them',
      'leads the conversation towards the goal: mixes the campaign goal, funnel stage and lead status into the prompt',
      'determines that the goal has been achieved, thanks and closes the dialogue - does not press further',
      'moves the lead status in CRM during correspondence',
      'optionally presses those who wrote themselves after the dialogue was closed',
      'can work in several parallel threads with skewed starts',
    ],
    doesNot: [
      'NEVER WRITES FIRST - only replies. Cold mailing is “Mailing”',
      'does not work according to the list of goals: the module has no channels and groups in principle',
      'does not write in groups - this is “Neurochatting”',
      'does not respond to Telegram bots and service chats - lets them through',
    ],
    requires: [
      'at least one account in a working status with a working proxy',
      'incoming messages: without them the module just waits and does nothing - this is normal',
    ],
    risks:
      'Personal correspondence with living people. A bunch of answers in a row from one number - the fastest '
      + 'path to PEER_FLOOD and reports, so the number of responses per visit is limited by the protection level. '
      + 'The spamblocked account continues to read inboxes, but does not respond.',
    costModel:
      'Charged per action according to the price list of the module; text generation is included. Analysis of pictures is billed separately.'
      + 'AI generation runs on model access provided by the platform: the caller supplies no key, token or provider credential, and there is no field for one — it works out of the box.',
  },

  blocks: [
    {
      id: 'accounts',
      title: 'Select accounts',
      purpose: 'Whose incoming messages the task serves.',
      howItWorks:
        'Accounts are moving in a circle. Busy with another task is not displayed; problematic statuses '
        + 'and daily drug limit are skipped. When the daily limit is reached, the module does NOT end, '
        + 'but is quietly idle - he is a responder, not a batch mailer.',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['accountIds'] },
      params: ['accountIds'],
    },
    {
      id: 'behaviour',
      title: 'What to answer',
      purpose: 'What dialogues does the module use?',
      howItWorks:
        '"Unread" mode - only new incoming messages. “All” mode - including messages already read, '
        + "where the last word belongs to the interlocutor. Doesn't reply to the same message twice: "
        + 'the answer will be repeated only when the interlocutor writes a new one.',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['replyScope'] },
      params: ['replyScope'],
    },
    {
      id: 'limits',
      title: 'Limits on dialogue',
      purpose: 'How many messages to write to one person and how many in total.',
      howItWorks:
        'Or we write until the lead completes the target action (only daily limits apply), '
        + 'or no more than a specified number of responses per lead. The total task limit is considered the same as for everyone else '
        + 'modules - a random number from [min, max].',
      api: {
        method: 'POST',
        path: '/api/modules/neuro-dialogs/tasks',
        fills: ['replyLimitMode', 'maxRepliesPerLead', 'maxActions', 'minActions'],
      },
      params: ['replyLimitMode', 'maxRepliesPerLead', 'maxActions', 'minActions'],
    },
    {
      id: 'modes',
      title: 'Operating mode',
      purpose: 'Is the task limited by the number of answers or time?',
      howItWorks:
        'The responder module is usually set by time: it works a shift and waits for incoming messages, '
        + 'and not “works through the pack and ends.”',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['workMode', 'durationMinutes'] },
      params: ['workMode', 'durationMinutes'],
    },
    {
      id: 'followup',
      title: "We'll put the pressure on",
      purpose: 'What to do when the dialogue is closed, and the person wrote it himself.',
      howItWorks:
        'The boost is turned on only for INCOMING interest: the dialogue is already closed (the goal has been achieved or '
        + 'the person refused), but he wrote again. Separate tone - sell the same thing again '
        + 'surefire way to get blocked. The boost has its own counter and its own ceiling.',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['followUp'] },
      params: ['followUp'],
    },
    {
      id: 'prompts',
      title: 'Prompts and generation',
      purpose: 'What the model knows about the conversation and what tone she responds in.',
      howItWorks:
        'The system prompt is assembled in layers: your own prompt (or card) → strict rules of correspondence '
        + '(in short, in the language of the interlocutor, do not introduce yourself again, never admit that this is AI) '
        + '→ completion rules → lead stage → funnel stage from the goal → link from the entire goal → '
        + 'campaign goal → dialogue instructions.',
      api: {
        method: 'POST',
        path: '/api/modules/neuro-dialogs/tasks',
        fills: ['dialogGoal', 'promptIndex', 'promptText', 'promptOverrides', 'analyzeImages'],
      },
      params: ['dialogGoal', 'promptIndex', 'promptText', 'promptOverrides', 'analyzeImages', 'typeWeights'],
    },
    {
      id: 'performance',
      title: 'Parallelism',
      purpose: 'How many threads do accounts serve simultaneously?',
      howItWorks:
        'Accounts are divided between threads in a circle. Each stream has its own random phase and jitter: '
        + 'without dephasing, the streams are aligned and start knocking in Telegram synchronously, and an even '
        + 'the machine rhythm from several accounts is the cluster, which is visible from the outside.',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['threads'] },
      params: ['threads'],
    },
    {
      id: 'protection',
      title: 'Account protection',
      purpose: 'Delay multiplier and how many LAN accounts are responsible for one visit.',
      howItWorks:
        'For this module, the level of protection is determined not only by speed: it determines the size of the packet of responses '
        + 'per call (2 / 4 / 6). The module has no probability - it responds to everyone who wrote.',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['protectionLevel'] },
      params: ['protectionLevel'],
    },
    {
      id: 'timings',
      title: 'Timings and delays',
      purpose: 'Pauses between responses and behavior during FloodWait.',
      howItWorks: 'Pause = random from the range × protection multiplier × preset multiplier, but not less than 5 seconds.',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['delayPreset', 'delays'] },
      params: ['delayPreset', 'delays'],
    },
    {
      id: 'binding',
      title: 'Binding',
      purpose: 'What goal and campaign does the task relate to?',
      howItWorks:
        'The goal gives the status classifier an understanding of what to consider as “completed”, and the prompt - the stages '
        + 'funnels and link. An overdue deadline stops an already ongoing task.',
      api: { method: 'POST', path: '/api/modules/neuro-dialogs/tasks', fills: ['goalId', 'campaignId', 'deadline'] },
      params: ['goalId', 'campaignId', 'deadline'],
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
      purpose: 'IDs of the accounts whose incoming DMs are served by the task.',
      constraints: ['empty list → refusal “Select at least one account”'],
      examples: [['acc_1'], ['acc_1', 'acc_2', 'acc_3']],
      storedAs: 'task.settings.accountIds',
    },
    {
      name: 'replyScope',
      block: 'behaviour',
      title: 'What to answer',
      type: 'string',
      default: 'unread',
      enum: [
        { value: 'unread', label: 'Only unread', means: 'We only respond to new incoming messages.' },
        { value: 'all', label: 'To everyone who wrote', means: 'We also respond to dialogues that have already been read, where the interlocutor has the last word.' },
      ],
      purpose: 'What dialogues to use.',
      constraints: [
        'We do not respond to the same message twice - only when the interlocutor writes a new one',
        'Telegram service chats and bots are allowed in any mode',
      ],
      storedAs: 'task.settings.replyScope',
    },
    {
      name: 'replyLimitMode',
      block: 'limits',
      title: 'Limit per lead',
      type: 'string',
      default: 'untilTarget',
      enum: [
        {
          value: 'untilTarget',
          label: 'Before target action',
          means: 'We write until the lead completes the target action or refuses. The only restrictions are daily limits and stop lists.',
        },
        {
          value: 'count',
          label: 'No more than N answers',
          means: 'After maxRepliesPerLead answers, we do not continue the dialogue with this person.',
        },
      ],
      purpose: 'What is the limit on the number of messages to one person?',
      seeAlso: ['maxRepliesPerLead'],
      storedAs: 'task.settings.replyLimitMode',
    },
    {
      name: 'maxRepliesPerLead',
      block: 'limits',
      title: 'Replies per lead',
      type: 'integer',
      default: 0,
      min: 0,
      effectiveWhen: { replyLimitMode: 'count' },
      purpose: 'How many messages can you write to one person?',
      constraints: ['0 = no limit', 'only works with replyLimitMode = count'],
      examples: [0, 3, 10],
      seeAlso: ['replyLimitMode'],
      storedAs: 'task.settings.maxRepliesPerLead',
    },
    {
      name: 'maxActions',
      block: 'limits',
      title: 'Max. answers for the task',
      type: 'integer',
      default: 100,
      min: 1,
      aliases: ['maxComments'],
      purpose: 'The upper limit on the number of submitted responses for the entire task.',
      constraints: ['must be ≥ minActions'],
      examples: [50, 200],
      seeAlso: ['minActions', 'workMode'],
      storedAs: 'task.settings.maxActions',
    },
    {
      name: 'minActions',
      block: 'limits',
      title: 'Min. answers for the task',
      type: 'integer',
      default: 0,
      min: 0,
      aliases: ['minComments'],
      purpose: 'The lower bound of the goal of the task. The actual target is a random number from [min, max].',
      constraints: ['must be ≤ maxActions'],
      seeAlso: ['maxActions'],
      storedAs: 'task.settings.minActions',
    },
    {
      name: 'workMode',
      block: 'modes',
      title: 'Operating mode',
      type: 'integer',
      default: 0,
      enum: [
        { value: 0, label: 'By quantity', means: 'The task continues until the goal for the number of answers is reached.' },
        { value: 1, label: 'By time', means: 'The task runs for the specified time and waits for incoming messages all this time.' },
      ],
      purpose: 'What is the limitation of the task?',
      constraints: [
        'when workMode = 1 durationMinutes is required',
        'For a responder module, time mode is usually more appropriate: incoming messages arrive when they arrive',
      ],
      seeAlso: ['durationMinutes'],
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
      purpose: 'How long is the task on duty at the inbox?',
      constraints: [
        'is treated as MAXIMUM: the actual duration is a random number from [min, durationMinutes], '
        + 'where min sets the protection level (60 / 45 / 30 minutes)',
      ],
      examples: [240, 480],
      seeAlso: ['workMode', 'protectionLevel'],
      storedAs: 'task.settings.durationMinutes',
    },
    {
      name: 'followUp',
      block: 'followup',
      title: "We'll put the pressure on",
      type: 'object',
      purpose: 'Should I respond to those who wrote themselves after the dialogue was closed?',
      constraints: [
        'triggers ONLY on an incoming message - the module itself does not initiate the boost',
        'if not specified, the boost settings are taken from the target (for campaigns created earlier)',
      ],
      properties: [
        {
          name: 'enabled',
          title: 'Enabled',
          type: 'boolean',
          default: false,
          purpose: 'Whether to respond to incoming messages in closed dialogues.',
        },
        {
          name: 'limit',
          title: 'Boost ceiling',
          type: 'integer',
          default: 0,
          min: 0,
          purpose: 'How many times can you squeeze one person maximum?',
          constraints: ['0 = no limit; counter separate from maxRepliesPerLead'],
        },
        {
          name: 'instructions',
          title: 'Pressure instructions',
          type: 'string',
          default: '',
          purpose: 'How does the tone of the squeeze differ from the main conversation?',
          constraints: ['added to the system prompt only in boost'],
        },
      ],
      storedAs: 'task.settings.followUp',
    },
    {
      name: 'dialogGoal',
      block: 'prompts',
      title: 'Instructions and purpose of dialogue',
      type: 'string',
      default: '',
      purpose: 'Free text: what to talk about and how to behave.',
      constraints: [
        'added as the last layer of the system prompt - interrupts more general instructions',
        'this is NOT a goal from the directory: it is specified separately via goalId',
      ],
      examples: ['Gently lead you to sign up for a free consultation, give a link only after obvious interest.'],
      seeAlso: ['goalId'],
      storedAs: 'task.settings.dialogGoal',
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
        { value: 0, label: 'Positive', means: 'Friendly tone.' },
        { value: 1, label: 'Intimate', means: 'Personal, confidential tone.' },
        { value: 2, label: 'Emotional response', means: 'Expression of emotion.' },
        { value: 3, label: 'Question to the interlocutor', means: 'A clarifying question continues the conversation.' },
        { value: 4, label: 'Brief review', means: 'One or two sentences to the point.' },
        { value: 5, label: 'Analytical approach', means: 'Analysis is essentially an argument.' },
      ],
      supersededBy: ['promptText'],
      purpose: 'A basic tone card on top of which the correspondence rules are superimposed.',
      storedAs: 'task.settings.promptIndex',
    },
    {
      name: 'promptText',
      block: 'prompts',
      title: 'Your system prompt',
      type: 'string',
      default: '',
      purpose: "The model's own instructions instead of the built-in card.",
      constraints: [
        'a non-empty value overrides promptIndex and promptOverrides',
        'strict rules of correspondence (do not admit that it is AI; answer briefly and in language '
        + 'interlocutor; do not say hello again) are added ON TOP and are not disabled',
      ],
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
      purpose: 'Replace the text of specific tone cards.',
      constraints: ['element index corresponds to promptIndex'],
      storedAs: 'task.settings.promptOverrides',
    },
    {
      name: 'analyzeImages',
      block: 'prompts',
      title: 'Image Analysis',
      type: 'boolean',
      default: false,
      purpose: 'Describe the photos sent by your interlocutor and respond based on their essence.',
      constraints: ['billed separately with imageMultiplier', 'only applies to the last incoming message'],
      storedAs: 'task.settings.analyzeImages',
    },
    {
      name: 'threads',
      block: 'performance',
      title: 'Streams',
      type: 'integer',
      default: 1,
      min: 1,
      purpose: 'How many sets of accounts are serviced in parallel?',
      constraints: [
        'There can be no more than the number of accounts - the value is cut off: an empty thread would spin the loop idle',
        'this is ONE task: general progress, general logs, one “Stop” button',
        'thread starts are separated by a random pause - a simultaneous salvo reads like a farm',
      ],
      examples: [1, 3],
      storedAs: 'task.settings.threads',
    },
    {
      name: 'protectionLevel',
      block: 'protection',
      title: 'Protection level',
      type: 'integer',
      default: 1,
      enum: [
        {
          value: 0,
          label: 'Conservative',
          means: 'Delays ×1.8, no more than 2 responses per login with one account, minimum duration 60 minutes.',
        },
        {
          value: 1,
          label: 'Balanced',
          means: 'Delays ×1, up to 4 responses per entry, minimum duration 45 minutes.',
        },
        {
          value: 2,
          label: 'Aggressive',
          means: 'Delays ×0.75, up to 6 responses per call, minimum duration 30 minutes.',
        },
      ],
      purpose: 'Speed ​​and size of a packet of answers from one number.',
      constraints: [
        "THIS module's protection level additionally limits the number of responses per pass (2 / 4 / 6)",
        'a bunch of answers in a row from one number is the fastest way to PEER_FLOOD and reports',
        'ATTENTION: the numbering is REVERSED delayPreset - here 0 is the safest',
      ],
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
        { value: 0, label: 'Aggressive', means: 'Pauses ×0.6, duration ×0.75.' },
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
        'delays here are shorter than in other modules: they are waiting for a response in correspondence, and there is a pause of two '
        + 'minutes looks weirder than a pause of twenty seconds',
      ],
      properties: [
        {
          name: 'action',
          title: 'Pause before answering',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          default: [5, 30],
          unit: 's',
          purpose: 'Range [min, max] pause before sending a response.',
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
          purpose: 'How many consecutive FloodWaits an account can withstand before being sent to quarantine.',
        },
      ],
      storedAs: 'task.settings.delays',
    },
    {
      name: 'goalId',
      block: 'binding',
      title: 'Target',
      type: 'string',
      purpose: 'Campaign Goal: Provides funnel stages, target action and send link.',
      constraints: [
        'must exist; get the list - GET /api/v1/goals',
        'using it, the classifier understands what to consider as “completed” and moves the lead status in CRM',
        'the link from the target is inserted into the entire message - the model does not insert placeholders',
      ],
      seeAlso: ['dialogGoal', 'deadline'],
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
      name: 'deadline',
      block: 'binding',
      title: 'Deadline',
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      purpose: 'The date after which work on the task stops.',
      constraints: [
        'format YYYY-MM-DD; deadline includes the entire specified day',
        'comes from campaign; if not specified, the goal deadline is taken by goalId',
        'stops an ALREADY RUNNING task',
      ],
      examples: ['2026-09-01'],
      seeAlso: ['goalId'],
      storedAs: 'task.settings.deadline',
    },
  ],

  presets: [
    {
      param: 'delayPreset',
      title: 'Tempo preset',
      source: 'server/lib/protection.js — PRESET_MUL',
      values: [
        { value: 0, label: 'Aggressive', multiplier: 0.6, means: 'Pauses ×0.6, duration ×0.75.', useWhen: 'warmed up accounts, a lot of incoming ones' },
        { value: 1, label: 'Balanced', multiplier: 1, means: 'Basic delays.', useWhen: 'daily work' },
        { value: 2, label: 'Conservative', multiplier: 1.8, means: 'Pauses ×1.8, duration ×1.5.', useWhen: 'new and expensive accounts' },
        { value: 3, label: 'Custom', multiplier: 1, means: 'No scaling.', useWhen: 'manual setting' },
      ],
    },
    {
      param: 'protectionLevel',
      title: 'Protection level',
      source: 'server/lib/protection.js - LEVEL_MUL; server/lib/workModeDuration.js; perPassCap [2,4,6] in runNeuroDialogs',
      values: [
        { value: 0, label: 'Conservative', multiplier: 1.8, repliesPerPass: 2, minDurationMinutes: 60, means: 'Delays ×1.8, up to 2 responses per call.' },
        { value: 1, label: 'Balanced', multiplier: 1, repliesPerPass: 4, minDurationMinutes: 45, means: 'Delays ×1, up to 4 responses per call.' },
        { value: 2, label: 'Aggressive', multiplier: 0.75, repliesPerPass: 6, minDurationMinutes: 30, means: 'Delays ×0.75, up to 6 responses per call.' },
      ],
    },
  ],

  examples: [
    {
      title: 'Duty on incoming targets',
      when: 'there is a campaign going on, people write themselves, we need to bring them to the target action',
      input: {
        accountIds: ['acc_1', 'acc_2'],
        replyScope: 'unread',
        replyLimitMode: 'untilTarget',
        workMode: 1,
        durationMinutes: 480,
        goalId: 'goal_123',
        dialogGoal: 'Make an appointment for a free consultation. Provide a link only after clear interest.',
        protectionLevel: 1,
        delayPreset: 1,
      },
    },
    {
      title: 'Careful analysis of accumulated drugs',
      when: 'There are unread messages in your accounts, you need to reply to everyone without risk',
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
      title: 'Many accounts in several streams with boost',
      when: 'a large flow of incoming messages, it is necessary to process in parallel and return those who wrote again',
      input: {
        accountIds: ['acc_1', 'acc_2', 'acc_3', 'acc_4', 'acc_5', 'acc_6'],
        threads: 3,
        replyScope: 'unread',
        workMode: 1,
        durationMinutes: 600,
        followUp: { enabled: true, limit: 2, instructions: 'Do not resell. Briefly ask if you have any questions.' },
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
