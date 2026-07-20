import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDataUrl, kindFromMime, safeFileName, isValidRef, KB_FILE_MAX_BYTES } from '../kbFiles.js'

test('§4 parseDataUrl: принимает разрешённый тип, режет мусор', () => {
  const png = 'data:image/png;base64,' + Buffer.from('hello').toString('base64')
  const { mime, buffer } = parseDataUrl(png)
  assert.equal(mime, 'image/png')
  assert.equal(buffer.toString(), 'hello')

  assert.throws(() => parseDataUrl('не data-url'), /data:/i)
  assert.throws(() => parseDataUrl(''), /data:/i)
  // исполняемое не принимаем
  assert.throws(() => parseDataUrl('data:application/x-msdownload;base64,AAAA'), /не поддерживается/i)
})

test('§4 parseDataUrl: пустой и слишком большой файл — ошибка', () => {
  assert.throws(() => parseDataUrl('data:text/plain;base64,'), /data:/i) // regex требует данные
  const big = Buffer.alloc(KB_FILE_MAX_BYTES + 10, 0x41).toString('base64')
  assert.throws(() => parseDataUrl(`data:application/pdf;base64,${big}`), /больше/i)
})

test('§4 kindFromMime: картинка vs файл', () => {
  assert.equal(kindFromMime('image/jpeg'), 'image')
  assert.equal(kindFromMime('application/pdf'), 'file')
  assert.equal(kindFromMime(undefined), 'file')
})

test('§4 safeFileName: срезает пути и спецсимволы, сохраняет пробелы и кириллицу', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd') // обход каталога срезан
  assert.equal(safeFileName('C:\\tmp\\файл.pdf'), 'файл.pdf')
  assert.equal(safeFileName('Отчёт 2026 v1.pdf'), 'Отчёт 2026 v1.pdf') // пробелы на месте
  assert.equal(safeFileName('bad<>:"|?*.txt'), 'bad.txt')
  assert.equal(safeFileName(''), 'file')
  assert.equal(safeFileName('   '), 'file')
})

test('§4 isValidRef: только наши ссылки, без обхода каталога', () => {
  assert.equal(isValidRef('kbf_abcdef123456.png'), true)
  assert.equal(isValidRef('kbf_abcdef123456'), true)
  assert.equal(isValidRef('../../etc/passwd'), false)
  assert.equal(isValidRef('kbf_../x'), false)
  assert.equal(isValidRef('random.png'), false)
  assert.equal(isValidRef(''), false)
})
