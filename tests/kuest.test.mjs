import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { extname } from 'node:path'
import test from 'node:test'

// Node can strip TypeScript types; this hook resolves the Worker's extensionless imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'postgres') {
      return { url: 'data:text/javascript,export default function postgres() {}', shortCircuit: true }
    }
    if (specifier.startsWith('.') && context.parentURL && !extname(new URL(specifier, context.parentURL).pathname)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

const { createKuestKey, listKuestKeyMetadata, revokeKuestKey } = await import('../worker/kuest.ts')
const { default: worker } = await import('../worker/index.ts')

const env = {
  CLOB_URL_MAINNET: 'https://clob.example',
  RELAYER_URL_MAINNET: 'https://relayer.example',
}
const input = {
  address: '0x0000000000000000000000000000000000000001',
  signature: `0x${'1'.repeat(130)}`,
  timestamp: '1234567890',
  nonce: '0',
  chainId: 137,
}
const bundle = { apiKey: 'test-key', apiSecret: 'test-secret', passphrase: 'test-passphrase' }
const upstreamBundle = { apiKey: bundle.apiKey, secret: bundle.apiSecret, passphrase: bundle.passphrase }
const auth = { ...bundle, address: input.address, apiSecret: btoa('a'.repeat(32)), chainId: 137 }

function reply(status, payload = {}) {
  return new Response(JSON.stringify(payload), { status })
}

async function withUpstreams(responder, run) {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    const request = { url: new URL(url), method: options.method, headers: options.headers }
    calls.push(request)
    return responder(request)
  }
  try {
    return await run(calls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('create-key preserves a shared malformed-signature rejection without exposing upstream text', async () => {
  await withUpstreams(
    () => reply(400, { error: 'private upstream diagnostic' }),
    async (calls) => {
      await assert.rejects(createKuestKey(env, input), (error) => {
        assert.equal(error.status, 400)
        assert.match(error.message, /sign again/i)
        assert.doesNotMatch(error.message, /private upstream diagnostic/)
        return true
      })
      assert.equal(calls.length, 2)
      assert(calls.every(({ method }) => method === 'POST'))
    },
  )
})

test('create-key preserves a shared expired-signature rejection', async () => {
  await withUpstreams(
    () => reply(401),
    async (calls) => {
      await assert.rejects(createKuestKey(env, input), { status: 401 })
      assert.equal(calls.length, 2)
    },
  )
})

test('create-key preserves shared access denial and rate limits', async () => {
  for (const status of [403, 429]) {
    await withUpstreams(
      () => reply(status),
      async (calls) => {
        await assert.rejects(createKuestKey(env, input), { status })
        assert.equal(calls.length, 2)
      },
    )
  }
})

test('HTTP API retains its error envelope and the mapped status', async () => {
  await withUpstreams(
    () => reply(400),
    async () => {
      const response = await worker.fetch(
        new Request('https://auth.example/api/kuest/create-key', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
        env,
      )
      assert.equal(response.status, 400)
      assert.match((await response.json()).error.message, /sign again/i)
    },
  )
})

test('create-key reports partial issuance as a dependency failure', async () => {
  await withUpstreams(
    ({ url }) => (url.host === 'clob.example' ? reply(200, upstreamBundle) : reply(401)),
    async (calls) => {
      await assert.rejects(createKuestKey(env, input), { status: 502 })
      assert.equal(calls.length, 2)
    },
  )
})

test('create-key can derive an existing key after both issuance responses fail', async () => {
  await withUpstreams(
    ({ method }) => (method === 'POST' ? reply(500) : reply(200, upstreamBundle)),
    async (calls) => {
      assert.deepEqual(await createKuestKey(env, input), bundle)
      assert.equal(calls.filter(({ method }) => method === 'GET').length, 2)
    },
  )
})

test('create-key reports dependency failure when issuance and recovery both fail', async () => {
  await withUpstreams(
    ({ method }) => (method === 'POST' ? reply(503) : reply(404)),
    async (calls) => {
      await assert.rejects(createKuestKey(env, input), { status: 502 })
      assert.equal(calls.length, 4)
    },
  )
})

test('list-keys preserves shared authentication failure', async () => {
  await withUpstreams(
    () => reply(401),
    async (calls) => {
      await assert.rejects(listKuestKeyMetadata(env, auth), { status: 401 })
      assert.equal(calls.length, 2)
    },
  )
})

test('list-keys does not mistake a partial empty result for no keys', async () => {
  await withUpstreams(
    ({ url }) => (url.host === 'clob.example' ? reply(200, []) : reply(401)),
    async () => assert.rejects(listKuestKeyMetadata(env, auth), { status: 502 }),
  )
})

test('list-keys preserves existing nonempty partial results', async () => {
  await withUpstreams(
    ({ url }) =>
      url.host === 'clob.example' ? reply(200, [{ apiKey: 'test-key', nonce: '2', status: 'active' }]) : reply(401),
    async () =>
      assert.deepEqual(await listKuestKeyMetadata(env, auth), [{ apiKey: 'test-key', nonce: '2', status: 'active' }]),
  )
})

test('list-keys returns empty only after both services succeed with empty results', async () => {
  await withUpstreams(
    () => reply(200, []),
    async () => assert.deepEqual(await listKuestKeyMetadata(env, auth), []),
  )
})

test('list-keys treats differing upstream failures as a dependency failure', async () => {
  await withUpstreams(
    ({ url }) => (url.host === 'clob.example' ? reply(401) : reply(500)),
    async () => assert.rejects(listKuestKeyMetadata(env, auth), { status: 502 }),
  )
})

test('revoke-key preserves success from either service', async () => {
  await withUpstreams(
    ({ url }) => (url.host === 'clob.example' ? new Response(null, { status: 204 }) : reply(401)),
    async () => assert.equal(await revokeKuestKey(env, auth, 'test-key'), true),
  )
})
