/**
 * Tracks the unit of work a polling loop has in flight, so a shutdown can wait for it to
 * finish instead of killing it mid-way. Pure — the job worker uses it, and a spec pins the
 * waiting behaviour without a database.
 */
export type InFlightTracker = {
	/** Mark `run` as the work in flight until it settles. Returns `run` unchanged. */
	track<T>(run: Promise<T>): Promise<T>
	/**
	 * Resolve true once nothing is in flight, or false if something still is after
	 * `timeoutMs`. With `timeoutMs <= 0` it does not wait: true only if already idle. Work
	 * that rejects counts as finished.
	 */
	drain(timeoutMs: number): Promise<boolean>
}

export function createInFlightTracker(): InFlightTracker {
	let current: Promise<unknown> | null = null

	return {
		track(run) {
			current = run
			const clear = () => {
				if (current === run) current = null
			}
			run.then(clear, clear)
			return run
		},

		async drain(timeoutMs) {
			const running = current
			if (!running) return true
			if (timeoutMs <= 0) return false
			let timer: ReturnType<typeof setTimeout> | undefined
			const deadline = new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs)
			})
			const settled = running.then(
				() => true,
				() => true,
			)
			const drained = await Promise.race([settled, deadline])
			clearTimeout(timer)
			return drained
		},
	}
}
