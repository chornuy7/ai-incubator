/**
 * §10.5: анализ изображений во входящих ЛС.
 *
 * Собеседник в нейродиалоге прислал фото — без этого модель отвечает вслепую
 * («что за картинку он показал?»). Здесь мы скачиваем изображение и просим
 * vision-модель описать его словами; описание подмешивается в промпт ответа.
 *
 * Отдельным модулем, а не внутри воркера: у vision свой формат запроса (image_url),
 * свой (переопределяемый) выбор модели и ОТДЕЛЬНЫЙ расход, который биллинг наценивает
 * множителем «картинка ×N» (priceStore.imageMultiplier). Наценку даёт именно множитель,
 * а не модель: по умолчанию это тот же gpt-4o-mini, что и для текста. Держать это рядом
 * с генерацией текста нельзя — иначе не разделить, где текстовые токены, а где vision.
 *
 * Всё best-effort: любая осечка (нет ключа, не скачалось, vision недоступен) →
 * возвращаем null, и диалог продолжается по тексту. Молчание vision не должно
 * ронять ответ живому человеку.
 */

/** Vision-модель. По умолчанию тот же gpt-4o-mini, но можно поднять на более сильную
 *  через OPENAI_VISION_MODEL, не трогая текстовую (OPENAI_MODEL). */
const VISION_MODEL = () => process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini'

/** Ограничение на размер картинки в vision-запрос: крупные фото раздувают расход и время. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024 // 4 МБ

/**
 * Тип медиа сообщения GramJS — только фото имеет смысл описывать.
 * @param {any} msg сообщение GramJS
 * @returns {boolean}
 */
export function messageHasPhoto(msg) {
  const m = msg?.media
  if (!m) return false
  const cn = m.className || m._ || ''
  if (/Photo/i.test(cn)) return true
  // Документ-картинка (некоторые клиенты шлют изображение файлом).
  const mime = m.document?.mimeType || ''
  return /^image\//i.test(mime)
}

/** MIME по буферу-сигнатуре: vision требует корректный data:-префикс. @param {Buffer} buf */
function sniffMime(buf) {
  if (!buf || buf.length < 4) return 'image/jpeg'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif'
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp'
  return 'image/jpeg'
}

/**
 * Скачать фото из входящего сообщения и вернуть описание словами.
 * @param {any} client GramJS-клиент (нужен downloadMedia)
 * @param {any} msg сообщение с фото
 * @returns {Promise<{ text:string, usage:{tokens:number, promptTokens:number, completionTokens:number, model:string} }|null>}
 */
export async function describeIncomingImage(client, msg) {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey || !client || !messageHasPhoto(msg)) return null
  let buf
  try {
    buf = await client.downloadMedia(msg, {})
  } catch {
    return null // не скачалось — молча пропускаем
  }
  if (!buf || !buf.length || buf.length > MAX_IMAGE_BYTES) return null
  const b64 = Buffer.from(buf).toString('base64')
  const dataUrl = `data:${sniffMime(buf)};base64,${b64}`
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL(),
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Опиши кратко (1–2 предложения), что изображено на картинке. Только описание, без вступлений.' },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
          ],
        }],
        max_tokens: 120,
        temperature: 0.3,
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content?.trim()
    if (!text) return null
    return {
      text,
      usage: {
        tokens: Number(data?.usage?.total_tokens) || 0,
        promptTokens: Number(data?.usage?.prompt_tokens) || 0,
        completionTokens: Number(data?.usage?.completion_tokens) || 0,
        model: String(data?.model || VISION_MODEL()),
      },
    }
  } catch {
    return null
  }
}
