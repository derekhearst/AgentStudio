/**
 * An awaitable replacement for `window.confirm()`.
 *
 * Thirteen call sites used the native dialog. It is unstyled, it cannot be themed, it
 * renders inconsistently in a PWA shell, and in a Tauri webview it is the host OS's
 * dialog rather than the app's. A component per call site would have meant thirteen
 * copies of `let pendingDelete = $state(...)` plus thirteen pieces of markup, so this is
 * a singleton with a promise instead: the call sites keep the shape they already had.
 *
 *     if (!(await confirmDialog({ title: 'Delete?', message: '…' }))) return
 *
 * The host component is mounted once in the root layout. Module-level rune state is the
 * established pattern here — see `chat-console/mobile-drawer-state.svelte.ts`.
 */

export type ConfirmVariant = 'primary' | 'danger' | 'warning'

export type ConfirmOptions = {
	title: string
	message: string
	confirmLabel?: string
	cancelLabel?: string
	/** `danger` turns the confirm button red, for anything that destroys data. */
	variant?: ConfirmVariant
}

type PendingConfirm = Required<ConfirmOptions> & { resolve: (confirmed: boolean) => void }

export const confirmState = $state<{ pending: PendingConfirm | null }>({ pending: null })

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
	// Never resolves on the server. Every caller is an event handler, so this only runs in
	// the browser; returning `false` outright would silently cancel a real user action if
	// that ever stopped being true.
	return new Promise<boolean>((resolve) => {
		// A second request while one is open would otherwise strand the first promise
		// forever. Treat being interrupted as "not confirmed" — the safe answer.
		confirmState.pending?.resolve(false)

		confirmState.pending = {
			title: options.title,
			message: options.message,
			confirmLabel: options.confirmLabel ?? 'Confirm',
			cancelLabel: options.cancelLabel ?? 'Cancel',
			variant: options.variant ?? 'primary',
			resolve,
		}
	})
}

/** Called by the host component when the operator answers, or dismisses. */
export function settleConfirm(confirmed: boolean): void {
	const pending = confirmState.pending
	if (!pending) return
	confirmState.pending = null
	pending.resolve(confirmed)
}
