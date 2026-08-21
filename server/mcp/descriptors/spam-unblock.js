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
  // ИИ не участвует: генерации нет, токены модели не тратятся (см. costModel).
  usesAi: false,
  version: 1,
  title: 'Removing spamblock',
  platform: 'telegram',
  tags: ['spamblock', 'spamblock', 'unlocking', 'recovery', 'spambot'],

  whoAmI: {
    summary: 'Contacts @SpamBot on behalf of blocked accounts and asks to remove restrictions.',
    does: [
      'writes to @SpamBot in turn from each selected account',
      "parses the bot's response and determines whether restrictions have been lifted",
      'counts how many accounts the spam block was removed',
      'withstands random pauses between accounts',
    ],
    doesNot: [
      'does not guarantee withdrawal: the decision is made by Telegram, not us',
      'does not perform any other actions in Telegram',
      'does not work for purposes - the module does not have channels or groups',
    ],
    requires: ['accounts with a live session that are subject to restrictions'],
    risks:
      'Short. But repeating it too often is pointless: if the bot refuses, the spam block is removed'
      + 'in time, and repeated requests do not speed this up.',
    costModel: 'Service task. AI tokens are not consumed.',
  },

  blocks: [
    {
      id: 'accounts',
      title: 'Select accounts',
      purpose: 'Which accounts are we trying to unblock?',
      howItWorks: 'Accounts are processed strictly one at a time, one at a time - a salvo in @SpamBot makes no sense.',
      api: { method: 'POST', path: '/api/modules/spam-unblock/tasks', fills: ['accountIds'] },
      params: ['accountIds'],
    },
    {
      id: 'timings',
      title: 'Pauses between accounts',
      purpose: 'How long before I take on the next account?',
      howItWorks:
        'The pause is selected randomly from the range: an even interval between calls to one and'
        + 'to the same bot from different accounts it reads like a farm.',
      api: { method: 'POST', path: '/api/modules/spam-unblock/tasks', fills: ['delayMin', 'delayMax'] },
      params: ['delayMin', 'delayMax'],
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
      purpose: 'IDs of the accounts for which the removal of restrictions is requested.',
      constraints: ['processed one at a time, one at a time'],
      examples: [['acc_1'], ['acc_1', 'acc_2', 'acc_3']],
      storedAs: 'task.settings.accountIds',
    },
    {
      name: 'delayMin',
      block: 'timings',
      title: 'Min. pause',
      type: 'number',
      default: 30,
      min: 5,
      unit: 'With',
      purpose: 'The lower limit of the pause between accounts.',
      constraints: [
        'value below 5 seconds rises to 5',
        'this module has its own pause fields - there is no general delays structure here',
      ],
      examples: [30, 60],
      seeAlso: ['delayMax'],
      storedAs: 'task.settings.delayMin',
    },
    {
      name: 'delayMax',
      block: 'timings',
      title: 'Max. pause',
      type: 'number',
      default: 120,
      min: 5,
      unit: 'With',
      purpose: 'The upper limit of the pause between accounts.',
      constraints: ['if it is less than delayMin, it rises to it - the task will not fall, but there will be no scatter'],
      examples: [120, 300],
      seeAlso: ['delayMin'],
      storedAs: 'task.settings.delayMax',
    },
  ],

  presets: [],

  examples: [
    {
      title: 'Unblock multiple accounts',
      when: 'after a tough campaign, some accounts went to spamblock',
      input: { accountIds: ['acc_1', 'acc_2', 'acc_3'], delayMin: 60, delayMax: 300 },
    },
  ],

  contract: {
    sources: [{ file: 'server/spamUnblock.js', symbols: ['runSpamUnblock'] }],
    ignore: ['initiator', 'userId'],
  },
}
