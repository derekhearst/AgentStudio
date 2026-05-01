// Shim for SvelteKit's $app/environment when running in plain bun script context.
export const browser = false
export const building = false
export const dev = process.env.NODE_ENV !== 'production'
export const version = 'bench'
