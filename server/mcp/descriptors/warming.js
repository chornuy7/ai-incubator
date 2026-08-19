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
  title: 'Warming up',
  platform: 'telegram',
  tags: ['warming up', 'warming', 'warming up', 'account preparation', 'trust'],

  whoAmI: {
    summary: 'Simulates the live behavior of an account to increase its trust in Telegram before combat work.',
    does: [
      'he chooses the action according to a weighted proportion: viewing posts 40%, reactions 20%, reading dialogues 20%, introductions 10%, subscriptions 10%',
      'performs REAL actions - reactions and entries into public channels, and not imitation in logs',
      'works only in the daytime window 9:00–23:00: activity at night is indicated by the bot',
      'When the daily limit is reached, actions degrade into safe browsing',
    ],
    doesNot: [
      'does not work for your purposes: the module does not have channels or groups, it selects public platforms itself',
      'does not write text and does not contact AI',
      'does not allow you to select a specific action: the proportion is hardwired and changes only by level',
    ],
    requires: ['at least one account with a working proxy'],
    risks:
      'The risk is lower than that of combat modules, but the actions are real: too aggressive level at the new'
      + 'account has the opposite effect. Warming up COMPLETELY blocks the account for other modules -'
      + 'A profile occupied by warming up is not assigned to a combat mission.',
    costModel: 'Charged per action according to the price list of the module. AI tokens are not consumed.',
  },

  blocks: [
    {
      id: 'accounts',
      title: 'Select accounts',
      purpose: 'Which accounts are warming up?',
      howItWorks:
        'Accounts are moving in a circle. During warm-up, the profile is not available to other modules -'
        + 'This is a priority lock, not a regular lock.',
      api: { method: 'POST', path: '/api/modules/warming/tasks', fills: ['accountIds'] },
      params: ['accountIds'],
    },
    {
      id: 'level',
      title: 'Warm-up level',
      purpose: 'How quickly and intensely do we heat?',
      howItWorks:
        'Уровень задаёт и темп (множитель задержек), и суточную норму действий. Чем быстрее — '
        + 'the more actions per day and the more visible the account.',
      api: { method: 'POST', path: '/api/modules/warming/tasks', fills: ['warmLevel'] },
      params: ['warmLevel'],
    },
    {
      id: 'limits',
      title: 'Limits',
      purpose: 'How many actions to perform per task.',
      howItWorks:
        'The actual target is a random number from [min, max], determined by the task ID.'
        + 'On top of this is the daily level norm and the total daily account limit.',
      api: { method: 'POST', path: '/api/modules/warming/tasks', fills: ['maxActions', 'minActions'] },
      params: ['maxActions', 'minActions'],
    },
    {
      id: 'modes',
      title: 'Operating mode',
      purpose: 'Is the task limited by the number of actions or time?',
      howItWorks: 'Warming up is often timed: it should go on in the background for several days.',
      api: { method: 'POST', path: '/api/modules/warming/tasks', fills: ['workMode', 'durationMinutes'] },
      params: ['workMode', 'durationMinutes'],
    },
    {
      id: 'protection',
      title: 'Account protection',
      purpose: 'Additional delay multiplier on top of the warm-up level.',
      howItWorks: 'Total pause = base × protection multiplier × preset multiplier × warm-up level multiplier.',
      api: { method: 'POST', path: '/api/modules/warming/tasks', fills: ['protectionLevel', 'delayPreset'] },
      params: ['protectionLevel', 'delayPreset'],
    },
    {
      id: 'timings',
      title: 'FloodWait',
      purpose: 'Behavior under Telegram restrictions.',
      howItWorks: 'Pause for the duration of the flood plus a margin; after N in a row, the account goes into quarantine.',
      api: { method: 'POST', path: '/api/modules/warming/tasks', fills: ['delays'] },
      params: ['delays'],
    },
    {
      id: 'binding',
      title: 'Binding',
      purpose: 'When work stops.',
      howItWorks: 'An overdue deadline stops the warm-up that is already in progress.',
      api: { method: 'POST', path: '/api/modules/warming/tasks', fills: ['goalId', 'deadline'] },
      params: ['goalId', 'deadline'],
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
      purpose: 'IDs of accounts that are warming up.',
      constraints: ['empty list → refusal “Select at least one account”'],
      examples: [['acc_1'], ['acc_1', 'acc_2']],
      storedAs: 'task.settings.accountIds',
    },
    {
      name: 'warmLevel',
      block: 'level',
      title: 'Warm-up level',
      type: 'integer',
      default: 1,
      enum: [
        {
          value: 0,
          label: 'Fast (2 days)',
          means: 'Delays ×0.8, up to 40 actions per day. Fast, but the account is more visible - for those who need it urgently.',
        },
        {
          value: 1,
          label: 'Normal (3–7 days)',
          means: 'Delays ×1.3, up to 20 actions per day. Recommended mode.',
        },
        {
          value: 2,
          label: 'Standard (7–14 days)',
          means: 'Delays ×2.0, up to 10 actions per day. Slowly and as closely as possible similar to a living person.',
        },
      ],
      purpose: 'Warm-up rate and daily rate of action.',
      constraints: ['The level multiplier is multiplied with the protection and preset, rather than replacing them'],
      seeAlso: ['protectionLevel', 'delayPreset'],
      storedAs: 'task.settings.warmLevel',
    },
    {
      name: 'maxActions',
      block: 'limits',
      title: 'Max. actions',
      type: 'integer',
      default: 100,
      min: 1,
      aliases: ['maxComments'],
      purpose: 'Upper limit on the number of warm-up actions per task.',
      constraints: ['must be ≥ minActions', 'does not cancel the daily level norm'],
      examples: [40, 200],
      seeAlso: ['minActions', 'warmLevel'],
      storedAs: 'task.settings.maxActions',
    },
    {
      name: 'minActions',
      block: 'limits',
      title: 'Min. actions',
      type: 'integer',
      default: 0,
      min: 0,
      aliases: ['minComments'],
      purpose: 'The lower bound of the goal of the task.',
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
        { value: 0, label: 'By quantity', means: 'Until the goal for the number of actions is achieved.' },
        { value: 1, label: 'By time', means: 'Until durationMinutes expires.' },
      ],
      purpose: 'What is the limitation of the task?',
      constraints: ['when workMode = 1 durationMinutes is required'],
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
      purpose: 'How long does the task heat up accounts?',
      constraints: [
        'is treated as MAXIMUM: the actual duration is a random number from [min, durationMinutes],'
        + 'where min sets the protection level (60 / 45 / 30 minutes)',
        'outside the window 9:00–23:00 actions are not performed in any case',
      ],
      examples: [480, 1440],
      seeAlso: ['workMode', 'protectionLevel'],
      storedAs: 'task.settings.durationMinutes',
    },
    {
      name: 'protectionLevel',
      block: 'protection',
      title: 'Protection level',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Conservative', means: 'Delays ×1.8, minimum duration 60 min.' },
        { value: 1, label: 'Balanced', means: 'Delays ×1, minimum duration 45 min.' },
        { value: 2, label: 'Aggressive', means: 'Delays ×0.75, minimum duration 30 min.' },
      ],
      purpose: 'Extra caution on top of the warm-up level.',
      constraints: ['ATTENTION: the numbering is REVERSED delayPreset - here 0 is the safest'],
      seeAlso: ['warmLevel', 'delayPreset'],
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
      purpose: 'Another delay multiplier.',
      constraints: ['ВНИМАНИЕ: нумерация ОБРАТНА protectionLevel — здесь 0 самый быстрый'],
      seeAlso: ['protectionLevel', 'warmLevel'],
      storedAs: 'task.settings.delayPreset',
    },
    {
      name: 'delays',
      block: 'timings',
      title: 'Delays',
      type: 'object',
      purpose: 'Behavior during FloodWait.',
      constraints: [
        'pauses between warm-up actions are set by level and multipliers, and not by this field -'
        + 'here is only a reaction to Telegram restrictions',
      ],
      properties: [
        {
          name: 'floodWait',
          title: 'Stock after FloodWait',
          type: 'number',
          default: 120,
          min: 0,
          unit: 'With',
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
      purpose: 'The goal to which the task formally relates.',
      constraints: ['does not affect warm-up behavior - used for deadlines and reporting'],
      seeAlso: ['deadline'],
      storedAs: 'task.settings.goalId',
    },
    {
      name: 'deadline',
      block: 'binding',
      title: 'Deadline',
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      purpose: 'Date after which heating stops.',
      constraints: ['format YYYY-MM-DD', 'stops an ALREADY RUNNING task'],
      examples: ['2026-09-01'],
      seeAlso: ['goalId'],
      storedAs: 'task.settings.deadline',
    },
  ],

  presets: [
    {
      param: 'warmLevel',
      title: 'Warm-up level',
      source: 'server/lib/workerLoop.js — warmingPace',
      values: [
        { value: 0, label: 'Fast (2 days)', multiplier: 0.8, actionsPerDay: 40, means: 'Задержки ×0.8, 40 действий в день.', useWhen: 'I need an account urgently' },
        { value: 1, label: 'Normal (3–7 days)', multiplier: 1.3, actionsPerDay: 20, means: 'Delays ×1.3, 20 actions per day.', useWhen: 'common case' },
        { value: 2, label: 'Standard (7–14 days)', multiplier: 2.0, actionsPerDay: 10, means: 'Delays ×2.0, 10 actions per day.', useWhen: 'Dear accounts, no hurry' },
      ],
    },
    {
      param: 'protectionLevel',
      title: 'Protection level',
      source: 'server/lib/protection.js — LEVEL_MUL; server/lib/workModeDuration.js',
      values: [
        { value: 0, label: 'Conservative', multiplier: 1.8, minDurationMinutes: 60, means: 'Delays ×1.8.' },
        { value: 1, label: 'Balanced', multiplier: 1, minDurationMinutes: 45, means: 'Delays ×1.' },
        { value: 2, label: 'Aggressive', multiplier: 0.75, minDurationMinutes: 30, means: 'Delays ×0.75.' },
      ],
    },
  ],

  examples: [
    {
      title: 'Long warm-up time for new accounts',
      when: 'accounts have just been purchased, there is combat work ahead',
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
      title: 'Urgent warm-up before launch',
      when: 'I need the account to work in a couple of days',
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
