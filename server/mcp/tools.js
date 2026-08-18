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
  if (!MODULE_DEFS[key]) throw new ToolError(`Неизвестный модуль «${key}». Доступные: ${Object.keys(MODULE_DEFS).join(', ')}`)
  const desc = getDescriptor(key)
  if (!desc) {
    throw new ToolError(
      `Схема модуля «${key}» ещё не описана — воспользоваться им через MCP пока нельзя. `
      + `Описаны: ${listDescriptorKeys().join(', ')}.`,
    )
  }
  return desc
}

/** Описания инструментов для tools/list. */
export const TOOLS = [
  {
    name: 'list_modules',
    title: 'Список модулей',
    description:
      'Перечислить модули платформы с кратким описанием и признаком, у каких схема описана полностью. '
      + 'Ключевые слова: модули, возможности, capabilities, modules.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'describe_module',
    title: 'Описание модуля',
    description:
      'Исчерпывающее описание модуля: назначение (что делает и чего НЕ делает), блоки интерфейса, '
      + 'ВСЕ параметры создания задачи с ограничениями и примерами, расшифровка пресетов и готовые сценарии запуска. '
      + 'Ключевые слова: схема, параметры, ограничения, пресеты, schema, params, limits.',
    inputSchema: {
      type: 'object',
      properties: { module: { type: 'string', description: `Ключ модуля. Со схемой: ${moduleEnum().join(', ')}` } },
      required: ['module'],
      additionalProperties: false,
    },
  },
  {
    name: 'describe_block',
    title: 'Справка по блоку',
    description:
      'Что делает конкретный блок модуля, как он работает, какие параметры в нём живут, какой API он '
      + 'вызывает и какие поля этого API заполняет. Ключевые слова: помощь, справка, блок, help, support.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: `Ключ модуля. Со схемой: ${moduleEnum().join(', ')}` },
        block: { type: 'string', description: 'ID блока из describe_module' },
      },
      required: ['module', 'block'],
      additionalProperties: false,
    },
  },
  {
    name: 'validate_task',
    title: 'Проверить черновик задачи',
    description:
      'Проверить настройки задачи по схеме модуля и по реальным правилам запуска — БЕЗ создания задачи, '
      + 'без списания денег и без обращения к Telegram. Возвращает список ошибок с указанием поля и '
      + 'предупреждения о полях, которые заданы, но не сработают. Ключевые слова: проверка, валидация, dry-run.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: `Ключ модуля. Со схемой: ${moduleEnum().join(', ')}` },
        settings: { type: 'object', description: 'Черновик настроек задачи' },
      },
      required: ['module', 'settings'],
      additionalProperties: false,
    },
  },
  {
    name: 'estimate_task',
    title: 'Оценить стоимость и время',
    description:
      'Сколько спишется и сколько времени займёт задача при заданном числе действий и аккаунтов. '
      + 'Считается до запуска. Ключевые слова: цена, стоимость, время, estimate.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Ключ модуля' },
        actions: { type: 'integer', description: 'Сколько действий планируется', minimum: 0 },
        accounts: { type: 'integer', description: 'Сколько аккаунтов делят работу', minimum: 1, default: 1 },
      },
      required: ['module', 'actions'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task',
    title: 'Состояние задачи',
    description:
      'Что стало с ранее созданной задачей: статус, прогресс, кем запущена и последние записи лога. '
      + 'Ключевые слова: статус, прогресс, логи, task, status, progress.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Ключ модуля, которым создана задача' },
        taskId: { type: 'string', description: 'ID из ответа create_task' },
      },
      required: ['module', 'taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_task',
    title: 'Остановить задачу',
    description:
      'Остановить выполняющуюся задачу. Уже сделанные действия не отменяются — Telegram их не '
      + 'откатывает. Ключевые слова: стоп, остановить, отмена, stop, cancel.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Ключ модуля, которым создана задача' },
        taskId: { type: 'string', description: 'ID из ответа create_task' },
      },
      required: ['module', 'taskId'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'create_task',
    title: 'Создать и запустить задачу',
    description:
      'Создать задачу модуля и запустить её. ДЕЙСТВИЕ РЕАЛЬНОЕ: выполняются настоящие операции в Telegram '
      + 'и списываются средства. Перед вызовом обязательно прогнать validate_task. Доступны только аккаунты '
      + 'пользователя ключа. Ключевые слова: запуск, старт, создать задачу, run.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: `Ключ модуля. Со схемой: ${moduleEnum().join(', ')}` },
        settings: { type: 'object', description: 'Настройки задачи — по схеме из describe_module' },
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
        note: 'Схема не описана — модуль недоступен через MCP',
      }
    ))
    return {
      described: listDescriptorKeys().length,
      total: modules.length,
      modules,
      // Прямо говорим, чему верить: раньше неописанные модули выглядели так же полно,
      // как описанные, и оркестратор принимал 5 полей за исчерпывающий список.
      note: 'Полагаться можно только на модули с described = true; у остальных список полей неполный.',
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
      throw new ToolError(`Блок «${block}» не найден у модуля «${module}». Есть: ${full.blocks.map((b) => b.id).join(', ')}`)
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
        ? `Задачу запустить нельзя: ошибок ${errors.length}${warnings.length ? `, предупреждений ${warnings.length}` : ''}.`
        : `Задача валидна${warnings.length ? `, но есть предупреждения (${warnings.length}) — часть настроек не сработает.` : '.'}`,
    }
  },

  async estimate_task({ module, actions, accounts }) {
    if (!MODULE_DEFS[module]) throw new ToolError(`Неизвестный модуль «${module}»`)
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
        note: 'Генерация текста включена в цену действия. Анализ изображений биллится отдельно по факту.',
      },
      time: {
        perAccount: perAcc,
        minSec: perAcc * 30,
        maxSec: perAcc * 120,
        note: 'Оценка по базовым задержкам 30–120 с. Пресет темпа и уровень защиты меняют её множителем.',
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
    if (!store) throw new ToolError(`Неизвестный модуль «${module}»`)
    const task = await store.loadTask(taskId)
    if (!task) throw new ToolError(`Задача «${taskId}» у модуля «${module}» не найдена`)
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
    if (!store) throw new ToolError(`Неизвестный модуль «${module}»`)
    const task = await store.loadTask(taskId)
    if (!task) throw new ToolError(`Задача «${taskId}» у модуля «${module}» не найдена`)
    const { stopWorker } = await import('../modules/workers.js')
    await stopWorker(taskId, store)
    const after = await store.loadTask(taskId)
    return {
      taskId,
      module,
      status: after?.status || 'stopped',
      note: 'Задача остановлена. Уже выполненные действия в Telegram не отменяются.',
    }
  },

  async create_task({ module, settings }, ctx) {
    const desc = requireDescribed(module)

    // Валидируем ТЕМ ЖЕ кодом, что и validate_task: расхождение между «проверил» и
    // «запустил» — худшее, что можно сделать с оркестратором.
    const check = HANDLERS.validate_task({ module, settings })
    if (!check.valid) {
      throw new ToolError(`Задача не прошла проверку. ${check.errors.map((e) => `${e.path || 'настройки'}: ${e.message}`).join('; ')}`)
    }

    const accountIds = Array.isArray(settings?.accountIds) ? settings.accountIds : []
    const { canSeeAccount } = await import('../lib/accessGuard.js')
    for (const id of accountIds) {
      if (!(await canSeeAccount(ctx.req, id))) throw new ToolError(`Аккаунт ${id} недоступен пользователю этого ключа`)
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
      started = startModuleTask(module, payload)
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : 'Не удалось создать задачу')
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
      note: 'Задача запущена. Прогресс и логи — GET /api/modules/' + module + '/tasks/' + task.id,
    }
  },
}

export async function callTool(name, args, ctx) {
  const handler = HANDLERS[name]
  if (!handler) throw new ToolError(`Неизвестный инструмент «${name}»`)

  const def = TOOLS.find((t) => t.name === name)
  const argErrors = validateAgainstSchema(def.inputSchema, args || {})
  if (argErrors.length) {
    throw new ToolError(`Неверные аргументы: ${argErrors.map((e) => `${e.path || 'вход'} — ${e.message}`).join('; ')}`)
  }
  return handler(args || {}, ctx || {})
}

export { DESCRIPTORS }
