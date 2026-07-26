import { PaperclipIcon } from 'lucide-react'
import { useRef } from 'react'

import { Button } from '@/components/ui/button'
import { MAX_IMAGES } from './composer-images'

/** The paperclip + its hidden multi-file input (legacy `#msg-attach`). At the image cap it
 *  disables with the reason in its title — earlier than the picker-then-toast round trip. */
export function AttachButton({
  disabled,
  atCap,
  onFiles,
}: {
  disabled: boolean
  atCap: boolean
  onFiles: (files: readonly File[]) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-round"
        aria-label="Attach images"
        title={atCap ? `Image limit reached (${MAX_IMAGES})` : 'Attach an image (or paste a screenshot)'}
        disabled={disabled || atCap}
        className="text-muted-foreground"
        onClick={() => inputRef.current?.click()}
      >
        <PaperclipIcon aria-hidden="true" className="size-4" />
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />
    </>
  )
}
