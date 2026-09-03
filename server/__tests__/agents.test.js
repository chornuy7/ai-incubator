/**
 * Сущность «Агент» (AI-персона) — решение созвона 22.07. Тон/ограничения/характер
 * живут ОТДЕЛЬНО от цели: цель = что достичь, агент = как общаться.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-'))
  const prev = process.env.AGENTS_FILE
  process.env.AGENTS_FILE = path.join(dir, 'agents.json')
  try {
    const mod = await import(`../agents.js?t=${Date.now()}`)
    return await fn(mod)
  } finally {
    if (prev === undefined) delete process.env.AGENTS_FILE
    else process.env.AGENTS_FILE = prev
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('createAgent: имя обязательно', async () => {
  await withStore(async ({ createAgent }) => {
    await assert.rejects(() => createAgent({ name: '  ' }), /Укажите название/)
  })
})

test('normalizeAgent: поля обрезаются, дожима у агента нет', async () => {
  await withStore(async ({ normalizeAgent }) => {
    const a = normalizeAgent({ name: ' Спорщик ', toneOfVoice: 'резко', restrictions: 'без мата' })
    assert.equal(a.name, 'Спорщик')
    assert.equal(a.toneOfVoice, 'резко')
    // Дожим — решение кампании: она знает цель, этап и пул. Агент только говорит.
    assert.equal(a.followUp, undefined)
  })
})

test('CRUD: создать → прочитать → обновить → удалить', async () => {
  await withStore(async ({ createAgent, getAgent, updateAgent, deleteAgent, listAgents }) => {
    const a = await createAgent({ name: 'Хвалит', character: 'новичок' })
    assert.match(a.id, /^agent_/)
    assert.equal((await getAgent(a.id)).character, 'новичок')
    await updateAgent(a.id, { toneOfVoice: 'на ты' })
    assert.equal((await getAgent(a.id)).toneOfVoice, 'на ты')
    assert.equal(await deleteAgent(a.id), true)
    assert.equal((await listAgents()).length, 0)
  })
})

test('buildAgentContext: тон и запрет — в промпт, запрет жёстко', async () => {
  await withStore(async ({ createAgent, buildAgentContext }) => {
    const a = await createAgent({ name: 'A', toneOfVoice: 'коротко', restrictions: 'не обещать доход' })
    const ctx = await buildAgentContext(a.id)
    assert.match(ctx, /Тон/)
    assert.match(ctx, /коротко/)
    assert.match(ctx, /ЗАПРЕЩЕНО/)
    assert.match(ctx, /не обещать доход/)
  })
})

test('buildAgentContext: пустой агент и несуществующий → пустая строка', async () => {
  await withStore(async ({ createAgent, buildAgentContext }) => {
    const a = await createAgent({ name: 'Пустой' })
    assert.equal(await buildAgentContext(a.id), '')
    assert.equal(await buildAgentContext(null), '')
    assert.equal(await buildAgentContext('agent_нет'), '')
  })
})

test('дожим нельзя записать в агента даже напрямую', async () => {
  // Переезд в кампанию (24.07). Если поле снова начнёт сохраняться у агента,
  // настройка раздвоится и никто не поймёт, какая из двух победила.
  await withStore(async ({ createAgent }) => {
    const a = await createAgent({ name: 'F', followUp: { enabled: true, limit: 999 } })
    assert.equal(a.followUp, undefined)
  })
})
