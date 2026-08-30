/**
 * Регистрация с включённой капчей: конфиг капчи обязан быть доступен ГОСТЮ.
 *
 * Найдено 30.08 на живом прогоне. Человек заполнял форму и получал «проверка «я не робот»
 * не пройдена — обновите страницу и попробуйте снова», сколько бы раз ни обновлял.
 *
 * Цепочка была такая: страница регистрации спрашивает у сервера, включена ли капча и какой
 * у неё site-key → `/api/users/auth-config` не входил в публичный список → гостю отвечали
 * 401 → фронт молча глотал ошибку (`.catch(() => {})`) и считал, что капчи нет → виджет
 * Turnstile не рисовался → токен не приходил → сервер отказывал. Зарегистрироваться не мог
 * НИКТО, пока задан SESSION_SECRET, то есть на проде — вообще никто.
 *
 * Тесты поведенческие: гоняем настоящий `sessionGuard` настоящими запросами.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.SESSION_SECRET = 'тест-секрет-регистрация' // без него замок выключен и проверять нечего

const { sessionGuard } = await import('../lib/authGuard.js')

/** Прогнать гостевой запрос через гвард: пропущен дальше или отбит кодом. */
function гость(method, url) {
  const req = { method, url, originalUrl: url, headers: {}, header: () => undefined }
  let code = 0
  let passed = false
  const res = { status: (c) => { code = c; return res }, json: () => res }
  sessionGuard(req, res, () => { passed = true })
  return { code, passed }
}

test('гость получает конфиг капчи — иначе регистрация невозможна', () => {
  const r = гость('GET', '/api/users/auth-config')
  assert.ok(r.passed, [
    'Конфиг капчи нужен странице регистрации, где человек по определению НЕ вошёл.',
    'Без него фронт не знает site-key, виджет не рисуется, токен не приходит —',
    'и регистрация отказывает всем подряд со словами «проверка не пройдена».',
  ].join('\n'))
  assert.notEqual(r.code, 401, 'гостю не должно отвечать «требуется вход»')
})

test('вход и регистрация остаются открыты', () => {
  for (const url of ['/api/users/login', '/api/users/register']) {
    assert.ok(гость('POST', url).passed, `${url} обязан быть доступен без входа`)
  }
})

test('открыт ТОЛЬКО конфиг, а не весь /api/users', () => {
  // Публичным стал один точечный роут. Если бы правило написали шире (`/api/users/*`),
  // наружу уехал бы список пользователей платформы.
  for (const url of ['/api/users', '/api/users/usr_admin', '/api/accounts']) {
    const r = гость('GET', url)
    assert.equal(r.code, 401, `${url} обязан требовать входа`)
    assert.ok(!r.passed, `${url} не должен пропускаться дальше`)
  }
})

test('секрет капчи наружу не отдаётся', async () => {
  // Гостю уходит только флаг и ПУБЛИЧНЫЙ site-key. Секрет остаётся на сервере.
  const fs = await import('node:fs/promises')
  const src = await fs.readFile(new URL('../lib/turnstile.js', import.meta.url), 'utf8')
  const at = src.indexOf('export function turnstileConfig')
  const body = src.slice(at, at + 300)
  assert.ok(/siteKey: SITE_KEY\(\)/.test(body), 'site-key публичный — его отдавать можно')
  assert.ok(!/SECRET\(\)\s*[,}]/.test(body.replace(/!!SECRET\(\)/g, '')), 'секрет в ответ попадать не должен')
})
