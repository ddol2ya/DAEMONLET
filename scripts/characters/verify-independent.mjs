import { createServer } from 'vite'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdir, realpath, readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { resolve, relative, sep, extname } from 'node:path'

const { values } = parseArgs({ options: { source: { type: 'string' }, id: { type: 'string' }, output: { type: 'string' }, payload: { type: 'string' }, mode: { type: 'string', default: 'renderer' } } })
if (!values.source || !values.output || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.id ?? '')) throw new Error('Require --source, --id and --output')
if (!['renderer', 'behavior'].includes(values.mode)) throw new Error('Expected renderer or behavior mode')
const root = await realpath(process.cwd()), source = await realpath(resolve(values.source)), output = resolve(values.output)
if (![source, output].every(path => path.startsWith(root + sep))) throw new Error('QA paths must stay within the workspace')
await mkdir(output, { recursive: true })
const payload = values.payload ? await realpath(resolve(values.payload)) : null
if (payload && JSON.parse(await readFile(resolve(payload, 'character.json'), 'utf8')).id !== values.id) throw Error('Payload character ID differs from --id')
const qaCatalog = payload ? JSON.parse(await readFile(resolve(root, 'public/characters/catalog.json'), 'utf8')) : null
if (qaCatalog && !qaCatalog.characters.includes(`${values.id}/character.json`)) qaCatalog.characters.push(`${values.id}/character.json`)
const server = await createServer({ cacheDir: resolve(output, 'vite-cache'), server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'independent-model-qa', configureServer(server) {
    if (qaCatalog) server.middlewares.use('/characters/catalog.json', (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.statusCode = 405; response.end(); return }
      response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store')
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(qaCatalog))
    })
    if (payload) server.middlewares.use(`/characters/${values.id}`, async (request, response) => {
      try {
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.statusCode = 405; response.end(); return }
        const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
        const file = await realpath(resolve(payload, `.${pathname}`))
        const types = { '.json': 'application/json', '.psd': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }
        if (!file.startsWith(payload + sep) || !types[extname(file)]) throw Error('Outside payload')
        response.setHeader('Content-Type', types[extname(file)]); response.setHeader('Cache-Control', 'no-store')
        response.end(request.method === 'HEAD' ? undefined : await readFile(file))
      } catch { response.statusCode = 404; response.end() }
    })
    server.middlewares.use('/independent-model-qa', (_request, response) => {
      response.setHeader('Content-Type', 'text/html')
      response.end('<!doctype html><meta charset="utf-8"><title>Independent model verification</title><body style="margin:0;background:#eee"></body>')
    })
  },
}] })
try {
  await server.listen()
  const port = server.httpServer.address().port
  const child = spawn(electron, [resolve(`scripts/characters/${values.mode === 'behavior' ? 'verify-behavior' : 'verify-independent'}.cjs`)], { stdio: 'inherit', env: {
    ...process.env, INDEPENDENT_QA_URL: `http://127.0.0.1:${port}`, INDEPENDENT_QA_SOURCE: '/' + relative(root, source).split(sep).join('/'),
    INDEPENDENT_QA_ID: values.id, INDEPENDENT_QA_OUTPUT: output,
  } })
  const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60 * 1000)
  try { process.exitCode = await new Promise((resolveExit, reject) => { child.once('exit', code => resolveExit(code ?? 1)); child.once('error', reject) }) }
  finally { clearTimeout(timer) }
} finally { await server.close() }
