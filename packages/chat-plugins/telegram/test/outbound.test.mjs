import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { createTelegramAdapter, telegramRequest } from '../dist/adapter.js'

const inputs = [
  '<>& &lt; <b>literal</b> *not formatting*',
  '<@U123> <#C123|general> <!channel> <!everyone> @everyone @user',
  'https://example.com/task?a=1&b=2 <https://example.com|label>',
  'Task output:\n<script>alert("x")</script>\nUser request: a < b && c > d',
  'x'.repeat(4094) + '😀',
]
function fixture() {
  const calls = []
  const request = telegramRequest('123456:' + 'A'.repeat(24), {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (_url, options) => {
      calls.push(JSON.parse(options.body))
      return { statusCode: 200, body: Readable.from((async function* () {
        yield Buffer.from(JSON.stringify({ ok: true, result: { message_id: 91, chat: { id: -30 } } }))
      })()) }
    },
  })
  return { calls, adapter: createTelegramAdapter(request) }
}
for (const text of inputs) test('Telegram wire preserves literal text: ' + text.slice(0, 45), async () => {
  const { adapter, calls } = fixture()
  await adapter.send('-30', { text })
  assert.equal(calls[0].text, text)
  assert.equal(calls[0].parse_mode, undefined)
  assert.equal(calls[0].entities, undefined)
  assert.deepEqual(calls[0].link_preview_options, { is_disabled: true })
})
test('Telegram ordinary buttons and reply routing survive plain mode', async () => {
  const { adapter, calls } = fixture()
  const receipt = await adapter.send('-30', { text: 'Choose <one> & confirm', buttons: [[{ text: 'Confirm', data: 'yes' }]], replyTo: { chatId: '-30', messageId: '42' } })
  assert.deepEqual(receipt, { chatId: '-30', messageId: '91' })
  assert.deepEqual(calls[0].reply_markup.inline_keyboard, [[{ text: 'Confirm', callback_data: 'yes' }]])
  assert.deepEqual(calls[0].reply_parameters, { message_id: 42 })
  await assert.rejects(adapter.send('-30', { text: 'wrong chat', replyTo: { chatId: '-31', messageId: '42' } }), /blocked/)
})
test('Telegram rejects empty and oversized text without dialing', async () => {
  const { adapter, calls } = fixture()
  for (const text of ['', 'x'.repeat(4097)]) await assert.rejects(adapter.send('-30', { text }), /blocked/)
  assert.equal(calls.length, 0)
})
test('explicit Telegram formatting preserves safe host rendering and rejects unsafe markup', async () => {
  const { adapter, calls } = fixture()
  const text = '<b>Task completed</b> · A &lt; B\n<code>safe &amp; bounded</code>\n<a href="https://example.com/?a=1&amp;b=2">Open task</a>'
  await adapter.send('-30', { text, textFormat: 'telegram-html' })
  assert.equal(calls[0].text, text)
  assert.equal(calls[0].parse_mode, 'HTML')
  for (const text of ['<script>bad</script>', '<a href="tg://user?id=123">mention</a>', '<b>unclosed', '<a href="https://safe" onclick="bad">bad</a>', '<b>unescaped & text</b>']) {
    await assert.rejects(adapter.send('-30', { text, textFormat: 'telegram-html' }), /blocked/)
  }
  await assert.rejects(adapter.send('-30', { text: 'wrong format', textFormat: 'slack-mrkdwn' }), /blocked/)
  assert.equal(calls.length, 1)
})
test('the public adapter transmits every historical Telegram presentation golden unchanged', async () => {
  const { readFile } = await import('node:fs/promises')
  // Shared compatibility fixtures only; no private runtime import enters the artifact.
  const golden = await readFile(new URL('../../../cezar/src/webhooks/__goldens__/telegram-notices.txt', import.meta.url), 'utf8')
  const { adapter, calls } = fixture()
  for (const header of golden.matchAll(/^### .+ \((\d+) chars\)\n/gm)) {
    const start = header.index + header[0].length
    const text = golden.slice(start, start + Number(header[1]))
    await adapter.send('-30', { text, textFormat: 'telegram-html' })
    assert.equal(calls.at(-1).text, text)
    assert.equal(calls.at(-1).parse_mode, 'HTML')
  }
  assert.ok(calls.length > 20)
})
