import type { UseAccountReturnType } from 'wagmi'

import { useWalletInfo } from '@reown/appkit/react'
import { CheckIcon, ChevronDownIcon, Loader2Icon, WalletIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { UserRejectedRequestError } from 'viem'
import { useAccount, useDisconnect, useSignTypedData, useSwitchChain } from 'wagmi'
import { polygon, polygonAmoy } from 'wagmi/chains'

import type { KeyBundle } from '@/types/keygen'
import type { RuntimeConfig } from '@/types/runtime-config'

import { EnvBlock } from '@/components/env-block'
import { KeysPanel } from '@/components/keys-panel'
import { SiteLogoIcon } from '@/components/site-logo-icon'
import { useAppKit } from '@/hooks/useAppKit'
import { useRuntimeConfig } from '@/hooks/useRuntimeConfig'
import {
  createKuestKey,
  listKuestKeyMetadata,
  listKuestKeys,
  nextKuestNonceFromMetadata,
  revokeKuestKey,
  saveKeyEmail,
} from '@/lib/api'
import { shortenAddress } from '@/lib/format'

const EMAIL_STORAGE_KEY = 'kuest-email'
const EMAIL_STORAGE_TTL = 1000 * 60 * 60 * 24 * 3
const AMOY_CHAIN_HEX = `0x${polygonAmoy.id.toString(16)}`
const AMOY_ADD_PARAMS = {
  chainId: AMOY_CHAIN_HEX,
  chainName: 'Polygon Amoy Testnet',
  nativeCurrency: {
    name: 'POL',
    symbol: 'POL',
    decimals: 18,
  },
  rpcUrls: ['https://polygon-amoy.drpc.org'],
  blockExplorerUrls: ['https://amoy.polygonscan.com/'],
}

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

interface ErrorWithCode extends Error {
  code?: number
  cause?: unknown
}

interface ActionPromptProps {
  open: boolean
  title: string
  description: string
  showConnectedWalletIcon?: boolean
  allowClose?: boolean
  onClose?: () => void
}

interface KeyGeneratorContentProps {
  account: UseAccountReturnType
  runtimeConfig: RuntimeConfig
}

type ChainMode = RuntimeConfig['kuestChainMode']

function getInjectedProvider(): Eip1193Provider | null {
  const maybeProvider = (window as Window & { ethereum?: Eip1193Provider }).ethereum

  if (!maybeProvider || typeof maybeProvider.request !== 'function') {
    return null
  }

  return maybeProvider
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  return fallback
}

function isMissingChainError(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }

  const candidate = error as ErrorWithCode
  const cause = candidate.cause as { code?: number; message?: string } | undefined
  const message = candidate.message.toLowerCase()
  const causeMessage = cause?.message?.toLowerCase() ?? ''

  return (
    candidate.code === 4902 ||
    cause?.code === 4902 ||
    message.includes('4902') ||
    causeMessage.includes('4902') ||
    message.includes('unrecognized chain') ||
    causeMessage.includes('unrecognized chain')
  )
}

function readStoredEmailDraft() {
  if (typeof window === 'undefined') {
    return ''
  }

  const saved = window.localStorage.getItem(EMAIL_STORAGE_KEY)
  if (!saved) {
    return ''
  }

  try {
    const parsed = JSON.parse(saved) as {
      value?: string
      savedAt?: number
    }
    if (!parsed?.value) {
      return ''
    }

    const age = Date.now() - (parsed.savedAt ?? 0)
    if (age < EMAIL_STORAGE_TTL) {
      return parsed.value
    }

    window.localStorage.removeItem(EMAIL_STORAGE_KEY)
  } catch {
    window.localStorage.removeItem(EMAIL_STORAGE_KEY)
  }

  return ''
}

function ActionPrompt({
  open,
  title,
  description,
  showConnectedWalletIcon = false,
  allowClose = false,
  onClose,
}: ActionPromptProps) {
  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-80 flex items-center justify-center bg-background/85 px-4 py-6 backdrop-blur-md">
      <div className="relative w-full max-w-sm auth-panel p-6 text-center">
        {allowClose && onClose && (
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 auth-icon-button p-2 text-muted-foreground hover:text-foreground"
            aria-label="Close waiting modal"
          >
            <XIcon className="size-4" />
          </button>
        )}

        <h3 className="text-xl font-semibold text-foreground">{title}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>

        <div className="mt-5 flex justify-center">
          <div className="relative size-36 overflow-hidden rounded-[30px] bg-card text-primary">
            <div
              className={`pointer-events-none absolute inset-0 animate-[spin_1500ms_linear_infinite] bg-[conic-gradient(from_0deg,transparent_0deg,transparent_288deg,currentColor_320deg,currentColor_350deg,transparent_360deg)]`}
            />
            <div className="absolute inset-[3px] rounded-[26px] bg-background" />
            <div className="relative flex size-full items-center justify-center">
              <div className="flex size-[88%] items-center justify-center">
                {showConnectedWalletIcon ? (
                  <ActionPromptWalletIcon />
                ) : (
                  <WalletIcon className="size-16 text-primary" strokeWidth={1.7} />
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-foreground">
          <Loader2Icon className="size-4 animate-spin text-primary" />
          <span>Waiting for wallet approval...</span>
        </div>
      </div>
    </div>
  )
}

function ActionPromptWalletIcon() {
  const { walletInfo } = useWalletInfo()
  const [failedWalletIconUrl, setFailedWalletIconUrl] = useState<string | null>(null)
  const walletName = typeof walletInfo?.name === 'string' ? walletInfo.name : undefined
  const walletIconUrl = typeof walletInfo?.icon === 'string' ? walletInfo.icon.trim() : ''
  const walletIconLoadFailed = failedWalletIconUrl === walletIconUrl

  if (!walletIconUrl || walletIconLoadFailed) {
    return <WalletIcon className="size-16 text-primary" strokeWidth={1.7} />
  }

  return (
    <img
      src={walletIconUrl}
      alt={walletName ? `${walletName} wallet icon` : 'Connected wallet icon'}
      width={64}
      height={64}
      className="size-16 rounded-2xl object-cover"
      onError={() => setFailedWalletIconUrl(walletIconUrl)}
    />
  )
}

export function KeyGenerator() {
  const runtimeConfig = useRuntimeConfig()
  const account = useAccount()
  const flowKey = account.address ?? 'anonymous'

  return <KeyGeneratorContent key={flowKey} account={account} runtimeConfig={runtimeConfig} />
}

function KeyGeneratorContent({ account, runtimeConfig }: KeyGeneratorContentProps) {
  const siteName = runtimeConfig.siteName.trim() || 'Kuest'
  const [selectedChainMode, setSelectedChainMode] = useState<ChainMode>(runtimeConfig.kuestChainMode)
  const requiredChain = selectedChainMode === 'polygon' ? polygon : polygonAmoy
  const requiredChainId = requiredChain.id
  const requiredChainLabel = selectedChainMode === 'polygon' ? 'Polygon Mainnet (137)' : 'Polygon Amoy Testnet (80002)'

  const { disconnect, status: disconnectStatus } = useDisconnect()
  const { switchChainAsync, status: switchStatus } = useSwitchChain()
  const { signTypedDataAsync } = useSignTypedData()
  const { open: openAppKit, isReady: isAppKitReady } = useAppKit()
  const signingInFlightRef = useRef(false)

  const isConnected = account.status === 'connected' && Boolean(account.address)
  const onRequiredChain = isConnected && account.chainId !== undefined ? account.chainId === requiredChainId : false

  const [bundles, setBundles] = useState<Partial<Record<ChainMode, KeyBundle>>>({})
  const [keysByChainMode, setKeysByChainMode] = useState<Record<ChainMode, string[]>>({
    amoy: [],
    polygon: [],
  })
  const [keysLoading, setKeysLoading] = useState(false)
  const [keysError, setKeysError] = useState<string | null>(null)
  const [keysHelper, setKeysHelper] = useState<string | null>(null)
  const [emailDraft, setEmailDraft] = useState(readStoredEmailDraft)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [flowError, setFlowError] = useState<string | null>(null)
  const [flowInfo, setFlowInfo] = useState<string | null>(null)
  const [isSigning, setIsSigning] = useState(false)
  const [isEnsuringNetwork, setIsEnsuringNetwork] = useState(false)
  const [connectPromptRequested, setConnectPromptRequested] = useState(false)
  const [emailNotice, setEmailNotice] = useState<string | null>(null)
  const [showKeyManagement, setShowKeyManagement] = useState(false)

  const bundle = bundles[selectedChainMode] ?? null
  const keys = keysByChainMode[selectedChainMode]

  const keyManagementDisabled = !bundle
  const connectPromptOpen = connectPromptRequested && !isConnected

  function handleChainModeChange(nextMode: ChainMode) {
    if (nextMode === selectedChainMode) {
      return
    }

    setSelectedChainMode(nextMode)
    setFlowError(null)
    setFlowInfo(null)
    setKeysError(null)
    setKeysHelper(null)
    setEmailNotice(null)
    setShowKeyManagement(false)
  }

  function updateEmailDraft(value: string) {
    setEmailDraft(value)
    const trimmed = value.trim()
    if (trimmed) {
      window.localStorage.setItem(EMAIL_STORAGE_KEY, JSON.stringify({ value: trimmed, savedAt: Date.now() }))
    } else {
      window.localStorage.removeItem(EMAIL_STORAGE_KEY)
    }
  }

  async function handleWalletConnectClick() {
    setFlowError(null)
    setFlowInfo(null)
    setConnectPromptRequested(true)
    try {
      await openAppKit()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open wallet modal.'
      setFlowError(message)
      setConnectPromptRequested(false)
    }
  }

  async function handleEnsureRequiredNetwork() {
    setFlowError(null)
    setFlowInfo(null)

    if (!isConnected) {
      setFlowError('Connect a wallet before switching networks.')
      return false
    }

    if (onRequiredChain) {
      setFlowInfo(`${requiredChainLabel} is already active.`)
      return true
    }

    setIsEnsuringNetwork(true)

    try {
      if (!switchChainAsync) {
        throw new Error(
          'Automatic network switch is not available for this wallet. Switch manually in wallet settings.',
        )
      }

      await switchChainAsync({ chainId: requiredChainId })
      setFlowInfo(`${requiredChainLabel} is active.`)
      return true
    } catch (error) {
      if (requiredChainId === polygonAmoy.id && isMissingChainError(error)) {
        try {
          const provider = getInjectedProvider()
          if (!provider) {
            throw new Error('Auto-add works only with injected wallets (browser extension or in-app browser).')
          }

          setFlowInfo('Adding Polygon Amoy to your wallet...')
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [AMOY_ADD_PARAMS],
          })
          await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: AMOY_CHAIN_HEX }],
          })
          setFlowInfo('Polygon Amoy enabled. You can sign now.')
          return true
        } catch (addError) {
          setFlowError(
            getErrorMessage(addError, 'Unable to add Polygon Amoy automatically. Switch manually in your wallet.'),
          )
          return false
        }
      }

      setFlowError(getErrorMessage(error, `Unable to switch to ${requiredChainLabel}.`))
      return false
    } finally {
      setIsEnsuringNetwork(false)
    }
  }

  useEffect(
    function clearFlowErrorOnInteraction() {
      if (!flowError) {
        return
      }

      function clearFlowError() {
        setFlowError(null)
      }

      window.addEventListener('pointerdown', clearFlowError, { once: true })
      window.addEventListener('keydown', clearFlowError, { once: true })

      return () => {
        window.removeEventListener('pointerdown', clearFlowError)
        window.removeEventListener('keydown', clearFlowError)
      }
    },
    [flowError],
  )

  function getAuthContext() {
    if (!bundle) {
      throw new Error('Generate an API key before managing credentials.')
    }
    if (!account.address) {
      throw new Error('Connect your wallet to manage keys.')
    }

    return {
      address: account.address,
      apiKey: bundle.apiKey,
      apiSecret: bundle.apiSecret,
      passphrase: bundle.passphrase,
      chainId: requiredChainId,
    }
  }

  async function resolveNonceForNextKey() {
    if (!bundle) {
      return '0'
    }

    setFlowInfo('Checking existing keys...')
    const metadata = await listKuestKeyMetadata(getAuthContext())
    return nextKuestNonceFromMetadata(metadata)
  }

  async function handleSignAndGenerate() {
    setFlowError(null)
    setFlowInfo(null)

    if (!account.address || account.chainId === undefined) {
      setFlowError('Connect a wallet before signing.')
      return
    }
    if (!onRequiredChain) {
      setFlowError(`Switch to ${requiredChainLabel} before signing.`)
      return
    }

    if (signingInFlightRef.current) {
      return
    }

    signingInFlightRef.current = true
    setIsSigning(true)

    try {
      const safeNonce = await resolveNonceForNextKey()
      const timestamp = Math.floor(Date.now() / 1000).toString()

      setFlowInfo('Open your wallet and sign the Kuest attestation.')

      const typedData = {
        domain: {
          name: 'ClobAuthDomain',
          version: '1',
          chainId: requiredChainId,
        },
        types: {
          ClobAuth: [
            { name: 'address', type: 'address' as const },
            { name: 'timestamp', type: 'string' as const },
            { name: 'nonce', type: 'uint256' as const },
            { name: 'message', type: 'string' as const },
          ],
        },
        primaryType: 'ClobAuth' as const,
        message: {
          address: account.address,
          timestamp,
          nonce: safeNonce,
          message: 'This message attests that I control the given wallet',
        },
      }

      const signature = await signTypedDataAsync(typedData)

      setFlowInfo('Minting your Kuest credentials...')
      const result = await createKuestKey({
        address: account.address,
        signature,
        timestamp,
        nonce: safeNonce,
        chainId: requiredChainId,
      })

      const nextBundle = {
        ...result,
        address: account.address,
      }
      setBundles((previous) => ({
        ...previous,
        [selectedChainMode]: nextBundle,
      }))
      if (bundle) {
        handleRefreshKeys().catch(() => {})
      }
      setKeysByChainMode((previous) => ({
        ...previous,
        [selectedChainMode]: previous[selectedChainMode].includes(result.apiKey)
          ? previous[selectedChainMode]
          : [result.apiKey, ...previous[selectedChainMode]],
      }))
      setKeysHelper('New key minted. Use refresh to fetch all keys from Kuest.')
      setKeysError(null)

      const trimmedEmail = emailDraft.trim()
      if (trimmedEmail) {
        try {
          const emailResult = await saveKeyEmail({
            apiKey: result.apiKey,
            email: trimmedEmail,
          })

          setEmailNotice(
            emailResult.status === 'duplicate'
              ? 'Email already saved for this key.'
              : 'Saved. You can revoke any time.',
          )
          updateEmailDraft(trimmedEmail)
        } catch (error) {
          setEmailNotice(error instanceof Error ? `Email save failed: ${error.message}` : 'Email save failed.')
        }
      } else {
        setEmailNotice(null)
        updateEmailDraft('')
      }

      setFlowInfo(null)
    } catch (error) {
      setFlowInfo(null)
      if (error instanceof UserRejectedRequestError) {
        setFlowError('Signature was rejected in your wallet.')
      } else if (error instanceof Error && error.message?.includes('Proposal expired')) {
        setFlowError('Wallet session expired. Reopen your wallet and try connecting again.')
        disconnect()
      } else {
        setFlowError(error instanceof Error ? error.message : 'Unable to generate keys. Please try again.')
      }
    } finally {
      signingInFlightRef.current = false
      setIsSigning(false)
    }
  }

  async function handleRefreshKeys() {
    setKeysError(null)
    setKeysHelper(null)
    setKeysLoading(true)
    try {
      const auth = getAuthContext()
      const latest = await listKuestKeys(auth)
      setKeysByChainMode((previous) => ({
        ...previous,
        [selectedChainMode]: latest,
      }))
      setKeysHelper(
        latest.length
          ? `Loaded ${latest.length} active key${latest.length > 1 ? 's' : ''}.`
          : 'No keys found for this wallet.',
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load keys.'
      setKeysError(message)
      setKeysByChainMode((previous) => ({
        ...previous,
        [selectedChainMode]: [],
      }))
      if (error instanceof Error && /401|403/.test(message)) {
        setBundles((previous) => {
          const next = { ...previous }
          delete next[selectedChainMode]
          return next
        })
        setKeysHelper('Credentials look invalid. Generate a new API key to continue.')
      }
    } finally {
      setKeysLoading(false)
    }
  }

  async function handleRevoke(key: string) {
    setKeysError(null)
    setKeysHelper(null)
    setKeysLoading(true)
    try {
      const auth = getAuthContext()
      await revokeKuestKey(auth, key)
      setKeysByChainMode((previous) => ({
        ...previous,
        [selectedChainMode]: previous[selectedChainMode].filter((value) => value !== key),
      }))
      if (bundle?.apiKey === key) {
        setBundles((previous) => {
          const next = { ...previous }
          delete next[selectedChainMode]
          return next
        })
        setEmailNotice(null)
        setKeysHelper('Key revoked. Generate a new API key to keep trading.')
      } else {
        setKeysHelper('Key revoked. Refresh to verify remaining credentials.')
      }
    } catch (error) {
      setKeysError(error instanceof Error ? error.message : 'Failed to revoke key.')
    } finally {
      setKeysLoading(false)
    }
  }

  const networkActionPending = isEnsuringNetwork || switchStatus === 'pending'
  const canSign = isConnected && onRequiredChain && !isSigning && !networkActionPending
  const chainStepLabel = selectedChainMode === 'amoy' ? 'Activate Polygon Amoy' : 'Activate Polygon Mainnet'
  const currentStep = !isConnected
    ? {
        number: 1,
        title: 'Connect your wallet',
        description: 'This is a signature-only step: no balance required, no funds moved, no gas fees.',
        actionLabel: isAppKitReady ? 'Connect wallet' : 'Loading...',
        action: handleWalletConnectClick,
        disabled: !isAppKitReady,
      }
    : !onRequiredChain
      ? {
          number: 2,
          title: chainStepLabel,
          description:
            selectedChainMode === 'amoy'
              ? 'We will try to switch automatically and add Amoy if needed.'
              : 'Switch network before signing.',
          actionLabel: networkActionPending
            ? 'Switching network...'
            : selectedChainMode === 'amoy'
              ? 'Activate Amoy'
              : 'Switch network',
          action: handleEnsureRequiredNetwork,
          disabled: networkActionPending,
        }
      : {
          number: 3,
          title: 'Sign to generate API key',
          description: 'One EIP-712 signature, no funds moved.',
          actionLabel: isSigning ? 'Waiting for signature...' : 'Sign now',
          action: handleSignAndGenerate,
          disabled: !canSign,
        }

  const steps = [
    {
      number: 1,
      label: 'Connect wallet',
      done: isConnected || Boolean(bundle),
    },
    {
      number: 2,
      label: chainStepLabel,
      done: onRequiredChain || Boolean(bundle),
    },
    {
      number: 3,
      label: 'Sign message',
      done: Boolean(bundle),
    },
  ]
  const activeStepNumber = bundle ? 3 : currentStep.number
  const completedSteps = steps.filter((step) => step.done && step.number < currentStep.number)

  return (
    <>
      <div className="mx-auto w-full max-w-4xl py-6">
        <section className="w-full auth-shell px-6 py-8 sm:px-10">
          <div className="mb-6 flex justify-center">
            <div className="flex items-center gap-3 text-foreground">
              <SiteLogoIcon
                alt={`${siteName} logo`}
                className="size-[1.7rem]"
                imageClassName="object-contain"
                size={32}
              />
              <span className="text-2xl font-semibold tracking-tight">{siteName}</span>
            </div>
          </div>
          <h1 className="mt-3 text-center text-3xl font-semibold text-foreground sm:text-4xl">
            Generate API credentials
          </h1>

          <div className="mt-6 w-full auth-stepper">
            <div className="grid w-full grid-cols-3">
              {steps.map((step) => (
                <div
                  key={step.number}
                  data-state={step.number === activeStepNumber ? 'active' : step.done ? 'done' : 'idle'}
                  className="auth-step text-center text-xs sm:text-sm"
                >
                  <span className="auth-step-index shrink-0">{step.number}</span>
                  <span className="truncate">{step.label}</span>
                </div>
              ))}
            </div>
          </div>

          {!bundle && (
            <div className="mt-6 space-y-6">
              {completedSteps.map((step) => (
                <div key={step.number} className="flex items-center justify-between auth-subpanel px-6 py-4">
                  <p className="text-sm font-semibold text-foreground">
                    {step.number}. {step.label}
                  </p>
                  <div
                    className={`flex size-12 items-center justify-center rounded-full border border-white/70 bg-white text-background shadow-[0_12px_28px_rgba(0,0,0,0.18)]`}
                  >
                    <CheckIcon className="size-7" strokeWidth={2.4} />
                  </div>
                </div>
              ))}

              <div className="auth-panel p-6">
                <p className="text-xs font-semibold tracking-[0.28em] text-muted-foreground uppercase">
                  Step {currentStep.number}
                </p>
                <h2 className="mt-2 text-2xl font-semibold text-foreground sm:text-3xl">{currentStep.title}</h2>
                <p className="mt-3 text-sm text-muted-foreground sm:text-base">
                  {currentStep.number === 1 ? (
                    <>
                      <a
                        href="https://metamask.io/download"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium auth-link"
                      >
                        MetaMask browser extension
                      </a>{' '}
                      is recommended for the simplest setup. {currentStep.description}
                    </>
                  ) : (
                    currentStep.description
                  )}
                </p>

                {isConnected && account.address && (
                  <p className="mt-4 text-xs text-muted-foreground sm:text-sm">
                    {shortenAddress(account.address)}
                    {' · '}
                    {account.chain?.name ?? `Chain ${account.chainId ?? '-'}`}
                  </p>
                )}

                <div className="mt-7 flex items-center justify-center">
                  <div className="w-full max-w-sm">
                    <button
                      type="button"
                      onClick={currentStep.action}
                      disabled={currentStep.disabled}
                      className={`inline-flex w-full items-center justify-center auth-cta px-6 py-4 text-sm font-semibold tracking-[0.16em] uppercase focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none`}
                    >
                      {currentStep.actionLabel}
                    </button>
                  </div>
                </div>

                {flowError && (
                  <p
                    className={`mx-auto mt-4 max-w-sm auth-feedback auth-feedback-error px-4 py-3 text-sm text-destructive`}
                  >
                    {flowError}
                  </p>
                )}
              </div>

              <div className="auth-subpanel px-5 py-4">
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((previous) => !previous)}
                  className={`flex w-full items-center justify-between text-left text-sm font-medium text-foreground transition hover:text-foreground`}
                >
                  <span>Advanced options</span>
                  <ChevronDownIcon className={`size-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
                </button>

                {advancedOpen && (
                  <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
                    <fieldset className="space-y-2">
                      <legend className="text-sm font-semibold tracking-[0.24em] text-muted-foreground uppercase">
                        Credential network
                      </legend>
                      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Credential network">
                        {[
                          { mode: 'amoy' as const, label: 'Amoy', detail: '80002' },
                          { mode: 'polygon' as const, label: 'Mainnet', detail: '137' },
                        ].map((option) => (
                          <button
                            key={option.mode}
                            type="button"
                            aria-pressed={selectedChainMode === option.mode}
                            onClick={() => handleChainModeChange(option.mode)}
                            className={`flex flex-col items-center justify-center auth-secondary-button px-3 py-2 text-sm font-semibold tracking-[0.14em] uppercase ${selectedChainMode === option.mode ? 'border-primary bg-primary/10 text-primary' : ''} `}
                          >
                            <span>{option.label}</span>
                            <span className="mt-0.5 text-sm font-normal tracking-normal text-muted-foreground normal-case">
                              Polygon · {option.detail}
                            </span>
                          </button>
                        ))}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        API credentials are unique to the selected network. Switching does not revoke credentials from
                        the other network.
                      </p>
                    </fieldset>
                    <label htmlFor="kuest-email" className="block space-y-2">
                      <span className="text-xs font-semibold tracking-[0.24em] text-muted-foreground uppercase">
                        Email address (optional)
                      </span>
                      <input
                        id="kuest-email"
                        type="email"
                        value={emailDraft}
                        onChange={(event) => updateEmailDraft(event.target.value)}
                        placeholder="you@team.com"
                        className="w-full auth-input px-4 py-2.5 text-sm"
                      />
                    </label>
                  </div>
                )}
              </div>
            </div>
          )}

          {flowInfo && <p className="mt-6 auth-feedback px-4 py-3 text-sm text-foreground">{flowInfo}</p>}
          {emailNotice && <p className="mt-4 auth-feedback auth-feedback-success px-4 py-3 text-sm">{emailNotice}</p>}

          {bundle && (
            <div className="mt-6 space-y-6">
              <div className="auth-subpanel px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold tracking-[0.24em] text-muted-foreground uppercase">
                      Credential network
                    </p>
                    <p className="mt-1 text-sm text-foreground">{requiredChainLabel}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleChainModeChange(selectedChainMode === 'amoy' ? 'polygon' : 'amoy')}
                    className="auth-secondary-button px-3 py-1.5 text-xs font-semibold tracking-[0.14em] uppercase"
                  >
                    Generate for {selectedChainMode === 'amoy' ? 'Mainnet' : 'Amoy'}
                  </button>
                </div>
              </div>
              <div
                className={`mx-auto flex size-24 animate-[auth-success-pop_520ms_ease-out] items-center justify-center rounded-full border border-white/70 bg-white text-background shadow-[0_18px_40px_rgba(0,0,0,0.22)]`}
              >
                <CheckIcon className="size-12" strokeWidth={2.2} />
              </div>
              <div className="text-center">
                <h2 className="text-3xl font-semibold text-foreground sm:text-4xl">API key generated successfully</h2>
                <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground sm:text-base">
                  Copy the credentials block below and paste it into your `.env` file.
                </p>
              </div>
              <EnvBlock bundle={bundle} />
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={handleSignAndGenerate}
                  disabled={!canSign}
                  className={`inline-flex items-center justify-center auth-secondary-button px-4 py-2 text-xs font-semibold tracking-[0.2em] uppercase`}
                >
                  Generate another key
                </button>
              </div>
            </div>
          )}

          {isConnected && keys.length > 0 && (
            <div className="mt-6 auth-subpanel px-5 py-4">
              <button
                type="button"
                onClick={() => setShowKeyManagement((previous) => !previous)}
                className={`flex w-full items-center justify-between text-left text-sm font-medium text-foreground transition hover:text-foreground`}
              >
                <span>Key Management</span>
                <ChevronDownIcon className={`size-4 transition-transform ${showKeyManagement ? 'rotate-180' : ''}`} />
              </button>
              {showKeyManagement && (
                <div className="mt-4 border-t border-border/60 pt-4">
                  <KeysPanel
                    keys={keys}
                    onRefresh={handleRefreshKeys}
                    onRevoke={handleRevoke}
                    loading={keysLoading}
                    disabled={keyManagementDisabled}
                    helper={keysHelper}
                    error={keysError}
                  />
                </div>
              )}
            </div>
          )}

          {isConnected && account.address && (
            <div className="mt-6 flex justify-center">
              <button
                type="button"
                onClick={() => disconnect()}
                disabled={disconnectStatus === 'pending'}
                className={`inline-flex items-center justify-center auth-secondary-button px-3 py-1.5 text-xs font-semibold tracking-[0.2em] text-muted-foreground uppercase hover:text-foreground`}
              >
                Disconnect
              </button>
            </div>
          )}
        </section>
      </div>

      <ActionPrompt
        open={connectPromptOpen}
        title="Connecting wallet"
        description="Open your wallet and approve the connection to continue."
        showConnectedWalletIcon={isAppKitReady}
        allowClose
        onClose={() => setConnectPromptRequested(false)}
      />

      <ActionPrompt
        open={isSigning}
        title="Waiting for signature"
        description="Approve the signature in your wallet to generate credentials."
        showConnectedWalletIcon={isAppKitReady}
        allowClose
        onClose={() => {
          setIsSigning(false)
        }}
      />
    </>
  )
}
