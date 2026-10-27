export class HttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

export function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  headers.set('cache-control', 'no-store')

  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  })
}

export function noContent(init: ResponseInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('cache-control', 'no-store')

  return new Response(null, {
    ...init,
    status: init.status ?? 204,
    headers,
  })
}

export async function readJsonBody<T>(request: Request): Promise<T> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'Expected application/json request body.')
  }

  try {
    return (await request.json()) as T
  } catch {
    throw new HttpError(400, 'Invalid JSON request body.')
  }
}

export function requireMethod(request: Request, method: string) {
  if (request.method.toUpperCase() !== method) {
    throw new HttpError(405, `Use ${method} for this endpoint.`)
  }
}

export function requireString(value: unknown, field: string, options: { allowEmpty?: boolean } = {}) {
  if (typeof value !== 'string') {
    throw new HttpError(400, `${field} must be a string.`)
  }

  const normalized = value.trim()
  if (!options.allowEmpty && normalized.length === 0) {
    throw new HttpError(400, `${field} is required.`)
  }

  return normalized
}
