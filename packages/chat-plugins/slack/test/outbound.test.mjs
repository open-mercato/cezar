import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createSlackAdapter, slackRequest } from '../dist/adapter.js'

const credentials = { appToken: 'xapp-' + 'A'.repeat(20), botToken: 'xoxb-' + 'B'.repeat(20) }
const chatId = 'group:T1:U1:C1'
const inputs = [
  '<>& &lt; *literal* _literal_ ~literal~ `code`',
  '<@U123> <#C123|general> <!channel> <!here> <!everyone> <!subteam^S123>',
  '@channel @here @everyone @user #general',
  'https://example.com/task?a=1&b=2 <https://example.com|label>',
  'Task output:\n<script>alert("x")</script>\nUser request: a < b && c > d',
  '&'.repeat(3998) + '😀',
]
const decode = text => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
async function fixture() {
  const calls = []
  const request = slackRequest(credentials, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (url, options) => {
      const body = Object.fromEntries(new URLSearchParams(options.body))
      calls.push(body)
      const result = String(url).endsWith('/auth.test')
        ? { ok: true, team_id: 'T1', user_id: 'U1', user: 'cezar' }
        : { ok: true, channel: 'C1', ts: '1800000001.000001' }
      return { statusCode: 200, body: (async function* () { yield Buffer.from(JSON.stringify(result)) })() }
    },
  })
  const adapter = createSlackAdapter(credentials, request)
  await adapter.identify()
  calls.length = 0
  return { adapter, calls }
}
for (const text of inputs) test('Slack wire preserves literal text: ' + text.slice(0, 45), async () => {
  const { adapter, calls } = await fixture()
  await adapter.send(chatId, { text })
  const body = calls[0]
  assert.doesNotMatch(body.text, /[<>]/)
  assert.equal(decode(body.text), text)
  assert.equal(body.mrkdwn, 'false')
  assert.equal(body.parse, 'none')
  assert.equal(body.link_names, 'false')
  assert.equal(body.unfurl_links, 'false')
  assert.equal(body.unfurl_media, 'false')
  assert.ok(body.text.length <= 40000)
})
test('Slack button messages retain visible text, callbacks and reply routing within block limits', async () => {
  const { adapter, calls } = await fixture()
  for (const text of ['Choose <one> & confirm', '&'.repeat(2999) + '😀' + '>'.repeat(999)]) {
    await adapter.send(chatId, { text, buttons: [[{ text: 'Go', data: 'go' }]], replyTo: { chatId, messageId: '1800000000.000001' } })
    const body = calls.at(-1), blocks = JSON.parse(body.blocks)
    assert.equal(body.thread_ts, '1800000000.000001')
    const sections = blocks.filter(block => block.type === 'section')
    assert.equal(sections.map(block => decode(block.text.text)).join(''), text)
    for (const section of sections) {
      assert.equal(section.text.type, 'plain_text')
      assert.equal(section.text.emoji, false)
      assert.ok(section.text.text.length <= 3000)
      assert.doesNotMatch(section.text.text, /[<>]/)
    }
    assert.deepEqual(blocks.find(block => block.type === 'actions').elements[0], { type: 'button', action_id: 'cezar_0', text: { type: 'plain_text', text: 'Go' }, value: 'go' })
  }
  await assert.rejects(adapter.send(chatId, { text: 'wrong chat', replyTo: { chatId: 'group:T1:U1:C2', messageId: '1800000000.000001' } }), /blocked/)
})
for (const [name, prefix, glyph, escapedPrefix] of [
  ['combining accent', 'x'.repeat(2999), 'e\u0301', 'x'.repeat(2999)],
  ['family ZWJ after escaping', '&'.repeat(599), '👩‍👩‍👧‍👦', '&amp;'.repeat(599)],
]) test('Slack sections preserve grapheme boundaries: ' + name, async () => {
  const { adapter, calls } = await fixture()
  await adapter.send(chatId, { text: prefix + glyph, buttons: [[{ text: 'Go', data: 'go' }]] })
  const sections = JSON.parse(calls[0].blocks).filter(block => block.type === 'section')
  assert.deepEqual(sections.map(section => section.text.text), [escapedPrefix, glyph])
  for (const section of sections) assert.ok(section.text.text.length <= 3000)
})
test('Slack refuses an oversized escaped grapheme before sending any payload', async () => {
  const { adapter, calls } = await fixture()
  // The second cluster fits before escaping, but exceeds the serialized limit.
  for (const text of ['e' + '\u0301'.repeat(3000), '&' + '\u0301'.repeat(2996)]) {
    await assert.rejects(adapter.send(chatId, { text, buttons: [[{ text: 'Go', data: 'go' }]] }), /blocked/)
  }
  assert.equal(calls.length, 0)
  // Exactly 3000 serialized units remains valid, with the entire cluster intact.
  const text = '&' + '\u0301'.repeat(2995)
  await adapter.send(chatId, { text, buttons: [[{ text: 'Go', data: 'go' }]] })
  const sections = JSON.parse(calls[0].blocks).filter(block => block.type === 'section')
  assert.deepEqual(sections.map(section => section.text.text), ['&amp;' + '\u0301'.repeat(2995)])
})
test('Slack keeps the 4000-character input bound', async () => {
  const { adapter, calls } = await fixture()
  for (const text of ['', 'x'.repeat(4001)]) await assert.rejects(adapter.send(chatId, { text }), /blocked/)
  assert.equal(calls.length, 0)
})
test('explicit Slack formatting preserves escaped host text and refuses native mention markup', async () => {
  const { adapter, calls } = await fixture()
  const text = 'A &lt; B &amp; C\n@\u200beveryone'
  await adapter.send(chatId, { text, textFormat: 'slack-mrkdwn', buttons: [[{ text: 'Confirm', data: 'yes' }]] })
  assert.equal(calls[0].text, text)
  assert.equal(calls[0].mrkdwn, 'true')
  assert.equal(JSON.parse(calls[0].blocks)[0].text.type, 'mrkdwn')
  assert.equal(JSON.parse(calls[0].blocks)[0].text.verbatim, true)
  await assert.rejects(adapter.send(chatId, { text: '<!channel>', textFormat: 'slack-mrkdwn' }), /blocked/)
  await assert.rejects(adapter.send(chatId, { text: 'wrong format', textFormat: 'telegram-html' }), /blocked/)
  assert.equal(calls.length, 1)
})
test('the published adapter exposes only the session receive model', async () => {
 const adapter = createSlackAdapter({ appToken: 'xapp-synthetic12345', botToken: 'xoxb-synthetic12345' }, async () => ({}))
 assert.equal('receive' in adapter, false); assert.equal(typeof adapter.receiveSession, 'function')
 await adapter.dispose()
})

test('calls to one address reuse a pooled dispatcher instead of a new TLS handshake', async () => {
 const dispatchers = [], credentials = { appToken: 'xapp-' + 'A'.repeat(20), botToken: 'xoxb-' + 'B'.repeat(20) }
 let address = '8.8.4.1'
 const call = slackRequest(credentials, { lookup: async () => [{ address, family: 4 }], request: async (_url, request) => { dispatchers.push(request.dispatcher); return { statusCode: 200, body: Readable.from([Buffer.from('{"ok":true}')]) } } })
 await call('auth.test', {}); await call('auth.test', {})
 assert.equal(new Set(dispatchers).size, 1)
 assert.equal(dispatchers[0].closed, false, 'stays open for the next call')
 address = '8.8.4.2'; await call('auth.test', {})
 assert.equal(new Set(dispatchers).size, 2, 'a different validated address never shares a pinned agent')
})
