import { existsSync } from 'node:fs'

export function sanitizedOpenCodeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  const extraCerts = env.NODE_EXTRA_CA_CERTS
  if (extraCerts && !existsSync(extraCerts)) delete env.NODE_EXTRA_CA_CERTS
  return env
}

export async function withSanitizedOpenCodeProcessEnv<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.NODE_EXTRA_CA_CERTS
  const shouldDelete = !!original && !existsSync(original)
  if (shouldDelete) delete process.env.NODE_EXTRA_CA_CERTS
  try {
    return await fn()
  } finally {
    if (shouldDelete) process.env.NODE_EXTRA_CA_CERTS = original
  }
}
