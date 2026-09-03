/**
 * Инструменты MCP-сервера Murmex.
 *
 * Разделение намеренное: описание (`describe_*`) отдельно от проверки (`validate_task`),
 * проверка — отдельно от запуска (`create_task`). «Мозги» должны уметь собрать черновик,
 * убедиться, что он валиден, узнать цену — и только потом тратить деньги и аккаунты.
 * Раньше единственным способом проверить настройки был реальный запуск в Telegram.
 *
 * У КАЖДОГО инструмента есть `outputSchema`. Без него `structuredContent` — это JSON,
 * про который клиент не знает ничего: ни какие поля будут, ни какого они типа. Модель в
 * такой ситуации гадает по одному примеру ответа, а клиент не может провалидировать
 * результат. Схема выхода — половина контракта, и раньше её просто не было.
 */
import { MODULE_DEFS, getModuleStore, startModuleTask, validateSettingsDetailed } from '../modules/registry.js'
import { moduleTitle } from '../lib/moduleTitles.js'
import {
  DESCRIPTORS, describeModule, getDescriptor, listDescriptorKeys, summarizeModule, buildInputSchema,
} from './descriptors/index.js'
import { validateAgainstSchema, validateDescriptorRules } from './validate.js'

/** Ошибка инструмента: доезжает до клиента как isError, а не как падение сервера. */
export class ToolError extends Error {}

/** Модули со схемой — их можно описывать, проверять и запускать через MCP. */
const describedKeys = () => listDescriptorKeys()
/** Все модули платформы — у них можно спросить цену и статус задачи. */
const allKeys = () => Object.keys(MODULE_DEFS)

function requireDescribed(key) {
  if (!MODULE_DEFS[key]) {
    throw new ToolError(`Unknown module "${key}". Available modules: ${allKeys().join(', ')}.`)
  }
  const desc = getDescriptor(key)
  if (!desc) {
    throw new ToolError(
      `Module "${key}" exists but its schema has not been described yet, so it cannot be driven through MCP.`
      + ` Modules with a full schema: ${describedKeys().join(', ')}.`,
    )
  }
  return desc
}

// ── Переиспользуемые куски схем ────────────────────────────────────────────────

const moduleArg = (keys, extra = '') => ({
  type: 'string',
  enum: keys,
  description: `Module key.${extra ? ` ${extra}` : ''}`,
})

/** Одна запись об ошибке или предупреждении валидации. */
const ISSUE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Settings field the issue belongs to. Empty string means the settings object as a whole.' },
    code: { type: 'string', description: 'Machine-readable issue kind, e.g. required, enum, maximum, unknownField, ineffective, superseded.' },
    message: { type: 'string', description: 'What is wrong and what to do about it.' },
  },
  required: ['path', 'message'],
  additionalProperties: false,
}

/** Краткая карточка модуля в списке. */
const MODULE_CARD_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Module key to pass to every other tool.' },
    title: { type: 'string' },
    version: { type: 'integer', description: 'Schema version of this module descriptor.' },
    summary: { type: 'string', description: 'One sentence on what the module does.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Search keywords.' },
    usesAi: { type: 'boolean', description: 'Whether the module calls the model.' },
    paramCount: { type: 'integer', description: 'How many settings fields the module accepts.' },
    described: { type: 'boolean', description: 'True only if the schema is complete and can be trusted.' },
    note: { type: 'string', description: 'Present only when described is false.' },
  },
  required: ['key', 'described'],
  additionalProperties: true,
}

/** Доступ, посчитанный для владельца ключа. Общий кусок всех видов возможностей. */
const ACCESS_SCHEMA = {
  type: 'object',
  properties: {
    allowed: { type: 'boolean', description: 'False means calling it will be refused with 403. Plan around it instead of retrying.' },
    reason: { type: 'string', description: 'Why it is allowed or refused — role, subscription, or unrestricted key.' },
    blocks: { type: 'object', description: 'Per-block permissions inside a module (run, settings, targets, templates, results, logs).', additionalProperties: { type: 'boolean' } },
  },
  required: ['allowed'],
  additionalProperties: true,
}

/** Одна возможность любого вида. Поля различаются по kind — потому additionalProperties. */
const CAPABILITY_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['module', 'service', 'user'], description: 'Which kind of capability this is.' },
    key: { type: 'string', description: 'Identifier to pass to describe_capability, and for modules to every module tool.' },
    title: { type: 'string' },
    summary: { type: ['string', 'null'] },
    access: ACCESS_SCHEMA,
  },
  required: ['kind', 'key', 'title'],
  additionalProperties: true,
}

/** Описания инструментов для tools/list. Порядок детерминированный — спека просит именно так. */
export const TOOLS = [
  {
    name: 'list_capabilities',
    title: 'List capabilities',
    description:
      'Everything this key can touch, and whether it is actually ALLOWED to: campaign modules, platform services'
      + ' (proxies, account manager, tasks dashboard, statistics, goals, campaigns, CRM, channels, logs, automation,'
      + ' billing) and the permissions of the user the key acts as. Call this at the start of a session, or after any'
      + ' 403, before assuming something is broken. Narrow it with kind when you only need one slice.'
      + ' Keywords: capabilities, permissions, access, allowed, what can I do, 403, forbidden, services, subsystems.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['all', 'module', 'service', 'user'],
          default: 'all',
          description: 'Which slice to return. "all" gives modules + services + the key owner. "user" lists users — other people only if this key is admin or the service key.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        viewer: {
          type: 'object',
          description: 'Whose permissions the access fields were computed for.',
          properties: {
            id: { type: 'string' },
            isService: { type: 'boolean', description: 'True for the env service key, which is unrestricted.' },
            isAdmin: { type: 'boolean' },
            roleName: { type: 'string' },
          },
          additionalProperties: true,
        },
        counts: { type: 'object', additionalProperties: true },
        modules: { type: 'array', items: CAPABILITY_SCHEMA },
        services: { type: 'array', items: CAPABILITY_SCHEMA },
        users: { type: 'array', items: CAPABILITY_SCHEMA },
        user: { type: ['object', 'null'], additionalProperties: true, description: 'The key owner, returned when kind is "all".' },
        note: { type: 'string' },
      },
      required: ['kind', 'viewer'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'describe_capability',
    title: 'Describe one capability',
    description:
      'One capability in full: a module with its pricing and per-block permissions, a platform service with what it'
      + ' does, its endpoints and the permission that gates it, or a user with their roles, permissions and balance.'
      + ' Use "me" as the id to describe the user this key acts as.'
      + ' Keywords: capability, permission, access, service, subsystem, role, balance, who am I.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['module', 'service', 'user'], description: 'Which kind of capability to describe.' },
        id: { type: 'string', description: 'Module key, service key, or user id ("me" for the key owner).' },
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
    outputSchema: CAPABILITY_SCHEMA,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_modules',
    title: 'List modules',
    description:
      'List every campaign module with a one-line summary and a flag showing whether its schema is fully described.'
      + ' This is the catalogue you build tasks from; module keys here feed every other module tool.'
      + ' It answers "which modules have a usable schema", NOT "am I allowed to run them" — for permissions,'
      + ' pricing and platform services other than modules, use list_capabilities.'
      + ' Keywords: modules, catalog, list, what modules exist.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        described: { type: 'integer', description: 'How many modules have a complete schema.' },
        total: { type: 'integer', description: 'How many modules exist.' },
        modules: { type: 'array', items: MODULE_CARD_SCHEMA },
        note: { type: 'string' },
      },
      required: ['described', 'total', 'modules'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'describe_module',
    title: 'Describe a module',
    description:
      'The complete contract of one module: what it does and explicitly does NOT do, its interface blocks,'
      + ' EVERY task parameter with limits and examples, decoded presets, ready-made launch examples and a machine'
      + ' JSON Schema of the task input. Read this before building any task — field names differ per module and'
      + ' cannot be guessed from another one.'
      + ' Keywords: schema, parameters, limits, presets, params, fields, options.',
    inputSchema: {
      type: 'object',
      properties: { module: moduleArg(describedKeys(), 'Must be a module with a complete schema.') },
      required: ['module'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        version: { type: 'integer', description: 'Schema version. Changes when fields are added or their meaning changes.' },
        title: { type: 'string' },
        platform: { type: 'string', description: 'Which platform the module drives, e.g. telegram.' },
        usesAi: { type: 'boolean', description: 'Whether the module generates text with the model. Drives whether token spend is added on top of the per-action price.' },
        tags: { type: 'array', items: { type: 'string' } },
        whoAmI: {
          type: 'object',
          description: 'Self-description of the module, written for a model choosing between modules.',
          properties: {
            summary: { type: 'string' },
            does: { type: 'array', items: { type: 'string' }, description: 'What the module actually performs, step by step.' },
            doesNot: { type: 'array', items: { type: 'string' }, description: 'What it deliberately does NOT do, and which module does it instead.' },
            requires: { type: 'array', items: { type: 'string' }, description: 'Preconditions without which the task will not start.' },
            risks: { type: 'string', description: 'What can go wrong with real accounts.' },
            costModel: { type: 'string', description: 'How the balance is charged.' },
          },
          required: ['summary', 'does', 'doesNot', 'requires', 'risks', 'costModel'],
          additionalProperties: true,
        },
        blocks: { type: 'array', description: 'Interface blocks with their parameters already resolved.', items: { type: 'object', additionalProperties: true } },
        params: { type: 'array', description: 'Every settings field with purpose, limits, defaults and conditions.', items: { type: 'object', additionalProperties: true } },
        presets: { type: 'array', description: 'Decoded preset values with the exact multipliers the server applies.', items: { type: 'object', additionalProperties: true } },
        examples: { type: 'array', description: 'Complete, valid settings objects for common scenarios.', items: { type: 'object', additionalProperties: true } },
        inputSchema: { type: 'object', description: 'JSON Schema of the settings object accepted by validate_task and create_task.', additionalProperties: true },
      },
      required: ['key', 'version', 'title', 'whoAmI', 'blocks', 'params', 'inputSchema'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'describe_block',
    title: 'Describe one interface block',
    description:
      'What a single block of a module does, how it works, which parameters it owns, which API endpoint it calls'
      + ' and which fields of that call it fills. Use when describe_module is more than you need.'
      + ' Keywords: help, block, section, panel, parameters, API.',
    inputSchema: {
      type: 'object',
      properties: {
        module: moduleArg(describedKeys()),
        block: { type: 'string', description: 'Block id, taken from blocks[].id in describe_module.' },
      },
      required: ['module', 'block'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string' },
        id: { type: 'string' },
        title: { type: 'string' },
        purpose: { type: 'string', description: 'Why the block exists.' },
        howItWorks: { type: 'string', description: 'The rules the server actually applies for this block.' },
        api: {
          type: 'object',
          description: 'The HTTP call this block contributes to.',
          properties: {
            method: { type: 'string' },
            path: { type: 'string' },
            fills: { type: 'array', items: { type: 'string' }, description: 'Request fields this block populates.' },
          },
          additionalProperties: true,
        },
        params: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['module', 'id', 'title', 'purpose', 'howItWorks', 'params'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'validate_task',
    title: 'Validate a draft task',
    description:
      'Check draft settings against the module schema AND the real launch rules — WITHOUT creating a task, spending'
      + ' balance or touching Telegram. Returns errors with the exact field path, plus warnings about fields that are'
      + ' set but will be silently ignored. Always call this before create_task.'
      + ' Keywords: check, validate, verify, dry run, lint, test settings.',
    inputSchema: {
      type: 'object',
      properties: {
        module: moduleArg(describedKeys()),
        settings: { type: 'object', description: 'Draft task settings, shaped by the inputSchema from describe_module.', additionalProperties: true },
      },
      required: ['module', 'settings'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string' },
        valid: { type: 'boolean', description: 'True only when errors is empty. Warnings do not make a task invalid.' },
        errors: { type: 'array', items: ISSUE_SCHEMA, description: 'Blocking problems. The task will not start until every one is fixed.' },
        warnings: { type: 'array', items: ISSUE_SCHEMA, description: 'Non-blocking: the task will run, but these fields will have no effect.' },
        summary: { type: 'string', description: 'One-line verdict.' },
      },
      required: ['module', 'valid', 'errors', 'warnings', 'summary'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'estimate_task',
    title: 'Estimate cost and time',
    description:
      'How much balance a run will consume and how long it will take, for a given number of actions spread over a'
      + ' given number of accounts. Calculated before launch, charges nothing.'
      + ' Keywords: price, cost, budget, how long, duration, estimate, quote.',
    inputSchema: {
      type: 'object',
      properties: {
        module: moduleArg(allKeys()),
        actions: { type: 'integer', minimum: 0, description: 'How many actions the run should perform in total.' },
        accounts: { type: 'integer', minimum: 1, default: 1, description: 'How many accounts share the work. More accounts means the same volume finishes sooner.' },
      },
      required: ['module', 'actions'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string' },
        actions: { type: 'integer' },
        accounts: { type: 'integer' },
        usesAi: { type: 'boolean', description: 'Whether this module calls the model. Only AI modules add token cost on top of the action price.' },
        cost: {
          type: 'object',
          properties: {
            perAction: { type: 'number', description: 'Price of one action.' },
            actionsCoins: { type: 'number', description: 'Total for the requested volume.' },
            currency: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['perAction', 'actionsCoins', 'currency'],
          additionalProperties: false,
        },
        time: {
          type: 'object',
          properties: {
            perAccount: { type: 'integer', description: 'Actions each account performs.' },
            minSec: { type: 'integer', description: 'Optimistic wall-clock duration in seconds.' },
            maxSec: { type: 'integer', description: 'Pessimistic wall-clock duration in seconds.' },
            note: { type: 'string' },
          },
          required: ['perAccount', 'minSec', 'maxSec'],
          additionalProperties: false,
        },
      },
      required: ['module', 'actions', 'accounts', 'cost', 'time'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_task',
    title: 'Get task status',
    description:
      'What happened to a previously created task: status, progress against its real target, who started it, and the'
      + ' tail of its log. Every skipped action is logged with its reason, so this is how you find out why a run did'
      + ' less than expected. Keywords: status, progress, logs, result, monitor, check task.',
    inputSchema: {
      type: 'object',
      properties: {
        module: moduleArg(allKeys(), 'The module that created the task.'),
        taskId: { type: 'string', description: 'Task id returned by create_task.' },
      },
      required: ['module', 'taskId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        module: { type: 'string' },
        status: { type: 'string', description: 'queued, running, paused, done, stopped or error.' },
        initiator: { type: 'string', description: 'Who created the task: mcp, api or operator.' },
        progress: {
          type: ['object', 'null'],
          description: 'done counts completed actions; total is the real target drawn for this task, which is a random value in [min, max] and normally below the maximum.',
          properties: { done: { type: 'integer' }, total: { type: 'integer' } },
          additionalProperties: true,
        },
        startedAt: { type: ['integer', 'null'] },
        updatedAt: { type: ['integer', 'null'] },
        logs: {
          type: 'array',
          description: 'Last 20 log entries, oldest first.',
          items: {
            type: 'object',
            properties: {
              level: { type: 'string', description: 'info, warning or error.' },
              message: { type: 'string' },
              account: { type: ['string', 'null'] },
            },
            required: ['level', 'message'],
            additionalProperties: false,
          },
        },
      },
      required: ['taskId', 'module', 'status', 'logs'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'stop_task',
    title: 'Stop a running task',
    description:
      'Interrupt a running task. Actions already performed in Telegram are NOT undone — Telegram has no rollback.'
      + ' Safe to call twice: stopping an already-stopped task changes nothing.'
      + ' Keywords: stop, cancel, halt, abort, interrupt, kill.',
    inputSchema: {
      type: 'object',
      properties: {
        module: moduleArg(allKeys(), 'The module that created the task.'),
        taskId: { type: 'string', description: 'Task id returned by create_task.' },
      },
      required: ['module', 'taskId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        module: { type: 'string' },
        status: { type: 'string', description: 'Task status after the stop request.' },
        note: { type: 'string' },
      },
      required: ['taskId', 'module', 'status'],
      additionalProperties: false,
    },
    // Не destructive: остановка ничего не удаляет и не откатывает, она лишь прекращает
    // дальнейшие действия. Помечать «разрушающим» аварийный тормоз — значит заставить
    // клиента спрашивать подтверждение ровно тогда, когда нужно жать не думая.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'create_task',
    title: 'Create and start a task',
    description:
      'Create and start a module task. THIS PERFORMS REAL, IRREVERSIBLE ACTIONS: it publishes to Telegram from live'
      + ' accounts and debits the balance. Nothing here can be undone, including by stop_task.'
      + ' Call validate_task first and only proceed on valid: true. Only accounts belonging to the key owner are'
      + ' accepted; anything else is refused. Keywords: launch, start, run, execute, create task, go.',
    inputSchema: {
      type: 'object',
      properties: {
        module: moduleArg(describedKeys()),
        settings: { type: 'object', description: 'Task settings matching the inputSchema from describe_module.', additionalProperties: true },
      },
      required: ['module', 'settings'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Pass this to get_task and stop_task.' },
        module: { type: 'string' },
        status: { type: 'string' },
        schemaVersion: { type: 'integer', description: 'Descriptor version the task was built against.' },
        warnings: { type: 'array', items: ISSUE_SCHEMA, description: 'Carried over from validation: fields that were set but will not take effect.' },
        note: { type: 'string' },
      },
      required: ['taskId', 'module', 'status'],
      additionalProperties: false,
    },
    // destructiveHint: true — единственная честная пометка. Задача публикует в Telegram
    // и списывает деньги; откатить нельзя. Прежнее `false` означало для клиента
    // «изменения только аддитивные, можно вызывать без подтверждения» — прямая ложь
    // о самом дорогом вызове во всём наборе.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
]

/** Реализации. Каждая возвращает объект — он уедет и текстом, и структурой. */
const HANDLERS = {
  /**
   * Возможности идут ЧЕРЕЗ ТОТ ЖЕ реестр, что и REST-срезы `/api/v1/capabilities/*`.
   * Считать «что мне можно» в двух местах — верный способ получить протокол, который
   * обещает доступ, и REST, который отдаёт 403.
   */
  async list_capabilities({ kind = 'all' }, ctx) {
    const caps = await import('./capabilities.js')
    const viewer = await caps.resolveViewer(ctx)
    const viewerCard = { id: viewer.userId, isService: viewer.isService, isAdmin: viewer.isAdmin, roleName: viewer.roleName }

    if (kind === 'module') {
      const modules = await caps.listModuleCapabilities(ctx, viewer)
      return { kind, viewer: viewerCard, counts: { modules: modules.length, modulesAllowed: modules.filter((m) => m.access.allowed).length }, modules }
    }
    if (kind === 'service') {
      const services = await caps.listServiceCapabilities(ctx, viewer)
      return { kind, viewer: viewerCard, counts: { services: services.length, servicesAllowed: services.filter((s) => s.access.allowed).length }, services }
    }
    if (kind === 'user') {
      const users = await caps.listUserCapabilities(ctx, viewer)
      return {
        kind,
        viewer: viewerCard,
        counts: { users: users.length },
        users,
        note: caps.canViewOtherUsers(viewer)
          ? 'This key may read every user.'
          : 'This key acts as one user and sees only itself. Reading another user needs an admin-role owner or the service key.',
      }
    }
    return { kind: 'all', ...(await caps.allCapabilities(ctx)) }
  },

  async describe_capability({ kind, id }, ctx) {
    const caps = await import('./capabilities.js')
    if (kind === 'user') {
      const r = await caps.getUserCapability(id, ctx)
      if (r.error) throw new ToolError(r.error)
      return r.capability
    }
    const capability = kind === 'module'
      ? await caps.getModuleCapability(id, ctx)
      : await caps.getServiceCapability(id, ctx)
    if (!capability) {
      const known = kind === 'module' ? allKeys() : caps.listServiceKeys()
      throw new ToolError(`Unknown ${kind} "${id}". Available ${kind}s: ${known.join(', ')}.`)
    }
    return capability
  },

  list_modules() {
    const modules = allKeys().map((key) => (
      summarizeModule(key) || {
        key,
        title: moduleTitle(key),
        described: false,
        note: 'This module has no descriptor and cannot be driven through MCP.',
      }
    ))
    return {
      described: describedKeys().length,
      total: modules.length,
      modules,
      // Прямо говорим, чему верить: раньше неописанные модули выглядели так же полно,
      // как описанные, и оркестратор принимал 5 полей за исчерпывающий список.
      note: 'Only modules with described = true have a complete field list. For the others, treat the schema as unknown rather than empty.',
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
      throw new ToolError(
        `Block "${block}" does not exist in module "${module}".`
        + ` Available blocks: ${full.blocks.map((b) => b.id).join(', ')}.`,
      )
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
      // Берём СТРУКТУРУ, а не строку: строковая форма русская — её читает оператор в
      // панели. Сюда должен уехать `messageEn`, иначе это была бы единственная кириллица
      // во всём протоколе (правило «MCP только по-английски», CLAUDE.md).
      const err = validateSettingsDetailed(module, settings || {})
      if (err) runtime.push({ path: '', code: err.code || 'launchRule', message: err.messageEn })
    }

    const errors = [...schemaErrors, ...ruleErrors, ...runtime]
    return {
      module,
      valid: errors.length === 0,
      errors,
      warnings,
      summary: errors.length
        ? `Cannot start: ${errors.length} error(s)${warnings.length ? ` and ${warnings.length} warning(s)` : ''}. Fix every error, then validate again.`
        : warnings.length
          ? `Valid, but ${warnings.length} field(s) will be ignored — review the warnings before launching.`
          : 'Valid and ready to launch.',
    }
  },

  async estimate_task({ module, actions, accounts }) {
    if (!MODULE_DEFS[module]) {
      throw new ToolError(`Unknown module "${module}". Available modules: ${allKeys().join(', ')}.`)
    }
    const n = Math.max(0, Math.round(Number(actions) || 0))
    const acc = Math.max(1, Math.round(Number(accounts) || 1))
    const { effectivePrices } = await import('../priceStore.js')
    const eff = await effectivePrices()
    const perAction = eff.actionMap[module] || 0
    const perAcc = Math.ceil(n / acc)
    const usesAi = getDescriptor(module)?.usesAi === true
    return {
      module,
      actions: n,
      accounts: acc,
      usesAi,
      cost: {
        perAction,
        actionsCoins: Math.round(perAction * n * 1000) / 1000,
        currency: 'USD',
        note: usesAi
          ? 'Text generation is included in the action price. Image analysis is billed separately, after the fact, with the imageMultiplier.'
          : 'This module does not call the model, so no token cost is added on top of the action price.',
      },
      time: {
        perAccount: perAcc,
        minSec: perAcc * 30,
        maxSec: perAcc * 120,
        note: 'Based on the base 30-120 s delay window. The tempo preset and protection level scale this by their multiplier.',
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
    if (!store) throw new ToolError(`Unknown module "${module}". Available modules: ${allKeys().join(', ')}.`)
    const task = await store.loadTask(taskId)
    if (!task) throw new ToolError(`Task "${taskId}" was not found in module "${module}". Check the id returned by create_task.`)
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
    if (!store) throw new ToolError(`Unknown module "${module}". Available modules: ${allKeys().join(', ')}.`)
    const task = await store.loadTask(taskId)
    if (!task) throw new ToolError(`Task "${taskId}" was not found in module "${module}". Check the id returned by create_task.`)
    const { stopWorker } = await import('../modules/workers.js')
    await stopWorker(taskId, store)
    const after = await store.loadTask(taskId)
    return {
      taskId,
      module,
      status: after?.status || 'stopped',
      note: 'Task stopped. Actions already performed in Telegram are not undone.',
    }
  },

  async create_task({ module, settings }, ctx) {
    const desc = requireDescribed(module)

    // Валидируем ТЕМ ЖЕ кодом, что и validate_task: расхождение между «проверил» и
    // «запустил» — худшее, что можно сделать с оркестратором.
    const check = HANDLERS.validate_task({ module, settings })
    if (!check.valid) {
      throw new ToolError(
        `Task rejected by validation, nothing was started or charged. `
        + `${check.errors.map((e) => `${e.path || 'settings'}: ${e.message}`).join(' ')}`,
      )
    }

    const accountIds = Array.isArray(settings?.accountIds) ? settings.accountIds : []
    const { canSeeAccount } = await import('../lib/accessGuard.js')
    for (const id of accountIds) {
      if (!(await canSeeAccount(ctx.req, id))) {
        throw new ToolError(`Account "${id}" is not available to the owner of this API key. Remove it from accountIds.`)
      }
    }

    // Помечаем происхождение: задача «под MCP» не должна незаметно правиться руками —
    // иначе «мозги» продолжают считать, что она идёт по их плану (MR-148).
    const payload = { ...settings, accountIds, initiator: 'mcp' }
    // Отказы запуска — «аккаунты заняты другой задачей», «цель просрочена», нарушение
    // правил модуля — это ОТВЕТ инструмента, а не сбой сервера: модель должна прочитать
    // причину и исправиться. Без этой обёртки обычный Error всплывал как -32603
    // «внутренняя ошибка», по которой оркестратору нечего делать, кроме как сдаться.
    let started
    try {
      // lang: 'en' — отказы запуска («аккаунты заняты», «модуль не поддерживается»)
      // приходят по-английски: их читает модель, а не оператор.
      started = startModuleTask(module, payload, { lang: 'en' })
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : 'Could not create the task.')
    }
    const { store, task, worker } = started
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
      // Раньше здесь стоял REST-путь, закрытый пользовательской сессией: по MCP-ключу
      // он не открывается, и «мозги» упирались в 401 ровно там, где им сказали смотреть.
      note: `Task started. Follow it with get_task({ module: "${module}", taskId: "${task.id}" }) and interrupt it with stop_task.`,
    }
  },
}

export async function callTool(name, args, ctx) {
  const handler = HANDLERS[name]
  if (!handler) throw new ToolError(`Unknown tool "${name}". Available tools: ${TOOLS.map((t) => t.name).join(', ')}.`)

  const def = TOOLS.find((t) => t.name === name)
  const argErrors = validateAgainstSchema(def.inputSchema, args || {})
  if (argErrors.length) {
    throw new ToolError(
      `Invalid arguments for ${name}: ${argErrors.map((e) => `${e.path || 'input'} — ${e.message}`).join(' ')}`,
    )
  }
  return handler(args || {}, ctx || {})
}

export { DESCRIPTORS }
