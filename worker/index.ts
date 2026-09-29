import type { CreateKuestKeyInput, KuestAuthContext } from '../shared/api'
import type { Env } from './types'

import { HttpError, json, noContent, readJsonBody, requireMethod, requireString } from './http'
import { createKuestKey, listKuestKeyMetadata, revokeKuestKey } from './kuest'
import { saveKeyEmail } from './postgres'
import { AMOY_CHAIN_ID, getRuntimeConfig, POLYGON_MAINNET_CHAIN_ID } from './runtime-config'

function parseCreateKuestKeyInput(payload: unknown): CreateKuestKeyInput {
  const record = requireRecord(payload)
  return {
    address: requireString(record.address, 'address'),
    signature: requireString(record.signature, 'signature'),
    timestamp: requireString(record.timestamp, 'timestamp'),
    nonce: requireString(record.nonce, 'nonce', { allowEmpty: true }),
    chainId: requireChainId(record.chainId),
  }
}

function parseAuthContext(payload: unknown): KuestAuthContext {
  const record = requireRecord(payload)
  return {
    address: requireString(record.address, 'address'),
    apiKey: requireString(record.apiKey, 'apiKey'),
    apiSecret: requireString(record.apiSecret, 'apiSecret'),
    passphrase: requireString(record.passphrase, 'passphrase'),
    chainId: requireChainId(record.chainId),
  }
}

function requireChainId(value: unknown) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    (value !== AMOY_CHAIN_ID && value !== POLYGON_MAINNET_CHAIN_ID)
  ) {
    throw new HttpError(400, 'chainId must be Polygon Amoy (80002) or Polygon Mainnet (137).')
  }
  return value
}

function requireRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'Expected a JSON object.')
  }
  return payload as Record<string, unknown>
}

function normalizeError(error: unknown) {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      message: error.message,
      logMessage: error.message,
    }
  }
  if (error instanceof Error) {
    return {
      status: 500,
      message: 'Unexpected request failure.',
      logMessage: error.message,
    }
  }
  return {
    status: 500,
    message: 'Unexpected request failure.',
    logMessage: 'Non-error exception.',
  }
}

async function handleApi(request: Request, env: Env) {
  const url = new URL(request.url)

  try {
    if (request.method === 'OPTIONS') {
      return noContent()
    }

    if (url.pathname === '/api/config') {
      requireMethod(request, 'GET')
      return json(getRuntimeConfig(env))
    }

    if (url.pathname === '/api/kuest/create-key') {
      requireMethod(request, 'POST')
      const payload = parseCreateKuestKeyInput(await readJsonBody(request))
      const bundle = await createKuestKey(env, payload)
      return json(bundle)
    }

    if (url.pathname === '/api/kuest/list-keys') {
      requireMethod(request, 'POST')
      const auth = parseAuthContext(await readJsonBody(request))
      const keys = await listKuestKeyMetadata(env, auth)
      return json({ keys })
    }

    if (url.pathname === '/api/kuest/revoke-key') {
      requireMethod(request, 'POST')
      const payload = requireRecord(await readJsonBody(request))
      const auth = parseAuthContext(payload.auth)
      const apiKey = requireString(payload.apiKey, 'apiKey')
      await revokeKuestKey(env, auth, apiKey)
      return json({ ok: true })
    }

    if (url.pathname === '/api/key-emails') {
      requireMethod(request, 'POST')
      const payload = requireRecord(await readJsonBody(request))
      const apiKey = requireString(payload.apiKey, 'apiKey')
      const email = requireString(payload.email, 'email')
      const result = await saveKeyEmail(env, { apiKey, email })
      return json(result)
    }

    throw new HttpError(404, 'API route not found.')
  } catch (error) {
    const normalized = normalizeError(error)
    if (normalized.status >= 500) {
      console.warn('[api] request failed', {
        path: url.pathname,
        message: normalized.logMessage,
      })
    }
    return json({ error: { message: normalized.message } }, { status: normalized.status })
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env)
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
