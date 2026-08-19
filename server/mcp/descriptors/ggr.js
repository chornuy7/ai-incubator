/**
 * MCP-дескриптор модуля «AI Rating» (внутренний ключ `ggr`).
 *
 * Формат — docs/mcp/MCP-SPEC.md, правила правки — docs/mcp/MCP-CONTRIBUTING.md.
 *
 * Служебный модуль без настроек: он проверяет аккаунты, а не работает в Telegram по целям.
 *
 * Осторожно с «проверить все»: в воркере есть ветка «пустой список → взять все аккаунты,
 * кроме корзины», но ЧЕРЕЗ ШТАТНЫЙ ЗАПУСК она недостижима — `validateSettings` отклоняет
 * пустой `accountIds` у любого модуля («Выберите хотя бы один аккаунт»). Первая же версия
 * этого дескриптора обещала обратное, и живой `validate_task` это поймал. Описываем то,
 * что происходит на самом деле, а не то, что написано в одной ветке кода.
 */

/** @type {import('./index.js').ModuleDescriptor} */
export default {
  key: 'ggr',
  version: 1,
  title: 'AI Rating',
  platform: 'telegram',
  tags: ['rating', 'rating', 'account verification', 'health', 'trust', 'diagnostics'],

  whoAmI: {
    summary: 'Checks managed accounts and assigns each a quality rating based on profile and session status.',
    does: [
      'connects to each account and checks if the session is alive',
      'awards points for profile completeness - username, phone number',
      'flags accounts that require reauthorization',
      'does not change the status of punished accounts: quarantine, spamblock and ban remain as is',
    ],
    doesNot: [
      'does not perform any actions in Telegram: does not write, does not subscribe, does not watch',
      'does not work for purposes - the module does not have channels or groups',
      'does not affect accounts busy with another task: parallel login with the same session drops both'
      + 'tasks and looks like session hijacking to Telegram',
    ],
    requires: ['accounts with saved session; a proxy is desirable, but the check will work without it'],
    risks: 'Minimum: only login and read your own profile. Useful to run before combat missions.',
    costModel: 'Service check. AI tokens are not consumed.',
  },

  blocks: [
    {
      id: 'accounts',
      title: 'Select accounts',
      purpose: 'What accounts do we check?',
      howItWorks:
        'Accounts are verified one by one. Those busy with another task are skipped with a warning:'
        + 'Parallel login with the same session drops both tasks and looks like hijacking for Telegram.',
      api: { method: 'POST', path: '/api/modules/ggr/tasks', fills: ['accountIds'] },
      params: ['accountIds'],
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
      purpose: 'Account IDs for verification.',
      constraints: [
        'an empty list will NOT launch: “Select at least one account.” The worker has'
        + 'branch “empty → take all”, but it doesn’t reach it - the launch check is triggered earlier',
        'accounts busy with another task are skipped with a warning',
      ],
      examples: [['acc_1'], ['acc_1', 'acc_2']],
      storedAs: 'task.settings.accountIds',
    },
  ],

  presets: [],

  examples: [
    {
      title: 'Check out the entire park',
      when: 'before a big campaign, you need to understand which accounts are even alive',
      input: { accountIds: ['acc_1', 'acc_2', 'acc_3'] },
    },
    {
      title: 'Check specific accounts',
      when: 'I suspect that some of the sessions have fallen off',
      input: { accountIds: ['acc_1'] },
    },
  ],

  contract: {
    sources: [{ file: 'server/modules/workers.js', symbols: ['runGgr'] }],
    ignore: ['initiator', 'userId'],
  },
}
