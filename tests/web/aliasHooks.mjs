import { pathToFileURL } from 'node:url'
import { resolve as resolvePath } from 'node:path'

const ROOT = resolvePath(import.meta.dirname, '..', '..')

// vite 의 @shared / @features 별칭을 Node 가 읽도록 저장소 경로로 바꾼다
export async function resolve(specifier, context, nextResolve) {
  const match = /^@(shared|features)\/(.+)$/.exec(specifier)
  if (match) return nextResolve(pathToFileURL(resolvePath(ROOT, match[1], match[2])).href, context)
  return nextResolve(specifier, context)
}
