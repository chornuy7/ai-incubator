/**
 * MCP-дескриптор модуля «Мейлинг».
 *
 * Формат — docs/mcp/MCP-SPEC.md, правила правки — docs/mcp/MCP-CONTRIBUTING.md.
 *
 * Самый рискованный модуль платформы: это ХОЛОДНАЯ рассылка в личные сообщения людям,
 * которые не писали первыми. Отличия от остальных модулей, критичные для оркестратора:
 *  - работа идёт по СПИСКУ ЦЕЛЕЙ (номера и юзернеймы), а не по каналам;
 *  - объём задачи = длина списка, лимитов вида maxActions/workMode здесь НЕТ;
 *  - к рассылке допускаются только аккаунты с достаточным trust score;
 *  - паузы по умолчанию 90–300 с, а не 30–120 как везде.
 */

/** @type {import('./index.js').ModuleDescriptor} */
export default {
  key: 'mailing',
  version: 1,
  // Генерирует текст через ИИ — на этих модулях расход на ИИ реален.
  usesAi: true,
  title: 'Mailing',
  platform: 'telegram',
  tags: ['mailing', 'broadcast', 'dm', 'direct messages', 'phones', 'usernames', 'cold outreach', 'outbound'],

  whoAmI: {
    summary: 'Sends the first personal messages to a list of phone numbers and usernames on behalf of managed accounts.',
    does: [
      'parses the list of targets into phones and usernames',
      'filters out recipients on the blacklist, by username and by phone number in any notation',
      'resolves a phone to a Telegram account; numbers not registered in Telegram are skipped',
      'sends the text: a template, the opener from the goal, or AI generated per recipient',
      'can attach media or links to the message',
      'can run in several parallel threads',
    ],
    doesNot: [
      'does NOT answer incoming messages — that is Neurodialogs',
      'does not write in groups and does not comment on channels',
      'does not use accounts below the trust score threshold unless explicitly allowed',
      'has no "do N actions" limit and no time mode: the volume of the task is the length of the target list',
    ],
    requires: [
      'at least one account with a trust score above the threshold and a working proxy',
      'a non-empty target list',
      'text: either a template, or the opener stored in the goal, or AI generation enabled',
    ],
    risks:
      'HIGHEST RISK on the platform. Cold PMs to strangers - a direct path to reports '
      + 'and spamblock. Therefore: a strict trust score threshold, pauses of 90–300 seconds, daily drug limit '
      + 'to the account. Run only on warmed up accounts and in small batches.',
    costModel: 'Charged per action according to the price list of the module. With AI generation, the text is included in the price of the action.',
  },

  blocks: [
    {
      id: 'accounts',
      title: 'Select accounts',
      purpose: 'Which accounts send the mailing.',
      howItWorks:
        'Before the start, each account is checked by trust score, and the log shows how many of '
        + 'selected are admitted. Accounts below the threshold are eliminated - this can only be circumvented with an explicit flag. '
        + 'In addition, there is a daily DM limit per account: the account that selects it is skipped.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: ['accountIds', 'allowLowTrust'] },
      params: ['accountIds', 'allowLowTrust'],
    },
    {
      id: 'targets',
      title: 'Who to write to',
      purpose: 'The list of mailing recipients.',
      howItWorks:
        'The list is broken down into telephone numbers and usernames. The phone resolves to the Telegram account via '
        + 'import contact; if there is no number in Telegram, the target is skipped. The progress of the task is considered '
        + 'depending on the length of the list: as many goals as there are as many actions.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: ['targets'] },
      params: ['targets'],
    },
    {
      id: 'message',
      title: 'Message text',
      purpose: 'What exactly the person receives.',
      howItWorks:
        'Three text sources by priority: your template → first messages from the target → AI generation '
        + 'for each recipient. If none of the three are specified, the task does not start. You can go to the text '
        + 'attach media or links.',
      api: {
        method: 'POST',
        path: '/api/modules/mailing/tasks',
        fills: ['message', 'aiPerRecipient', 'promptIndex', 'promptOverrides', 'typeWeights', 'mediaUrls'],
      },
      params: ['message', 'aiPerRecipient', 'promptIndex', 'promptOverrides', 'mediaUrls', 'typeWeights'],
    },
    {
      id: 'limits',
      title: 'Limits',
      purpose: 'How many messages a single account sends.',
      howItWorks:
        'The task does not have a general limit - it ends when the list of goals ends. Limit '
        + 'You can only load the account; if not specified, the daily drug limit from the security settings works.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: ['maxPerAccount'] },
      params: ['maxPerAccount'],
    },
    {
      id: 'performance',
      title: 'Parallelism',
      purpose: 'How many threads send at the same time.',
      howItWorks:
        'Both the list of goals and accounts are divided between threads in a circle. There are no more streams than allowed '
        + 'accounts. The starts of threads are separated by a random pause - a simultaneous salvo reads like a farm.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: ['threads'] },
      params: ['threads'],
    },
    {
      id: 'protection',
      title: 'Account protection',
      purpose: 'Delay multiplier and the ceiling on send probability.',
      howItWorks:
        'The protection level multiplies the pauses between sends and caps the probability from above '
        + '(conservative no higher than 25%, balanced no higher than 45%). Probability here does not cancel '
        + 'a send: a recipient who loses the roll moves to the end of the queue and goes to another account, '
        + 'so nobody drops off the list.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: ['protectionLevel', 'probability'] },
      params: ['protectionLevel', 'probability'],
    },
    {
      id: 'binding',
      title: 'Goal, campaign and agent',
      purpose: 'What the mailing works towards and whose voice it speaks in.',
      howItWorks:
        'The goal supplies context and the knowledge base for AI generation, and its link is inserted into the text. '
        + 'The agent supplies tone, role and prohibitions, and owns the first-message variants: when the agent has them, '
        + 'they are rotated instead of the template. The campaign is used only for reporting and token accounting. '
        + 'For older goals that still keep the opener in their description, the legacy fallback is honoured.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: ['goalId', 'campaignId', 'agentId'] },
      params: ['goalId', 'campaignId', 'agentId'],
    },
    {
      id: 'timings',
      title: 'Timings and delays',
      purpose: 'Pauses between messages and behaviour on FloodWait.',
      howItWorks:
        'The default is 90–300 seconds—three times longer than other modules. This is not reinsurance: '
        + 'Frequent messages to strangers are monitored most strictly by Telegram.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: ['delays', 'delayPreset'] },
      params: ['delays', 'delayPreset'],
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
      purpose: 'IDs of the managed accounts that send the mailing.',
      constraints: [
        'empty list → refusal “Select at least one account”',
        'each account is additionally checked against the trust score threshold before the run',
        'an account already busy with another task is not issued: one account = one task',
      ],
      examples: [['acc_1'], ['acc_1', 'acc_2', 'acc_3']],
      storedAs: 'task.settings.accountIds',
    },
    {
      name: 'targets',
      block: 'targets',
      title: 'Recipients',
      type: 'array',
      items: 'string',
      required: true,
      minItems: 1,
      purpose: 'Who to write to: phone numbers and/or usernames, mixed freely in one list.',
      constraints: [
        'a phone is resolved through import contact; if the number is not registered in Telegram, the target is skipped',
        'a username may be given with or without the leading @',
        'targets on the blacklist are removed before any action and the count is reported in the log',
        'the volume of the task equals the length of this list: the module has no maxActions and no time mode',
      ],
      examples: [['+79991234567', '@durov'], ['79991234567', '79997654321']],
      storedAs: 'task.settings.targets',
    },
    {
      name: 'allowLowTrust',
      block: 'accounts',
      title: 'Allow accounts below the trust threshold',
      type: 'boolean',
      default: false,
      purpose: 'Deliberately admit accounts whose trust score is under the mailing threshold.',
      constraints: [
        'without it, accounts below the threshold are skipped and the reason is logged',
        'the threshold itself is a platform setting (mailingMinTrust), not a task field',
        'every account admitted this way is named in the log: an explicit override, not a silent bypass',
        'raises the odds of a spamblock — the threshold exists because cold DMs from cold accounts get reported',
      ],
      seeAlso: ['accountIds'],
      storedAs: 'task.settings.allowLowTrust',
    },
    {
      name: 'aiPerRecipient',
      block: 'message',
      title: 'Generate text per recipient',
      type: 'boolean',
      default: false,
      purpose: 'Write a separate AI message for every recipient instead of sending one template to everyone.',
      constraints: [
        'requires AI generation to be enabled on the platform; otherwise the flag has no effect',
        'without it one identical text goes to the whole list — the most recognisable signature of a mass mailing',
        'goal and agent context is fed into every generation, so texts differ in wording, not only in the name',
      ],
      seeAlso: ['message', 'goalId', 'agentId'],
      storedAs: 'task.settings.aiPerRecipient',
    },
    {
      name: 'mediaUrls',
      block: 'message',
      title: 'Media and links',
      type: 'array',
      items: 'string',
      default: [],
      purpose: 'Attach pictures or links to the message.',
      constraints: [
        'only http/https URLs are accepted; anything else is dropped and not counted',
        'attachments are sent together with the text, not as a separate message',
      ],
      examples: [['https://example.com/promo.jpg']],
      storedAs: 'task.settings.mediaUrls',
    },
    {
      name: 'message',
      block: 'message',
      title: 'Message text',
      type: 'string',
      default: '',
      aliases: ['promptText'],
      purpose: 'The first-message template, identical for every recipient.',
      constraints: [
        'text source priority: this template → first messages from the goal → AI generation',
        'if empty, with no goal messages and no AI generation enabled, the task does not start',
        'the server also accepts promptText: it is the same field',
      ],
      examples: ['Hello! I saw your profile — I have a quick question, is now a good time?'],
      seeAlso: ['aiPerRecipient', 'goalId'],
      storedAs: 'task.settings.message (the server also accepts promptText)',
    },
    {
      name: 'typeWeights',
      block: 'message',
      title: 'Tone distribution, %',
      type: 'array',
      items: 'number',
      default: [],
      purpose: 'Mix message tones in a given proportion so accounts do not all write in the same voice.',
      constraints: [
        'the element index corresponds to promptIndex',
        'if at least one weight is > 0, promptIndex is NOT used — the tone is drawn by weighted lottery for each message',
        'weights are normalised automatically; they do not have to add up to 100',
      ],
      examples: [[50, 0, 0, 30, 20, 0]],
      seeAlso: ['promptIndex'],
      storedAs: 'task.settings.typeWeights',
    },
    {
      name: 'promptIndex',
      block: 'message',
      title: 'Message tone',
      type: 'integer',
      default: 0,
      enum: [
        { value: 0, label: 'Positive', means: 'A friendly approach.' },
        { value: 1, label: 'Intimate', means: 'A personal, confiding tone.' },
        { value: 2, label: 'Emotional response', means: 'A lively, emotional approach.' },
        { value: 3, label: 'A question to the reader', means: 'Opening with a question raises the chance of a reply.' },
        { value: 4, label: 'Brief note', means: 'One or two sentences to the point.' },
        { value: 5, label: 'Analytical', means: 'A substantive approach carrying an argument.' },
      ],
      effectiveWhen: { aiPerRecipient: true },
      purpose: 'Which prompt card is used for AI generation.',
      constraints: ['only meaningful with aiPerRecipient = true: for a template the tone is set by the text itself'],
      seeAlso: ['aiPerRecipient'],
      storedAs: 'task.settings.promptIndex',
    },
    {
      name: 'promptOverrides',
      block: 'message',
      title: 'Tone card overrides',
      type: 'array',
      items: 'string',
      default: [],
      effectiveWhen: { aiPerRecipient: true },
      supersededBy: ['message'],
      purpose: 'Replace the text of specific tone cards used for AI generation.',
      constraints: [
        'the element index corresponds to promptIndex',
        'overridden by a non-empty message: an explicit template cancels generation entirely',
      ],
      seeAlso: ['promptIndex', 'aiPerRecipient'],
      storedAs: 'task.settings.promptOverrides',
    },
    {
      name: 'delays',
      block: 'timings',
      title: 'Delays',
      type: 'object',
      purpose: 'Base intervals that the protection level and tempo preset multiply.',
      constraints: [
        'the mailing pause is set by the `dm` field; `action` is also accepted for compatibility',
        'the 90–300 s default is deliberately three times longer than in other modules',
      ],
      properties: [
        {
          name: 'dm',
          title: 'Pause between messages',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          default: [90, 300],
          unit: 's',
          purpose: 'The [min, max] range of the pause between direct messages.',
          constraints: ['the actual pause is random within the range × the multipliers, but never below 5 seconds'],
        },
        {
          name: 'action',
          title: 'Pause between messages (alias)',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          unit: 's',
          purpose: 'Same as dm — used when dm is not set.',
          constraints: ['kept for compatibility with the shared settings shape; prefer dm'],
        },
        {
          name: 'floodWait',
          title: 'Margin after FloodWait',
          type: 'number',
          default: 120,
          min: 0,
          unit: 's',
          purpose: 'How long to wait on top of the duration Telegram returned.',
        },
        {
          name: 'floodQuarantine',
          title: 'FloodWaits before quarantine',
          type: 'integer',
          default: 3,
          min: 1,
          purpose: 'How many consecutive FloodWaits an account withstands before it is sent to quarantine.',
        },
      ],
      storedAs: 'task.settings.delays',
    },
    {
      name: 'maxPerAccount',
      block: 'limits',
      title: 'Limit per account',
      type: 'integer',
      default: 0,
      min: 0,
      purpose: 'How many messages a single account may send within this task.',
      constraints: [
        '0 means no task-level limit; only the global daily DM limit from the safety settings applies',
        'the module has NO total limit — the run ends when the target list ends',
        'an account that reaches either limit is skipped and the next one in the circle takes over',
      ],
      examples: [0, 20],
      seeAlso: ['accountIds'],
      storedAs: 'task.settings.maxPerAccount',
    },
    {
      name: 'threads',
      block: 'performance',
      title: 'Parallel threads',
      type: 'integer',
      default: 1,
      min: 1,
      purpose: 'How many independent sending streams run at once.',
      constraints: [
        'capped at the number of usable accounts: an empty thread would only spin the loop',
        'this is still ONE task — shared progress, shared log, one stop button',
        'thread starts are separated by a random pause; a simultaneous salvo reads like a farm',
      ],
      examples: [1, 3],
      seeAlso: ['accountIds'],
      storedAs: 'task.settings.threads',
    },
    {
      name: 'probability',
      block: 'protection',
      title: 'Send probability',
      type: 'integer',
      default: 100,
      purpose: 'What share of recipients is written to out of list order, and not by the account that was next in line.',
      constraints: [
        'the meaning differs from commenting and reactions: a miss does not cancel the send, it defers it',
        'a recipient who loses the roll moves to the end of the queue and goes to another account — nobody drops off the list',
        'the roll happens once per recipient: on the second pass the send goes through unconditionally, otherwise the queue would spin forever',
        'the protection level caps it from above: conservative no higher than 25%, balanced no higher than 45%',
      ],
      seeAlso: ['protectionLevel'],
      storedAs: 'task.settings.probability',
    },
    {
      name: 'protectionLevel',
      block: 'protection',
      title: 'Protection level',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Conservative', means: 'Delays ×1.8.' },
        { value: 1, label: 'Balanced', means: 'Base delays ×1.' },
        { value: 2, label: 'Aggressive', means: 'Delays ×0.75.' },
      ],
      purpose: 'Multiplies every pause in the task.',
      constraints: [
        'this module has no probability setting: everyone on the list is written to',
        'ATTENTION: the numbering is REVERSED relative to delayPreset — here 0 is the safest',
        'for cold DMs aggressive is rarely worth it: a report costs the account, not a retry',
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
        { value: 0, label: 'Aggressive', means: 'Pauses ×0.6.' },
        { value: 1, label: 'Balanced', means: 'Base delays ×1.' },
        { value: 2, label: 'Conservative', means: 'Pauses ×1.8.' },
        { value: 3, label: 'Custom', means: 'Delays are used exactly as given, without scaling.' },
      ],
      purpose: 'Scales all delays of the task on top of the protection level.',
      constraints: [
        'ATTENTION: the numbering is REVERSED relative to protectionLevel — here 0 is the fastest',
        'multiplies with protectionLevel: conservative × conservative is roughly ×3.2',
      ],
      seeAlso: ['protectionLevel', 'delays'],
      storedAs: 'task.settings.delayPreset',
    },
    {
      name: 'goalId',
      block: 'binding',
      title: 'Goal',
      type: 'string',
      purpose: 'Campaign goal: supplies context and knowledge base for generation, and the link inserted into the text.',
      constraints: [
        'must exist; get the list from GET /api/v1/goals',
        'for older goals the opener may still live in the goal description under “Первое сообщение:” — that fallback is honoured',
        'the link from the goal is inserted into the whole message; the model does not insert placeholders',
      ],
      seeAlso: ['campaignId', 'agentId', 'aiPerRecipient'],
      storedAs: 'task.settings.goalId',
    },
    {
      name: 'campaignId',
      block: 'binding',
      title: 'Campaign',
      type: 'string',
      purpose: 'Campaign for reporting and for attributing token consumption.',
      constraints: ['must exist; get the list from GET /api/v1/campaigns'],
      seeAlso: ['goalId'],
      storedAs: 'task.settings.campaignId',
    },
    {
      name: 'agentId',
      block: 'binding',
      title: 'Agent',
      type: 'string',
      purpose: 'Whose voice the mailing speaks in: tone, role, prohibitions and the first-message variants.',
      constraints: [
        'when the agent defines firstMessage variants they are rotated and take priority over the message template',
        'without an agent generation still works — it simply has no persona',
      ],
      seeAlso: ['goalId', 'message'],
      storedAs: 'task.settings.agentId',
    },
  ],

  presets: [
    {
      param: 'delayPreset',
      title: 'Tempo preset',
      source: 'server/lib/protection.js — PRESET_MUL',
      values: [
        { value: 0, label: 'Aggressive', multiplier: 0.6, means: 'Pauses ×0.6 — risky for cold DMs.', useWhen: 'disposable accounts' },
        { value: 1, label: 'Balanced', multiplier: 1, means: 'Base pauses 90-300 s.', useWhen: 'an ordinary mailing' },
        { value: 2, label: 'Conservative', multiplier: 1.8, means: 'Pauses ×1.8 — 3-9 minutes between messages.', useWhen: 'expensive accounts, a first mailing' },
        { value: 3, label: 'Custom', multiplier: 1, means: 'No scaling.', useWhen: 'manual tuning' },
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
      title: 'Trial mailing to five numbers',
      when: 'a first run: what matters is confirming that numbers resolve and messages arrive',
      input: {
        accountIds: ['acc_1'],
        targets: ['+380501234567', '+380501234568', '@durov'],
        message: 'Hello! I saw your profile — I have a quick question, is now a good time?',
        maxPerAccount: 5,
        protectionLevel: 0,
        delayPreset: 2,
      },
    },
    {
      title: 'Mailing with AI text tailored to each recipient and to the goal',
      when: 'there is a goal and a knowledge base, and we need different texts instead of a hundred identical ones',
      input: {
        accountIds: ['acc_1', 'acc_2', 'acc_3'],
        targets: ['+380501234567', '+380501234568', '+380501234569'],
        aiPerRecipient: true,
        promptIndex: 3,
        goalId: 'goal_123',
        agentId: 'agent_1',
        threads: 2,
        maxPerAccount: 20,
        protectionLevel: 1,
        delays: { dm: [120, 360], floodWait: 180, floodQuarantine: 2 },
      },
    },
  ],

  contract: {
    sources: [
      // ГЛАВНЫЙ источник модуля. Его затянуло внутрь комментария при переводе файла, и
      // contract-тест перестал сканировать сам воркер: схема обещала 5 полей при
      // реальных 16, а тест этого не видел — ровно тот дефект, ради которого MCP и делался.
      { file: 'server/modules/workers.js', symbols: ['runMailing'] },
      // goalExpired у мейлинга НЕ вызывается: у модуля нет поля дедлайна, поэтому обещать
      // его «мозгам» нельзя — дедлайн кампании эту рассылку не остановит.
      { file: 'server/lib/accountRunner.js', symbols: ['handleFlood'] },
      { file: 'server/neuroCommenting/commentGenerator.js', symbols: ['resolveSystemPrompt'] },
    ],
    ignore: ['initiator', 'userId'],
  },
}
