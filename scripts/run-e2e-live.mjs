import { spawn } from 'node:child_process'

const command = 'bunx playwright test --grep @live --workers=1'

const child = spawn(command, {
	stdio: 'inherit',
	shell: true,
	env: {
		...process.env,
		PLAYWRIGHT_LIVE: '1',
	},
})

child.on('exit', (code) => {
	process.exit(code ?? 1)
})
