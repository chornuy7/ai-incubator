/**
 * MR-185: системный промпт в генерацию приходит ОТ ВЛАДЕЛЬЦА ЗАДАЧИ.
 *
 * Мало сделать промпт личным в базе — его ещё надо донести до воркера. Раньше
 * `resolveSystemPrompt` подмешивал общий текст сам, без всякого владельца: правка одного
 * человека уезжала в чужие запуски. Теперь промпт приносит воркер, зная `task.userId`.
 *
 * Первый тест — настоящий вызов генератора. Остальные текстовые: проводку внутри воркеров
 * иначе не проверить, а сторожить нужно именно её — что промпт владельца доходит до всех
 * точек генерации, а не до одной из пяти.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { resolveSystemPrompt } from '../neuroCommenting/commentGenerator.js'

const read = async (p) => fs.readFile(new URL(`../../${p}`, import.meta.url), 'utf8')

test('промпт владельца подмешивается к тексту карточки', () => {
  const out = resolveSystemPrompt({ promptText: 'Текст карточки' }, 'ПРОМПТ ВЛАДЕЛЬЦА')
  assert.match(out, /ПРОМПТ ВЛАДЕЛЬЦА/)
  assert.match(out, /Текст карточки/)
})

test('у разных владельцев — разные системные промпты на одной и той же карточке', () => {
  const a = resolveSystemPrompt({ promptText: 'карточка' }, 'промпт Ильи')
  const b = resolveSystemPrompt({ promptText: 'карточка' }, 'промпт Николая')
  assert.notEqual(a, b)
  assert.ok(!a.includes('Николая') && !b.includes('Ильи'), 'промпты не должны смешиваться')
})

test('пустой промпт владельца оставляет только карточку', () => {
  assert.equal(resolveSystemPrompt({ promptText: 'только карточка' }, ''), 'только карточка')
})

test('воркеры читают промпт владельца задачи, а не общий', async () => {
  const w = await read('server/modules/workers.js')
  const calls = [...w.matchAll(/const ownerPrompt = await getUserGlobalPrompt\(([^)]*)\)/g)].map((m) => m[1])
  assert.ok(calls.length >= 4, `ожидались ИИ-воркеры с промптом владельца, найдено ${calls.length}`)
  for (const arg of calls) assert.match(arg, /task\.userId/, 'промпт берётся по владельцу задачи')
})

test('во ВСЕ точки генерации промпт владельца доходит', async () => {
  const w = await read('server/modules/workers.js')
  // Объявления функций пропускаем — сторожим ВЫЗОВЫ. Иначе тест падал на собственной
  // сигнатуре `function pickPrompt(s, weights, extra = '', globalPrompt)`.
  const code = w.replace(/^\s*\/\/.*$/gm, '').replace(/function (pickPrompt|dialogSystemPrompt)\([^)]*\)/g, '')
  for (const call of [...code.matchAll(/pickPrompt\([^)]*\)/g)].map((m) => m[0])) {
    if (call.startsWith('pickPrompt(s,')) {
      assert.match(call, /ownerPrompt/, `вызов без промпта владельца: ${call}`)
    }
  }
  // Берём строку целиком: внутри вызова есть вложенные скобки (stageForStatus(...)),
  // и «до первой закрывающей» обрезало бы аргументы раньше промпта владельца.
  const dlg = code.split(/\r?\n/).filter((l) => l.includes('dialogSystemPrompt(s,'))
  assert.ok(dlg.length, 'вызов dialogSystemPrompt найден — иначе тест сторожит пустоту')
  for (const call of dlg) assert.match(call, /ownerPrompt/, `диалоги без промпта владельца: ${call.trim()}`)
})

test('легаси-воркер нейрокомментинга тоже берёт промпт владельца', async () => {
  const w = await read('server/neuroCommenting/worker.js')
  assert.match(w, /getUserGlobalPrompt\(task\.userId\)/, 'этот воркер живой — он подключён в routes.js')
  assert.match(w, /resolveSystemPrompt\(s,\s*ownerPrompt\)/)
})

/*
 * Раньше промпт был общим, и запись охранял админский гейт (tenantLeaksAccounts). Теперь
 * он личный, и гейт заменён на другое правило: владелец берётся ИЗ СЕССИИ. Без этого
 * чужой промпт читался бы и переписывался подстановкой чужого id — дыра шире прежней.
 */
test('ручка настроек берёт владельца из сессии, а не из параметров', async () => {
  const r = await read('server/featureRoutes.js')
  for (const method of ['get', 'post']) {
    const at = r.indexOf(`featureRouter.${method}('/ai-settings'`)
    assert.ok(at > 0, `ручка ${method.toUpperCase()} /ai-settings найдена`)
    const block = r.slice(at, r.indexOf('featureRouter.', at + 10))
    assert.match(block, /req\.header\('x-user-id'\)/, `${method.toUpperCase()}: владелец обязан браться из сессии`)
    assert.match(block, /Нет сессии/, `${method.toUpperCase()}: без сессии — отказ, а не общий промпт`)
    assert.match(block, /UserGlobalPrompt/, `${method.toUpperCase()}: работает с личным промптом`)
  }
})
