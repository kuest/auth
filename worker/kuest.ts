import type {
  CreateKuestKeyInput,
  KuestAuthContext,
  KuestKeyBundle,
  KuestKeyMetadata,
} from '../shared/api'
import type { Env } from './types'
import { hmacSha256Base64Url } from './crypto'
import { HttpError, readJsonSafely } from './http'
import { getKuestBaseUrls, kuestDebugErrorsEnabled } from './runtime-config'

function sanitizeKuestMessage(
  env: Env,
  status: number | undefined,
  rawMessage?: string,
) {
  const normalized = (rawMessage ?? '').replace(/\s+/g, ' ').trim()
  const truncated = normalized.slice(0, 200)

  let sanitized: string
  if (status === 401 || status === 403) {
    sanitized
      = 'Credentials rejected by Kuest. Generate a fresh API key and try again.'
  }
  else if (status === 429) {
    sanitized = 'Too many requests. Hold on a moment before retrying.'
  }
  else if (status === 500 || status === 503) {
    sanitized = 'Kuest is temporarily unavailable. Retry shortly.'
  }
  else if (truncated.length > 0) {
    sanitized = truncated
  }
  else {
    sanitized = 'Kuest request failed. Please try again.'
  }

  if (kuestDebugErrorsEnabled(env) && truncated.length > 0) {
    if (sanitized === truncated) {
      return truncated
    }
    return `${truncated} - ${sanitized}`
  }

  return sanitized
}

function normalizeKeyBundle(payload: unknown): KuestKeyBundle {
  if (!payload || typeof payload !== 'object') {
    throw new HttpError(502, 'Unexpected response when minting API key.')
  }

  function unwrapNested(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if ('data' in record && typeof record.data === 'object') {
        return record.data as Record<string, unknown>
      }
      return record
    }
    return null
  }

  const record = unwrapNested(payload)
  if (!record) {
    throw new HttpError(502, 'Unexpected response when minting API key.')
  }
  const normalizedRecord = record

  function readFirst(...keys: string[]) {
    for (const key of keys) {
      const candidate = normalizedRecord[key]
      if (typeof candidate === 'string' && candidate.length > 0) {
        return candidate
      }
    }
    return undefined
  }

  const apiKey = readFirst('apiKey', 'api_key', 'key')
  const apiSecret = readFirst('secret', 'apiSecret', 'api_secret')
  const passphrase = readFirst('passphrase')

  if (!apiKey || !apiSecret || !passphrase) {
    const keys = Object.keys(normalizedRecord).join(', ') || 'none'
    throw new HttpError(
      502,
      `Kuest did not return API credentials. Payload keys: ${keys}`,
    )
  }

  return {
    apiKey,
    apiSecret,
    passphrase,
  }
}

async function requestKuestKey(
  env: Env,
  baseUrl: string,
  { address, signature, timestamp, nonce }: CreateKuestKeyInput,
  options: {
    path: '/auth/api-key' | '/auth/derive-api-key'
    method: 'POST' | 'GET'
  } = { path: '/auth/api-key', method: 'POST' },
) {
  const url = new URL(options.path, baseUrl)

  const response = await fetch(url.toString(), {
    method: options.method,
    headers: {
      KUEST_ADDRESS: address,
      KUEST_SIGNATURE: signature,
      KUEST_TIMESTAMP: timestamp,
      KUEST_NONCE: nonce,
    },
    cache: 'no-store',
  })

  if (!response.ok) {
    let message = 'Failed to generate API key.'
    const errorPayload = await readJsonSafely(response)
    if (errorPayload && typeof errorPayload === 'object') {
      message
        = (errorPayload as { message?: string }).message
          ?? (errorPayload as { error?: string }).error
          ?? message
    }

    const sanitized = sanitizeKuestMessage(env, response.status, message)
    console.warn('[kuest] create key failed', {
      baseUrl,
      status: response.status,
      message,
    })
    throw new HttpError(502, sanitized)
  }

  const data = await response.json()
  return normalizeKeyBundle(data)
}

async function deriveExistingKuestKey(
  env: Env,
  targets: string[],
  input: CreateKuestKeyInput,
) {
  const results = await Promise.allSettled(
    targets.map(baseUrl =>
      requestKuestKey(env, baseUrl, input, {
        path: '/auth/derive-api-key',
        method: 'GET',
      }),
    ),
  )

  const values = results.flatMap(result =>
    result.status === 'fulfilled' ? [result.value] : [],
  )
  if (values.length === 0) {
    return null
  }

  const [first, ...rest] = values
  const mismatch = rest.find(value => (
    value.apiKey !== first.apiKey
    || value.apiSecret !== first.apiSecret
    || value.passphrase !== first.passphrase
  ))
  if (mismatch) {
    throw new HttpError(502, 'Kuest services returned mismatched API credentials.')
  }

  return first
}

export async function createKuestKey(env: Env, input: CreateKuestKeyInput) {
  const targets = getKuestBaseUrls(env, input.chainId)
  const results = await Promise.allSettled(
    targets.map(baseUrl => requestKuestKey(env, baseUrl, input)),
  )

  const values: KuestKeyBundle[] = []
  const failures: Error[] = []

  for (const result of results) {
    if (result.status === 'fulfilled') {
      values.push(result.value)
    }
    else {
      failures.push(
        result.reason instanceof Error
          ? result.reason
          : new Error(String(result.reason)),
      )
    }
  }

  if (failures.length > 0) {
    if (failures.length === targets.length) {
      const recovered = await deriveExistingKuestKey(env, targets, input)
      if (recovered) {
        return recovered
      }
    }

    const normalized = failures[0]
    const prefix = failures.length === targets.length
      ? 'Failed to generate API key.'
      : 'Failed to generate API key on all services.'
    throw new HttpError(502, `${prefix} ${normalized.message}`)
  }

  if (values.length === 0) {
    throw new HttpError(502, 'Failed to generate API key.')
  }

  const [first, ...rest] = values
  const mismatch = rest.find(value => (
    value.apiKey !== first.apiKey
    || value.apiSecret !== first.apiSecret
    || value.passphrase !== first.passphrase
  ))

  if (mismatch) {
    throw new HttpError(502, 'Kuest services returned mismatched API credentials.')
  }

  return first
}

function buildHeaders(options: {
  address: string
  apiKey: string
  passphrase: string
  timestamp: string
  signature: string
}) {
  return {
    KUEST_ADDRESS: options.address,
    KUEST_API_KEY: options.apiKey,
    KUEST_PASSPHRASE: options.passphrase,
    KUEST_TIMESTAMP: options.timestamp,
    KUEST_SIGNATURE: options.signature,
  }
}

async function signMessage(options: {
  apiSecret: string
  method: string
  path: string
  timestamp: string
  body?: string
}) {
  const signingPath = options.path.split('?')[0]
  const signingString = `${options.timestamp}${options.method.toUpperCase()}${signingPath}${
    options.body ?? ''
  }`
  return hmacSha256Base64Url(options.apiSecret, signingString)
}

function normalizeKuestKeyMetadata(payload: unknown): KuestKeyMetadata[] {
  if (!Array.isArray(payload)) {
    return []
  }

  return payload.flatMap((value) => {
    if (typeof value === 'string' && value.trim()) {
      return [{ apiKey: value.trim(), nonce: null, status: 'active' }]
    }
    if (!value || typeof value !== 'object') {
      return []
    }

    const record = value as Record<string, unknown>
    const apiKey = typeof record.apiKey === 'string'
      ? record.apiKey
      : typeof record.api_key === 'string'
        ? record.api_key
        : typeof record.key === 'string'
          ? record.key
          : null
    const nonce = normalizeKuestNonce(record.nonce)
    const status = typeof record.status === 'string' ? record.status : 'active'

    if (!apiKey) {
      return []
    }

    return [{ apiKey, nonce, status }]
  })
}

function normalizeKuestNonce(value: unknown) {
  const raw = typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isInteger(value)
      ? value.toString()
      : null
  if (!raw) {
    return null
  }

  const parsed = parseKuestNonce(raw)
  return parsed === null ? null : parsed.toString()
}

function parseKuestNonce(value: string | null) {
  if (!value) {
    return null
  }

  try {
    const parsed = BigInt(value)
    return parsed < BigInt(0) ? null : parsed
  }
  catch {
    return null
  }
}

function compareNonce(left: string | null, right: string | null) {
  const leftValue = parseKuestNonce(left)
  const rightValue = parseKuestNonce(right)
  if (leftValue !== null && rightValue !== null) {
    if (leftValue === rightValue) {
      return 0
    }
    return leftValue > rightValue ? 1 : -1
  }
  if (leftValue !== null) {
    return 1
  }
  if (rightValue !== null) {
    return -1
  }
  return 0
}

function mergeKuestKeyMetadata(
  existing: KuestKeyMetadata,
  incoming: KuestKeyMetadata,
) {
  return {
    apiKey: existing.apiKey,
    nonce: compareNonce(existing.nonce, incoming.nonce) >= 0
      ? existing.nonce
      : incoming.nonce,
    status: existing.status === 'active' || incoming.status === 'active'
      ? 'active'
      : incoming.status || existing.status,
  }
}

async function fetchKeysFrom(baseUrl: string, env: Env, auth: KuestAuthContext) {
  const path = '/auth/api-keys'
  const url = new URL(path, baseUrl)
  url.searchParams.set('metadata', 'true')
  url.searchParams.set('includeRevoked', 'true')
  const timestamp = Math.floor(Date.now() / 1000).toString()

  const signature = await signMessage({
    apiSecret: auth.apiSecret,
    method: 'GET',
    path,
    timestamp,
  })

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: buildHeaders({
      address: auth.address,
      apiKey: auth.apiKey,
      passphrase: auth.passphrase,
      timestamp,
      signature,
    }),
    cache: 'no-store',
  })

  if (!response.ok) {
    let message = 'Failed to load keys.'
    const payload = await readJsonSafely(response)
    if (payload && typeof payload === 'object') {
      message
        = (payload as { message?: string }).message
          ?? (payload as { error?: string }).error
          ?? message
    }
    const sanitized = sanitizeKuestMessage(env, response.status, message)
    throw new HttpError(502, sanitized)
  }

  const data = await response.json()
  if (!Array.isArray(data)) {
    throw new HttpError(502, 'Unexpected response when listing keys.')
  }

  return normalizeKuestKeyMetadata(data)
}

export async function listKuestKeyMetadata(
  env: Env,
  auth: KuestAuthContext,
) {
  const targets = getKuestBaseUrls(env, auth.chainId)
  const keys = new Map<string, KuestKeyMetadata>()
  let lastError: Error | null = null

  for (const baseUrl of targets) {
    try {
      const fetched = await fetchKeysFrom(baseUrl, env, auth)
      fetched.forEach((key) => {
        const existing = keys.get(key.apiKey)
        keys.set(
          key.apiKey,
          existing ? mergeKuestKeyMetadata(existing, key) : key,
        )
      })
    }
    catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      console.warn('[kuest] list keys failed', {
        baseUrl,
        message: lastError.message,
      })
    }
  }

  if (keys.size > 0) {
    return Array.from(keys.values())
  }

  throw lastError ?? new Error('Failed to load keys.')
}

async function revokeKeyOn(
  baseUrl: string,
  env: Env,
  auth: KuestAuthContext,
  apiKey: string,
) {
  const path = '/auth/api-key'
  const url = new URL(path, baseUrl)
  url.searchParams.set('apiKey', apiKey)
  const timestamp = Math.floor(Date.now() / 1000).toString()

  const signature = await signMessage({
    apiSecret: auth.apiSecret,
    method: 'DELETE',
    path,
    timestamp,
  })

  const response = await fetch(url.toString(), {
    method: 'DELETE',
    headers: buildHeaders({
      address: auth.address,
      apiKey: auth.apiKey,
      passphrase: auth.passphrase,
      timestamp,
      signature,
    }),
    cache: 'no-store',
  })

  if (!response.ok) {
    let message = 'Failed to revoke key.'
    const payload = await readJsonSafely(response)
    if (payload && typeof payload === 'object') {
      message
        = (payload as { message?: string }).message
          ?? (payload as { error?: string }).error
          ?? message
    }
    const sanitized = sanitizeKuestMessage(env, response.status, message)
    throw new HttpError(502, sanitized)
  }
}

export async function revokeKuestKey(
  env: Env,
  auth: KuestAuthContext,
  apiKey: string,
) {
  const targets = getKuestBaseUrls(env, auth.chainId)
  let success = false
  let lastError: Error | null = null

  for (const baseUrl of targets) {
    try {
      await revokeKeyOn(baseUrl, env, auth, apiKey)
      success = true
    }
    catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      console.warn('[kuest] revoke key failed', {
        baseUrl,
        message: lastError.message,
      })
    }
  }

  if (success) {
    return true
  }

  throw lastError ?? new Error('Failed to revoke key.')
}
