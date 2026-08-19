/**
 * Реестр MCP-дескрипторов и сборка производных представлений.
 *
 * Дескриптор — единственный источник правды о модуле (docs/mcp/MCP-SPEC.md). Отсюда
 * получаются три вещи, которые раньше писались независимо и расходились:
 *   1) `inputSchema` (JSON Schema) для MCP-инструмента и валидации;
 *   2) полное описание модуля для «мозгов» — /api/v1/modules/:key/describe;
 *   3) help по блокам — что за блок, как работает, какой API заполняет.
 *
 * @typedef {object} ModuleDescriptor
 * @property {string} key
 * @property {number} version
 * @property {string} title
 * @property {string[]} tags
 * @property {object} whoAmI
 * @property {object[]} blocks
 * @property {object[]} params
 * @property {object[]} presets
 * @property {object[]} examples
 * @property {{sources: {file: string, symbols: string[]}[], ignore?: string[]}} contract
 */
import neuroCommenting from './neuro-commenting.js'
import neuroChatting from './neuro-chatting.js'
import massReact from './mass-react.js'
import neuroDialogs from './neuro-dialogs.js'
import mailing from './mailing.js'
import warming from './warming.js'
import massLooking from './mass-looking.js'
import autoposting from './autoposting.js'
import parsing from './parsing.js'
import parsingGroups from './parsing-groups.js'
import parsingUsers from './parsing-users.js'
import parsingMessages from './parsing-messages.js'
import parsingComments from './parsing-comments.js'
import ggr from './ggr.js'
import spamUnblock from './spam-unblock.js'

/** Все дескрипторы по ключу модуля. Новый модуль — импорт + строка здесь. */
export const DESCRIPTORS = {
  'neuro-commenting': neuroCommenting,
  'neuro-chatting': neuroChatting,
  'mass-react': massReact,
  'neuro-dialogs': neuroDialogs,
  mailing,
  warming,
  'mass-looking': massLooking,
  autoposting,
  parsing,
  'parsing-groups': parsingGroups,
  'parsing-users': parsingUsers,
  'parsing-messages': parsingMessages,
  'parsing-comments': parsingComments,
  ggr,
  'spam-unblock': spamUnblock,
}

export function getDescriptor(key) {
  return DESCRIPTORS[key] || null
}

export function listDescriptorKeys() {
  return Object.keys(DESCRIPTORS)
}

/**
 * Имена всех полей настроек, которые модуль признаёт: канонические + алиасы + вложенные.
 * Нужно contract-тесту и валидации «это поле вообще существует?».
 */
export function descriptorFieldNames(desc) {
  const out = new Set()
  for (const p of desc.params || []) {
    out.add(p.name)
    for (const a of p.aliases || []) out.add(a)
    for (const child of p.properties || []) out.add(`${p.name}.${child.name}`)
  }
  return out
}

/** Только верхнеуровневые ключи (то, что реально лежит в `task.settings`). */
export function descriptorTopLevelNames(desc) {
  const out = new Set()
  for (const p of desc.params || []) {
    out.add(p.name)
    for (const a of p.aliases || []) out.add(a)
  }
  return out
}

const JSON_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object'])

/**
 * Параметр → фрагмент JSON Schema.
 *
 * Текстовые ограничения (`constraints`) не выбрасываем: то, что невыразимо схемой
 * («работает только при commentMode = 1»), всё равно должно дойти до «мозгов» —
 * иначе они соберут формально валидную, но бессмысленную задачу.
 */
function paramToSchema(p) {
  const schema = { type: JSON_TYPES.has(p.type) ? p.type : 'string' }

  const descParts = [p.purpose]
  if (p.enum?.length) {
    descParts.push(p.enum.map((e) => `${e.value} — ${e.label}: ${e.means}`).join(' · '))
  }
  if (p.constraints?.length) descParts.push(`Restrictions:${p.constraints.join('; ')}.`)
  if (p.unit) descParts.push(`Unit:${p.unit}.`)
  if (p.seeAlso?.length) descParts.push(`Related:${p.seeAlso.join(', ')}.`)
  schema.description = descParts.filter(Boolean).join(' ')

  if (p.enum?.length) schema.enum = p.enum.map((e) => e.value)
  if (p.default !== undefined) schema.default = p.default
  if (p.min !== undefined) schema.minimum = p.min
  if (p.max !== undefined) schema.maximum = p.max
  if (p.minItems !== undefined) schema.minItems = p.minItems
  if (p.maxItems !== undefined) schema.maxItems = p.maxItems
  if (p.pattern) schema.pattern = p.pattern
  if (p.examples?.length) schema.examples = p.examples
  if (p.type === 'array') schema.items = { type: JSON_TYPES.has(p.items) ? p.items : 'string' }
  if (p.type === 'object' && p.properties?.length) {
    schema.properties = {}
    for (const child of p.properties) schema.properties[child.name] = paramToSchema(child)
    // Лишние ключи в объекте задержек — почти всегда опечатка, а не расширение.
    schema.additionalProperties = false
  }
  return schema
}

/** Дескриптор → JSON Schema входа задачи (то, что MCP отдаёт как inputSchema). */
export function buildInputSchema(desc) {
  const properties = {}
  const required = []
  for (const p of desc.params || []) {
    properties[p.name] = paramToSchema(p)
    if (p.required) required.push(p.name)
  }
  return {
    type: 'object',
    properties,
    required,
    // Незнакомое поле — сигнал, что «мозги» работают по устаревшей схеме. Молча
    // проглатывать его нельзя: именно так рождается «задача создалась, но делает не то».
    additionalProperties: false,
  }
}

/**
 * Блоки с уже подставленными параметрами — слой «Помощь». Заказчику нужно было именно
 * это: что за блок, как работает, какой API дёргает и какие поля этого API заполняет.
 */
export function buildBlocks(desc) {
  const byName = new Map((desc.params || []).map((p) => [p.name, p]))
  return (desc.blocks || []).map((b) => ({
    ...b,
    params: (b.params || []).map((name) => {
      const p = byName.get(name)
      return p ? { name: p.name, title: p.title, type: p.type, purpose: p.purpose } : { name, missing: true }
    }),
  }))
}

/** Полное описание модуля — ответ /describe и содержимое MCP-ресурса. */
export function describeModule(key) {
  const desc = getDescriptor(key)
  if (!desc) return null
  return {
    key: desc.key,
    version: desc.version,
    title: desc.title,
    platform: desc.platform || 'telegram',
    tags: desc.tags || [],
    whoAmI: desc.whoAmI,
    blocks: buildBlocks(desc),
    params: desc.params,
    presets: desc.presets || [],
    examples: desc.examples || [],
    inputSchema: buildInputSchema(desc),
  }
}

/** Краткая карточка модуля для списков. */
export function summarizeModule(key) {
  const desc = getDescriptor(key)
  if (!desc) return null
  return {
    key: desc.key,
    title: desc.title,
    version: desc.version,
    summary: desc.whoAmI?.summary || '',
    tags: desc.tags || [],
    paramCount: (desc.params || []).length,
    described: true,
  }
}
