/**
 * Проверка черновика задачи по дескриптору — БЕЗ запуска.
 *
 * Зачем отдельно от запуска: «мозги» должны иметь возможность собрать задачу и убедиться,
 * что она валидна, не тратя деньги и не трогая живые аккаунты. Раньше единственным способом
 * узнать, правильные ли настройки, был реальный запуск в Telegram.
 *
 * Валидатор свой, а не библиотечный: нужен ровно тот поднабор JSON Schema 2020-12, который
 * порождает `buildInputSchema`. Тащить ajv ради этого — лишняя зависимость в проде.
 *
 * ГЛАВНОЕ ТРЕБОВАНИЕ К СООБЩЕНИЯМ. Их читает не человек, а модель, и по ним она чинит
 * задачу. Поэтому каждое сообщение говорит три вещи: что получено, что ожидалось и что
 * сделать. «expected line, received integer» — это не сообщение, это шум.
 */

/** Как называть тип в тексте ошибки — словами JSON Schema, а не «строка/число». */
const TYPE_NAMES = {
  string: 'string',
  integer: 'integer',
  number: 'number',
  boolean: 'boolean',
  array: 'array',
  object: 'object',
  null: 'null',
}

const typeName = (t) => TYPE_NAMES[t] || String(t)

function typeOf(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function typeMatches(expected, value) {
  const actual = typeOf(value)
  if (expected === 'number') return actual === 'number' || actual === 'integer'
  return actual === expected
}

/** Короткое и однозначное представление значения в тексте ошибки. */
function show(value) {
  if (typeof value === 'string') return value.length > 40 ? `${JSON.stringify(value.slice(0, 40))}…` : JSON.stringify(value)
  if (Array.isArray(value)) return `array of ${value.length}`
  if (value && typeof value === 'object') return 'object'
  return JSON.stringify(value)
}

/** Ближайшее по написанию имя — чтобы на опечатку отвечать подсказкой, а не только отказом. */
function closestName(name, candidates) {
  const lower = String(name).toLowerCase()
  let best = null
  let bestScore = Infinity
  for (const c of candidates) {
    const a = c.toLowerCase()
    if (a === lower) return c
    // Расстояние Левенштейна, итеративно по одной строке — список полей короткий.
    let prev = [...Array(a.length + 1).keys()]
    for (let i = 1; i <= lower.length; i += 1) {
      const cur = [i]
      for (let j = 1; j <= a.length; j += 1) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (lower[i - 1] === a[j - 1] ? 0 : 1))
      }
      prev = cur
    }
    const dist = prev[a.length]
    if (dist < bestScore) { bestScore = dist; best = c }
  }
  // Порог: треть длины имени. Иначе «channels» предлагается вместо «foo».
  return bestScore <= Math.max(2, Math.floor(lower.length / 3)) ? best : null
}

/** Текст про неизвестное поле: с подсказкой, если похоже на опечатку. */
function unknownFieldMessage(name, known) {
  const near = closestName(name, known)
  return near
    ? `Unknown field "${name}". Did you mean "${near}"? Call describe_module for the current schema.`
    : `Unknown field "${name}" is not part of this module's schema. Call describe_module for the list of accepted fields.`
}

/**
 * Проверить значение против фрагмента схемы. Ошибки складываются в `out`, а не бросаются:
 * «мозгам» нужен ВЕСЬ список проблем сразу, иначе они чинят задачу по одной за круг.
 */
function checkValue(schema, value, path, out) {
  if (!typeMatches(schema.type, value)) {
    out.push({
      path,
      code: 'type',
      message: `Expected ${typeName(schema.type)}, received ${typeName(typeOf(value))} (${show(value)}).`,
    })
    return
  }

  if (schema.enum && !schema.enum.includes(value)) {
    out.push({
      path,
      code: 'enum',
      message: `Value ${show(value)} is not allowed. Allowed values: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}.`,
    })
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    out.push({ path, code: 'minimum', message: `Value ${show(value)} is below the minimum of ${schema.minimum}.` })
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    out.push({ path, code: 'maximum', message: `Value ${show(value)} is above the maximum of ${schema.maximum}.` })
  }
  if (schema.pattern && !new RegExp(schema.pattern).test(String(value))) {
    out.push({ path, code: 'pattern', message: `Value ${show(value)} does not match the required format ${schema.pattern}.` })
  }

  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      out.push({ path, code: 'minItems', message: `At least ${schema.minItems} item(s) required, received ${value.length}.` })
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      out.push({ path, code: 'maxItems', message: `At most ${schema.maxItems} item(s) allowed, received ${value.length}.` })
    }
    if (schema.items?.type) {
      value.forEach((item, i) => {
        if (!typeMatches(schema.items.type, item)) {
          out.push({
            path: `${path}[${i}]`,
            code: 'type',
            message: `Array items must be ${typeName(schema.items.type)}, received ${typeName(typeOf(item))} (${show(item)}).`,
          })
        }
      })
    }
  }

  if (schema.type === 'object' && schema.properties) {
    const known = Object.keys(schema.properties)
    // Обязательные поля вложенного объекта: раньше не проверялись вовсе, и `delays: {}`
    // проходило как валидное, а падало уже на запуске.
    for (const name of schema.required || []) {
      if (value[name] === undefined || value[name] === null) {
        out.push({ path: `${path}.${name}`, code: 'required', message: 'Required field is missing.' })
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (!schema.properties[key]) {
        if (schema.additionalProperties === false) {
          out.push({ path: `${path}.${key}`, code: 'unknownField', message: unknownFieldMessage(key, known) })
        }
        continue
      }
      if (child !== undefined && child !== null) checkValue(schema.properties[key], child, `${path}.${key}`, out)
    }
  }
}

/**
 * Черновик задачи против JSON Schema модуля.
 * @returns {{path: string, code: string, message: string}[]}
 */
export function validateAgainstSchema(schema, settings) {
  if (settings === undefined || settings === null) {
    return [{ path: '', code: 'type', message: 'Expected an object of task settings, received nothing.' }]
  }
  if (typeof settings !== 'object' || Array.isArray(settings)) {
    return [{
      path: '',
      code: 'type',
      message: `Expected an object of task settings, received ${typeName(typeOf(settings))}.`,
    }]
  }

  const out = []
  const known = Object.keys(schema.properties || {})

  // Пустое обязательное поле сообщаем ОДИН раз. Иначе на `accountIds: []` прилетало
  // сразу два сообщения — «обязательное не заполнено» и «нужно минимум 1 элемент», —
  // и модель чинила одну и ту же проблему дважды.
  const missing = new Set()
  for (const name of schema.required || []) {
    const v = settings[name]
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
    if (empty) {
      missing.add(name)
      out.push({
        path: name,
        code: 'required',
        message: `Required field is missing or empty. See describe_module → params.${name} for what to put here.`,
      })
    }
  }

  for (const [key, v] of Object.entries(settings)) {
    if (missing.has(key)) continue
    const prop = schema.properties?.[key]
    if (!prop) {
      // Незнакомое поле — почти всегда признак того, что оркестратор работает по
      // устаревшей схеме. Промолчать здесь = «задача создалась, но делает не то».
      if (schema.additionalProperties === false) {
        out.push({ path: key, code: 'unknownField', message: unknownFieldMessage(key, known) })
      }
      continue
    }
    if (v === undefined || v === null) continue
    checkValue(prop, v, key, out)
  }
  return out
}

const isSet = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)

/**
 * Проверки, невыразимые в JSON Schema: обязательность при условии и поля, которые заданы,
 * но не сработают. Правила берутся из дескриптора (`requiredWhen`, `effectiveWhen`,
 * `supersededBy`), а не зашиты в код, — иначе новый модуль их не унаследует.
 *
 * @returns {{errors: object[], warnings: object[]}}
 */
export function validateDescriptorRules(desc, settings = {}) {
  const errors = []
  const warnings = []
  const val = (name) => settings[name]

  const conditionHolds = (cond) => Object.entries(cond).every(([field, expected]) => (
    expected === '*' ? isSet(val(field)) : val(field) === expected
  ))
  const condText = (cond) => Object.entries(cond)
    .map(([f, e]) => (e === '*' ? `${f} is set` : `${f} = ${JSON.stringify(e)}`))
    .join(' and ')

  for (const p of desc.params || []) {
    if (p.requiredWhen && conditionHolds(p.requiredWhen) && !isSet(val(p.name))) {
      errors.push({
        path: p.name,
        code: 'requiredWhen',
        message: `Required when ${condText(p.requiredWhen)}.`,
      })
    }
    // Поле задано, но условие его применения не выполнено — молча проигнорировать нельзя:
    // оператор (или «мозги») уверен, что настройка работает, а она нет.
    if (p.effectiveWhen && isSet(val(p.name)) && !conditionHolds(p.effectiveWhen)) {
      warnings.push({
        path: p.name,
        code: 'ineffective',
        message: `Will be ignored: this field only takes effect when ${condText(p.effectiveWhen)}.`,
      })
    }
    for (const other of p.supersededBy || []) {
      if (isSet(val(p.name)) && isSet(val(other))) {
        warnings.push({
          path: p.name,
          code: 'superseded',
          message: `Overridden by "${other}", which takes priority. Remove one of the two.`,
        })
      }
    }
  }
  return { errors, warnings }
}
