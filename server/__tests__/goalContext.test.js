import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGoalContext, firstMessagesFromGoal, pickFirstMessage } from '../lib/goalContext.js'

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
