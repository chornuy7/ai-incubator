/**
 * §2/§6: отпечаток устройства аккаунта.
 *
 * Telegram видит, с какого «устройства» приходит клиент: модель, версия системы,
 * версия приложения, язык. Если сорок наших аккаунтов ходят с одной и той же строкой —
 * это готовая связка «все они один оператор», и банят их пачкой. Поэтому:
 *
 *  - если отпечаток известен из json продавца — используем ЕГО (сессия рождена под ним,
 *    менять устройство на живой авторизации нельзя);
 *  - если неизвестен — генерируем свой, но ДЕТЕРМИНИРОВАННО от accountId: у каждого
 *    аккаунта он свой и при этом не меняется от запуска к запуску. Плавающий отпечаток
 *    хуже отсутствующего — это выглядит как постоянная смена устройства.
 */
import crypto from 'crypto'

/**
 * Реальные строки устройств Telegram Desktop — это модель материнской платы или ноутбука
 * (берётся из WMI). Пул составлен из типичных значений, чтобы не выделяться.
 */
const DEVICES = [
  'P8Z77-V LX', 'B450M DS3H', 'PRIME B450M-A', 'H310M H', 'B550M AORUS ELITE',
  'Z390 AORUS PRO', 'MS-7C56', 'MS-7B86', 'H81M-S1', 'G31M-ES2L',
  'Precision 7530', 'Latitude 5420', 'Inspiron 15 3511', 'OptiPlex 7050',
  'Acer Nitro 5', 'Aspire A315-42', 'IdeaPad 3 15ADA05', 'ThinkPad T480',
  'HP ProBook 450 G7', 'Pavilion Laptop 15', 'VivoBook_ASUSLaptop X512DA',
  'SG41', 'SQ9204', 'P55-UD4', 'G33M-DS2R', 'SJV50PU', '8216',
]

/** Версии системы — только те, что реально встречаются у Desktop-клиентов. */
const SYSTEMS = ['Windows 10 x64', 'Windows 11 x64']

/** Версии Telegram Desktop. Держим близкими к актуальным — древняя версия сама по себе метка. */
const APP_VERSIONS = ['6.5.1 x64', '6.7.2 x64', '6.8.0 x64', '6.9.3 x64']

/** Официальный app_id Telegram Desktop: под ним и создаются сессии из tdata. */
export const TDESKTOP_API_ID = 2040
export const TDESKTOP_API_HASH = 'b18441a1ff607e10a989891a5462e627'

/** Взять элемент пула по срезу хеша — стабильно для одного и того же seed. */
const pickBy = (hash, offset, pool) => pool[hash.readUInt32BE(offset) % pool.length]

/**
 * Сгенерировать отпечаток по seed (обычно accountId). Один и тот же seed всегда даёт
 * один и тот же результат — отпечаток не «плавает» между запусками.
 * @param {string} seed
 * @param {{apiId?:number, apiHash?:string, langCode?:string}} [base]
 */
export function generateFingerprint(seed, base = {}, taken) {
  // При совпадении с уже занятым отпечатком подсаливаем seed и пробуем снова: детерминизм
  // сохраняется (соль зависит только от номера попытки), но пачка не склеивается.
  for (let attempt = 0; attempt < 24; attempt++) {
    const h = crypto.createHash('sha256').update(`${seed || 'seed'}${attempt ? `#${attempt}` : ''}`).digest()
    const fp = {
      apiId: Number(base.apiId) || TDESKTOP_API_ID,
      apiHash: base.apiHash || TDESKTOP_API_HASH,
      device: pickBy(h, 0, DEVICES),
      system: pickBy(h, 4, SYSTEMS),
      appVersion: pickBy(h, 8, APP_VERSIONS),
      langCode: base.langCode || 'en',
      systemLangCode: base.langCode ? `${base.langCode}-US` : 'en-US',
    }
    if (!taken || !taken.has(fingerprintKey(fp))) return fp
  }
  // Пул исчерпан (аккаунтов больше, чем комбинаций) — отдаём как есть, дубль лучше пустоты.
  const h = crypto.createHash('sha256').update(String(seed || 'seed')).digest()
  return {
    apiId: Number(base.apiId) || TDESKTOP_API_ID,
    apiHash: base.apiHash || TDESKTOP_API_HASH,
    device: pickBy(h, 0, DEVICES),
    system: pickBy(h, 4, SYSTEMS),
    appVersion: pickBy(h, 8, APP_VERSIONS),
    langCode: base.langCode || 'en',
    systemLangCode: base.langCode ? `${base.langCode}-US` : 'en-US',
  }
}

/** Ключ для сравнения отпечатков: именно эту тройку Telegram и видит. */
export const fingerprintKey = (fp) => `${fp?.device}|${fp?.system}|${fp?.appVersion}`

/**
 * Отпечатки, уже занятые другими аккаунтами — чтобы новый им не совпал.
 * @param {Record<string, object>} allMeta карта meta по accountId
 * @param {string} [exceptId] чей отпечаток не считать занятым (свой же)
 */
export function takenFingerprints(allMeta = {}, exceptId) {
  const set = new Set()
  for (const [id, m] of Object.entries(allMeta)) {
    if (id === exceptId) continue
    set.add(fingerprintKey(accountFingerprint(id, m)))
  }
  return set
}

/**
 * Отпечаток аккаунта: из meta, если он там есть (пришёл с аккаунтом), иначе
 * сгенерированный от accountId. Никогда не возвращает пустоту — иначе клиент уйдёт
 * с дефолтом GramJS, одинаковым у всех.
 * @param {string} accountId @param {{fingerprint?: object}} [meta]
 * @param {Set<string>} [taken] отпечатки других аккаунтов — генерируемый им не совпадёт
 */
export function accountFingerprint(accountId, meta = {}, taken) {
  const fp = meta?.fingerprint
  // Отпечаток из json бывает частичным (например, только app_id) — недостающее дописываем
  // сгенерированным, чтобы в эфир не ушли дефолтные значения библиотеки.
  const gen = generateFingerprint(accountId, { apiId: fp?.apiId, apiHash: fp?.apiHash, langCode: fp?.langCode }, taken)
  if (!fp) return gen
  return {
    apiId: fp.apiId || gen.apiId,
    apiHash: fp.apiHash || gen.apiHash,
    device: fp.device || gen.device,
    system: fp.system || gen.system,
    appVersion: fp.appVersion || gen.appVersion,
    langCode: fp.langCode || gen.langCode,
    systemLangCode: fp.systemLangCode || gen.systemLangCode,
  }
}
