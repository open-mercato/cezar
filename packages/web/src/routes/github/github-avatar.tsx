import { useState } from 'react'

/** A 16 px comment avatar. Falls back to a letter block when no URL is known or the image fails to
 *  load (private-repo attachments, deleted avatars) — never a broken-image glyph. */
export function GithubAvatar({ url, login }: { url?: string; login: string }) {
  const [failed, setFailed] = useState(false)
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        width={16}
        height={16}
        loading="lazy"
        onError={() => setFailed(true)}
        data-slot="gh-avatar"
        className="size-4 shrink-0 rounded-full"
      />
    )
  }
  return (
    <span
      data-slot="gh-avatar-fallback"
      aria-hidden="true"
      className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-semibold text-muted-foreground uppercase"
    >
      {login.slice(0, 1) || '?'}
    </span>
  )
}
