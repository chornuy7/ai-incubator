// Порт ядра TGStat-парсера (tgstat_svc.py + iter_catalog_http_pages) на Node + cheerio.
import * as cheerio from 'cheerio'
import {
  REGION_HOSTS, DEFAULT_HOST, DEFAULT_HEADERS, CATALOG_PEER_TYPES,
  TELEGRAM_LOGIN_COOKIES, buildCatalogUrl, categoryLabel, regionLabel,
} from './constants.js'

export class ParseError extends Error {}

const NUMBER_RE = /(\d[\d  ]*\.?\d*)\s*([kкmмbб])?/i
const TGSTAT_HOST = String.raw`[a-z0-9-]*\.?tgstat\.(?:ru|com)`
const CHANNEL_URL_RE = new RegExp(`^https?://${TGSTAT_HOST}/(?:[a-z]{2}/)?channel/([^/?#]+)`, 'i')
const CHAT_URL_RE = new RegExp(`^https?://${TGSTAT_HOST}/(?:[a-z]{2}/)?chat/([^/?#]+)`, 'i')
const TG_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,32}$/

/** '33 550 participants' / '1.2K' / '12К участников' → int. */
export function parseSubscribers(text) {
  if (!text) return 0
  const s = String(text).trim().replace(/ /g, ' ')
  const m = NUMBER_RE.exec(s)
  if (!m) return 0
  const numPart = m[1].replace(/ /g, '').replace(',', '.')
  const suffix = (m[2] || '').toLowerCase()
  const val = Number(numPart)
  if (!Number.isFinite(val)) return 0
  let mul = 1
  if (suffix === 'k' || suffix === 'к') mul = 1_000
  else if (suffix === 'm' || suffix === 'м') mul = 1_000_000
  else if (suffix === 'b' || suffix === 'б') mul = 1_000_000_000
  return Math.round(val * mul)
}

function absoluteUrl(href, base) {
  try { return new URL(href, base).toString() } catch { return href }
}

/** /channel/… или /chat/… → { chatLink, username, statUrl } | null */
export function extractPeerMeta(rawHref, sourceUrl) {
  let href = (rawHref || '').trim()
  if (!href) return null
  if (!href.startsWith('http')) href = absoluteUrl(href, sourceUrl)
  href = href.split('?')[0]
  for (const re of [CHANNEL_URL_RE, CHAT_URL_RE]) {
    const m = re.exec(href)
    if (!m) continue
    let rawId = m[1]
    let username = null
    if (rawId.startsWith('@')) {
      const cand = rawId.slice(1)
      if (TG_USERNAME_RE.test(cand)) username = cand
    } else if (TG_USERNAME_RE.test(rawId)) {
      username = rawId
    }
    const chatLink = username ? `https://t.me/${username}` : href
    return { chatLink, username, statUrl: href }
  }
  return null
}

export function looksLikeCloudflare(text) {
  const low = (text || '').toLowerCase()
  if (low.includes('cloudflare') && (
    low.includes('checking your browser') || low.includes('ray id') ||
    low.includes('attention required') || low.includes('challenge-platform'))) return true
  if (low.includes('cf-mitigated') || low.includes('name="cf-')) return true
  return false
}

function catalogPageHasPeers(html) {
  const low = (html || '').toLowerCase()
  return low.includes('peer-item') || low.includes('/channel/') || low.includes('/chat/')
}

/** HTML каталога → массив ParsedChat. */
export function parsePage(htmlText, sourceUrl, categorySlug, regionSlug) {
  if (looksLikeCloudflare(htmlText)) {
    throw new ParseError('Cloudflare challenge — tgstat требует проверки браузера. Попробуйте позже или используйте прокси.')
  }
  const $ = cheerio.load(htmlText)
  const catHuman = categoryLabel(categorySlug)
  const regionHuman = regionLabel(regionSlug)
  const results = []
  const seen = new Set()

  let anchors = $('.peer-item-row a, .peer-item-box a, .peer-item a').filter((_, a) => {
    const h = $(a).attr('href') || ''
    return h.includes('/channel/') || h.includes('/chat/')
  })
  if (anchors.length === 0) {
    anchors = $('a').filter((_, a) => {
      const h = $(a).attr('href') || ''
      return h.includes('/channel/') || h.includes('/chat/')
    })
  }

  anchors.each((_, a) => {
    const meta = extractPeerMeta($(a).attr('href'), sourceUrl)
    if (!meta || seen.has(meta.chatLink)) return

    const $card = nearestCard($, a)
    const cardText = ($card.text() || '').trim()
    const anchorText = ($(a).text() || '').trim()

    // Имя чата: первая строка с буквами, не число/служебное слово.
    let chatName = ''
    const candidates = (anchorText ? anchorText : cardText).split(/[\n\r]+/).map((x) => x.trim()).filter(Boolean)
    for (const line of candidates) {
      if (line.startsWith('#') && /^\d+$/.test(line.slice(1).trim())) continue
      if (/^[\d.,kKкКmMмМ\s]+$/.test(line)) continue
      const low = line.toLowerCase()
      if (['participants', 'участников', 'подписчиков', 'messages', 'сообщений', 'сообщения', 'mau'].includes(low)) continue
      chatName = line.slice(0, 255)
      break
    }
    if (!chatName) chatName = (meta.username || meta.chatLink).slice(0, 255)

    let subscribers = 0
    const mSubs = /([\d ,. ]+[kKкКmMмМbBбБ]?)\s*(?:participants|участников|подписчиков|members)/.exec(cardText)
    if (mSubs) subscribers = parseSubscribers(mSubs[1])
    if (subscribers === 0) {
      const mAny = /([\d][\d ,. ]*[kKкКmMмМbBбБ]?)/.exec(anchorText)
      if (mAny) subscribers = parseSubscribers(mAny[1])
    }

    results.push({
      chat_name: chatName,
      chat_link: meta.chatLink.slice(0, 255),
      chat_username: meta.username ? meta.username.slice(0, 128) : null,
      subscribers,
      category: catHuman,
      category_code: categorySlug,
      region: regionHuman,
      source_tgstat_url: meta.statUrl.slice(0, 500),
    })
    seen.add(meta.chatLink)
  })

  return results
}

function nearestCard($, el) {
  const keywords = ['participant', 'участник', 'подписчик']
  let node = $(el)
  for (let i = 0; i < 8; i++) {
    const parent = node.parent()
    if (!parent || parent.length === 0) return node
    const blob = (parent.text() || '').toLowerCase()
    if (keywords.some((k) => blob.includes(k)) && /\d/.test(blob)) return parent
    node = parent
  }
  return $(el)
}

// ── cookies ──

export function cookieHeaderFromState(state) {
  const cookies = state?.cookies || []
  const parts = []
  for (const c of cookies) {
    const domain = (c.domain || '').toLowerCase()
    if (!domain.includes('tgstat')) continue
    if (c.name && c.value != null) parts.push(`${c.name}=${c.value}`)
  }
  return parts.length ? parts.join('; ') : null
}

export function hasTelegramLogin(state) {
  for (const c of state?.cookies || []) {
    const domain = (c.domain || '').toLowerCase()
    if (domain.includes('tgstat') && TELEGRAM_LOGIN_COOKIES.has(c.name)) return true
  }
  return false
}

export function cookieSummary(state) {
  const names = [...new Set((state?.cookies || [])
    .filter((c) => (c.domain || '').toLowerCase().includes('tgstat'))
    .map((c) => c.name).filter(Boolean))].sort()
  return names.length ? names.join(',') : '(пусто)'
}

// ── load-more ──

function parseLoadMoreForm(htmlText, pageUrl) {
  const $ = cheerio.load(htmlText)
  let form = $('form.lm-form')
  if (form.length === 0) {
    form = $('form').filter((_, f) => $(f).find('input.lm-page, input[name="page"], input.lm-offset').length > 0)
  }
  if (form.length === 0) return null
  const el = form.first()
  const action = (el.attr('action') || '').trim()
  const postUrl = action ? absoluteUrl(action, pageUrl) : pageUrl
  const fields = {}
  el.find('input').each((_, inp) => { const n = $(inp).attr('name'); if (n) fields[n] = $(inp).attr('value') || '' })
  el.find('select').each((_, sel) => {
    const n = $(sel).attr('name'); if (!n) return
    const opt = $(sel).find('option[selected]')
    fields[n] = (opt.length ? opt.attr('value') : $(sel).attr('value')) || ''
  })
  return Object.keys(fields).length ? { postUrl, fields } : null
}

function countPeers(html) {
  return (html.match(/peer-item/g) || []).length
}

function updateLoadMoreFields(fields, data) {
  const upd = { ...fields }
  if (data.nextPage != null) upd.page = String(data.nextPage)
  if (data.nextOffset != null) upd.offset = String(data.nextOffset)
  return upd
}

/**
 * Каталог через fetch + cookies. Async-генератор: yield [step, html].
 * Реплицирует AJAX «Показать больше»: POST по peer_type channel/chat.
 */
async function* iterCatalogHttpPages(url, state, maxPages) {
  const cookieHeader = cookieHeaderFromState(state)
  if (!cookieHeader) throw new ParseError('Нет cookies tgstat для HTTP-запроса')

  const headers = { ...DEFAULT_HEADERS, Cookie: cookieHeader }
  const resp = await fetch(url, { headers, redirect: 'follow' })
  const html = await resp.text()
  const finalUrl = resp.url || url

  if (resp.status === 429) throw new ParseError(`TGStat блокирует IP (HTTP ${resp.status}). Нужен прокси.`)
  if (looksLikeCloudflare(html)) throw new ParseError('Cloudflare блокирует запрос даже с cookies. Обновите cookies или используйте ПК/прокси.')
  if (!catalogPageHasPeers(html)) throw new ParseError(`Каталог не распознан (HTTP ${resp.status}). Проверьте cookies, регион и категорию.`)

  const formInfo = parseLoadMoreForm(html, finalUrl)
  if (!formInfo) { yield [1, html]; return }

  const { postUrl, fields: baseFields } = formInfo
  const origin = new URL(finalUrl).origin
  const xhrHeaders = {
    ...headers,
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: finalUrl,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  }

  let step = 0
  for (const peerType of CATALOG_PEER_TYPES) {
    let fields = { ...baseFields, peer_type: peerType, page: '1', offset: '0' }
    let accumulated
    let postStart
    if (peerType === 'channel') {
      step += 1
      yield [step, html]
      if (maxPages <= 1) continue
      postStart = 2
      accumulated = html
    } else {
      postStart = 1
      accumulated = ''
    }

    for (let pageNum = postStart; pageNum <= maxPages; pageNum++) {
      const data = await postCatalogItems(postUrl, fields, xhrHeaders)
      if (!data) break
      const chunk = data.html || ''
      if (!chunk) break
      const before = accumulated ? countPeers(accumulated) : 0
      accumulated = accumulated ? accumulated + chunk : chunk
      const after = countPeers(accumulated)
      if (after <= before) break
      step += 1
      yield [step, accumulated]
      fields = updateLoadMoreFields(fields, data)
      if (!data.hasMore) break
    }
  }
}

async function postCatalogItems(postUrl, fields, headers) {
  try {
    const body = new URLSearchParams(fields).toString()
    const resp = await fetch(postUrl, { method: 'POST', headers, body, redirect: 'follow' })
    const ct = (resp.headers.get('content-type') || '').toLowerCase()
    if (!ct.includes('json')) return null
    const data = await resp.json()
    return data.status === 'ok' ? data : null
  } catch {
    return null
  }
}

// ── single-page fetch (без сессии / max_pages=1) ──

async function fetchPage(url, state) {
  const headers = { ...DEFAULT_HEADERS }
  const ch = cookieHeaderFromState(state)
  if (ch) headers.Cookie = ch
  const resp = await fetch(url, { headers, redirect: 'follow' })
  const text = await resp.text()
  if (resp.status === 404) return ''
  if (resp.status === 403 || resp.status === 503 || looksLikeCloudflare(text)) {
    throw new ParseError(`TGStat заблокировал запрос (HTTP ${resp.status}, Cloudflare). Войдите на TGStat и загрузите свежие cookies или используйте прокси.`)
  }
  if (resp.status >= 400) throw new ParseError(`tgstat вернул HTTP ${resp.status} для ${url}`)
  return text
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Главный генератор: yield { page, chat }.
 * @param {string} category slug
 * @param {string|null} region slug
 * @param {number} maxPages
 * @param {number} minSubscribers
 * @param {object|null} state storage_state ({cookies:[...]})
 * @param {() => boolean} cancelCheck
 */
export async function* parseTgstatChats(category, region, maxPages, minSubscribers, state, cancelCheck) {
  const host = REGION_HOSTS[region || 'russia'] || DEFAULT_HOST
  const url = buildCatalogUrl(host, category)
  const seenLinks = new Set()
  const hasSession = !!cookieHeaderFromState(state)
  const useLoadMore = hasSession || maxPages > 1

  if (useLoadMore && maxPages > 1 && !hasTelegramLogin(state)) {
    throw new ParseError('Для загрузки более 100 каналов нужен вход в TGStat через Telegram (cookies с tgstat_sirk). Войдите на TGStat и загрузите cookies один раз (Cookie-Editor).')
  }

  if (useLoadMore) {
    for await (const [pageNum, htmlText] of iterCatalogHttpPages(url, state, maxPages)) {
      if (cancelCheck?.()) return
      if (!htmlText) { if (pageNum === 1) throw new ParseError(`tgstat вернул пустую страницу для «${category}».`); return }
      const chats = parsePage(htmlText, url, category, region)
      const fresh = chats.filter((c) => !seenLinks.has(c.chat_link))
      if (pageNum > 1 && fresh.length === 0) return
      fresh.forEach((c) => seenLinks.add(c.chat_link))
      for (const chat of fresh) if (chat.subscribers >= minSubscribers) yield { page: pageNum, chat }
      if (pageNum < maxPages) await sleep(1500 + Math.random() * 2000)
    }
    return
  }

  // single page
  if (cancelCheck?.()) return
  const htmlText = await fetchPage(url, state)
  if (!htmlText) throw new ParseError(`tgstat вернул 404 для категории «${category}». Проверьте slug. URL: ${url}`)
  const chats = parsePage(htmlText, url, category, region)
  for (const chat of chats) if (chat.subscribers >= minSubscribers) yield { page: 1, chat }
}
