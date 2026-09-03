/**
 * Регресс-тесты на правки по итогам ручного прогона 21–22.07.
 * Каждый тест назван номером теста из чек-листа, чтобы связь с находкой не терялась.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeTargets } from '../targetFolders.js'
import { postErrorHint, stopWorker, breakableDelay } from '../modules/workers.js'
import { generateComment } from '../neuroCommenting/commentGenerator.js'
import { foldersForRequest } from '../lib/accessGuard.js'
import { taskSignature, findDuplicateActiveTask } from '../lib/taskDedup.js'
import { OPEN_SESSION_CAP_MS } from '../workLog.js'
import { assertAccountsAssignable } from '../accountsMeta.js'

const mockReq = (headers = {}) => ({ header: (h) => headers[h.toLowerCase()] })
const FOLDERS = [
  { id: 'fld_a', name: 'Крипто', targets: ['c1', 'c2'] },
  { id: 'fld_b', name: 'IT', targets: ['c3'] },
]

// ── 11.7-d: дедуп целей папки регистронезависим ──────────────────────────
test('11.7-d: @NuancesProg и nuancesprog — одна цель, а не две', () => {
  const t = normalizeTargets(['@NuancesProg', 'nuancesprog', 'NUANCESPROG'])
  assert.deepEqual(t, ['nuancesprog'], 'юзернеймы Telegram регистронезависимы')
})

test('11.7-d: @, пробелы и регистр схлопываются вместе', () => {
  const t = normalizeTargets(['  @IT_Boooks ', 'it_boooks', '@dadaqqqeqw', ''])
  assert.deepEqual(t, ['it_boooks', 'dadaqqqeqw'])
})

test('11.7-d: порядок первого вхождения сохраняется', () => {
  assert.deepEqual(normalizeTargets(['b', 'a', 'B', 'A']), ['b', 'a'])
})

// ── 10.1: подсказка про права админа — только для ошибок доступа ─────────
test('10.1: CHAT_ADMIN_REQUIRED получает подсказку про права', () => {
  const s = postErrorHint(new Error('CHAT_ADMIN_REQUIRED'))
  assert.match(s, /админом канала/, 'здесь подсказка уместна')
})

test('10.1: ошибка прокси НЕ получает подсказку про права админа', () => {
  const s = postErrorHint(new Error('Invalid sockets params: ip=1.2.3.4, port=7063, socksType=undefined'))
  assert.doesNotMatch(s, /админ/i, 'иначе оператор идёт проверять права, а дело в прокси')
})

test('10.1: сетевая ошибка НЕ получает подсказку про права админа', () => {
  assert.doesNotMatch(postErrorHint(new Error('TIMEOUT')), /админ/i)
})

test('10.1: CHAT_WRITE_FORBIDDEN — тоже про доступ, подсказка нужна', () => {
  assert.match(postErrorHint(new Error('CHAT_WRITE_FORBIDDEN')), /админом канала/)
})

// ── 11.7: права на папки применяются НА СЕРВЕРЕ, а не только во фронте ───
test('11.7: без сессии отдаём все папки (дев/демо, как moduleAccessGuard)', async () => {
  assert.deepEqual(await foldersForRequest(mockReq(), FOLDERS), FOLDERS)
})

test('11.7: неизвестный пользователь не получает НИ ОДНОЙ папки (fail-closed)', async () => {
  const out = await foldersForRequest(mockReq({ 'x-user-id': 'нет-такого-юзера' }), FOLDERS)
  assert.deepEqual(out, [], 'иначе прямой запрос отдаёт базы каналов всех ролей')
})

test('11.7: исходный массив не мутируется', async () => {
  const copy = JSON.parse(JSON.stringify(FOLDERS))
  await foldersForRequest(mockReq({ 'x-user-id': 'нет-такого-юзера' }), FOLDERS)
  assert.deepEqual(FOLDERS, copy)
})

// ── 6.6: подпись задачи различает парсеры по ключевым словам ─────────────
test('6.6: поиск «crypto» и «nft» одним аккаунтом — РАЗНЫЕ задачи', () => {
  const a = { accountIds: ['acc_1'], keywords: ['crypto'] }
  const b = { accountIds: ['acc_1'], keywords: ['nft'] }
  assert.notEqual(taskSignature(a), taskSignature(b), 'иначе вторая выгрузка отклоняется как дубль')
  assert.equal(findDuplicateActiveTask([{ status: 'running', settings: a }], b), null)
})

test('6.6: те же ключи в другом порядке и регистре — всё же дубль', () => {
  const a = { accountIds: ['acc_1'], keywords: ['Crypto', 'nft'] }
  const b = { accountIds: ['acc_1'], keywords: ['NFT', 'crypto'] }
  assert.equal(taskSignature(a), taskSignature(b))
  assert.ok(findDuplicateActiveTask([{ status: 'running', settings: a }], b), 'настоящий дубль ловим')
})

// ── 6.2: стоп работает и на задаче, стоящей на паузе ─────────────────────
function mockStore(task) {
  return {
    loadTask: async () => task,
    saveTask: async (t) => { task = t },
    appendLog: async () => {},
  }
}

test('6.2: стоп задачи НА ПАУЗЕ переводит её в stopped, а не оставляет paused', async () => {
  const task = { id: 'x_1', status: 'paused', pauseRequested: true, settings: { accountIds: [] } }
  const out = await stopWorker('x_1', mockStore(task))
  assert.equal(out.status, 'stopped', 'иначе «остановленную» задачу можно возобновить кнопкой')
  assert.equal(out.pauseRequested, false, 'снят флаг паузы, иначе она вернётся в paused')
})

test('6.2: у работающей задачи стоп только просит остановиться — статус меняет воркер', async () => {
  const task = { id: 'x_2', status: 'running', settings: { accountIds: [] } }
  const out = await stopWorker('x_2', mockStore(task))
  assert.equal(out.stopRequested, true)
  assert.equal(out.status, 'running', 'воркер сам доведёт до stopped на выходе из цикла')
})

// ── MR-130: «Стоп» реагирует ВО ВРЕМЯ паузы между действиями ─────────────
test('MR-130: breakableDelay ловит стоп из store за ~1с и переносит флаг в task', async () => {
  const stored = { id: 'd_1', stopRequested: true }
  const task = { id: 'd_1' } // in-memory копия воркера БЕЗ флага (как после старого saveTask)
  const t0 = Date.now()
  const broke = await breakableDelay(60_000, mockStore(stored), task)
  assert.equal(broke, true, 'длинная пауза прерывается по стопу из store, а не спит минуту')
  assert.ok(Date.now() - t0 < 5_000, 'реакция за пару секунд, а не за все 60с')
  assert.equal(task.stopRequested, true, 'флаг перенесён в task → финальный статус будет stopped, не done')
})

test('MR-130: без стопа breakableDelay досыпает и возвращает false', async () => {
  const task = { id: 'd_2' }
  const broke = await breakableDelay(40, mockStore({ id: 'd_2' }), task)
  assert.equal(broke, false)
  assert.ok(!task.stopRequested && !task.pauseRequested)
})

// ── MR-130: секвенс — сверх лимита задачи ждут в очереди ─────────────────
test('MR-130: сверх лимита задачи встают в очередь (queued) и стартуют по слоту', async () => {
  const { startWorker, stopWorker, getConcurrencyState } = await import('../modules/workers.js')
  const tick = () => new Promise((r) => setTimeout(r, 15))
  const tasks = new Map()
  const store = {
    loadTask: async (id) => tasks.get(id) || null,
    saveTask: async (t) => { tasks.set(t.id, t) },
    appendLog: async () => {},
  }
  const gates = {} // gates[id]() завершает раннер этой задачи
  const runner = (task) => new Promise((resolve) => { gates[task.id] = resolve })
  const ids = ['q1', 'q2', 'q3', 'q4', 'q5'] // лимит по умолчанию = 3
  for (const id of ids) {
    tasks.set(id, { id, status: 'running', settings: { accountIds: [] } })
    startWorker(id, store, runner)
  }
  await tick()
  let st = getConcurrencyState()
  assert.equal(st.running, 3, 'одновременно работает ровно лимит')
  assert.equal(st.waiting, 2, 'остальные ждут свободный слот')
  assert.equal(tasks.get('q4').status, 'queued', 'ждущая помечена как queued, а не «пропала»')

  // Стоп ждущей в очереди — снимаем без холостого запуска.
  await stopWorker('q5', store)
  assert.equal(tasks.get('q5').status, 'stopped', 'снятая из очереди — stopped')
  assert.equal(getConcurrencyState().waiting, 1, 'в очереди осталась одна (q4)')

  // Одна работающая завершилась → освободившийся слот берёт ждущая q4.
  gates.q1()
  await tick()
  st = getConcurrencyState()
  assert.equal(st.waiting, 0, 'очередь опустела — q4 стартовала по слоту')
  assert.equal(st.running, 3, 'слот переиспользован, не превышен')

  // Прибираемся: завершаем оставшиеся раннеры.
  gates.q2(); gates.q3(); gates.q4()
  await tick()
})

// ── 1.3: шаблонный комментарий различается по аккаунту ───────────────────
test('1.3: разные аккаунты под одним постом пишут РАЗНЫЙ текст', async (t) => {
  const key = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY
  t.after(() => { if (key !== undefined) process.env.OPENAI_API_KEY = key })
  const post = 'Привет всем!'
  const ids = ['acc_aaa111', 'acc_bbb222', 'acc_ccc333']
  const texts = []
  for (const id of ids) texts.push((await generateComment(post, 0, undefined, id)).text)
  assert.equal(new Set(texts).size, texts.length,
    'одинаковый текст с нескольких аккаунтов — сигнатура ботофермы и путь к спам-блоку')
})

test('1.3: тот же аккаунт на том же посте даёт стабильный текст', async (t) => {
  const key = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY
  t.after(() => { if (key !== undefined) process.env.OPENAI_API_KEY = key })
  const a = await generateComment('Привет всем!', 0, undefined, 'acc_aaa111')
  const b = await generateComment('Привет всем!', 0, undefined, 'acc_aaa111')
  assert.equal(a.text, b.text, 'вариант не должен перебираться при повторе')
})

test('1.3: без seed поведение прежнее — выбор по promptIndex', async (t) => {
  const key = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY
  t.after(() => { if (key !== undefined) process.env.OPENAI_API_KEY = key })
  const a = await generateComment('Привет всем!', 1)
  const b = await generateComment('Привет всем!', 1)
  assert.equal(a.text, b.text)
})

// ── 7.9: учёт рабочего времени считает работу, а не календарь ────────────
test('7.9: незакрытая сессия не растёт бесконечно — есть потолок', () => {
  const H = 60 * 60 * 1000
  assert.equal(OPEN_SESSION_CAP_MS, 12 * H, 'смена, а не четверо суток')
  const start = Date.parse('2026-07-17T16:53:00Z')
  const now = start + 98 * H // ровно тот случай из лога: сессия «длиной 98 часов»
  const counted = Math.min(now, start + OPEN_SESSION_CAP_MS) - start
  assert.equal(counted, 12 * H)
})

// ── 9.1: строка-заголовок схемы задаёт схему следующим строкам ───────────
test('9.1: «http:» отдельной строкой не ошибка, а схема для следующих прокси', async () => {
  const { parseProxyList } = await import('../lib/proxyImport.js')
  const r = parseProxyList('http:\n1.2.3.4:7063:u:p\nsocks5:\n1.2.3.4:7163:u:p\n')
  assert.equal(r.errors.length, 0, 'заголовок схемы больше не падает в errors')
  assert.deepEqual(r.items.map((i) => `${i.scheme}:${i.port}`), ['http:7063', 'socks5:7163'],
    'иначе http-прокси легли бы в базу как socks5 и не работали')
})

test('9.1: без заголовка поведение прежнее — схема по умолчанию', async () => {
  const { parseProxyList } = await import('../lib/proxyImport.js')
  const r = parseProxyList('1.2.3.4:7163:u:p')
  assert.equal(r.items[0].scheme, 'socks5')
})

// ── 9.11: ссылка смены IP — не ошибка формата ────────────────────────────
test('9.11: ссылка …/changeip/<token> привязывается к прокси того же хоста', async () => {
  const { parseProxyList } = await import('../lib/proxyImport.js')
  const r = parseProxyList('http:\n1.2.3.4:7063:u:p\nhttp://1.2.3.4:8881/changeip/abc123\n')
  assert.equal(r.errors.length, 0, 'раньше такая строка пугала оператора как «не удалось разобрать формат»')
  assert.equal(r.items[0].rotateUrl, 'http://1.2.3.4:8881/changeip/abc123')
})

test('9.11: чужой хост ссылку не получает', async () => {
  const { parseProxyList } = await import('../lib/proxyImport.js')
  const r = parseProxyList('5.6.7.8:7063:u:p\nhttp://1.2.3.4:8881/changeip/abc\n')
  assert.equal(r.items[0].rotateUrl, undefined)
})

// ── 9.4: geoSource переживает запись в базу ──────────────────────────────
test('9.4: geoSource сохраняется, мусор отсекается', async () => {
  const { normalizeProxy } = await import('../proxies.js')
  assert.equal(normalizeProxy({ host: 'h', port: 1, geoSource: 'exit' }).geoSource, 'exit')
  assert.equal(normalizeProxy({ host: 'h', port: 1, geoSource: 'gateway' }).geoSource, 'gateway')
  assert.equal(normalizeProxy({ host: 'h', port: 1, geoSource: 'мусор' }).geoSource, null,
    'иначе UI не отличит гео реального выхода от гео шлюза')
})

// ── 12.6: аккаунт без посчитанного trust не идёт в боевой модуль ─────────
test('12.6: профиль без trust не пускается в боевой модуль (fail-closed)', async () => {
  const err = await assertAccountsAssignable(['acc_нет_такого_в_кэше'], 'neuro-commenting')
  assert.ok(err, 'иначе свежедобавленный аккаунт — самый уязвимый — проходит гейт §6')
  assert.match(String(err), /не посчитан trust/i)
})

test('12.6: не-боевой модуль по trust не гейтится', async () => {
  assert.equal(await assertAccountsAssignable(['acc_нет_такого_в_кэше'], 'parsing'), null)
})

test('7.9: в окно попадает ПЕРЕСЕЧЕНИЕ сессии с ним, а не вся длительность', () => {
  const H = 60 * 60 * 1000
  const overlap = (aS, aE, wS, wE) => Math.max(0, Math.min(aE, wE) - Math.max(aS, wS))
  const dayStart = Date.parse('2026-07-22T00:00:00Z')
  // Сессия с 22:00 вчера до 02:00 сегодня: «сегодня» должно быть 2 часа, а не 4.
  const s = dayStart - 2 * H
  const e = dayStart + 2 * H
  assert.equal(overlap(s, e, dayStart, e), 2 * H)
})
