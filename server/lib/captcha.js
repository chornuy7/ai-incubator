/**
 * Капча/антиспам при вступе в группы (§8.6). Классификация капчи от групп-ботов
 * (Shieldy, Miss Rose, Fallen, Captcha_Rubot и т.п.) и решение, что делать.
 *
 * ⚠️ Границы (ToS): СОБСТВЕННЫЕ проверки Telegram (SMS/звонок/reCAPTCHA при авторизации)
 * НЕ проходятся автоматически — только оператор. Обрабатываем лишь входные капчи ГРУПП
 * (это обычное действие пользователя при вступе).
 *
 * «3 варианта антиспама» = 3 стратегии (action):
 *  - 'auto'     — бот проходит сам (кнопка / простая математика / выбор по числу);
 *  - 'operator' — сложная капча → флаг оператору (аккаунт «нужна помощь»), не гадаем;
 *  - 'skip'     — не тратим аккаунт: выходим из группы.
 *
 * Модуль чистый (без I/O) — целиком юнит-тестируется. Клик по кнопке / отправка ответа —
 * на воркере (live), тут только решение.
 */

/** Известные боты-капчи (для приоритетной классификации по автору сообщения). */
export const CAPTCHA_BOTS = ['shieldy', 'missrose', 'miss_rose', 'rose', 'fallen', 'captcha_rubot', 'safeguard', 'combot', 'grouphelp']

/** Решить простой арифметический пример «5 + 7». @returns {number|null} */
export function solveMath(text) {
  const m = String(text).match(/(-?\d+)\s*([+\-*x×])\s*(-?\d+)/)
  if (!m) return null
  const a = Number(m[1]), b = Number(m[3])
  switch (m[2]) {
    case '+': return a + b
    case '-': return a - b
    default: return a * b // *, x, ×
  }
}

/** Найти кнопку, чей текст совпадает с ответом. @param {{text:string}[]} buttons @param {number|string} answer */
export function matchButton(buttons, answer) {
  const want = String(answer).trim()
  return (buttons || []).find((b) => String(b.text ?? b).trim() === want) || null
}

/**
 * Классифицировать входную капчу и решить действие.
 * @param {{ text?: string, buttons?: {text:string}[], fromBot?: string }} input
 * @returns {{ type: string, action: 'auto'|'operator'|'skip', solution?: any, reason: string }}
 */
export function classifyCaptcha(input = {}) {
  const text = String(input.text ?? '')
  const t = text.toLowerCase()
  const buttons = Array.isArray(input.buttons) ? input.buttons : []

  // 1) Собственная проверка Telegram — НИКОГДА не авто (ToS).
  if (/recaptcha|google/i.test(text) || /код из смс|sms\s*code|verification code|код подтвержд/i.test(t)) {
    return { type: 'telegram', action: 'operator', reason: 'Проверка Telegram (SMS/reCAPTCHA) — только оператор (ToS)' }
  }

  // 2) Математическая капча → авто (если ответ есть среди кнопок или можно прислать текстом).
  const sol = solveMath(text)
  if (sol !== null && /(\?|=|реши|solv|посчита|сколько)/i.test(t)) {
    const btn = matchButton(buttons, sol)
    return { type: 'math', action: 'auto', solution: btn ? { button: btn.text } : { reply: String(sol) }, reason: `Матем. капча: ${sol}` }
  }

  // 3) Кнопочная «я не бот / подтвердите» → авто (клик единственной/первой кнопки).
  if (buttons.length && /(нажмите|подтверд|not a robot|i'?m human|я не бот|я не робот|верифи|verify|human|press the button|tap)/i.test(t)) {
    return { type: 'button', action: 'auto', solution: { button: buttons[0].text }, reason: 'Кнопочная капча' }
  }

  // 4) Игровая/эмодзи «выбери …» — распознавание, лучше оператор.
  if (buttons.length && /(выбер|нажми на|choose|select|найди).*(эмодзи|emoji|картинк|животн|icon|значок|предмет)/i.test(t)) {
    return { type: 'emoji', action: 'operator', reason: 'Игровая капча (выбор картинки/эмодзи) — оператор' }
  }

  // 5) Картинка-капча (символы с изображения) — OCR ненадёжен → оператор.
  if (/картинк|изображени|символы|введите символы|distorted|image captcha/i.test(t) && !buttons.length) {
    return { type: 'image', action: 'operator', reason: 'Капча-картинка (распознавание) — оператор' }
  }

  // 6) Кастомный вопрос админа — нет готового ответа → оператор.
  if (text.includes('?') && /(вопрос|ответьте|напишите ответ|question|answer)/i.test(t)) {
    return { type: 'custom', action: 'operator', reason: 'Кастомный вопрос — оператор' }
  }

  // 7) Ничего похожего на капчу.
  return { type: 'none', action: 'skip', reason: 'Капча не распознана' }
}
