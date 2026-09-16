// Local-only QA server. Production never imports this module.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
const modes = new Set(['good', 'corrupt', 'disconnect', 'cancel', 'size', 'signature'])
export function serveUpdateFixtures(output, port = 45943) {
  const server = createServer(async (request, response) => {
    let stream
    try {
      const parts = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).slice(1).split('/')
      const mode = parts.length === 1 ? 'good' : parts[0], name = parts.at(-1)
      if (parts.length > 2 || !modes.has(mode)) throw Error('not found')
      const isMac = name === 'latest-mac.yml' || name.endsWith('-macOS-arm64.zip')
      const channel = isMac ? 'latest-mac.yml' : 'latest.yml'
      const metadata = JSON.parse(await readFile(join(output, 'feed', channel), 'utf8'))
      if (name !== channel && name !== metadata.path) throw Error('not found')
      let file = join(output, 'feed', metadata.path)
      if (mode === 'signature') {
        file = join(output, 'bad-signature.zip')
        const digest = JSON.parse(await readFile(join(output, 'bad-signature.json'), 'utf8'))
        metadata.sha512 = digest.sha512; metadata.files[0].sha512 = digest.sha512; metadata.files[0].size = digest.size
      }
      if (mode === 'size') metadata.files[0].size++
      if (name === channel) {
        const bytes = Buffer.from(JSON.stringify(metadata))
        response.writeHead(200, { 'Content-Type': 'application/yaml', 'Content-Length': bytes.length }); response.end(bytes); return
      }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': (await stat(file)).size })
      stream = createReadStream(file, { highWaterMark: 64 * 1024 })
      response.once('close', () => stream.destroy())
      let first = true
      for await (const part of stream) {
        if (mode === 'corrupt' && first) part[10] ^= 1
        await new Promise(resolve => response.write(part, () => resolve())); first = false
        if (mode === 'disconnect') { await new Promise(r => setTimeout(r, 50)); response.destroy(); break }
        if (mode === 'cancel') await new Promise(r => setTimeout(r, 10))
        if (response.destroyed) break
      }
      if (!response.destroyed) response.end()
    } catch { stream?.destroy(); if (!response.headersSent) response.writeHead(404); response.end() }
  })
  server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ feed: 'http://127.0.0.1:' + port, output })))
  return server
}
