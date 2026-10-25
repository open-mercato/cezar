import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { LockIcon } from 'lucide-react'

import { putSecurityLan } from '@/api/client'
import { useSecurityLan, workspaceQueryKeys } from '@/api/queries'
import type { SecurityLanStatus, SetSecurityLanInput } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'

/**
 * Settings → Security: LAN access behind HTTP Basic Auth and TLS (spec `2026-10-20-lan-basic-auth-https`).
 * Global — listener state and auth credentials belong to the host machine.
 */
export function SecuritySection() {
  const query = useSecurityLan()

  if (query.isPending) {
    return (
      <p data-slot="security-loading" className="p-4 text-[13px] text-muted-foreground md:p-6">
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
      <div
        data-slot="security-section"
        className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
      >
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-foreground">LAN access</h2>
          <p data-slot="security-unavailable" className="text-[13px] text-muted-foreground">
            LAN access is not available on a hosted cockpit (its reverse proxy owns access).
          </p>
        </section>
      </div>
    )
  }

  if (!status.editable) {
    return (
      <div
        data-slot="security-section"
        className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
      >
        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">LAN access</h2>
            <p data-slot="security-read-only-notice" className="text-[13px] text-muted-foreground">
              LAN access can only be changed from the machine running cezar.
            </p>
          </div>

          <SecurityStatusLine status={status} />
          {status.active && status.certFingerprint ? (
            <SecurityFingerprint fingerprint={status.certFingerprint} />
          ) : null}
        </section>
      </div>
    )
  }

  return <SecurityForm status={status} />
}

function SecurityStatusLine({ status }: { status: SecurityLanStatus }) {
  if (status.active) {
    return (
      <div data-slot="security-status" className="text-[13px] text-muted-foreground">
        <span className="font-medium text-foreground">Active — </span>
        {status.lanUrls.length > 0 ? (
          status.lanUrls.map((url, idx) => (
            <span key={url} className="inline-flex items-center gap-1.5">
              {idx > 0 ? <span className="text-muted-foreground">, </span> : null}
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[12px] text-foreground underline underline-offset-2 hover:text-primary"
              >
                {url}
              </a>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(url).then(
                    () => toast('LAN URL copied to clipboard'),
                    () => toast('Failed to copy URL', { tone: 'danger' }),
                  )
                }}
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                title="Copy URL"
                aria-label={`Copy ${url}`}
              >
                Copy
              </button>
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
      <p data-slot="security-status" className="text-[13px] text-destructive">
        {status.error || 'not listening'}
      </p>
    )
  }

  return (
    <p data-slot="security-status" className="text-[13px] text-muted-foreground">
      Only this machine can reach the cockpit (127.0.0.1).
    </p>
  )
}

function SecurityFingerprint({ fingerprint }: { fingerprint: string }) {
  return (
    <div data-slot="security-fingerprint" className="flex flex-col gap-1 text-[13px] text-muted-foreground">
      <span className="font-medium text-foreground">Certificate fingerprint (SHA-256)</span>
      <div className="flex items-center gap-2">
        <code className="rounded bg-muted px-2 py-0.5 font-mono text-[12px] text-foreground break-all">
          {fingerprint}
        </code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(fingerprint).then(
              () => toast('Fingerprint copied to clipboard'),
              () => toast('Failed to copy fingerprint', { tone: 'danger' }),
            )
          }}
          className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          title="Copy fingerprint"
          aria-label="Copy fingerprint"
        >
          Copy
        </button>
      </div>
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
    <div
      data-slot="security-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <section className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              <label htmlFor="lan-access-switch">Allow LAN access</label>
            </h2>
            <p className="text-[13px] text-muted-foreground">
              Reach this cockpit from other devices on your network, over HTTPS with a password.
            </p>
          </div>
          <Switch
            id="lan-access-switch"
            data-slot="security-lan-switch"
            aria-label="Allow LAN access"
            checked={lanAccess}
            disabled={saving}
            onCheckedChange={setLanAccess}
          />
        </div>

        <SecurityStatusLine status={status} />
        {status.active && status.certFingerprint ? (
          <SecurityFingerprint fingerprint={status.certFingerprint} />
        ) : null}

        {lanAccess ? (
          <p data-slot="security-cert-notice" className="text-[13px] text-muted-foreground">
            The cockpit uses a self-signed certificate; the first visit from another device shows a browser warning — check the fingerprint, then proceed. Credentials are asked once per browser.
          </p>
        ) : null}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="security-username">Username</Label>
            <Input
              id="security-username"
              data-slot="security-username"
              type="text"
              autoComplete="username"
              value={username}
              disabled={saving}
              onChange={(e) => {
                setUsername(e.target.value)
                if (errors.username) setErrors((prev) => ({ ...prev, username: undefined }))
              }}
              aria-invalid={Boolean(errors.username)}
            />
            {errors.username ? (
              <p data-slot="security-username-error" className="text-xs text-destructive">
                {errors.username}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="security-password">Password</Label>
            <Input
              id="security-password"
              data-slot="security-password"
              type="password"
              autoComplete="new-password"
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
              <p data-slot="security-password-error" className="text-xs text-destructive">
                {errors.password}
              </p>
            ) : null}
          </div>

          <div className="pt-1">
            <Button
              type="submit"
              data-action="security-save"
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save & apply'}
            </Button>
          </div>
        </form>
      </section>
    </div>
  )
}
