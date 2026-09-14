export interface RuntimeConfig {
  siteName: string
  kuestChainMode: 'amoy' | 'polygon'
  reownAppKitProjectId: string
  appUrl: string
  appIcon: string
}

export interface KuestKeyBundle {
  apiKey: string
  apiSecret: string
  passphrase: string
}

export interface CreateKuestKeyInput {
  address: string
  signature: string
  timestamp: string
  nonce: string
  chainId: number
}

export interface KuestAuthContext {
  address: string
  apiKey: string
  apiSecret: string
  passphrase: string
  chainId: number
}

export interface KuestKeyMetadata {
  apiKey: string
  nonce: string | null
  status: string
}

export interface ListKuestKeysResponse {
  keys: KuestKeyMetadata[]
}

export interface RevokeKuestKeyResponse {
  ok: true
}

export interface SaveKeyEmailInput {
  apiKey: string
  email: string
}

export interface SaveKeyEmailResponse {
  status: 'saved' | 'duplicate'
}
