import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { buildGoalContext, firstMessagesFromGoal, pickFirstMessage, cleanDialogReply, hasPlaceholder } from '../lib/goalContext.js'

test('buildGoalContext: пустой/нет цели → пустая строка (генерация как раньше)', async () => {
  assert.equal(await buildGoalContext(null), '')
  assert.equal(await buildGoalContext(undefined), '')
  assert.equal(await buildGoalContext(''), '')
})

test('buildGoalContext: несуществующая цель → пустая строка (graceful)', async () => {
  const out = await buildGoalContext('goal_does_not_exist_' + Date.now())
  assert.equal(out, '')
})

// ── Варианты первого сообщения (§9). Баг: вся рассылка уходила одним текстом ──

test('firstMessagesFromGoal: «Альтернативное первое сообщение» тоже подхватывается', () => {
  // Реальное описание цели «Продвижение криптоканала» из боевого прогона 21.07.
  const goal = {
    description: [
      'Кампания продвигает Telegram-канал о криптовалютах.',
      '',
      'Первое сообщение:',
      'Привет! Вижу, ты интересуешься трейдингом. Не против посмотреть?',
      '',
      'Альтернативное первое сообщение:',
      'Привет! Хотел предложить тебе канал о криптовалютах. Отправить ссылку?',
    ].join('\n'),
  }
  const v = firstMessagesFromGoal(goal)
  // Раньше находился ОДИН вариант: `\w` в JS не покрывает кириллицу, поэтому
  // «Альтернативное» не опознавалось как заголовок и второй текст молча терялся.
  assert.equal(v.length, 2, 'должны найтись оба варианта')
  assert.match(v[0], /интересуешься трейдингом/)
  assert.match(v[1], /канал о криптовалютах/)
})

test('firstMessagesFromGoal: заголовки в разных начертаниях и без пустой строки', () => {
  const goal = {
    description: 'Описание.\nПервое сообщение:\nРаз\nАЛЬТЕРНАТИВНОЕ ПЕРВОЕ СООБЩЕНИЕ:\nДва',
  }
  assert.deepEqual(firstMessagesFromGoal(goal), ['Раз', 'Два'])
})

test('pickFirstMessage: варианты чередуются по кругу, а не залипают на первом', () => {
  const v = ['A', 'B', 'C']
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => pickFirstMessage(v, i)), ['A', 'B', 'C', 'A', 'B'])
  assert.equal(pickFirstMessage([], 3), '', 'нет вариантов — пустая строка, а не падение')
})

// ── Чистка ответов ИИ. Разбор реальных переписок 21.07 ──

test('cleanDialogReply: ярлык роли из промпта не уходит человеку', () => {
  // Реальное сообщение из боевого диалога — собеседник получил его с «Я: ».
  assert.equal(
    cleanDialogReply('Я: Отлично! Чат-бот действительно может упростить взаимодействие.'),
    'Отлично! Чат-бот действительно может упростить взаимодействие.',
  )
  assert.equal(cleanDialogReply('Переписка: Я: Привет'), 'Привет')
  assert.equal(cleanDialogReply('Ответ: Да, конечно'), 'Да, конечно')
  assert.equal(cleanDialogReply('Я — Да, конечно'), 'Да, конечно')
})

test('cleanDialogReply: не режет нормальный текст', () => {
  for (const ok of [
    'Привет! Как дела?',
    'Я думаю, это отличная идея — попробуй.',
    'Ясно, спасибо!',
    'Меня зовут Илья, пиши в телеграм.',
  ]) assert.equal(cleanDialogReply(ok), ok, `испорчен нормальный текст: ${ok}`)
})

test('cleanDialogReply: реплика собеседника в теле ответа отрезается', () => {
  assert.equal(cleanDialogReply('Конечно, держи ссылку.\nСобеседник: спасибо'), 'Конечно, держи ссылку.')
})

test('cleanDialogReply: снимает кавычки вокруг всего ответа, но не внутри', () => {
  assert.equal(cleanDialogReply('«Привет, как дела?»'), 'Привет, как дела?')
  assert.equal(cleanDialogReply('Он сказал «да» и ушёл'), 'Он сказал «да» и ушёл')
})

test('hasPlaceholder: заготовка вместо ссылки — не отправлять', () => {
  // Это ушло живому человеку 21.07.
  assert.equal(hasPlaceholder('Отлично! Вот ссылка на канал: [тут вставь ссылку].'), true)
  assert.equal(hasPlaceholder('Держи: [ссылка]'), true)
  assert.equal(hasPlaceholder('Привет, {{name}}!'), true)
  assert.equal(hasPlaceholder('Вот ссылка: https://t.me/+WNDfuu5d6EM1YjVi'), false)
  assert.equal(hasPlaceholder('Читай [тут](https://t.me/x)'), false, 'markdown-ссылка — это не заготовка')
})

// ── SPEC §1.2 (звонок 22.07): тон и запреты ушли из Цели в АГЕНТА ──
// Раньше здесь проверялось обратное — что они попадают в промпт цели. Заказчик прямо
// сказал, что это ошибка: одна цель навязывала один голос всем кампаниям, и сценарий
// «500 хвалят / 500 спорят» под одной целью был невозможен. Теперь их кладёт
// buildAgentContext, а цель отвечает только за измеримый результат.

test('buildGoalContext: тон и запреты в промпт цели НЕ попадают (их даёт агент)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goalctx-'))
  const prev = process.env.GOALS_FILE
  process.env.GOALS_FILE = path.join(dir, 'goals.json')
  t.after(async () => {
    if (prev === undefined) delete process.env.GOALS_FILE
    else process.env.GOALS_FILE = prev
    await fs.rm(dir, { recursive: true, force: true })
  })

  const { createGoal } = await import('../goals.js')
  const goal = await createGoal({
    name: 'Продвижение канала',
    targetAction: 'подписка',
    toneOfVoice: 'на «ты», коротко, без канцелярита',
    restrictions: 'не обещать доход, не давить',
  })

  const ctx = await buildGoalContext(goal.id)
  assert.doesNotMatch(ctx, /Тон общения/, 'тон — свойство агента, а не цели')
  assert.doesNotMatch(ctx, /без канцелярита/)
  assert.doesNotMatch(ctx, /ЗАПРЕЩЕНО/)
  assert.doesNotMatch(ctx, /не обещать доход/)
  // Цель по-прежнему отвечает за «чего добиваемся» — это остаётся в промпте.
  assert.match(ctx, /Цель: Продвижение канала/)
  assert.match(ctx, /Целевое действие: подписка/)
})

test('buildGoalContext: пустые тон и запреты не засоряют промпт', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goalctx2-'))
  const prev = process.env.GOALS_FILE
  process.env.GOALS_FILE = path.join(dir, 'goals.json')
  t.after(async () => {
    if (prev === undefined) delete process.env.GOALS_FILE
    else process.env.GOALS_FILE = prev
    await fs.rm(dir, { recursive: true, force: true })
  })

  const { createGoal } = await import('../goals.js')
  const goal = await createGoal({ name: 'Цель без правил' })
  const ctx = await buildGoalContext(goal.id)
  assert.doesNotMatch(ctx, /Тон общения/)
  assert.doesNotMatch(ctx, /ЗАПРЕЩЕНО/)
})
