/**
 * MR-186: данные живут в ОБЩЕЙ БАЗЕ, а не в браузере и не в файлах.
 *
 * Правило владельца с созвона 24.08: пройти по кодовой базе и убедиться, что другого
 * способа хранения нет. Повод был конкретный — тексты промптов лежали в localStorage без
 * имени владельца, из-за чего правка одного человека доставалась всем (MR-185), а шаблон
 * не возвращал текст промпта (MR-176).
 *
 * Этот тест — «дорога назад закрыта»: он падает, когда в интерфейсе появляется новое
 * обращение к памяти браузера вне разрешённого списка. Список короткий и каждый пункт
 * объяснён: что там лежит и почему это НЕ данные пользователя.
 *
 * Если вы сюда попали из-за красного теста — не добавляйте файл в список молча. Сначала
 * ответьте: что будет, если этих данных не станет; и что увидит другой человек, зашедший
 * с этого же компьютера. Если ответ «потеряются его настройки» или «увидит чужое» —
 * место данным в базе, а не здесь.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

const SRC = new URL('../../src/', import.meta.url)

/**
 * Кому МОЖНО обращаться к localStorage/sessionStorage — и почему.
 * Ключ: путь от src/. Значение: причина, по которой это не данные пользователя.
 */
const ALLOWED = {
  'features/auth/session.ts': 'токен и профиль текущей сессии — иначе вход не переживёт перезагрузку',
  'shared/lib/liveSocket.ts': 'тот же токен сессии для живого канала: браузерный WebSocket не даёт задать заголовок',
  'features/auth/zone.ts': 'имена ключей сессии (панель/админка живут раздельно)',
  'features/auth/SessionGuard.tsx': 'чтение токена своей зоны при входе на страницу',
  'features/auth/ImpersonationBar.tsx': 'вход под клиентом: снять подменную сессию и вернуться к своей',
  'pages/AdminStatsPage.tsx': 'вход под клиентом из админки — выдача подменной сессии',
  'mocks/store.ts': 'только настройки отображения: язык, тема, демо-состояние',
  'widgets/AppSidebar.tsx': 'какие группы меню свёрнуты — вид, а не данные',
  'widgets/AppHeader.tsx': 'закрытые уведомления, ключ именной (у каждого свои)',
  'pages/ProfilePage.tsx': 'аватар как картинка в браузере, ключ именной; на сервер не грузим',
  'features/modules/shared/promptDefaults.ts': 'РАЗОВЫЙ перенос старых промптов в базу: прочитать и стереть',
  'features/modules/shared/activeTaskStorage.ts': 'sessionStorage: какая задача открыта в этой вкладке',
  'api/usersApi.ts': 'запись токена сессии своей зоны — без него вход не переживёт перезагрузку',
  'features/billing/LowBalanceLoginModal.tsx': 'поп-ап про баланс: «больше не показывать» и «уже видел в этой вкладке»',
  'features/billing/plan.ts': 'кэш состава подписки, ключ ИМЕННОЙ; ответ сервера его сразу поправляет — иначе меню моргает пустотой',
}

/** Все файлы интерфейса. */
async function walk(dir) {
  const out = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir)
    if (e.isDirectory()) out.push(...await walk(p))
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

const rel = (u) => path.relative(SRC.pathname, u.pathname).replace(/\\/g, '/')

test('в интерфейсе нет новых обращений к памяти браузера вне разрешённого списка', async () => {
  const offenders = []
  for (const f of await walk(SRC)) {
    const src = await fs.readFile(f, 'utf8')
    // Комментарии не считаем: про localStorage в них пишут как раз объясняя, почему его убрали.
    const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    if (!/\b(localStorage|sessionStorage)\s*\./.test(code)) continue
    const key = rel(f)
    if (!(key in ALLOWED)) offenders.push(key)
  }
  assert.deepEqual(offenders, [], [
    'Данные пользователя должны лежать в общей базе, а не в браузере.',
    'Новые места:', ...offenders.map((o) => '  · ' + o),
    'Если это точно не данные (вид, черновик вкладки, токен сессии) — допишите файл',
    'в ALLOWED в этом тесте вместе с причиной.',
  ].join('\n'))
})

test('разрешённый список не протух: каждый файл существует и правда обращается к хранилищу', async () => {
  const stale = []
  for (const [key, why] of Object.entries(ALLOWED)) {
    assert.ok(why && why.length > 15, `${key}: причина должна быть человеческой, а не отпиской`)
    const src = await fs.readFile(new URL(key, SRC), 'utf8').catch(() => null)
    if (src === null) { stale.push(`${key} — файла нет`); continue }
    const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    if (!/\b(localStorage|sessionStorage)\s*\./.test(code)) stale.push(`${key} — обращения больше нет`)
  }
  assert.deepEqual(stale, [], 'Уберите из списка то, чего уже нет:\n  ' + stale.join('\n  '))
})

test('настройки модулей не запоминаются в браузере', async () => {
  // Находка 27.08: нейродиалоги помнили «отвечать всем», цель диалога и разбор картинок
  // в localStorage. На общем компьютере это доставалось следующему человеку, а со своего
  // второго устройства он этих настроек не видел. Все они и так уходят в настройки задачи
  // и восстанавливаются из шаблона — а шаблоны лежат в общей базе.
  const modules = (await walk(new URL('features/modules/', SRC))).concat(
    await walk(new URL('features/neuro-dialogs/', SRC)),
  )
  const offenders = []
  for (const f of modules) {
    const key = rel(f)
    if (key in ALLOWED) continue
    const code = (await fs.readFile(f, 'utf8')).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    if (/\b(localStorage|sessionStorage)\s*\./.test(code)) offenders.push(key)
  }
  assert.deepEqual(offenders, [], 'настройки модуля должны уходить в задачу и шаблон, а не в браузер')
})

test('данные кабинета не сохраняются в браузер: там только вид', async () => {
  const src = await fs.readFile(new URL('mocks/store.ts', SRC), 'utf8')
  const at = src.indexOf('const persist = ')
  assert.ok(at > 0, 'функция сохранения найдена')
  const body = src.slice(at, at + 600)
  assert.ok(/localStorage\.setItem/.test(body), 'сохранение действительно есть')
  assert.ok(!/\bdata\b\s*[,:}]/.test(body.split('setItem')[1] || ''), [
    'В браузер уезжают данные кабинета (тариф, монеты, задачи, тикеты, прокси, имя и почта).',
    'Выход из аккаунта их не чистит: на общем компьютере они достанутся следующему.',
  ].join('\n'))
})
