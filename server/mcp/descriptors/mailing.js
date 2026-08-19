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
  title: 'Mailing',
  platform: 'telegram',
  tags: ['newsletter', 'mailing', 'PM', 'dm', 'numbers', 'phones', 'cold', 'cold outreach'],

  whoAmI: {
    summary: 'Sends the first personal messages to a list of phone numbers and usernames on behalf of managed accounts.',
    does: [
      'parses the list of targets into phones and usernames',
      'resolves the number to the Telegram account (numbers that are not in Telegram are skipped)',
      'sends a text: template, first message from the target or AI generated for each recipient',
      'can attach media or links to post',
      'can work in several parallel threads',
    ],
    doesNot: [
      "DOESN'T respond to inboxes - this is Neurodialogues",
      'does not write in groups and does not comment on channels',
      'does not work for accounts with low trust scores unless explicitly allowed',
      'has no limits like “do N actions” and time work: the volume of the task is the length of the list of goals',
    ],
    requires: [
      'at least one account with a trust score above the threshold and a working proxy',
      'non-empty target list',
      'text: either a template, or the first message in the target, or AI generation enabled',
    ],
    risks:
      'HIGHEST RISK on the platform. Cold PMs to strangers - a direct path to reports'
      + 'and spamblock. Therefore: a strict trust score threshold, pauses of 90–300 seconds, daily drug limit'
      + 'to the account. Run only on warmed up accounts and in small batches.',
    costModel: 'Charged per action according to the price list of the module. With AI generation, the text is included in the price of the action.',
  },

  blocks: [
    {
      id: 'accounts',
      title: 'Select accounts',
      purpose: 'Which accounts send the newsletter?',
      howItWorks:
        'Before the start, each account is checked by trust score, and the log shows how many of'
        + 'selected are admitted. Accounts below the threshold are eliminated - this can only be circumvented with an explicit flag.'
        + 'In addition, there is a daily DM limit per account: the account that selects it is skipped.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: [] },
      params: [],
    },
    {
      id: 'targets',
      title: 'Who to write to',
      purpose: 'List of mailing recipients.',
      howItWorks:
        'The list is broken down into telephone numbers and usernames. The phone resolves to the Telegram account via'
        + 'import contact; if there is no number in Telegram, the target is skipped. The progress of the task is considered'
        + 'depending on the length of the list: as many goals as there are as many actions.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: [] },
      params: [],
    },
    {
      id: 'message',
      title: 'Message text',
      purpose: 'What exactly will a person receive?',
      howItWorks:
        'Three text sources by priority: your template → first messages from the target → AI generation'
        + 'for each recipient. If none of the three are specified, the task does not start. You can go to the text'
        + 'attach media or links.',
      api: {
        method: 'POST',
        path: '/api/modules/mailing/tasks',
        fills: ['message', 'promptIndex', 'promptOverrides'],
      },
      params: ['message', 'promptIndex', 'promptOverrides'],
    },
    {
      id: 'limits',
      title: 'Limits',
      purpose: 'How many messages does one account send?',
      howItWorks:
        'The task does not have a general limit - it ends when the list of goals ends. Limit'
        + 'You can only load the account; if not specified, the daily drug limit from the security settings works.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: [] },
      params: [],
    },
    {
      id: 'performance',
      title: 'Parallelism',
      purpose: 'How many streams are sent simultaneously?',
      howItWorks:
        'Both the list of goals and accounts are divided between threads in a circle. There are no more streams than allowed'
        + 'accounts. The starts of threads are separated by a random pause - a simultaneous salvo reads like a farm.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: [] },
      params: [],
    },
    {
      id: 'protection',
      title: 'Account protection',
      purpose: 'Delay multiplier.',
      howItWorks: 'The protection level increases the pauses between sendings. The module has no probability - we write to everyone on the list.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: [] },
      params: [],
    },
    {
      id: 'timings',
      title: 'Timings and delays',
      purpose: 'Pauses between messages and behavior during FloodWait.',
      howItWorks:
        'The default is 90–300 seconds—three times longer than other modules. This is not reinsurance:'
        + 'Frequent messages to strangers are monitored most strictly by Telegram.',
      api: { method: 'POST', path: '/api/modules/mailing/tasks', fills: ['delays'] },
      params: ['delays'],
    },
  ],

  params: [
    {
      name: 'message',
      block: 'message',
      title: 'Message text',
      type: 'string',
      default: '',
      aliases: ['promptText'],
      purpose: 'The first message template is the same for all recipients.',
      constraints: [
        'priority of text sources: this template → first messages from the target → AI generation',
        'if it is empty and there are no messages in the target or AI generation enabled, the task does not start',
        'the server accepts both promptText: they are the same field',
      ],
      examples: ['Hello! I saw your profile - I have a quick question, is it convenient?'],
      storedAs: 'task.settings.message (server accepts promptText)',
    },
    {
      name: 'promptIndex',
      block: 'message',
      title: 'Message tone',
      type: 'integer',
      default: 0,
      enum: [
        { value: 0, label: 'Positive', means: 'Friendly treatment.' },
        { value: 1, label: 'Intimate', means: 'Personal, confidential tone.' },
        { value: 2, label: 'Emotional response', means: 'Lively emotional appeal.' },
        { value: 3, label: 'Question to the interlocutor', means: 'Starting with a question increases the chance of an answer.' },
        { value: 4, label: 'Brief review', means: 'One or two sentences to the point.' },
        { value: 5, label: 'Analytical approach', means: 'Meaningful handling of the argument.' },
      ],
      purpose: 'Which prompt card is used in AI generation.',
      storedAs: 'task.settings.promptIndex',
    },
    {
      name: 'promptOverrides',
      block: 'message',
      title: 'Overriding Tone Cards',
      type: 'array',
      items: 'string',
      default: [],
      supersededBy: ['message'],
      purpose: 'Replace the text of specific tone cards during AI generation.',
      constraints: [
        'element index corresponds to promptIndex',
        'overlaps with a non-empty message: the specified template cancels the entire generation',
      ],
      seeAlso: ['promptIndex'],
      storedAs: 'task.settings.promptOverrides',
    },
    {
      name: 'delays',
      block: 'timings',
      title: 'Delays',
      type: 'object',
      purpose: 'The base intervals to which the protection and preset multipliers are applied.',
      constraints: [
        'the mailing pause is specified by the `dm` field; for compatibility, `action` is also accepted',
        'default values 90–300 s are intentionally three times higher than in other modules',
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
          purpose: 'Range [min, max] of pause between private messages.',
          constraints: ['the actual pause is random from the range × multipliers, but not less than 5 seconds'],
        },
        {
          name: 'action',
          title: 'Pause between messages (synonym)',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          unit: 's',
          purpose: 'Same as dm - used if dm is not specified.',
          constraints: ['left for compatibility with the general settings form; prefer dm'],
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
  ],

  presets: [
    {
      param: 'delayPreset',
      title: 'Tempo preset',
      source: 'server/lib/protection.js — PRESET_MUL',
      values: [
        { value: 0, label: 'Aggressive', multiplier: 0.6, means: 'Pauses ×0.6 - risky for cold drugs.', useWhen: 'expense accounts' },
        { value: 1, label: 'Balanced', multiplier: 1, means: 'Basic pauses are 90–300 s.', useWhen: 'regular mailing' },
        { value: 2, label: 'Conservative', multiplier: 1.8, means: 'Pauses ×1.8 – 3–9 minutes between messages.', useWhen: 'expensive accounts, first mailing' },
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
      title: 'Trial mailing to five numbers',
      when: 'first run, it is important to make sure that the numbers resolve and messages reach',
      input: {
        message: 'Hello! I saw your profile - I have a quick question, is it convenient?',
        delays: { dm: [90, 300], floodWait: 120, floodQuarantine: 3 },
      },
    },
    {
      title: 'Mailing with AI text tailored to each target',
      when: 'there is a goal and a knowledge base, we need different texts instead of a hundred identical ones',
      input: {
        promptIndex: 3,
        promptOverrides: ['Use a personal tone and ask a question'],
        delays: { dm: [120, 360], floodWait: 180, floodQuarantine: 2 },
      },
    },
  ],

  contract: {
    sources: [
      // goalExpired is NOT called by mailing The module does not have a deadline field, so promise
      // his “brains” are not allowed to: The campaign deadline will not stop this mailing. { file:'server/modules/workers.js', symbols: ['runMailing'] },
      { file: 'server/lib/accountRunner.js', symbols: ['handleFlood'] },
      { file: 'server/neuroCommenting/commentGenerator.js', symbols: ['resolveSystemPrompt'] },
    ],
    ignore: ['initiator', 'userId'],
  },
}
