import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

import { useOptionalTheme } from "@/components/theme-provider"

/* shadcn/ui Sonner, wired to this app's own theme provider instead of `next-themes`, and to the
 * cockpit's tokens: the everyday toast is the inverse `contrast` surface, a failure is `danger`
 * (sonner's "rich colors" slot, which only `error` uses here). */
const Toaster = ({ style, ...props }: ToasterProps) => {
  // `system` outside a ThemeProvider (a bare unit test) — every colour below is a token that
  // already follows the theme, so sonner's own light/dark palette is never what paints.
  const theme = useOptionalTheme()?.theme ?? "system"

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      richColors
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--contrast)",
          "--normal-text": "var(--contrast-foreground)",
          "--normal-border": "transparent",
          "--error-bg": "var(--danger)",
          "--error-text": "var(--danger-foreground)",
          "--error-border": "transparent",
          "--border-radius": "var(--radius)",
          ...style,
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
