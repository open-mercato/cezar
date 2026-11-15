import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { LockIcon } from 'lucide-react'

import { putSecurityLan } from '@/api/client'
import { useSecurityLan, workspaceQueryKeys } from '@/api/queries'
import type { SecurityLanStatus, SetSecurityLanInput } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'

import { CardNote, FormRow, SettingsCard } from './form-row'

/**
 * Settings → Security: LAN access behind HTTP Basic Auth and TLS (spec `2026-10-20-lan-basic-auth-https`).
 * Global — listener state and auth credentials belong to the host machine.
 */
export function SecuritySection() {
  const query = useSecurityLan()

  if (query.isPending) {
    return (
      <p data-slot="security-loading" className="text-ui text-muted-foreground">
        Loading security settings…
      </p>
    )
  }

  if (query.isError) {
    return (
      <CenteredState
        icon={<LockIcon />}
        tone="danger"
        title="Security settings did not load"
        subtitle={query.error.message}
        heading="h2"
      />
    )
  }

  const status = query.data

  if (!status.available) {
    return (
      <div data-slot="security-section" className="flex w-full flex-col gap-5">
        <SettingsCard id="lan-access" title="LAN access">
          <CardNote slot="security-unavailable">
            LAN access is not available on a hosted cockpit (its reverse proxy owns access).
          </CardNote>
        </SettingsCard>
      </div>
    )
  }

  if (!status.editable) {
    return (
      <div data-slot="security-section" className="flex w-full flex-col gap-5">
        <SettingsCard
          id="lan-access"
          title="LAN access"
          description={
            <span data-slot="security-read-only-notice">LAN access can only be changed from the machine running cezar.</span>
          }
        >
          <SecurityStatusRows status={status} />
        </SettingsCard>
      </div>
    )
  }

  return <SecurityForm status={status} />
}

/** The status row, plus the fingerprint row while the listener is up. */
function SecurityStatusRows({ status }: { status: SecurityLanStatus }) {
  return (
    <>
      <FormRow label="Status" stacked>
        <SecurityStatusLine status={status} />
      </FormRow>
      {status.active && status.certFingerprint ? (
        <FormRow label="Certificate fingerprint (SHA-256)" stacked>
          <SecurityFingerprint fingerprint={status.certFingerprint} />
        </FormRow>
      ) : null}
    </>
  )
}

function CopyButton({ value, label, copied }: { value: string; label: string; copied: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => toast(copied),
          () => toast(`Failed to copy ${label}`, { tone: 'danger' }),
        )
      }}
      className="shrink-0 text-meta text-muted-foreground underline underline-offset-2 hover:text-foreground"
      aria-label={`Copy ${label}`}
    >
      Copy
    </button>
  )
}

function SecurityStatusLine({ status }: { status: SecurityLanStatus }) {
  if (status.active) {
    return (
      <div data-slot="security-status" className="text-ui text-muted-foreground">
        <span className="font-medium text-foreground">Active — </span>
        {status.lanUrls.length > 0 ? (
          status.lanUrls.map((url, idx) => (
            <span key={url} className="inline-flex items-center gap-1.5">
              {idx > 0 ? <span className="text-muted-foreground">, </span> : null}
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-meta text-foreground underline underline-offset-2 hover:text-primary"
              >
                {url}
              </a>
              <CopyButton value={url} label={url} copied="LAN URL copied to clipboard" />
            </span>
          ))
        ) : (
          <span>not listening</span>
        )}
      </div>
    )
  }

  if (status.lanAccess) {
    return (
      <p data-slot="security-status" className="text-ui text-danger">
        {status.error || 'not listening'}
      </p>
    )
  }

  return (
    <p data-slot="security-status" className="text-ui text-muted-foreground">
      Only this machine can reach the cockpit (127.0.0.1).
    </p>
  )
}

function SecurityFingerprint({ fingerprint }: { fingerprint: string }) {
  return (
    <div data-slot="security-fingerprint" className="flex items-center gap-2">
      <code className="rounded bg-muted px-2 py-0.5 font-mono text-meta text-foreground break-all">{fingerprint}</code>
      <CopyButton value={fingerprint} label="fingerprint" copied="Fingerprint copied to clipboard" />
    </div>
  )
}

function SecurityForm({ status }: { status: SecurityLanStatus }) {
  const queryClient = useQueryClient()
  const [saving, setSaving] = React.useState(false)
  const [lanAccess, setLanAccess] = React.useState(status.lanAccess)
  const [username, setUsername] = React.useState(status.username ?? '')
  const [password, setPassword] = React.useState('')
  const [errors, setErrors] = React.useState<{ username?: string; password?: string }>({})

  React.useEffect(() => {
    setLanAccess(status.lanAccess)
    setUsername(status.username ?? '')
  }, [status.lanAccess, status.username])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedUsername = username.trim()
    const passwordTyped = password.length > 0
    const nextErrors: { username?: string; password?: string } = {}

    if (lanAccess && !status.authConfigured) {
      if (!trimmedUsername) {
        nextErrors.username = 'Username is required'
      }
      if (!passwordTyped) {
        nextErrors.password = 'Password is required'
      }
    }

    if (passwordTyped) {
      if (password.length < 8) {
        nextErrors.password = 'Password must be at least 8 characters'
      } else if (password.length > 128) {
        nextErrors.password = 'Password must be at most 128 characters'
      }
      if (!trimmedUsername) {
        nextErrors.username = 'Username is required when setting a password'
      }
    }

    if (trimmedUsername) {
      if (trimmedUsername.includes(':')) {
        nextErrors.username = 'Username must not contain ":"'
      } else if (trimmedUsername.length > 64) {
        nextErrors.username = 'Username must be at most 64 characters'
      }
    }

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      return
    }

    setErrors({})

    const body: SetSecurityLanInput = {
      lanAccess,
    }
    const usernameChanged = trimmedUsername !== (status.username ?? '')
    if (passwordTyped) {
      body.password = password
      body.username = trimmedUsername
    } else if (usernameChanged) {
      body.username = trimmedUsername
    }

    setSaving(true)
    try {
      const result = await putSecurityLan(body)
      queryClient.setQueryData(workspaceQueryKeys.securityLan, result)
      setPassword('')
      setLanAccess(result.lanAccess)
      setUsername(result.username ?? '')
      toast('LAN access settings saved')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save LAN access settings'
      toast(message, { tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  return (
    // One explicit "Save & apply": the switch, username and password are applied together, since
    // turning LAN access on without credentials would be refused.
    <form data-slot="security-section" onSubmit={handleSubmit} className="flex w-full flex-col gap-5">
      <SettingsCard
        id="lan-access"
        title="LAN access"
        description="Reach this cockpit from other devices on your network, over HTTPS with a password."
      >
        <FormRow label="Allow LAN access" htmlFor="lan-access-switch">
          <Switch
            id="lan-access-switch"
            data-slot="security-lan-switch"
            aria-label="Allow LAN access"
            checked={lanAccess}
            disabled={saving}
            onCheckedChange={setLanAccess}
          />
        </FormRow>
        <SecurityStatusRows status={status} />
        {lanAccess ? (
          <CardNote slot="security-cert-notice">
            The cockpit uses a self-signed certificate; the first visit from another device shows a browser warning —
            check the fingerprint, then proceed. Credentials are asked once per browser.
          </CardNote>
        ) : null}
      </SettingsCard>

      <SettingsCard id="lan-sign-in" title="Sign-in" description="The username and password other devices are asked for.">
        <FormRow label="Username" htmlFor="security-username" stacked>
          <Input
            id="security-username"
            data-slot="security-username"
            type="text"
            autoComplete="username"
            className="h-8"
            value={username}
            disabled={saving}
            onChange={(e) => {
              setUsername(e.target.value)
              if (errors.username) setErrors((prev) => ({ ...prev, username: undefined }))
            }}
            aria-invalid={Boolean(errors.username)}
          />
          {errors.username ? (
            <p data-slot="security-username-error" className="text-meta text-danger">
              {errors.username}
            </p>
          ) : null}
        </FormRow>
        <FormRow label="Password" htmlFor="security-password" stacked>
          <Input
            id="security-password"
            data-slot="security-password"
            type="password"
            autoComplete="new-password"
            className="h-8"
            placeholder={status.authConfigured ? 'unchanged' : undefined}
            value={password}
            disabled={saving}
            onChange={(e) => {
              setPassword(e.target.value)
              if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }))
            }}
            aria-invalid={Boolean(errors.password)}
          />
          {errors.password ? (
            <p data-slot="security-password-error" className="text-meta text-danger">
              {errors.password}
            </p>
          ) : null}
        </FormRow>
        <div className="flex justify-end px-4 py-3">
          <Button type="submit" data-action="security-save" disabled={saving}>
            {saving ? 'Saving…' : 'Save & apply'}
          </Button>
        </div>
      </SettingsCard>
    </form>
  )
}
