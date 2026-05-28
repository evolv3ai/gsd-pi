/**
 * Shared GSD-Pi block-letter ASCII logo.
 *
 * Lives under src/resources so extension builds can import it without
 * crossing tsconfig.resources rootDir. Re-exported from src/logo.ts for
 * loader, onboarding, installer, and welcome screen.
 */

/** Display name for product branding in banners and prompts. */
export const GSD_PI_BRAND = 'GSD-Pi'

/** Raw GSD-Pi wordmark lines — no ANSI codes, no leading newline. */
export const GSD_PI_LOGO: readonly string[] = [
  '  ██████╗ ███████╗██████╗  ─  ██████╗ ██╗',
  ' ██╔════╝ ██╔════╝██╔══██╗    ██╔══██╗██║',
  ' ██║  ███╗███████╗██║  ██║    ██████╔╝██║',
  ' ██║   ██║╚════██║██║  ██║    ██╔═══╝ ██║',
  ' ╚██████╔╝███████║██████╔╝    ██║     ██║',
  '  ╚═════╝ ╚══════╝╚═════╝     ╚═╝     ╚═╝',
]
