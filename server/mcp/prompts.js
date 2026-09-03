/**
 * Промпты MCP — готовые рабочие процедуры, а не украшение.
 *
 * Раньше `prompts/list` отдавал пустой массив при объявленной возможности: клиент видел
 * «промпты есть» и не получал ни одного. Пустой список — это обещание без содержания.
 *
 * Что здесь лежит: последовательности, в которых модель ГАРАНТИРОВАННО не потратит
 * деньги впустую. Все четыре написаны от одной боли — «мозги» шли сразу в create_task,
 * не спросив схему, и получали либо отказ, либо задачу, которая делает не то.
 *
 * Формат — spec 2026-07-28 § Prompts: список описывает аргументы, `prompts/get`
 * возвращает готовые сообщения с подставленными значениями.
 */
import { listDescriptorKeys } from './descriptors/index.js'

const moduleList = () => listDescriptorKeys().join(', ')

/** Описания промптов для `prompts/list`. */
export const PROMPTS = [
  {
    name: 'plan_campaign',
    title: 'Plan a campaign from a goal',
    description:
      'Turn a business goal ("get 50 warm leads from crypto channels") into a validated, costed, ready-to-launch '
      + 'Murmex task. Picks the right module, fills its schema, validates and estimates before anything is spent.',
    arguments: [
      { name: 'goal', description: 'What the campaign must achieve, in plain language.', required: true },
      { name: 'targets', description: 'Channels, groups, usernames or phone numbers to work with, comma-separated.', required: false },
      { name: 'accounts', description: 'Account IDs to use. Omit to have the assistant ask for them.', required: false },
    ],
  },
  {
    name: 'configure_module',
    title: 'Configure one module correctly',
    description:
      'Walk the full schema of a single module and build a settings object that passes validation, with every '
      + 'conditional field and preset resolved. Use when the module is already chosen.',
    arguments: [
      { name: 'module', description: `Module key. One of: ${moduleList()}`, required: true },
      { name: 'intent', description: 'What this particular run should do differently from the defaults.', required: false },
    ],
  },
  {
    name: 'preflight_launch',
    title: 'Pre-flight check before a real launch',
    description:
      'The last gate before create_task: re-validate, read every warning, confirm cost and account safety. '
      + 'Run this whenever a task is about to touch live Telegram accounts.',
    arguments: [
      { name: 'module', description: 'Module key of the task about to run.', required: true },
      { name: 'settings', description: 'The draft settings as a JSON object.', required: true },
    ],
  },
  {
    name: 'diagnose_task',
    title: 'Diagnose a task that did little or nothing',
    description:
      'A task finished but produced few or zero actions. Work out which filter, limit, status or protection '
      + 'setting stopped it — instead of assuming the module is broken.',
    arguments: [
      { name: 'module', description: 'Module key that created the task.', required: true },
      { name: 'taskId', description: 'Task ID returned by create_task.', required: true },
    ],
  },
]

const text = (s) => ({ role: 'user', content: { type: 'text', text: s } })

/** Тела промптов. Каждый — пошаговый порядок вызовов, а не совет «будь внимателен». */
const BODIES = {
  plan_campaign: (a) => [
    text(
      `Goal: ${a.goal || '(not specified — ask the user before doing anything else)'}\n`
      + `Targets: ${a.targets || '(not specified)'}\n`
      + `Accounts: ${a.accounts || '(not specified)'}\n\n`
      + 'Plan and prepare a Murmex campaign for this goal. Follow exactly this order:\n\n'
      + '1. Call list_modules. Consider only modules with described = true.\n'
      + '2. Call describe_module on the two or three plausible candidates and read whoAmI.doesNot before '
      + 'whoAmI.does — the wrong module is usually one that also "writes text". State which module you chose and why.\n'
      + '3. Build a settings object using ONLY field names from that module\'s params. Apply a preset from presets '
      + 'rather than inventing delay numbers, and start from the most conservative protection level.\n'
      + '4. Call validate_task. Fix every error. Read every warning out loud to the user — a warning means a field '
      + 'you set will be silently ignored, which is how a campaign quietly does the wrong thing.\n'
      + '5. Call estimate_task with the planned number of actions and accounts. Report money and time.\n'
      + '6. STOP. Present the plan, the cost and the warnings, and ask the user to confirm. '
      + 'Do not call create_task until they say yes — it publishes to real Telegram accounts and spends real balance.',
    ),
  ],

  configure_module: (a) => [
    text(
      `Module: ${a.module || '(not specified)'}\n`
      + `Intent: ${a.intent || 'a safe default run'}\n\n`
      + 'Produce a settings object for this module that passes validation.\n\n'
      + '1. Call describe_module for the module. Read params in full — do not work from memory or from another '
      + 'module\'s field names; they differ per module.\n'
      + '2. For every parameter that has requiredWhen, check whether your intent triggers it.\n'
      + '3. For every parameter that has effectiveWhen, only set it if its condition holds. Setting it otherwise '
      + 'produces a warning and no effect.\n'
      + '4. Where a preset exists (delayPreset, protectionLevel), use it instead of hand-picking raw delays. '
      + 'The presets in the schema are verified against the server\'s real multipliers.\n'
      + '5. Call validate_task and iterate until valid: true with zero warnings, or until every remaining warning '
      + 'is one you can justify to the user.\n'
      + '6. Return the final settings object and a one-line explanation of each non-default field.',
    ),
  ],

  preflight_launch: (a) => [
    text(
      `Module: ${a.module || '(not specified)'}\n`
      + `Draft settings:\n${a.settings || '(not specified)'}\n\n`
      + 'This task is about to perform real actions on real Telegram accounts and spend real balance. '
      + 'Run the pre-flight check:\n\n'
      + '1. Call validate_task with these exact settings. If valid is false, stop and report — do not "fix and launch".\n'
      + '2. List every warning and say, for each, what the user will lose by ignoring it.\n'
      + '3. Call estimate_task for the intended volume. Report cost and the time window.\n'
      + '4. Confirm the account list is what the user intended: accounts are exclusive, so every account named here '
      + 'is blocked from every other task for the duration.\n'
      + '5. Re-read whoAmI.risks from describe_module and repeat the specific risk for this module.\n'
      + '6. Ask for explicit confirmation. Only then call create_task, and report the returned taskId immediately '
      + 'so the run can be followed with get_task or interrupted with stop_task.',
    ),
  ],

  diagnose_task: (a) => [
    text(
      `Module: ${a.module || '(not specified)'}\n`
      + `Task: ${a.taskId || '(not specified)'}\n\n`
      + 'This task produced fewer actions than expected. Find the cause before concluding anything is broken — '
      + 'in this platform a near-zero result is almost always a filter doing its job, and it is logged.\n\n'
      + '1. Call get_task. Read status, progress and the log tail. Every skip is logged with its reason.\n'
      + '2. Call describe_module and map each logged skip reason to the parameter that caused it.\n'
      + '3. Check the usual suspects in this order: account statuses (quarantine, spamblock, re-auth needed), '
      + 'accounts busy with another task, filters that eliminate candidates before generation (keywords, stop '
      + 'words, minimum length, probability, semantic threshold), per-account and daily limits, and the protection '
      + 'level, which caps both probability and speed.\n'
      + '4. Remember that the real target is a random number drawn from [min, max] per task, not the maximum — '
      + 'finishing below the maximum is normal, not a failure.\n'
      + '5. Report the specific parameter to change and by how much. Do not propose disabling protection as the '
      + 'first remedy: it trades account lifetime for throughput.',
    ),
  ],
}

/**
 * Собрать промпт с подставленными аргументами.
 * @returns {{description: string, messages: object[]}|null}
 */
export function getPrompt(name, args = {}) {
  const def = PROMPTS.find((p) => p.name === name)
  const body = BODIES[name]
  if (!def || !body) return null
  return { description: def.description, messages: body(args || {}) }
}
