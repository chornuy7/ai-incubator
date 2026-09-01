/**
 * MR-262: прокси живут в каталоге, аккаунт ссылается на них КЛЮЧОМ.
 *
 * Владелец 01.09: «мы же тысячу раз говорили, что прокси храним в БД, а не в аккаунте,
 * отдельно! С любого места добавление идёт в БД, и мы их забираем к аккаунту из БД, а в
 * таблице БД ссылка просто на строку, где прокси».
 *
 * Что ломалось от копий строки в каждом аккаунте: смена пароля в каталоге до аккаунтов не
 * доходила, удаление прокси оставляло строку-призрак, «кем занят» считалось сравнением
 * строк. Здесь проверяется главное — что строка стала ПРОИЗВОДНОЙ от каталога.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.PROXIES_FILE = path.join(os.tmpdir(), `mr262-proxies-${process.pid}.json`)

const { createProxy, updateProxy, deleteProxy, importProxies, listProxies, toProxyUrl } = await import('../proxies.js')
const { withProxyStrings, proxyPatch, findByUrl } = await import('../lib/proxyLink.js')

test.after(() => { try { fs.unlinkSync(process.env.PROXIES_FILE) } catch { /* нечего убирать */ } })

test('назначение пишет ключ, а не только строку', async () => {
  const p = await createProxy({ host: '10.0.0.1', port: 1080, username: 'u', password: 'p1' })
  const patch = proxyPatch(p)
  assert.equal(patch.proxyId, p.id, 'ключ — источник истины')
  assert.equal(patch.proxy, 'socks5://u:p1@10.0.0.1:1080', 'строка рядом — для читателей')

  // Снятие прокси убирает и ссылку: иначе она пережила бы «без прокси».
  assert.deepEqual(proxyPatch(null), { proxyId: '', proxy: '' })
})

test('смена пароля в каталоге доходит до аккаунта сама', async () => {
  /*
   * Ради этого всё и делалось. Раньше строка лежала копией в каждом аккаунте: сменили
   * пароль у прокси — сорок аккаунтов продолжали ходить со старым, пока их не переназначат
   * руками.
   */
  const p = await createProxy({ host: '10.0.0.2', port: 1080, username: 'u', password: 'старый' })
  const мета = { acc_1: { proxyId: p.id, proxy: toProxyUrl(p) } }

  await updateProxy(p.id, { password: 'новый' })
  const после = await withProxyStrings(мета)
  assert.equal(после.acc_1.proxy, 'socks5://u:%D0%BD%D0%BE%D0%B2%D1%8B%D0%B9@10.0.0.2:1080',
    'строка пересобрана из каталога, а не взята из аккаунта')
  // Исходный объект не тронут: пересборка — это чтение, а не запись.
  assert.equal(мета.acc_1.proxy, 'socks5://u:%D1%81%D1%82%D0%B0%D1%80%D1%8B%D0%B9@10.0.0.2:1080')
})

test('прокси удалили — строку не стираем, но помечаем', async () => {
  /*
   * Молчаливый обрыв связи посреди задачи хуже, чем работа на прежнем прокси: аккаунт
   * продолжает работать, а «прокси исчез» — это разговор с человеком.
   */
  const p = await createProxy({ host: '10.0.0.3', port: 1080 })
  const url = toProxyUrl(p)
  await deleteProxy(p.id)

  const после = await withProxyStrings({ acc_2: { proxyId: p.id, proxy: url } })
  assert.equal(после.acc_2.proxy, url, 'строка осталась')
  assert.equal(после.acc_2.proxyGone, true, 'но видно, что каталог о нём больше не знает')
})

test('аккаунты без ссылки не трогаем — и каталог ради них не читаем', async () => {
  // Старые записи (строка без ключа) работают как работали: переход постепенный.
  const мета = { acc_3: { proxy: 'socks5://old:pass@1.2.3.4:1080' } }
  assert.deepEqual(await withProxyStrings(мета), мета)
})

test('строка находится в каталоге целиком, а не по host+port', async () => {
  /*
   * У одного хоста бывает несколько записей с разными логинами — по адресу их не
   * различить, и перенос старых аккаунтов повесил бы половину не на тот прокси.
   */
  const a = await createProxy({ host: '10.0.0.9', port: 1080, username: 'первый', password: 'x' })
  const b = await createProxy({ host: '10.0.0.9', port: 1080, username: 'второй', password: 'y' })
  const каталог = [a, b]
  assert.equal(findByUrl(каталог, toProxyUrl(b))?.id, b.id)
  assert.equal(findByUrl(каталог, 'socks5://чужой@10.0.0.9:1080'), null)
  assert.equal(findByUrl(каталог, ''), null)
})

test('каталог прокси лежит в БД, а не в файле', () => {
  /*
   * Таблицы `proxies` в базе не было вовсе — ни в одной из миграций. Прокси жили файлом
   * `data/proxies.json`, то есть в резервной копии базы их не было совсем: потеря диска
   * сервера означала потерю всех прокси.
   */
  const модуль = fs.readFileSync(new URL('../proxies.js', import.meta.url), 'utf8')
  assert.match(модуль, /listStore\(\{/, 'каталог должен работать через табличный стор')
  assert.match(модуль, /table: 'proxies'/)
  assert.doesNotMatch(модуль, /writeJson\(/, 'запись мимо стора вернула бы файл в источники истины')

  const миграция = fs.readFileSync(new URL('../../supabase/migrations/2026-09-01-mr262-proxies.sql', import.meta.url), 'utf8')
  assert.match(миграция, /create table if not exists proxies/)
  // Уникальность endpoint'а — на уровне базы: параллельный импорт из двух вкладок раньше
  // мог завести дубль, потому что «проверил → записал» делались не атомарно.
  assert.match(миграция, /create unique index if not exists proxies_unique_endpoint/)
  assert.match(миграция, /alter table accounts_meta add column if not exists proxy_id/)
})

test('в строке таблицы аккаунта есть ссылка на прокси', () => {
  const мета = fs.readFileSync(new URL('../accountsMeta.js', import.meta.url), 'utf8')
  assert.match(мета, /proxy_id: m\.proxyId \|\| null/, 'ключ должен доезжать до колонки')
  // Пересборка строки — на чтении; писать её обратно значило бы снова размножить копии.
  assert.match(мета, /return withProxyStrings\(await loadAllMetaRaw\(\)\)/)
})

test('каталог переносится из файла с СОХРАНЕНИЕМ id', async () => {
  /*
   * Найдено при проверке 01.09, до того как ударило: на проде каталог живёт в
   * `data/proxies.json` (97 записей), а новый код читает его из БД. Выложи код без переноса
   * — и в панели прокси стало бы НОЛЬ при живых записях на диске.
   *
   * Id сохраняются намеренно: на них уже ссылаются аккаунты. `createProxy` тут не годится
   * — он выдаёт новый id, и ссылки указывали бы в пустоту.
   */
  const итог = await importProxies([
    { id: 'px_старый', host: '10.9.9.1', port: 1080, username: 'u', password: 'p', status: 'ok' },
    { id: 'px_второй', host: '10.9.9.2', port: 1080 },
  ])
  assert.equal(итог.added, 2)
  const каталог = await listProxies()
  assert.equal(каталог.find((p) => p.id === 'px_старый')?.host, '10.9.9.1', 'id должен остаться прежним')
  assert.equal(каталог.find((p) => p.id === 'px_старый')?.status, 'ok', 'статус переносится, а не сбрасывается')

  // Повтор ничего не дублирует — скрипт переноса запускают не один раз.
  const второй = await importProxies([
    { id: 'px_старый', host: '10.9.9.1', port: 1080, username: 'u', password: 'p' },
    { id: 'px_другой_id', host: '10.9.9.2', port: 1080 }, // тот же адрес, другой id
  ])
  assert.equal(второй.added, 0)
  assert.equal(второй.skipped, 2, 'вторая запись — тот же адрес, а значит тот же прокси')

  // Мусор без адреса не переносим: гадать, что это было, хуже, чем пропустить.
  assert.deepEqual(await importProxies([{ id: 'px_пусто' }]), { added: 0, skipped: 0 })
})
