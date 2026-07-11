import { open, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf-8'))
const base = `TermFlow-${pkg.version}-x64`
const artifacts = [
  { path: resolve('dist', `${base}.exe`), signature: Buffer.from('MZ') },
  { path: resolve('dist', `${base}.zip`), signature: Buffer.from('PK') }
]

for (const artifact of artifacts) {
  const info = await stat(artifact.path)
  if (info.size < 1024 * 1024) throw new Error(`${artifact.path} is unexpectedly small (${info.size} bytes)`)
  const handle = await open(artifact.path, 'r')
  const header = Buffer.alloc(2)
  await handle.read(header, 0, 2, 0)
  await handle.close()
  if (!header.equals(artifact.signature)) throw new Error(`${artifact.path} has an invalid signature`)
}

console.log('Windows installer and ZIP artifacts are valid.')
