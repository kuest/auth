import type { RuntimeConfig } from '../shared/api'
import type { Env } from './types'

export type KuestChainMode = 'amoy' | 'polygon'

export const AMOY_CHAIN_ID = 80002
export const POLYGON_MAINNET_CHAIN_ID = 137

function firstEnv(env: Env, ...keys: Array<keyof Env>) {
  for (const key of keys) {
    const value = env[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return ''
}

function flagEnabled(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

export function getRuntimeConfig(env: Env): RuntimeConfig {
  const siteName = firstEnv(env, 'SITE_NAME') || 'Kuest'
  const chainModeRaw = firstEnv(env, 'KUEST_CHAIN_MODE').toLowerCase()
  const kuestChainMode = chainModeRaw === 'polygon' ? 'polygon' : 'amoy'
  const appUrl = firstEnv(env, 'APP_URL') || 'https://auth.kuest.com'
  const appIcon = firstEnv(env, 'APP_ICON') || `${appUrl.replace(/\/+$/, '')}/kuest-logo.svg`

  return {
    siteName,
    kuestChainMode,
    reownAppKitProjectId: firstEnv(env, 'REOWN_APPKIT_PROJECT_ID'),
    appUrl,
    appIcon,
  }
}

function getChainModeForChainId(chainId: number): KuestChainMode {
  if (chainId === POLYGON_MAINNET_CHAIN_ID) {
    return 'polygon'
  }
  if (chainId === AMOY_CHAIN_ID) {
    return 'amoy'
  }
  throw new Error(`Unsupported Kuest chain id: ${chainId}.`)
}

function firstNetworkEnv(env: Env, baseName: 'CLOB_URL' | 'RELAYER_URL', mode: KuestChainMode, fallback: string) {
  const suffix = mode === 'polygon' ? 'MAINNET' : 'AMOY'
  const networkKey = `${baseName}_${suffix}` as keyof Env
  const networkValue = env[networkKey]
  if (typeof networkValue === 'string' && networkValue.trim()) {
    return networkValue.trim()
  }

  if (mode === 'amoy') {
    const legacyValue = env[baseName]
    if (typeof legacyValue === 'string' && legacyValue.trim()) {
      return legacyValue.trim()
    }
  }

  return fallback
}

export function getKuestBaseUrls(env: Env, chainId: number) {
  const mode = getChainModeForChainId(chainId)
  const values = [
    firstNetworkEnv(
      env,
      'CLOB_URL',
      mode,
      mode === 'polygon' ? 'https://clob.kuest.com' : 'https://clob-staging.kuest.com',
    ),
    firstNetworkEnv(
      env,
      'RELAYER_URL',
      mode,
      mode === 'polygon' ? 'https://relayer.kuest.com' : 'https://relayer-staging.kuest.com',
    ),
  ].filter(Boolean)

  const unique = Array.from(new Set(values))
  if (unique.length === 0) {
    throw new Error(
      `CLOB_URL_${mode === 'polygon' ? 'MAINNET' : 'AMOY'} or RELAYER_URL_${mode === 'polygon' ? 'MAINNET' : 'AMOY'} must be defined.`,
    )
  }
  return unique
}

export function kuestDebugErrorsEnabled(env: Env) {
  return flagEnabled(env.KUEST_DEBUG_ERRORS)
}
