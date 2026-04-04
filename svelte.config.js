import adapter from '@sveltejs/adapter-node'
import { relative, sep } from 'node:path'

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		experimental: {
			async: true,
		},
	},
	kit: {
		adapter: adapter(),
		experimental: {
			remoteFunctions: true,
		},
	},
}

export default config
