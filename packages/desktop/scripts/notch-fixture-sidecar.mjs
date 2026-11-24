// Stands in for cezar so the notch can be driven without a real manager:
//
//   CEZ_DESKTOP_ENTRY=$PWD/packages/desktop/scripts/notch-fixture-sidecar.mjs \
//   NOTCH_FIXTURE=/tmp/managers.json CEZ_HOME=/tmp/notch-home packages/desktop/src-tauri/target/debug/cezar-desktop
//
// Every GET of the managers route answers with that file, so editing it changes the notch within
// a poll. Each request is logged, which is how the polling cadence was measured.
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const port = Number(process.argv[process.argv.indexOf('--port') + 1])
const fixture = process.env.NOTCH_FIXTURE

createServer((request, response) => {
  appendFileSync(`${fixture}.log`, `${new Date().toISOString()} ${request.method} ${request.url}\n`)
  const json = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(body)
  if (request.url === '/api/v1/health') return json(200, '{"version":"0.0.0-notch-fixture"}')
  if (request.url === '/api/v1/workspace/managers') {
    try {
      return json(200, readFileSync(fixture, 'utf8'))
    } catch {
      return json(200, '{"managers":[]}')
    }
  }
  response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>fixture cockpit</title>')
}).listen(port, '127.0.0.1')
