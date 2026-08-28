/**
 * MCP-дескриптор модуля «Нейрокомментинг».
 *
 * Это НЕ документация о коде — это источник правды. Отсюда собираются: `inputSchema`
 * для MCP-инструмента, ответ `/api/v1/modules/neuro-commenting/describe`, help по блокам.
 * Contract-тест (`server/__tests__/mcpDescriptors.test.js`) сверяет список ниже с полями,
 * которые реально читает воркер, — рассинхрон роняет тесты.
 *
 * Причина такой строгости: манифест `/api/v1/mcp` обещал «мозгам» 5 полей на модуль при
 * реальных 32, и оркестратор по нему собирал нерабочие задачи (созвон 14.08).
 *
 * Формат — docs/mcp/MCP-SPEC.md. Человекочитаемая карта — docs/mcp/MCP-MAP.md.
 */

/** @type {import('./index.js').ModuleDescriptor} */
export default {
  key: 'neuro-commenting',
  version: 1,
  // Генерирует текст через ИИ — на этих модулях расход на ИИ реален.
  usesAi: true,
  title: 'Neurocommenting',
  platform: 'telegram',
  // Штатного поля тегов в протоколе MCP нет: теги едут полем описания модуля
  // (`describe_module`, `list_modules`, ресурс `murmex://module/…`), а ключевые слова
  // дополнительно продублированы в description инструментов — поиск ищет по ним.
  // Дубликаты и разный регистр запрещены: это половина поискового индекса.
  tags: ['comments', 'commenting', 'channels', 'posts', 'ai', 'engagement', 'reach'],

  whoAmI: {
    summary: 'Writes AI comments under posts of public channels on behalf of managed Telegram accounts.',
    does: [
      'subscribes to the channel and its discussion group if the account is not already subscribed',
      'takes the window of recent posts and selects those that are suitable by mode and filters',
      'generates comment text by the model taking into account the goal, knowledge base and agent',
      'publishes a comment and records it in the logs and task history',
    ],
    doesNot: [
      'does not write in private messages - these are the “Mailing” and “Neurodialogues” modules',
      'does not post to his own channels - this is “Autoposting”',
      'does not put reactions - these are “Mass reactions”',
    ],
    requires: [
      'at least one account in a working status with a working proxy',
      'at least one target channel',
    ],
    risks:
      'Real publications on Telegram. Too short delays and high probability → FloodWait → '
      + 'account quarantine → spamblock. New accounts should start with conservative settings. '
      + 'If the model provider fails fatally, the task stops instead of falling back to template text: '
      + 'a hundred identical template comments from live accounts is worse than a halted task.',
    costModel:
      'Charged per action according to the price list of the module; text generation is included in the price of the action. '
      + 'Analysis of pictures (analyzeImages) is billed separately with the imageMultiplier multiplier and only '
      + 'after successfully submitting a comment.'
      + 'AI generation runs on model access provided by the platform: the caller supplies no key, token or provider credential, and there is no field for one — it works out of the box.',
  },

  blocks: [
    {
      id: 'accounts',
      title: 'Select accounts',
      purpose: 'Which managed accounts perform the task.',
      howItWorks:
        'Accounts move in a circle and divide the work among themselves. Account busy with another task '
        + 'not issued (one account = one task). Accounts in quarantine, spamblock, invalid, '
        + "frozen and requiring re-authorization are skipped and recorded in the log. If it's a full circle "
        + 'accounts turned out to be unavailable, the task is completed correctly indicating the reason.',
      api: { method: 'POST', path: '/api/modules/neuro-commenting/tasks', fills: ['accountIds'] },
      params: ['accountIds'],
    },
    {
      id: 'targets',
      title: 'Channels',
      purpose: 'Where do we comment and what depth of the channel’s history are we considering.',
      howItWorks:
        'At each iteration, a channel is selected randomly from the list. Before the first action, account '
        + 'joins the channel and its discussion group. Targets from the blacklist are eliminated before any action is taken.',
      api: { method: 'POST', path: '/api/modules/neuro-commenting/tasks', fills: ['channels', 'postWindow'] },
      params: ['channels', 'postWindow'],
    },
    {
      id: 'modes',
      title: 'Modes',
      purpose: 'How a post is selected for commenting and whether the task is limited by quantity or time.',
      howItWorks:
        'The comment mode decides how many posts from the window become candidates. Post filter '
        + 'additionally cuts off based on novelty. The operating mode determines the condition for completing the task.',
      api: { method: 'POST', path: '/api/modules/neuro-commenting/tasks', fills: ['commentMode', 'workMode', 'postFilter', 'lastPostsCount', 'pickOne'] },
      params: ['commentMode', 'workMode', 'postFilter', 'lastPostsCount', 'pickOne'],
    },
    {
      id: 'filters',
      title: 'Post filters',
      purpose: 'Screening of posts BEFORE text generation: according to words, volume, probability and semantic proximity to the goal.',
      howItWorks:
        'Elimination order: minimum words → keywords (only in “By Keywords” mode) → '
        + 'stop words → novelty filter → probability → semantics. Each step writes to the log the reason for the omission, '
        + 'so that a zero result is not read as a breakdown.',
      api: {
        method: 'POST',
        path: '/api/modules/neuro-commenting/tasks',
        fills: ['keywords', 'stopWords', 'minWords', 'probability', 'semanticFilter', 'semanticThreshold'],
      },
      params: ['keywords', 'stopWords', 'minWords', 'probability', 'semanticFilter', 'semanticThreshold'],
    },
    {
      id: 'limits',
      title: 'Limits',
      purpose: 'How many actions to do in total and how many per account; when working by time - duration.',
      howItWorks:
        'The actual goal of the task is a random number from the range [min, max], determined by the task ID. '
        + 'Two tasks with the same settings will receive different goals: even round numbers indicate automation. '
        + 'Progress is counted towards this goal, not towards the maximum.',
      api: {
        method: 'POST',
        path: '/api/modules/neuro-commenting/tasks',
        fills: ['maxComments', 'minComments', 'maxPerAccount', 'minPerAccount', 'durationMinutes'],
      },
      params: ['maxComments', 'minComments', 'maxPerAccount', 'minPerAccount', 'durationMinutes'],
    },
    {
      id: 'prompts',
      title: 'Prompts and generation',
      purpose: 'In what tone and what template is the comment written?',
      howItWorks:
        'Priority of prompt text sources: promptText (your text) → promptOverrides[promptIndex] → '
        + 'built-in card promptIndex. If the distribution typeWeights is specified, the type is selected as weighted '
        + 'by lot for each comment and promptIndex is not used. The global one is always added on top '
        + 'system prompt, target context with knowledge base and agent context.',
      api: {
        method: 'POST',
        path: '/api/modules/neuro-commenting/tasks',
        fills: ['promptIndex', 'promptText', 'promptOverrides', 'typeWeights', 'analyzeImages'],
      },
      params: ['promptIndex', 'promptText', 'promptOverrides', 'typeWeights', 'analyzeImages'],
    },
    {
      id: 'protection',
      title: 'Account protection',
      purpose: 'Delay multiplier and upper ceiling on action probability.',
      howItWorks:
        'The protection level multiplies all delays and limits the probability from above. He also sets the lower '
        + 'duration limit when working on time (conservative 60 minutes, balanced 45, aggressive 30).',
      api: { method: 'POST', path: '/api/modules/neuro-commenting/tasks', fills: ['aiProtection', 'protectionLevel'] },
      params: ['aiProtection', 'protectionLevel'],
    },
    {
      id: 'timings',
      title: 'Timings and delays',
      purpose: 'Pauses between actions and behavior during FloodWait.',
      howItWorks:
        'Total pause = random number from the range × defense level multiplier × tempo preset multiplier, '
        + 'but not less than 5 seconds. There are no even intervals - bots are calculated using them.',
      api: { method: 'POST', path: '/api/modules/neuro-commenting/tasks', fills: ['delayPreset', 'delays'] },
      params: ['delayPreset', 'delays'],
    },
    {
      id: 'binding',
      title: 'Binding',
      purpose: 'Which goal, campaign, and agent the task belongs to.',
      howItWorks:
        'The target mixes its text and knowledge base into the system prompt and turns on the semantic filter. '
        + 'An expired goal stops an already running task, not just new starts. Campaign needed '
        + 'for reporting and billing. The agent sets the tone, role, prohibitions and manner of communication.',
      api: { method: 'POST', path: '/api/modules/neuro-commenting/tasks', fills: ['goalId', 'campaignId', 'agentId', 'deadline'] },
      params: ['goalId', 'campaignId', 'agentId', 'deadline'],
    },
  ],

  params: [
    // ── accounts ──────────────────────────────────────────────────────────────
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
      examples: [['acc_1'], ['acc_1', 'acc_2', 'acc_3']],
      storedAs: 'task.settings.accountIds',
    },

    // ── targets ───────────────────────────────────────────────────────────────
    {
      name: 'channels',
      block: 'targets',
      title: 'Target channels',
      type: 'array',
      items: 'string',
      required: true,
      minItems: 1,
      aliases: ['targets'],
      purpose: 'Public channels under whose posts comments are published.',
      constraints: [
        'format: @username or https://t.me/<username>; leading @ is discarded',
        'channels from the blacklist are eliminated before any action is taken',
      ],
      examples: [['@durov'], ['https://t.me/telegram', '@durov']],
      storedAs: 'task.settings.channels (server accepts targets)',
    },
    {
      name: 'postWindow',
      block: 'targets',
      title: 'Posts window',
      type: 'integer',
      default: 20,
      min: 1,
      max: 50,
      purpose: 'How many recent channel posts to consider as candidates. Not all history is a window.',
      constraints: ['a value outside 1...50 is strictly brought to the limit, there will be no error'],
      examples: [5, 20, 50],
      storedAs: 'task.settings.postWindow',
    },

    // ── modes ─────────────────────────────────────────────────────────────────
    {
      name: 'commentMode',
      block: 'modes',
      title: 'Comment mode',
      type: 'integer',
      default: 2,
      enum: [
        { value: 0, label: 'Random', means: 'One random post is taken from the filtered candidates.' },
        { value: 1, label: 'By keywords', means: 'Only posts containing at least one word from the keywords remain.' },
        { value: 2, label: 'All posts', means: 'All window candidates that pass the filters are commented on.' },
      ],
      purpose: 'The rule by which candidates for comment are selected from the post window.',
      seeAlso: ['keywords', 'postWindow'],
      storedAs: 'task.settings.commentMode',
    },
    {
      name: 'workMode',
      block: 'modes',
      title: 'Operating mode',
      type: 'integer',
      default: 0,
      enum: [
        { value: 0, label: 'By quantity', means: 'The task continues until the goal for the number of comments is reached.' },
        { value: 1, label: 'By time', means: 'The task continues until durationMinutes expires.' },
      ],
      purpose: 'Is the task limited by the number of actions or time?',
      constraints: ['when workMode = 1 durationMinutes is required: otherwise the task does not have a termination condition'],
      seeAlso: ['durationMinutes', 'maxComments'],
      storedAs: 'task.settings.workMode',
    },
    {
      name: 'postFilter',
      block: 'modes',
      title: 'What posts to comment on',
      type: 'integer',
      default: 0,
      enum: [
        { value: 0, label: 'Only new ones', means: 'Only the most recent window post remains.' },
        { value: 1, label: 'Only existing ones', means: 'All window posts remain, EXCEPT the most recent one.' },
        { value: 2, label: 'All posts', means: 'The novelty filter is not applied.' },
      ],
      purpose: 'Additional screening of candidates based on the newness of the post.',
      storedAs: 'task.settings.postFilter',
    },
    {
      name: 'lastPostsCount',
      block: 'modes',
      title: 'Number of recent posts',
      type: 'integer',
      min: 1,
      max: 50,
      default: 3,
      purpose: 'Feed depth for postFilter = 3 (legacy path).',
      constraints: [
        'the UI NO LONGER sends this field: "last N posts" is postWindow, '
        + 'otherwise the form would carry two fields for the same thing (fixed 18.08). The worker still honours the value',
        'only works when postFilter = 3',
        'values outside 1-50 are clamped to the bounds; 0 and garbage fall back to 3',
        'N counts down the channel FEED, not the posts that passed the filters: otherwise strict keywords would drag "the last 3" deep into history',
      ],
      examples: [3, 5, 10],
      effectiveWhen: { field: 'postFilter', equals: 3 },
      seeAlso: ['postFilter'],
      storedAs: 'task.settings.lastPostsCount',
    },
    {
      name: 'pickOne',
      block: 'modes',
      title: 'One random post out of the suitable ones',
      type: 'boolean',
      default: true,
      purpose: 'HOW MANY of the suitable posts to comment on per pass: one at random, or all of them.',
      constraints: [
        'when the field is unset, the worker falls back to the legacy commentMode = 0, where randomness was hard-wired',
        'when off, ALL suitable posts are commented on in one pass; the task limits still apply',
      ],
      examples: [true, false],
      seeAlso: ['commentMode'],
      storedAs: 'task.settings.pickOne',
    },

    // ── filters ───────────────────────────────────────────────────────────────
    {
      name: 'keywords',
      block: 'filters',
      title: 'Keywords',
      type: 'array',
      items: 'string',
      default: [],
      purpose: 'Words by which posts are selected in the “By Keywords” mode.',
      effectiveWhen: { commentMode: 1 },
      constraints: [
        'work ONLY with commentMode = 1, in other modes they are ignored',
        'match by occurrence of a substring, case is not important',
        'empty list = filter does not cut anything',
      ],
      examples: [['crypt', 'bitcoin'], ['ai']],
      seeAlso: ['commentMode'],
      storedAs: 'task.settings.keywords',
    },
    {
      name: 'stopWords',
      block: 'filters',
      title: 'Safe words',
      type: 'array',
      items: 'string',
      default: [],
      purpose: 'Objectionable Topics and Tone: Posts containing any of these words will not be commented on.',
      constraints: ['work ALWAYS, regardless of commenting mode'],
      examples: [['policy', 'war']],
      storedAs: 'task.settings.stopWords',
    },
    {
      name: 'minWords',
      block: 'filters',
      title: 'Minimum words in a post',
      type: 'integer',
      default: 0,
      min: 0,
      purpose: 'Do not comment on posts that are too short - there is nothing substantive to say about them.',
      constraints: ['0 = filter disabled'],
      examples: [0, 5, 20],
      storedAs: 'task.settings.minWords',
    },
    {
      name: 'probability',
      block: 'filters',
      title: 'Likelihood of comment',
      type: 'integer',
      default: 30,
      min: 0,
      max: 100,
      unit: '%',
      purpose: 'The share of suitable posts on which the bot actually acts. The complete overkill looks machine-made.',
      constraints: [
        'with aiProtection = true, the ceiling is reduced by the level of protection: conservative ≤25%, balanced ≤45%, aggressive without limitation',
        'the given 80% with conservative protection will turn into 25% - this is not a bug',
      ],
      examples: [10, 30, 100],
      seeAlso: ['aiProtection', 'protectionLevel'],
      storedAs: 'task.settings.probability',
    },
    {
      name: 'semanticFilter',
      block: 'filters',
      title: 'Semantic filter to target',
      type: 'boolean',
      default: false,
      effectiveWhen: { goalId: '*' },
      purpose: 'Comment only on posts that are semantically close to the text of the goal.',
      constraints: [
        'requires goalId - without a selected goal, silently turns off and writes to the log',
        'if embeddings are not available, work continues without filter',
      ],
      seeAlso: ['goalId', 'semanticThreshold'],
      storedAs: 'task.settings.semanticFilter',
    },
    {
      name: 'semanticThreshold',
      block: 'filters',
      title: 'Threshold of intimacy',
      type: 'number',
      default: 0.2,
      min: 0,
      max: 1,
      effectiveWhen: { semanticFilter: true },
      purpose: 'The minimum cosine proximity of the post to the target, below which the post is skipped.',
      constraints: ['on live data: relevant post ≈0.52, offtopic ≈0.09 - threshold 0.2 cuts offtopic'],
      examples: [0.15, 0.2, 0.4],
      seeAlso: ['semanticFilter'],
      storedAs: 'task.settings.semanticThreshold',
    },

    // ── limits ────────────────────────────────────────────────────────────────
    {
      name: 'maxComments',
      block: 'limits',
      title: 'Max. comments',
      type: 'integer',
      default: 100,
      min: 1,
      aliases: ['maxActions'],
      purpose: 'The upper limit on the number of comments for the entire task.',
      constraints: ['must be ≥ minComments, otherwise the launch is rejected (“Minimum is greater than maximum”)'],
      examples: [5, 100, 1000],
      seeAlso: ['minComments', 'maxPerAccount'],
      storedAs: 'task.settings.maxComments (server accepts maxActions)',
    },
    {
      name: 'minComments',
      block: 'limits',
      title: 'Min. comments',
      type: 'integer',
      default: 0,
      min: 0,
      aliases: ['minActions'],
      purpose: 'The lower bound of the goal of the task. The actual target is a random number from [min, max].',
      constraints: [
        'must be ≤ maxComments',
        'the goal is determined by the task ID: the same run always gives the same number',
        'with maxComments ≥ 1 the goal cannot be zero',
      ],
      examples: [0, 20],
      seeAlso: ['maxComments'],
      storedAs: 'task.settings.minComments (server also accepts minActions)',
    },
    {
      name: 'maxPerAccount',
      block: 'limits',
      title: 'Max. to account',
      type: 'integer',
      default: 0,
      min: 0,
      purpose: 'Limit comments per account per task.',
      constraints: [
        '0 = no account restrictions',
        'must be ≥ minPerAccount',
        'Regardless of this, the daily limit §6 applies at the account level, common to all modules',
      ],
      examples: [0, 5, 20],
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
      purpose: 'The lower limit of the goal for one account (the same logic of a random number from the range).',
      constraints: ['must be ≤ maxPerAccount', 'only works when maxPerAccount > 0'],
      storedAs: 'task.settings.minPerAccount',
    },
    {
      name: 'durationMinutes',
      block: 'limits',
      title: 'Duration',
      type: 'integer',
      default: 60,
      min: 1,
      unit: 'min',
      requiredWhen: { workMode: 1 },
      effectiveWhen: { workMode: 1 },
      purpose: 'How long does the task run in the “Timed” mode?',
      constraints: [
        'ignored when workMode = 0',
        'is treated as MAXIMUM: the actual duration is a random number from [min, durationMinutes], '
        + 'where min specifies the level of protection (conservative 60, balanced 45, aggressive 30 minutes)',
      ],
      examples: [60, 180, 1440],
      seeAlso: ['workMode', 'protectionLevel'],
      storedAs: 'task.settings.durationMinutes',
    },

    // ── prompts ───────────────────────────────────────────────────────────────
    {
      name: 'promptIndex',
      block: 'prompts',
      title: 'Comment type',
      type: 'integer',
      default: 0,
      enum: [
        { value: 0, label: 'Positive comment', means: "Kind support for the author's thoughts." },
        { value: 1, label: 'Intimate', means: 'Personal, confidential tone.' },
        { value: 2, label: 'Emotional response', means: 'Expressing emotions about the post.' },
        { value: 3, label: 'Question to the author', means: 'A clarifying question provokes an answer and dialogue.' },
        { value: 4, label: 'Brief review', means: 'One or two sentences to the point.' },
        { value: 5, label: 'Analytical approach', means: 'Analysis is essentially an argument.' },
      ],
      supersededBy: ['promptText', 'typeWeights'],
      purpose: 'Which built-in prompt card is used to generate.',
      constraints: ['ignored if promptText or non-empty typeWeights is given'],
      seeAlso: ['promptText', 'promptOverrides', 'typeWeights'],
      storedAs: 'task.settings.promptIndex',
    },
    {
      name: 'promptText',
      block: 'prompts',
      title: 'Your system prompt',
      type: 'string',
      default: '',
      purpose: "The model's own instructions instead of the built-in card.",
      constraints: ['non-empty value has highest priority - overrides promptIndex and promptOverrides'],
      examples: ['Write briefly, in Russian, without emoji, maximum one sentence.'],
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
      constraints: ['element index corresponds to promptIndex; empty string = inline text is used'],
      storedAs: 'task.settings.promptOverrides',
    },
    {
      name: 'typeWeights',
      block: 'prompts',
      title: 'Type distribution, %',
      type: 'array',
      items: 'number',
      default: [],
      purpose: 'Mix comment types in a given proportion so that accounts do not write in the same tone.',
      constraints: [
        'element index corresponds to promptIndex',
        'if at least one weight > 0, promptIndex is NOT used - the type is chosen by weighted lottery for each comment',
        'weights are normalized automatically, the sum of 100 is not required',
      ],
      examples: [[50, 0, 0, 30, 20, 0]],
      seeAlso: ['promptIndex'],
      storedAs: 'task.settings.typeWeights',
    },
    {
      name: 'analyzeImages',
      block: 'prompts',
      title: 'Image Analysis',
      type: 'boolean',
      default: false,
      purpose: 'Describe the photo of the post by the model and comment on the essence of the image, and not on “[media]”.',
      constraints: [
        'billed separately with the imageMultiplier multiplier and only after successfully sending a comment',
        'does not affect the semantic filter - proximity is calculated based on the source text of the post',
      ],
      storedAs: 'task.settings.analyzeImages',
    },

    // ── protection ────────────────────────────────────────────────────────────
    {
      name: 'aiProtection',
      block: 'protection',
      title: 'AI protection',
      type: 'boolean',
      default: true,
      purpose: 'Includes a ceiling on the likelihood of actions by protection level.',
      constraints: ['off — probability is taken as specified, without ceiling'],
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
        {
          value: 0,
          label: 'Conservative',
          means: 'Delays ×1.8, probability not higher than 25%, minimum duration 60 minutes. Maximum security.',
        },
        {
          value: 1,
          label: 'Balanced',
          means: 'Delays ×1, probability not higher than 45%, minimum duration 45 minutes. Daily work mode.',
        },
        {
          value: 2,
          label: 'Aggressive',
          means: 'Delays ×0.75, probability unlimited, minimum duration 30 min. Fast and risky.',
        },
      ],
      purpose: 'How carefully the account behaves: delay multiplier and probability ceiling.',
      constraints: [
        'ATTENTION: the numbering is REVERSED delayPreset. Here 0 is the safest, delayPreset 0 is the fastest.',
      ],
      seeAlso: ['delayPreset', 'probability'],
      storedAs: 'task.settings.protectionLevel',
    },

    // ── timings ───────────────────────────────────────────────────────────────
    {
      name: 'delayPreset',
      block: 'timings',
      title: 'Tempo preset',
      type: 'integer',
      default: 1,
      enum: [
        { value: 0, label: 'Aggressive', means: 'Pauses ×0.6 (more often), duration ×0.75. Faster, higher chance of FloodWait.' },
        { value: 1, label: 'Balanced', means: 'Basic delays ×1. Recommended mode.' },
        { value: 2, label: 'Conservative', means: 'Pauses ×1.8 (less often), duration ×1.5. Slow and safe.' },
        { value: 3, label: 'Custom', means: 'Delays are taken as specified, without scaling. Only here the fields are unlocked in the interface.' },
      ],
      purpose: 'Scales all task delays.',
      constraints: [
        'ATTENTION: the numbering is REVERSED protectionLevel - here 0 is the fastest',
        'final multiplier = security level multiplier × preset multiplier × global AI security multiplier',
      ],
      seeAlso: ['protectionLevel', 'delays'],
      storedAs: 'task.settings.delayPreset',
    },
    {
      name: 'delays',
      block: 'timings',
      title: 'Delays',
      type: 'object',
      purpose: 'The base intervals to which the protection and preset multipliers are applied.',
      properties: [
        {
          name: 'comment',
          title: 'Pause between comments',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          default: [30, 120],
          unit: 's',
          purpose: 'Pause range [min, max] before publishing a comment.',
          constraints: ['the actual pause is random from the range × multipliers, but not less than 5 seconds'],
        },
        {
          name: 'join',
          title: 'Pause before introduction',
          type: 'array',
          items: 'number',
          minItems: 2,
          maxItems: 2,
          default: [84, 156],
          unit: 's',
          purpose: 'Range [min, max] of pause before joining a channel or discussion group.',
          constraints: [
            'hard floor 60 seconds: Telegram counts introductions separately and more harshly than other actions, '
            + 'it is impossible to speed them up with a preset - the aggressive settings multipliers were cut from 90–240 s to 32 s, '
            + 'after which the accounts went into FloodWait and quarantine',
          ],
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

    // ── binding ───────────────────────────────────────────────────────────────
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
      purpose: 'The goal towards which the work is being carried out: its text and knowledge base are mixed into the system prompt.',
      constraints: [
        'must exist; get the list - GET /api/v1/goals',
        'an expired goal stops an already running task, not just new starts',
      ],
      seeAlso: ['semanticFilter', 'campaignId'],
      storedAs: 'task.settings.goalId',
    },
    {
      name: 'campaignId',
      block: 'binding',
      title: 'Campaign',
      type: 'string',
      purpose: 'The campaign within which the task is taking place is needed for reporting and linking the consumption of tokens.',
      constraints: ['must exist; get the list - GET /api/v1/campaigns'],
      storedAs: 'task.settings.campaignId',
    },
    {
      name: 'agentId',
      block: 'binding',
      title: 'Agent',
      type: 'string',
      purpose: 'The agent sets the tone, role, prohibitions and manner of communication during generation.',
      constraints: ['without an agent, only the target context remains - generation works as before'],
      storedAs: 'task.settings.agentId',
    },
  ],

  presets: [
    {
      param: 'delayPreset',
      title: 'Tempo preset',
      source: 'server/lib/protection.js — PRESET_MUL, UI multipliers must match',
      values: [
        { value: 0, label: 'Aggressive', multiplier: 0.6, means: 'Pauses ×0.6, duration ×0.75.', useWhen: 'warmed up “expenditure” accounts' },
        { value: 1, label: 'Balanced', multiplier: 1, means: 'Basic delays.', useWhen: 'daily work' },
        { value: 2, label: 'Conservative', multiplier: 1.8, means: 'Pauses ×1.8, duration ×1.5.', useWhen: 'new and expensive accounts' },
        { value: 3, label: 'Custom', multiplier: 1, means: 'No scaling, values ​​as specified.', useWhen: 'manual fine tuning' },
      ],
    },
    {
      param: 'protectionLevel',
      title: 'Protection level',
      source: 'server/lib/protection.js — LEVEL_MUL + effectiveProbability; server/lib/workModeDuration.js — MIN_BY_PROTECTION_LEVEL',
      values: [
        { value: 0, label: 'Conservative', multiplier: 1.8, probabilityCap: 25, minDurationMinutes: 60, means: 'Delays ×1.8, probability ≤25%.' },
        { value: 1, label: 'Balanced', multiplier: 1, probabilityCap: 45, minDurationMinutes: 45, means: 'Delays ×1, probability ≤45%.' },
        { value: 2, label: 'Aggressive', multiplier: 0.75, probabilityCap: 100, minDurationMinutes: 30, means: 'Delays ×0.75, unlimited probability.' },
      ],
    },
  ],

  examples: [
    {
      title: 'Soft verification of the account + proxy combination',
      when: 'first run on a live channel, it’s important not to burn your account',
      input: {
        accountIds: ['acc_1'],
        channels: ['@durov'],
        commentMode: 0,
        postFilter: 0,
        maxComments: 3,
        maxPerAccount: 3,
        aiProtection: true,
        protectionLevel: 0,
        delayPreset: 2,
      },
    },
    {
      title: 'Thematic work on keywords to the goal',
      when: 'there is a goal and a knowledge base, you need to comment only on relevant posts',
      input: {
        accountIds: ['acc_1', 'acc_2'],
        channels: ['@crypto_channel', '@fintech_news'],
        commentMode: 1,
        keywords: ['crypt', 'bitcoin'],
        stopWords: ['policy'],
        postWindow: 30,
        minWords: 10,
        maxComments: 50,
        maxPerAccount: 25,
        probability: 40,
        goalId: 'goal_123',
        semanticFilter: true,
        semanticThreshold: 0.25,
        protectionLevel: 1,
        delayPreset: 1,
      },
    },
    {
      title: 'Timed work with mixed tone',
      when: 'you need to evenly distribute your activity over several hours',
      input: {
        accountIds: ['acc_1', 'acc_2', 'acc_3'],
        channels: ['@durov'],
        commentMode: 2,
        postFilter: 2,
        workMode: 1,
        durationMinutes: 240,
        typeWeights: [50, 0, 0, 30, 20, 0],
        protectionLevel: 1,
        delayPreset: 3,
        delays: { comment: [45, 180], join: [90, 200], floodWait: 150, floodQuarantine: 2 },
      },
    },
  ],

  /**
   * Где contract-тест ищет реальные обращения к настройкам. Если модуль начал читать поле
   * в новом месте — файл добавляется сюда, иначе тест это место просто не увидит.
   */
  contract: {
    sources: [
      { file: 'server/modules/workers.js', symbols: ['runNeuroCommenting', 'targets', 'goalExpired'] },
      { file: 'server/lib/workerLoop.js', symbols: ['pickCommentCandidates'] },
      { file: 'server/lib/targets.js', symbols: ['resolveTotalTarget', 'resolvePerAccountTarget'] },
      { file: 'server/lib/accountRunner.js', symbols: ['totalLimitReached', 'perAccountLimitReached', 'handleFlood'] },
      { file: 'server/lib/workModeDuration.js', symbols: ['resolveDurationPeriodMinutes'] },
      { file: 'server/neuroCommenting/commentGenerator.js', symbols: ['resolveSystemPrompt'] },
    ],
    /**
     * Служебные ключи задачи: их пишет платформа, а не оператор и не «мозги», поэтому в
     * MCP-схеме им не место — но воркер их читает, и без этого списка тест ругался бы.
     */
    ignore: ['initiator', 'userId'],
  },
}
