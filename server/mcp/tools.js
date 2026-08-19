/**
 * Инструменты MCP-сервера Murmex.
 *
 * Разделение намеренное: описание (`describe_*`) отдельно от проверки (`validate_task`),
 * проверка — отдельно от запуска (`create_task`). «Мозги» должны уметь собрать черновик,
 * убедиться, что он валиден, узнать цену — и только потом тратить деньги и аккаунты.
 * Раньше единственным способом проверить настройки был реальный запуск в Telegram.
 */
import { MODULE_DEFS, getModuleStore, startModuleTask, validateSettings } from '../modules/registry.js'
import { moduleTitle } from '../lib/moduleTitles.js'
import {
  DESCRIPTORS, describeModule, getDescriptor, listDescriptorKeys, summarizeModule, buildInputSchema,
} from './descriptors/index.js'
import { validateAgainstSchema, validateDescriptorRules } from './validate.js'

/** Ошибка инструмента: доезжает до клиента как isError, а не как падение сервера. */
export class ToolError extends Error {}

const moduleEnum = () => listDescriptorKeys()

function requireDescribed(key) {
  if (!MODULE_DEFS[key]) throw new ToolError(`Unknown module "${key}". Available: ${Object.keys(MODULE_DEFS).join(', ')}`)
  const desc = getDescriptor(key)
  if (!desc) {
    throw new ToolError(
      `Module diagram "${key}" has not yet been described - it cannot be used via MCP yet.`
      + ` Described modules: ${listDescriptorKeys().join(', ')}.`,
    )
  }
  return desc
}

/** Описания инструментов для tools/list. */
export const TOOLS = [
  {
    name: 'list_modules',
    title: 'List of modules',
    description:
      'List the platform modules with a brief description and a flag showing whether the schema is fully described.'
      + ' Key words: modules, capabilities, catalog, list.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'describe_module',
    title: 'Module description',
    description:
      'Comprehensive description of the module: purpose (what it does and does NOT do), interface blocks,'
      + 'ALL parameters for creating a task with limitations and examples, decoding of presets and ready-made launch scripts.'
      + 'Key words: scheme, parameters, restrictions, presets, schema, params, limits.',
    inputSchema: {
      type: 'object',
      properties: { module: { type: 'string', description: `Module key. With the scheme:${moduleEnum().join(', ')}` } },
      required: ['module'],
      additionalProperties: false,
    },
  },
  {
    name: 'describe_block',
    title: 'Block help',
    description:
      'What a given module block does, how it works, which parameters it contains, which API it calls,'
      + ' and which fields it fills. Key words: help, block, parameters, API, support.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: `Module key. Available modules: ${moduleEnum().join(', ')}` },
        block: { type: 'string', description: 'Block ID from describe_module' },
      },
      required: ['module', 'block'],
      additionalProperties: false,
    },
  },
  {
    name: 'validate_task',
    title: 'Check draft task',
    description:
      'Check the task settings against the module schema and the real launch rules - WITHOUT creating a task,'
      + ' without debiting money or contacting Telegram. Returns a list of errors showing the field and warnings'
      + ' about settings that are set but will not work. Key words: check, validation, dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: `Module key. Available modules: ${moduleEnum().join(', ')}` },
        settings: { type: 'object', description: 'Draft task settings' },
      },
      required: ['module', 'settings'],
      additionalProperties: false,
    },
  },
  {
    name: 'estimate_task',
    title: 'Estimate cost and time',
    description:
      'How much will be debited and how long the task will take for a given number of actions and accounts.'
      + ' Calculated before launch. Key words: price, cost, time, estimate.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Module key' },
        actions: { type: 'integer', description: 'How many actions are planned', minimum: 0 },
        accounts: { type: 'integer', description: 'How many accounts share the work?', minimum: 1, default: 1 },
      },
      required: ['module', 'actions'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task',
    title: 'Task Status',
    description:
      'What happened to a previously created task: status, progress, who launched it, and the latest log entries.'
      + ' Key words: status, progress, logs, task.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Key of the module that created the task' },
        taskId: { type: 'string', description: 'ID from create_task response' },
      },
      required: ['module', 'taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_task',
    title: 'Stop task',
    description:
      'Stop a running task. Actions already taken are not canceled; Telegram does not roll back them.'
      + ' Key words: stop, cancel, interrupt.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Key of the module that created the task' },
        taskId: { type: 'string', description: 'ID from create_task response' },
      },
      required: ['module', 'taskId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'create_task',
    title: 'Create and run a task',
    description:
      'Create and run a module task. ACTION IS REAL: real operations are performed in Telegram and funds are debited.'
      + ' Before calling, be sure to run validate_task. Only accounts available to the current user are accepted.'
      + ' Key words: launch, start, create a task, run.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: `Module key. Available modules: ${moduleEnum().join(', ')}` },
        settings: { type: 'object', description: 'Task settings - according to the schema from describe_module' },
      },
      required: ['module', 'settings'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
]

/** Реализации. Каждая возвращает объект — он уедет и текстом, и структурой. */
const HANDLERS = {
  list_modules() {
    const modules = Object.keys(MODULE_DEFS).map((key) => (
      summarizeModule(key) || {
        key, title: moduleTitle(key), described: false,
        note: 'The module is not described and is not available through MCP',
      }
    ))
    return {
      described: listDescriptorKeys().length,
      total: modules.length,
      modules,
      // Прямо говорим, чему верить: раньше неописанные модули выглядели так же полно,
      // как описанные, и оркестратор принимал 5 полей за исчерпывающий список.
      note: 'Only modules with described = true are reliable; for the others, the field list is incomplete.',
    }
  },

  describe_module({ module }) {
    requireDescribed(module)
    return describeModule(module)
  },

  describe_block({ module, block }) {
    requireDescribed(module)
    const full = describeModule(module)
    const found = full.blocks.find((b) => b.id === block)
    if (!found) {
      throw new ToolError(`Block "${block}" not found for module "${module}". Available: ${full.blocks.map((b) => b.id).join(', ')}`)
    }
    return { module, ...found }
  },

  validate_task({ module, settings }) {
    const desc = requireDescribed(module)
    const schemaErrors = validateAgainstSchema(buildInputSchema(desc), settings || {})
    const { errors: ruleErrors, warnings } = validateDescriptorRules(desc, settings || {})

    // Помимо схемы прогоняем НАСТОЯЩУЮ проверку запуска: часть правил (min > max,
    // обязательные цели) живёт в ней, и схема их не воспроизводит. Иначе «мозги»
    // получили бы «всё в порядке» на задаче, которую сервер откажется запускать.
    const runtime = []
    if (!schemaErrors.length && !ruleErrors.length) {
      const err = validateSettings(module, settings || {})
      if (err) runtime.push({ path: '', message: err })
    }

    const errors = [...schemaErrors, ...ruleErrors, ...runtime]
    return {
      module,
      valid: errors.length === 0,
      errors,
      warnings,
      summary: errors.length
        ? `The task cannot be started: ${errors.length} error(s)${warnings.length ? ` and ${warnings.length} warning(s)` : ''}.`
        : `The task is valid${warnings.length ? `, but there are ${warnings.length} warning(s) — some settings will not take effect.` : '.'}`,
    }
  },

  async estimate_task({ module, actions, accounts }) {
    if (!MODULE_DEFS[module]) throw new ToolError(`Unknown module "${module}"`)
    const n = Math.max(0, Math.round(Number(actions) || 0))
    const acc = Math.max(1, Math.round(Number(accounts) || 1))
    const { effectivePrices } = await import('../priceStore.js')
    const eff = await effectivePrices()
    const perAction = eff.actionMap[module] || 0
    const perAcc = Math.ceil(n / acc)
    return {
      module,
      actions: n,
      accounts: acc,
      cost: {
        perAction,
        actionsCoins: Math.round(perAction * n * 1000) / 1000,
        currency: eff.currency || '$',
        note: 'Text generation is included in the price of the action. Image analysis is billed separately after the fact.',
      },
      time: {
        perAccount: perAcc,
        minSec: perAcc * 30,
        maxSec: perAcc * 120,
        note: 'Estimated based on basic delays 30–120 s. Tempo preset and protection level change it by a multiplier.',
      },
    }
  },

  /**
   * Без этого «мозги» умели запускать задачу и не умели узнать, чем она кончилась:
   * create_task возвращал REST-путь, закрытый сессией. Дыра нашлась на первом же
   * живом прогоне через протокол.
   */
  async get_task({ module, taskId }) {
    const store = getModuleStore(module)
    if (!store) throw new ToolError(`Unknown module "${module}"`)
    const task = await store.loadTask(taskId)
    if (!task) throw new ToolError(`Task "${taskId}" for module "${module}" not found`)
    return {
      taskId: task.id,
      module,
      status: task.status,
      initiator: task.settings?.initiator || 'operator',
      progress: task.progress || null,
      startedAt: task.startedAt || null,
      updatedAt: task.updatedAt || null,
      // Лог обрезаем: «мозгам» нужен хвост, а не весь журнал на сотни строк.
      logs: (task.logs || []).slice(-20).map((l) => ({ level: l.level, message: l.message, account: l.account || null })),
    }
  },

  /**
   * Запустить и не иметь возможности остановить — худшая комбинация прав для
   * оркестратора, поэтому стоп идёт в том же наборе, что и запуск.
   */
  async stop_task({ module, taskId }) {
    const store = getModuleStore(module)
    if (!store) throw new ToolError(`Unknown module "${module}"`)
    const task = await store.loadTask(taskId)
    if (!task) throw new ToolError(`Task "${taskId}" for module "${module}" not found`)
    const { stopWorker } = await import('../modules/workers.js')
    await stopWorker(taskId, store)
    const after = await store.loadTask(taskId)
    return {
      taskId,
      module,
      status: after?.status || 'stopped',
      note: 'The task has stopped. Actions already taken in Telegram are not canceled.',
    }
  },

  async create_task({ module, settings }, ctx) {
    const desc = requireDescribed(module)

    // Валидируем ТЕМ ЖЕ кодом, что и validate_task: расхождение между «проверил» и
    // «запустил» — худшее, что можно сделать с оркестратором.
    const check = HANDLERS.validate_task({ module, settings })
    if (!check.valid) {
      throw new ToolError(`The task failed verification. ${check.errors.map((e) => `${e.path || 'settings'}: ${e.message}`).join('; ')}`)
    }

    const accountIds = Array.isArray(settings?.accountIds) ? settings.accountIds : []
    const { canSeeAccount } = await import('../lib/accessGuard.js')
    for (const id of accountIds) {
      if (!(await canSeeAccount(ctx.req, id))) throw new ToolError(`Account ${id} is not available to the user of this key`)
    }

    // Помечаем происхождение: задача «под MCP» не должна незаметно правиться руками —
    // иначе «мозги» продолжают считать, что она идёт по их плану (MR-148).
    const payload = { ...settings, accountIds, initiator: 'mcp' }
    const { store, task, worker } = startModuleTask(module, payload)
    // Сохранить ОБЯЗАТЕЛЬНО до старта: startWorker поднимает задачу из хранилища по id,
    // и без записи он молча не находит ничего. Задача «создавалась», получала id и
    // никогда не выполнялась — нашлось на первом живом прогоне через протокол.
    await store.saveTask(task)
    const { startWorker } = await import('../modules/workers.js')
    startWorker(task.id, store, worker)

    return {
      taskId: task.id,
      module,
      status: task.status,
      schemaVersion: desc.version,
      warnings: check.warnings,
      note: 'The task has started. Progress and logs: GET /api/modules/' + module + '/tasks/' + task.id,
    }
  },
}

export async function callTool(name, args, ctx) {
  const handler = HANDLERS[name]
  if (!handler) throw new ToolError(`Unknown tool "${name}"`)

  const def = TOOLS.find((t) => t.name === name)
  const argErrors = validateAgainstSchema(def.inputSchema, args || {})
  if (argErrors.length) {
    throw new ToolError(`Invalid arguments: ${argErrors.map((e) => `${e.path || 'input'} — ${e.message}`).join('; ')}`)
  }
  return handler(args || {}, ctx || {})
}

export { DESCRIPTORS }
