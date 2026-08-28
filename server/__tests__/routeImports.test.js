/**
 * Ловушка на класс ошибки, который 26.08 молча убил четыре роута парсера.
 *
 * `ownerScopeForRequest` импортировался динамически ВНУТРИ одного обработчика
 * (`const { ownerScopeForRequest } = await import('./lib/accessGuard.js')`), а
 * вызывался в пяти. В четырёх остальных это ReferenceError на этапе запроса:
 * синтаксис валиден, `node --check` молчит, юнит-тесты модулей зелёные — а
 * `/api/parser/cache/watch`, `/api/parser/cache/take` и `/api/parser/watches`
 * отвечают 500 «ownerScopeForRequest is not defined». Заметить это можно только
 * живым HTTP-запросом, поэтому здесь — статическая проверка.
 *
 * Идея: имя, полученное динамическим импортом, видно лишь в теле того
 * обработчика, где импорт написан. Разрезаем index.js по объявлениям роутов и
 * требуем, чтобы в каждом куске использованное имя было либо импортировано
 * сверху файла, либо динамически импортировано в этом же куске.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Имена из статических `import { a, b } from '…'` в шапке файла. */
function staticNames(src) {
  const out = new Set()
  for (const m of src.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/gm)) {
    for (const n of m[1].split(',')) {
      const name = n.trim().split(/\s+as\s+/).pop().trim()
      if (name) out.add(name)
    }
  }
  return out
}

/**
 * Имена, полученные динамическим импортом, — видимы только в своей области.
 *
 * Две формы, обе живые в этом коде:
 *   const { a } = await import('…')
 *   const [{ a }, { b }] = await Promise.all([import('…'), import('…')])
 * Вторую проверка сначала не знала и ругалась на корректный код (27.08) — а ложное
 * срабатывание в такой ловушке хуже пропуска: её начинают обходить, а не читать.
 */
function dynamicNames(chunk) {
  const out = new Set()
  const add = (list) => {
    for (const n of list.split(',')) {
      const name = n.trim().split(':').pop().trim()
      if (name) out.add(name)
    }
  }
  for (const m of chunk.matchAll(/(?:const|let)\s*\{([^}]+)\}\s*=\s*await\s+import\(/g)) add(m[1])
  for (const m of chunk.matchAll(/(?:const|let)\s*\[([^\]]+)\]\s*=\s*await\s+Promise\.all\(\s*\[[^\]]*import\(/g)) {
    for (const part of m[1].matchAll(/\{([^}]+)\}/g)) add(part[1])
  }
  return out
}

test('имена из динамических import() не используются за пределами своего обработчика', () => {
  const src = readFileSync(join(ROOT, 'index.js'), 'utf8')
  const known = staticNames(src)

  // Все имена, которые файл вообще получает через динамический импорт: только их
  // и проверяем — обычные локальные переменные тут ни при чём.
  const dynAll = dynamicNames(src)
  const suspects = [...dynAll].filter((n) => !known.has(n))

  // Границы обработчиков: app.get/post/put/patch/delete/use(…
  const bounds = [...src.matchAll(/^app\.(get|post|put|patch|delete|use)\(/gm)].map((m) => m.index)
  const chunks = bounds.map((start, i) => ({
    start,
    text: src.slice(start, bounds[i + 1] ?? src.length),
  }))

  const bad = []
  for (const name of suspects) {
    const used = new RegExp(`(?<![\\w.$])${name}\\s*\\(`)
    for (const ch of chunks) {
      if (!used.test(ch.text)) continue
      if (dynamicNames(ch.text).has(name)) continue
      const line = src.slice(0, ch.start).split('\n').length
      bad.push(`${name}() вызывается в обработчике со строки ${line}, но импорта в нём нет`)
    }
  }
  assert.deepEqual(bad, [], `\n${bad.join('\n')}\n`)
})
