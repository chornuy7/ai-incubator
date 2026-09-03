/**
 * MR-56: время задачи во ВСЕХ местах берёт ОДНУ и ту же задержку.
 *
 * У нейрокомментинга поле называется «Задержка комментария» и правит delays.comment,
 * а delays.action остаётся дефолтным. Верхний блок «Защита и тайминги» считает по
 * comment, а нижний чип запуска и плашка «≈ время» раньше жёстко читали delays.action —
 * поэтому при ручной правки задержки в Custom верх показывал новое время (28 мин), а низ
 * стоял на старом (13). Заказчик поймал это на живой странице.
 *
 * Фикс: единый выбор основной задержки (primaryDelay) — тот же, что у «Защиты и таймингов».
 * Тест текстовый: логика живёт внутри React-компонента, отдельно её не вызвать, а сторожить
 * нужно именно то, что все места времени зовут primaryDelay, а не delays.action напрямую.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const src = await fs.readFile(new URL('../../src/features/modules/LiveModule.tsx', import.meta.url), 'utf8')
// Комментарии срезаем — в них описан сам баг, искать надо КОД.
const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

test('в LiveModule объявлены commentPrimary и primaryDelay', () => {
  assert.ok(/const\s+commentPrimary\s*=/.test(code), 'commentPrimary — единый признак «модуль правит comment-задержку»')
  assert.ok(/const\s+primaryDelay\s*=/.test(code), 'primaryDelay — единый источник задержки для времени')
})

test('primaryDelay выбирается по commentPrimary между comment и action', () => {
  const m = code.match(/const\s+primaryDelay\s*=([^\n]+)/)
  assert.ok(m, 'строка primaryDelay найдена')
  const rhs = m[1]
  assert.ok(/commentPrimary/.test(rhs), 'выбор зависит от commentPrimary')
  assert.ok(/delays\.comment/.test(rhs) && /delays\.action/.test(rhs), 'учитывает обе задержки')
})

test('нижний чип запуска (LaunchCost) берёт primaryDelay, а не delays.action напрямую', () => {
  const m = code.match(/<LaunchCost[\s\S]*?delaySec=\{([\s\S]*?)\}\s*\/>/)
  assert.ok(m, 'LaunchCost с delaySec найден')
  const expr = m[1]
  assert.ok(/primaryDelay/.test(expr), 'delaySec считается из primaryDelay')
  assert.ok(!/delays\.action\s*\?\?\s*delays\.comment/.test(expr),
    'старый жёсткий выбор delays.action ?? delays.comment вернул бы рассинхрон верх/низ')
})

test('плашка «≈ время» в сводке модуля тоже считает по primaryDelay', () => {
  // Блок значения плашки: два вызова taskSeconds (from/to). Оба обязаны брать primaryDelay.
  const at = code.indexOf("label: '≈ время'")
  assert.ok(at > 0, 'плашка «≈ время» найдена')
  const block = code.slice(at, at + 700)
  const calls = [...block.matchAll(/taskSeconds\([^)]*\)/g)].map((x) => x[0])
  assert.ok(calls.length >= 2, 'в плашке считаются from и to')
  for (const c of calls) assert.ok(/primaryDelay/.test(c), `taskSeconds обязан брать primaryDelay: ${c}`)
})

/*
 * Замечание владельца 26.08: «задержка вступления ни на что не влияет — таймер меняется
 * только от задержки комментария». Воркер эту паузу реально спит (server/lib/joinTarget.js),
 * один раз на пару «аккаунт + цель», и при 281–600 с она весит больше самих комментариев.
 * Значит все три места времени обязаны её учитывать.
 */
test('вступления входят во время: все три места зовут joinSeconds', async () => {
  const timing = await fs.readFile(new URL('../../src/features/modules/shared/TimingSection.tsx', import.meta.url), 'utf8')
  const launch = await fs.readFile(new URL('../../src/features/modules/shared/LaunchCost.tsx', import.meta.url), 'utf8')
  assert.ok(/joinSeconds\(/.test(code), 'плашка «≈ время» в LiveModule учитывает вступления')
  assert.ok(/joinSeconds\(/.test(timing), 'блок «Защита и тайминги» учитывает вступления')
  assert.ok(/joinSeconds\(/.test(launch), 'нижний чип запуска учитывает вступления')
})

test('joinSeconds берёт min(целей, доли действий) — больше вступлений аккаунт не сделает', async () => {
  const pace = await fs.readFile(new URL('../../src/shared/lib/pace.ts', import.meta.url), 'utf8')
  const at = pace.indexOf('export function joinSeconds')
  assert.ok(at > 0, 'joinSeconds объявлена в общей формуле, а не скопирована по местам')
  const body = pace.slice(at, pace.indexOf('\n}', at))
  assert.ok(/Math\.min\(/.test(body), 'потолок — min(целей, доли действий)')
  assert.ok(/perAcc/.test(body) && /delay/.test(body), 'считает по доле аккаунта и паузе вступления')
})

test('LaunchCost принимает joinSec и targets — иначе нижний чип снова ослепнет', async () => {
  const launch = await fs.readFile(new URL('../../src/features/modules/shared/LaunchCost.tsx', import.meta.url), 'utf8')
  assert.ok(/joinSec\?:/.test(launch), 'проп joinSec объявлен')
  assert.ok(/targets\?:/.test(launch), 'проп targets объявлен')
  assert.ok(/joinSec=\{/.test(code) && /targets=\{/.test(code), 'LiveModule их реально передаёт')
})

test('блок «Защита и тайминги» получает showComment=commentPrimary — тот же признак', () => {
  assert.ok(/showComment=\{commentPrimary\}/.test(code), 'верхний блок и время делят один признак')
  assert.ok(/showAction=\{!commentPrimary\}/.test(code), 'action-поле показывается, когда модуль не comment-овый')
})
