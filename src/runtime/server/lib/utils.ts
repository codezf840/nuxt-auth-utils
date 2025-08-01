import { type H3Event, deleteCookie, getCookie, setCookie } from 'h3'
import { getRequestURL } from 'h3'
import { FetchError } from 'ofetch'
import { snakeCase, upperFirst } from 'scule'
import * as jose from 'jose'
import { subtle, getRandomValues } from 'uncrypto'
import type { OAuthProvider, OnError } from '#auth-utils'
import { createError } from '#imports'

export function getOAuthRedirectURL(event: H3Event): string {
  const requestURL = getRequestURL(event)

  return `${requestURL.protocol}//${requestURL.host}${requestURL.pathname}`
}

/**
 * Request an access token body.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.3
 */
export interface RequestAccessTokenBody {
  grant_type: 'authorization_code'
  code: string
  redirect_uri: string
  client_id: string
  client_secret?: string
  [key: string]: string | undefined
}

export interface RequestAccessTokenOptions {
  body?: RequestAccessTokenBody
  params?: Record<string, string | undefined>
  headers?: Record<string, string>
}

/**
 * Request an access token from the OAuth provider.
 *
 * When an error occurs, only the error data is returned.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.3
 */
// TODO: waiting for https://github.com/atinux/nuxt-auth-utils/pull/140
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function requestAccessToken(url: string, options: RequestAccessTokenOptions): Promise<any> {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...options.headers,
  }

  // Encode the body as a URLSearchParams if the content type is 'application/x-www-form-urlencoded'.
  const body = headers['Content-Type'] === 'application/x-www-form-urlencoded'
    ? new URLSearchParams(options.body as unknown as Record<string, string> || options.params || {},
      ).toString()
    : options.body

  return $fetch(url, {
    method: 'POST',
    headers,
    body,
  }).catch((error) => {
    /**
     * For a better error handling, only unauthorized errors are intercepted, and other errors are re-thrown.
     */
    if (error instanceof FetchError && error.status === 401) {
      return error.data
    }
    throw error
  })
}

/**
 * Handle OAuth access token error response
 *
 * @see https://datatracker.ietf.org/doc/html/rfc6749#section-5.2
 */
// TODO: waiting for https://github.com/atinux/nuxt-auth-utils/pull/140
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handleAccessTokenErrorResponse(event: H3Event, oauthProvider: OAuthProvider, oauthError: any, onError?: OnError) {
  const message = `${upperFirst(oauthProvider)} login failed: ${oauthError.error_description || oauthError.error || 'Unknown error'}`

  const error = createError({
    statusCode: 401,
    message,
    data: oauthError,
  })

  if (!onError) throw error
  return onError(event, error)
}

export function handleMissingConfiguration(event: H3Event, provider: OAuthProvider, missingKeys: string[], onError?: OnError) {
  const environmentVariables = missingKeys.map(key => `NUXT_OAUTH_${provider.toUpperCase()}_${snakeCase(key).toUpperCase()}`)

  const error = createError({
    statusCode: 500,
    message: `Missing ${environmentVariables.join(' or ')} env ${missingKeys.length > 1 ? 'variables' : 'variable'}.`,
  })

  if (!onError) throw error
  return onError(event, error)
}

export function handleInvalidState(event: H3Event, provider: OAuthProvider, onError?: OnError) {
  const message = `${upperFirst(provider)} login failed: state mismatch`

  const error = createError({
    statusCode: 500,
    message,
  })

  if (!onError) throw error
  return onError(event, error)
}

/**
 * JWT signing using jose
 *
 * @see https://github.com/panva/jose
 */

interface JWTSignOptions {
  privateKey: string
  keyId: string
  teamId?: string
  clientId?: string
  algorithm?: 'ES256' | 'RS256'
  expiresIn?: string // e.g., '5m', '1h'
}

export async function signJwt<T extends Record<string, unknown>>(
  payload: T,
  options: JWTSignOptions,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const privateKey = await jose.importPKCS8(
    options.privateKey.replace(/\\n/g, '\n'),
    options.algorithm || 'ES256',
  )

  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: options.algorithm || 'ES256', kid: options.keyId })
    .setIssuedAt(now)
    .setExpirationTime(options.expiresIn || '5m')
    .sign(privateKey)
}

/**
 * Verify a JWT token using jose - will throw error if invalid
 *
 * @see https://github.com/panva/jose
 */
interface JWTVerifyOptions {
  publicJwkUrl: string
  audience: string
  issuer: string
}

export async function verifyJwt<T>(
  token: string,
  options: JWTVerifyOptions,
): Promise<T> {
  const JWKS = jose.createRemoteJWKSet(new URL(options.publicJwkUrl))

  const { payload } = await jose.jwtVerify(token, JWKS, {
    audience: options.audience,
    issuer: options.issuer,
  })

  return payload as T
}

function encodeBase64Url(input: Uint8Array): string {
  return btoa(String.fromCharCode.apply(null, input as unknown as number[]))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function getRandomBytes(size: number = 32) {
  return getRandomValues(new Uint8Array(size))
}

export async function handlePkceVerifier(event: H3Event) {
  let verifier = getCookie(event, 'nuxt-auth-pkce')
  if (verifier) {
    deleteCookie(event, 'nuxt-auth-pkce')
    return { code_verifier: verifier }
  }

  // Create new verifier
  verifier = encodeBase64Url(getRandomBytes())
  setCookie(event, 'nuxt-auth-pkce', verifier)

  // Get pkce
  const encodedPkce = new TextEncoder().encode(verifier)
  const pkceHash = await subtle.digest('SHA-256', encodedPkce)
  const pkce = encodeBase64Url(new Uint8Array(pkceHash))

  return {
    code_verifier: verifier,
    code_challenge: pkce,
    code_challenge_method: 'S256',
  }
}

export async function handleState(event: H3Event) {
  let state = getCookie(event, 'nuxt-auth-state')
  if (state) {
    deleteCookie(event, 'nuxt-auth-state')
    return state
  }

  state = encodeBase64Url(getRandomBytes(8))
  setCookie(event, 'nuxt-auth-state', state)
  return state
}
