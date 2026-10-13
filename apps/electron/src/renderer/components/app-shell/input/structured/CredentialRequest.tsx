import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Key, User, Lock, Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { CredentialRequest as CredentialRequestType, CredentialResponse } from '../../../../../shared/types'
import { validateBasicAuthCredentials, getPasswordValue, getPasswordLabel, getPasswordPlaceholder } from '@/utils/auth-validation'
import {
  DECISION_ACTION,
  DecisionActions,
  DecisionBody,
  DecisionCard,
  DecisionDetails,
  DecisionFoot,
  DecisionHeader,
} from './DecisionCard'

/** Field chrome shared by every credential input: icon inset, reveal toggle on the right. */
const FIELD_LABEL = 'text-label-sm text-secondary'
const FIELD_ICON = 'pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary'
const REVEAL_BUTTON = 'absolute right-3 top-1/2 -translate-y-1/2 text-tertiary transition-colors hover:text-foreground hover:duration-instant'

interface CredentialRequestProps {
  request: CredentialRequestType
  onResponse: (response: CredentialResponse) => void
  /** When true, the composer slot (InputContainer) draws the card material and ring */
  unstyled?: boolean
}

/**
 * CredentialRequest - Secure input UI for authentication credentials
 *
 * Supports multiple auth modes:
 * - bearer: Single token field (Bearer Token, API Key)
 * - basic: Username + Password fields
 * - header: API Key with custom header name shown
 * - query: API Key for query parameter auth
 */
export function CredentialRequest({ request, onResponse, unstyled = false }: CredentialRequestProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  // Multi-header state: { "DD-API-KEY": "", "DD-APPLICATION-KEY": "" }
  const [headerValues, setHeaderValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    if (request.headerNames) {
      for (const name of request.headerNames) {
        initial[name] = ''
      }
    }
    return initial
  })

  const isBasicAuth = request.mode === 'basic'
  const isMultiHeader = request.mode === 'multi-header'
  const passwordRequired = request.passwordRequired ?? true  // default true for backward compatibility

  // Validation logic
  const isValid = isBasicAuth
    ? validateBasicAuthCredentials(username, password, passwordRequired)
    : isMultiHeader
    ? request.headerNames?.every(name => headerValues[name]?.trim().length > 0) ?? false
    : value.trim().length > 0

  const handleSubmit = useCallback(() => {
    if (!isValid) return

    if (isBasicAuth) {
      onResponse({
        type: 'credential',
        username: username.trim(),
        password: getPasswordValue(password, passwordRequired),
        cancelled: false
      })
    } else if (isMultiHeader) {
      // Trim all header values
      const trimmedHeaders: Record<string, string> = {}
      for (const [key, val] of Object.entries(headerValues)) {
        trimmedHeaders[key] = val.trim()
      }
      onResponse({
        type: 'credential',
        headers: trimmedHeaders,
        cancelled: false
      })
    } else {
      onResponse({
        type: 'credential',
        value: value.trim(),
        cancelled: false
      })
    }
  }, [isBasicAuth, isMultiHeader, username, password, value, headerValues, isValid, onResponse, passwordRequired])

  const handleCancel = useCallback(() => {
    onResponse({ type: 'credential', cancelled: true })
  }, [onResponse])

  const handleFormSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    handleSubmit()
  }, [handleSubmit])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isValid) {
      handleSubmit()
    } else if (e.key === 'Escape') {
      handleCancel()
    }
  }, [isValid, handleSubmit, handleCancel])

  // Get field labels
  const credentialLabel = request.labels?.credential ||
    (request.mode === 'bearer' ? 'Bearer Token' : 'API Key')
  const usernameLabel = request.labels?.username || 'Username'
  const basePasswordLabel = request.labels?.password || 'Password'
  const passwordLabel = getPasswordLabel(basePasswordLabel, passwordRequired)
  const passwordPlaceholder = getPasswordPlaceholder(basePasswordLabel, passwordRequired)

  return (
    <DecisionCard tone="info" standalone={!unstyled}>
      {/* Form wraps the entire card so password managers (1Password) can detect fields.
          action points to the source URL for domain-based credential matching. */}
      <form
        onSubmit={handleFormSubmit}
        action={request.sourceUrl || undefined}
        method="post"
        className="flex flex-col flex-1 min-h-0"
      >
        {/* Content */}
        <DecisionBody>
          {/* Header */}
          <DecisionHeader
            tone="info"
            icon={<Key />}
            title={t('chat.credentials.authenticationRequired')}
            aside={`(${request.sourceName})`}
          />
          <DecisionDetails>
            {request.description && (
              <p className="text-label text-secondary">{request.description}</p>
            )}

          {/* Input fields */}
          <div className="mt-3 space-y-3">
            {isBasicAuth ? (
              <>
                {/* Username field */}
                <div className="space-y-1.5">
                  <Label htmlFor="credential-username" className={FIELD_LABEL}>
                    {usernameLabel}
                  </Label>
                  <div className="relative">
                    <User className={FIELD_ICON} />
                    <Input
                      id="credential-username"
                      name="username"
                      autoComplete="username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      onKeyDown={handleKeyDown}
                      className="pl-9"
                      placeholder={`Enter ${usernameLabel.toLowerCase()}`}
                      autoFocus
                    />
                  </div>
                </div>
                {/* Password field */}
                <div className="space-y-1.5">
                  <Label htmlFor="credential-password" className={FIELD_LABEL}>
                    {passwordLabel}
                  </Label>
                  <div className="relative">
                    <Lock className={FIELD_ICON} />
                    <Input
                      id="credential-password"
                      name="password"
                      autoComplete="current-password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={handleKeyDown}
                      className="pl-9 pr-9"
                      placeholder={passwordPlaceholder}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className={REVEAL_BUTTON}
                      aria-label={showPassword ? t('chat.credentials.hideValue') : t('chat.credentials.showValue')}
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </>
            ) : isMultiHeader && request.headerNames ? (
              /* Multi-header fields (e.g., Datadog DD-API-KEY + DD-APPLICATION-KEY) */
              <>
                {request.headerNames.map((headerName, index) => (
                  <div key={headerName} className="space-y-1.5">
                    <Label htmlFor={`credential-header-${index}`} className={FIELD_LABEL}>
                      {headerName}
                    </Label>
                    <div className="relative">
                      <Key className={FIELD_ICON} />
                      <Input
                        id={`credential-header-${index}`}
                        name={headerName}
                        autoComplete="off"
                        type={showPassword ? 'text' : 'password'}
                        value={headerValues[headerName] || ''}
                        onChange={(e) => setHeaderValues(prev => ({
                          ...prev,
                          [headerName]: e.target.value
                        }))}
                        onKeyDown={handleKeyDown}
                        className="pl-9 pr-9"
                        placeholder={`Enter ${headerName}`}
                        autoFocus={index === 0}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className={REVEAL_BUTTON}
                        aria-label={showPassword ? t('chat.credentials.hideValue') : t('chat.credentials.showValue')}
                        tabIndex={-1}
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                ))}
              </>
            ) : (
              /* Single credential field (API key, bearer token) */
              <div className="space-y-1.5">
                <Label htmlFor="credential-value" className={FIELD_LABEL}>
                  {credentialLabel}
                  {request.mode === 'header' && request.headerName && (
                    <span className="ml-1 font-normal text-tertiary">
                      ({request.headerName})
                    </span>
                  )}
                </Label>
                <div className="relative">
                  <Key className={FIELD_ICON} />
                  <Input
                    id="credential-value"
                    name="credential"
                    autoComplete="current-password"
                    type={showPassword ? 'text' : 'password'}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className="pl-9 pr-9"
                    placeholder={`Enter ${credentialLabel.toLowerCase()}`}
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className={REVEAL_BUTTON}
                    aria-label={showPassword ? t('chat.credentials.hideValue') : t('chat.credentials.showValue')}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            )}

            {/* Hint */}
            {request.hint && (
              <p className="text-label-sm text-tertiary">
                {request.hint}
              </p>
            )}
          </div>
          </DecisionDetails>
        </DecisionBody>

        {/* Action buttons */}
        <DecisionActions>
          <Button
            type="submit"
            size="lg"
            variant="primary"
            className={DECISION_ACTION}
            disabled={!isValid}
          >
            Save
          </Button>
          <Button
            type="button"
            size="lg"
            variant="ghost"
            className={DECISION_ACTION}
            onClick={handleCancel}
          >
            Cancel
          </Button>
        </DecisionActions>

        <DecisionFoot icon={<ShieldCheck />}>
          Credentials are encrypted at rest
        </DecisionFoot>
      </form>
    </DecisionCard>
  )
}
