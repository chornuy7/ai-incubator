#!/usr/bin/env node
/**
 * MR-262: перенос уже накопленных прокси из аккаунтов в каталог.
 *
 * До этой задачи `accounts_meta.proxy` хранил полную строку подключения, скопированную в
 * каждый аккаунт. Скрипт разбирает эти строки, заводит недостающие записи в каталоге и
 * проставляет аккаунтам ссылку `proxyId`.
 *
 * Запуск: `node server/scripts/proxy-backfill.mjs` — покажет план и ничего не изменит.
 *         `node server/scripts/proxy-backfill.mjs --apply` — выполнит.
 *
 * Идемпотентен: аккаунт со ссылкой пропускается, одинаковые строки схлопываются в одну
 * запись каталога (правило уникальности host+port+логин+пароль — как в createProxy).
 */
import { loadAllMetaRaw, setAccountMeta } from '../accountsMeta.js'
import { listProxies, createProxy, importProxies, toProxyUrl } from '../proxies.js'
import { readJson, dataPath } from '../lib/jsonStore.js'
import { parseProxy } from '../proxy.js'

const ПРИМЕНИТЬ = process.argv.includes('--apply')

const строка = (m) => String(m?.proxy || '').trim()
const рабочая = (s) => s && s !== '—' && s.includes('://')

/**
 * Шаг 0: каталог из ФАЙЛА в хранилище.
 *
 * Найдено при проверке 01.09, до того как это ударило: на проде каталог живёт в
 * `data/proxies.json` (97 записей), а новый код читает каталог из БД. Выложи код без этого
 * шага — и в панели прокси стало бы НОЛЬ, хотя на диске они целы. Импортируем с
 * сохранением id: на старые id уже ссылаются аккаунты.
 */
async function перенестиКаталог() {
  const файл = process.env.PROXIES_FILE || dataPath('proxies.json')
  const изФайла = await readJson(файл, [])
  if (!Array.isArray(изФайла) || !изФайла.length) return { added: 0, skipped: 0, файл: 0 }
  if (ПРИМЕНИТЬ) return { ...(await importProxies(изФайла)), файл: изФайла.length }
  // Режим плана: считаем то же самое, но ничего не пишем.
  const есть = await listProxies()
  const поId = new Set(есть.map((p) => p.id))
  const добавим = изФайла.filter((p) => p && p.host && p.port && !поId.has(p.id)).length
  return { added: добавим, skipped: изФайла.length - добавим, файл: изФайла.length }
}

async function main() {
  const каталогИтог = await перенестиКаталог()
  console.log(`каталог из файла: ${каталогИтог.файл} записей → в хранилище ${ПРИМЕНИТЬ ? 'добавлено' : 'добавится'} ${каталогИтог.added}, пропущено ${каталогИтог.skipped}`)

  const мета = await loadAllMetaRaw()
  const каталог = await listProxies()
  const поСтроке = new Map(каталог.map((p) => [toProxyUrl(p), p]))

  const кПереносу = []
  let сСылкой = 0
  let безПрокси = 0

  for (const [id, m] of Object.entries(мета)) {
    if (m?.proxyId) { сСылкой++; continue }
    const url = строка(m)
    if (!рабочая(url)) { безПрокси++; continue }
    кПереносу.push({ id, url })
  }

  const новые = new Map() // строка → что заводим
  for (const { url } of кПереносу) {
    if (поСтроке.has(url) || новые.has(url)) continue
    const p = parseProxy(url)
    if (!p?.host || !p?.port) continue // мусор в строке — разбираться руками, а не гадать
    новые.set(url, {
      scheme: p.type || 'socks5',
      host: p.host,
      port: p.port,
      username: p.login || '',
      password: p.password || '',
      // Владельца берём с аккаунта: прокси — ресурс клиента, и общий каталог был бы утечкой.
      ownerId: мета[кПереносу.find((x) => x.url === url).id]?.ownerId || '',
      label: 'Перенесён из аккаунта',
    })
  }

  console.log(`аккаунтов всего: ${Object.keys(мета).length}`)
  console.log(`  уже по ссылке: ${сСылкой}`)
  console.log(`  без прокси:    ${безПрокси}`)
  console.log(`  к переносу:    ${кПереносу.length}`)
  console.log(`новых записей в каталоге: ${новые.size} (из ${каталог.length} имеющихся)`)

  if (!ПРИМЕНИТЬ) {
    console.log('\nЭто ПЛАН. Ничего не изменено. Повторите с --apply.')
    return
  }

  for (const [url, вход] of новые) {
    try {
      const p = await createProxy(вход)
      поСтроке.set(url, p)
    } catch (e) {
      // Уже есть (гонка или совпадение по правилу уникальности) — перечитаем каталог.
      const свежий = await listProxies()
      const найден = свежий.find((x) => toProxyUrl(x) === url)
      if (найден) поСтроке.set(url, найден)
      else console.warn(`не завёлся ${url}: ${e instanceof Error ? e.message : e}`)
    }
  }

  let проставлено = 0
  for (const { id, url } of кПереносу) {
    const p = поСтроке.get(url)
    if (!p) continue
    await setAccountMeta(id, { proxyId: p.id, proxy: toProxyUrl(p) })
    проставлено++
  }
  console.log(`\nГотово: ссылок проставлено ${проставлено}, записей заведено ${новые.size}.`)
}

main().catch((e) => { console.error('ОШИБКА:', e instanceof Error ? e.message : e); process.exit(1) })
