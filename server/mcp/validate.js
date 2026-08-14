/**
 * Проверка черновика задачи по дескриптору — БЕЗ запуска.
 *
 * Зачем отдельно от запуска: «мозги» должны иметь возможность собрать задачу и убедиться,
 * что она валидна, не тратя деньги и не трогая живые аккаунты. Раньше единственным способом
 * узнать, правильные ли настройки, был реальный запуск в Telegram.
 *
 * Валидатор свой, а не библиотечный: нужен ровно тот поднабор JSON Schema, который
 * порождает `buildInputSchema`, зато с русскими сообщениями и указанием пути до поля.
 * Тащить ajv ради этого — лишняя зависимость в проде.
 */

const TYPE_NAMES = {
  string: 'строка', integer: 'целое число', number: 'число',
  boolean: 'да/нет', array: 'список', object: 'объект',
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function typeMatches(expected, value) {
  const actual = typeOf(value)
  if (expected === 'number') return actual === 'number' || actual === 'integer'
  if (expected === 'object') return actual === 'object'
  return actual === expected
}

/**
 * Проверить значение против фрагмента схемы. Ошибки складываются в `out`, а не бросаются:
 * «мозгам» нужен ВЕСЬ список проблем сразу, иначе они чинят задачу по одной за круг.
 */
function checkValue(schema, value, path, out) {
  if (!typeMatches(schema.type, value)) {
    out.push({ path, message: `ожидается ${TYPE_NAMES[schema.type] || schema.type}, получено ${TYPE_NAMES[typeOf(value)] || typeOf(value)}` })
    return
  }

  if (schema.enum && !schema.enum.includes(value)) {
    out.push({ path, message: `недопустимое значение ${JSON.stringify(value)}; разрешены: ${schema.enum.join(', ')}` })
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    out.push({ path, message: `значение ${value} меньше минимума ${schema.minimum}` })
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    out.push({ path, message: `значение ${value} больше максимума ${schema.maximum}` })
  }
  if (schema.pattern && !new RegExp(schema.pattern).test(String(value))) {
    out.push({ path, message: `значение не соответствует формату ${schema.pattern}` })
  }

  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      out.push({ path, message: `нужно минимум ${schema.minItems} элем., получено ${value.length}` })
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      out.push({ path, message: `допустимо максимум ${schema.maxItems} элем., получено ${value.length}` })
    }
    if (schema.items?.type) {
      value.forEach((item, i) => {
        if (!typeMatches(schema.items.type, item)) {
          out.push({ path: `${path}[${i}]`, message: `элемент должен быть ${TYPE_NAMES[schema.items.type] || schema.items.type}` })
        }
      })
    }
  }

  if (schema.type === 'object' && schema.properties) {
    for (const [key, child] of Object.entries(value)) {
      if (!schema.properties[key]) {
        if (schema.additionalProperties === false) {
          out.push({ path: `${path}.${key}`, message: 'неизвестное поле' })
        }
        continue
      }
      if (child !== undefined && child !== null) checkValue(schema.properties[key], child, `${path}.${key}`, out)
    }
  }
}

/**
 * Черновик задачи против JSON Schema модуля.
 * @returns {{path: string, message: string}[]}
 */
export function validateAgainstSchema(schema, settings) {
  const out = []
  const value = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}
  if (value !== settings) return [{ path: '', message: 'настройки должны быть объектом' }]

  // Пустое обязательное поле сообщаем ОДИН раз. Иначе на `accountIds: []` прилетало
  // сразу два сообщения — «обязательное не заполнено» и «нужно минимум 1 элемент», —
  // и модель чинила одну и ту же проблему дважды.
  const missing = new Set()
  for (const name of schema.required || []) {
    const v = value[name]
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
    if (empty) { missing.add(name); out.push({ path: name, message: 'обязательное поле не заполнено' }) }
  }

  for (const [key, v] of Object.entries(value)) {
    if (missing.has(key)) continue
    const prop = schema.properties?.[key]
    if (!prop) {
      // Незнакомое поле — почти всегда признак того, что оркестратор работает по
      // устаревшей схеме. Промолчать здесь = «задача создалась, но делает не то».
      if (schema.additionalProperties === false) out.push({ path: key, message: 'неизвестное поле — проверьте актуальную схему модуля' })
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
    .map(([f, e]) => (e === '*' ? `задан ${f}` : `${f} = ${e}`))
    .join(' и ')

  for (const p of desc.params || []) {
    if (p.requiredWhen && conditionHolds(p.requiredWhen) && !isSet(val(p.name))) {
      errors.push({ path: p.name, message: `обязательно, когда ${condText(p.requiredWhen)}` })
    }
    // Поле задано, но условие его применения не выполнено — молча проигнорировать нельзя:
    // оператор (или «мозги») уверен, что настройка работает, а она нет.
    if (p.effectiveWhen && isSet(val(p.name)) && !conditionHolds(p.effectiveWhen)) {
      warnings.push({ path: p.name, message: `не будет применено: работает только когда ${condText(p.effectiveWhen)}` })
    }
    for (const other of p.supersededBy || []) {
      if (isSet(val(p.name)) && isSet(val(other))) {
        warnings.push({ path: p.name, message: `перекрывается полем ${other} — приоритет у него` })
      }
    }
  }
  return { errors, warnings }
}
