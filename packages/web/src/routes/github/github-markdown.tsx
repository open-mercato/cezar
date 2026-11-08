import { useQuery } from '@tanstack/react-query'
import type { ComponentProps } from 'react'
import { isGithubAttachmentUrl, queryScope } from '@open-mercato/cezar-api-client'
import { useProjectScope } from '@/api/project-scope-context'
import { getGithubAsset } from '@/api/client'
import { Markdown } from '../task-thread/markdown'

class AssetBusy extends Error {}

function GithubImage({ src, alt, srcSet: _srcSet, ...props }: ComponentProps<'img'>) {
  useProjectScope()
  const scope = queryScope()
  const source = typeof src === 'string' ? src : ''
  const attachment = isGithubAttachmentUrl(source)
  const image = useQuery({
    queryKey: ['github-asset', scope, source],
    queryFn: async ({ signal }) => {
      const result = await getGithubAsset(source, { signal }, scope)
      if (!result.available && result.retryable) throw new AssetBusy()
      return result
    },
    enabled: attachment,
    staleTime: 5 * 60_000,
    gcTime: 60_000,
    // A busy loader is transient; bound retries to one download deadline.
    retry: (count, error) => error instanceof AssetBusy && count < 16,
    retryDelay: 1000,
  })
  if (!attachment) return <img {...props} src={src} alt={alt} />
  if (!image.data?.available) return <span role="img" aria-label={alt || 'Image'}>{alt || 'Image'}{image.isPending ? ' (loading…)' : ' (unavailable)'}</span>
  return <img {...props} src={image.data.dataUrl} alt={alt} />
}

/** Replace only images; keep the shared sanitizer and local-file/link safety policy. */
export function GithubMarkdown({ children }: { children: string }) {
  return <Markdown imageComponent={GithubImage}>{children}</Markdown>
}
