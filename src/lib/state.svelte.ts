type PanelState = {
	open: boolean
	toggle: () => void
}

function createPanelState(): PanelState {
	let open = $state(false)

	return {
		get open() {
			return open
		},
		set open(v: boolean) {
			open = v
		},
		toggle() {
			open = !open
		},
	}
}

export const dreamPanel = createPanelState()
export const skillsPanel = createPanelState()
