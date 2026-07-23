/**
 * SPEC §2.4 (D5): кампания принимает НАМЕРЕНИЕ СЛОВАМИ, а раскладку по модулям
 * предлагает система. Заказчик: «я хочу создать кампанию, а не настроить модуль».
 *
 * Здесь — чистый разбор без сети и без ИИ. Почему не через OpenAI: раскладка нужна
 * мгновенно и предсказуемо, прямо во время набора текста, а запрос к модели — это
 * задержка, деньги (C2) и риск, что при мёртвой квоте форма перестанет подсказывать.
 * Правила читаются и правятся глазами, а ИИ можно добавить сверху как уточнение.
 *
 * Результат — ПРЕДЛОЖЕНИЕ, а не приказ: оператор видит, что система поняла, и может
 * поправить. Молча разложить чужое намерение по боевым модулям было бы опасно.
 */

/** Ключевые слова → модуль. Порядок важен: раньше в списке — выше приоритет. */
const RULES = [
  {
    moduleKey: 'neuro-commenting',
    why: 'комментарии под постами каналов',
    words: ['комментир', 'комментар', 'под постами', 'обсужден', 'коммент'],
  },
  {
    moduleKey: 'neuro-chatting',
    why: 'ответы в группах и чатах',
    words: ['в чат', 'в групп', 'обща', 'отвеча', 'диалог в групп', 'беседа'],
  },
  {
    moduleKey: 'neuro-dialogs',
    why: 'личная переписка с ответившими',
    words: ['в личк', 'лс', 'переписк', 'личных сообщ', 'довести до', 'дожим'],
  },
  {
    moduleKey: 'mailing',
    why: 'первое сообщение в личные сообщения',
    words: ['рассыл', 'разосла', 'написать всем', 'первое сообщение', 'инвайт'],
  },
  {
    moduleKey: 'mass-react',
    why: 'реакции на посты',
    words: ['реакц', 'лайк', 'эмодзи'],
  },
  {
    moduleKey: 'mass-looking',
    why: 'просмотры',
    words: ['просмотр', 'подня', 'охват'],
  },
  {
    moduleKey: 'autoposting',
    why: 'публикация в свои каналы',
    words: ['опубликова', 'постить', 'автопост', 'в свой канал', 'в наш канал'],
  },
  {
    moduleKey: 'parsing',
    why: 'сбор каналов по теме',
    words: ['найти канал', 'собрать канал', 'спарс', 'найди канал'],
  },
  {
    moduleKey: 'parsing-users',
    why: 'сбор аудитории',
    words: ['собрать аудитор', 'участник', 'подписчик', 'базу людей'],
  },
  {
    moduleKey: 'warming',
    why: 'прогрев профилей перед работой',
    words: ['прогре', 'разогре', 'новые аккаунт'],
  },
]

/** Слова, по которым понятно, что нужен измеримый результат в переходах (§1.3). */
const LINK_WORDS = ['переход', 'клик', 'на сайт', 'ссылк', 'трафик', 'регистрац']

/** Числа вида «200 переходов», «50 лидов» — это и есть цель по результату. */
function extractTarget(text) {
  const m = /(\d{1,6})\s*(переход|клик|лид|заявк|подписч|продаж)/i.exec(text)
  if (!m) return null
  return { amount: Number(m[1]), unit: m[2].toLowerCase() }
}

/** Упоминания каналов/групп прямо в тексте намерения. */
function extractTargets(text) {
  const found = String(text || '').match(/@[a-z0-9_]{3,}|t\.me\/[a-z0-9_]{3,}/gi) || []
  return [...new Set(found.map((x) => x.replace(/^.*t\.me\//i, '').replace(/^@/, '').toLowerCase()))]
}

/**
 * Разобрать намерение в предложение по кампании.
 * @param {string} text «хочу комментировать крипто-каналы и вести людей в личку, нужно 200 переходов»
 * @returns {{modules:{moduleKey:string, why:string}[], targets:string[], result:object|null,
 *            needsLink:boolean, warnings:string[], understood:boolean}}
 */
export function parseIntent(text) {
  const raw = String(text || '')
  const low = raw.toLowerCase()
  const modules = []

  for (const rule of RULES) {
    if (rule.words.some((w) => low.includes(w))) {
      modules.push({ moduleKey: rule.moduleKey, why: rule.why })
    }
  }

  const targets = extractTargets(raw)
  const result = extractTarget(low)
  const needsLink = LINK_WORDS.some((w) => low.includes(w))

  const warnings = []
  if (!modules.length) {
    warnings.push('Не понял, что именно делать. Опишите действие: комментировать, писать в личку, собрать аудиторию.')
  }
  // Диалоги без модуля, который приводит людей, работать не будут: отвечать некому.
  const hasDialogs = modules.some((m) => m.moduleKey === 'neuro-dialogs')
  const hasSource = modules.some((m) => ['neuro-commenting', 'neuro-chatting', 'mailing'].includes(m.moduleKey))
  if (hasDialogs && !hasSource) {
    warnings.push('Переписка в личке начинается с того, что человек ответил — добавьте комментинг, чатинг или рассылку.')
  }
  if (needsLink && !result) {
    warnings.push('Упомянуты переходы, но не сказано сколько — без числа цель нельзя закрыть по критерию.')
  }
  if (!targets.length && modules.some((m) => m.moduleKey !== 'warming' && !m.moduleKey.startsWith('parsing'))) {
    warnings.push('Не указаны каналы или группы — добавьте их в кампанию или соберите парсером.')
  }

  return {
    modules,
    targets,
    result,
    needsLink,
    warnings,
    understood: modules.length > 0,
  }
}
