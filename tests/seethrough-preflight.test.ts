import {createServer, type IncomingMessage, type ServerResponse} from 'node:http'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {expect, it} from 'vitest'

const exec = promisify(execFile)
const required = ['SeeThrough_LoadLayerDiffModel', 'SeeThrough_LoadDepthModel', 'SeeThrough_GenerateLayers', 'SeeThrough_GenerateDepth', 'SeeThrough_PostProcess', 'SeeThrough_SavePSD']
const objectInfo = Object.fromEntries(required.map(name => [name, {input: {required: {group_offload: ['BOOLEAN'], auto_download: ['BOOLEAN']}}}]))
const stats = (vram: number) => ({devices: [{type: 'cuda', vram_total: vram * 1024 ** 3, vram_free: 2 * 1024 ** 3}]})
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void, run: (url: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'daemonlet-offload-'))
  const server = createServer((req, res) => {res.setHeader('Content-Type', 'application/json'); handler(req, res)})
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw Error('No test listener')
    await run(`http://127.0.0.1:${address.port}`, root)
  } finally {server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(root, {recursive: true, force: true})}
}
function command(url: string, root: string, vram?: string) {
  return exec(process.execPath, [resolve('scripts/run-seethrough.mjs'), join(root, 'reference.png'), join(root, 'output'), '1', url, 'test', '1280', '30', ...(vram === undefined ? [] : [vram])], {timeout: 15000})
}

it('rejects an incompatible external installation before uploading artwork', async () => {
  let writes = 0
  await fixture((req, res) => {
    if (req.method !== 'GET') writes++
    res.end(JSON.stringify(req.url === '/system_stats' ? stats(12) : {}))
  }, async (url, root) => {
    await expect(command(url, root)).rejects.toThrow('Compatible See-through nodes are missing')
    expect(writes).toBe(0)
  })
})

it.each([
  {label: '8 GiB', capacity: 8, offload: true, resolution: 1024, depth: 720},
  {label: '12 GiB boundary', capacity: 12, offload: true, resolution: 1280, depth: -1},
  {label: 'just above 12 GiB', capacity: 12.0001, offload: false, resolution: 1280, depth: -1},
  {label: '24 GiB with only 2 GiB free', capacity: 24, offload: false, resolution: 1280, depth: -1},
  {label: 'explicit 24 GiB when stats are unavailable', capacity: null, explicit: '24', offload: false, resolution: 1280, depth: -1},
  {label: 'explicit 12 GiB when stats are unavailable', capacity: null, explicit: '12', offload: true, resolution: 1280, depth: -1},
])('submits both loaders with the capacity policy: $label', async ({capacity, explicit, offload, resolution, depth}) => {
  let submitted: Record<string, {inputs: Record<string, unknown>}> | null = null
  const writes: string[] = []
  await fixture((req, res) => {
    if (req.method !== 'GET') writes.push(req.url!)
    if (req.url === '/system_stats') return void res.end(JSON.stringify(capacity === null ? {} : stats(capacity)))
    if (req.url === '/object_info') return void res.end(JSON.stringify(objectInfo))
    if (req.url === '/queue') return void res.end(JSON.stringify({queue_running: [], queue_pending: []}))
    if (req.url === '/upload/image') {req.resume(); return void res.end(JSON.stringify({name: 'reference.png'}))}
    if (req.url === '/prompt') {
      let body = ''; req.on('data', part => {body += part}); req.on('end', () => {submitted = JSON.parse(body).prompt; res.end(JSON.stringify({prompt_id: 'synthetic'}))}); return
    }
    if (req.url === '/history/synthetic') return void res.end(JSON.stringify({synthetic: {status: {completed: true}, outputs: {'7': {text: ['layers.json']}}}}))
    if (req.url?.startsWith('/view?')) return void res.end(JSON.stringify({layers: [], width: resolution, height: resolution}))
    res.writeHead(404); res.end('{}')
  }, async (url, root) => {
    await writeFile(join(root, 'reference.png'), 'synthetic upload; no image inference')
    const result = await command(url, root, explicit)
    expect(result.stdout).toContain(`group offload ${offload ? 'enabled' : 'disabled'} on both loaders`)
    expect(writes).toEqual(['/upload/image', '/prompt'])
    for (const id of ['2', '3']) expect(submitted![id].inputs).toMatchObject({group_offload: offload, auto_download: false})
    expect(submitted!['4'].inputs.resolution).toBe(resolution)
    expect(submitted!['5'].inputs.resolution_depth).toBe(depth)
    expect(submitted!['6'].inputs.use_lama).toBe(false)
    const summary = JSON.parse(await readFile(join(root, 'output/run-summary.json'), 'utf8'))
    expect(summary).toMatchObject({vramGiB: explicit ? Number(explicit) : capacity, requestedProfile: {groupOffload: offload}, vramSource: explicit ? 'explicit capacity' : 'ComfyUI system_stats'})
  })
})

it.each([
  {label: 'missing stats', value: {}},
  {label: 'invalid capacity', value: {devices: [{type: 'cuda', vram_total: 'invalid'}]}},
  {label: 'multiple CUDA devices', value: {devices: [...stats(8).devices, ...stats(24).devices]}},
  {label: 'failed stats request', value: {}, status: 503},
])('stops before uploads or jobs when VRAM is unknown: $label', async ({value, status}) => {
  let writes = 0
  await fixture((req, res) => {if (req.method !== 'GET') writes++; if (status) res.statusCode = status; res.end(JSON.stringify(value))}, async (url, root) => {
    await expect(command(url, root)).rejects.toThrow('Cannot determine the selected ComfyUI GPU total VRAM')
    expect(writes).toBe(0)
  })
})

it('preserves active GPU jobs instead of uploading or cancelling them', async () => {
  let writes = 0
  await fixture((req, res) => {
    if (req.method !== 'GET') writes++
    res.end(JSON.stringify(req.url === '/system_stats' ? stats(24) : req.url === '/object_info' ? objectInfo : {queue_running: [['existing-job']], queue_pending: []}))
  }, async (url, root) => {
    await expect(command(url, root)).rejects.toThrow('ComfyUI has active jobs')
    expect(writes).toBe(0)
  })
})
