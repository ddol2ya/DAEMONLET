// Export the same selected A2 artwork as Windows multi-resolution PNG-in-ICO.
// The source illustration and existing Mac icon are never modified.
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
if (process.platform !== 'darwin') throw new Error('Regenerate on macOS with sips; Windows builds use the checked-in ICO.')
const root = resolve(import.meta.dirname, '..'), work = await mkdtemp(join(tmpdir(), 'daemonlet-ico-'))
try {
  const sizes = [16, 24, 32, 48, 64, 128, 256], images = []
  for (const size of sizes) {
    const output = join(work, `${size}.png`)
    execFileSync('/usr/bin/sips', ['-z', String(size), String(size), join(root, 'electron/assets/icon-source/app-a2-rabbit.png'), '--out', output], { stdio: 'ignore' })
    images.push(await readFile(output))
  }
  const header = Buffer.alloc(6 + sizes.length * 16)
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((size, index) => {
    const at = 6 + index * 16
    header[at] = header[at + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(images[index].length, at + 8); header.writeUInt32LE(offset, at + 12)
    offset += images[index].length
  })
  await writeFile(join(root, 'electron/assets/appIcon.ico'), Buffer.concat([header, ...images]))
} finally { await rm(work, { recursive: true, force: true }) }
