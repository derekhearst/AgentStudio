/**
 * Whether `AUTH_DEV_BYPASS` is in force: requests without a session attach to the owner.
 *
 * Three conditions, and the first is the one that matters. `devBuild` is SvelteKit's `dev`
 * from `$app/environment`, a constant the bundler fixes at build time — `false` in anything
 * `bun run build` produces. The check used to be `NODE_ENV !== 'production'` alone, read at
 * runtime, and Vite does not inline `process.env` into a server build: the production bundle
 * kept the check, and only the Dockerfile's `ENV NODE_ENV=production` held it shut. Running
 * the build any other way (`bun build/index.js` from a checkout, systemd, pm2) with the
 * developer's `.env` — which Bun loads automatically — attached every anonymous request on
 * the network to the owner account.
 *
 * `NODE_ENV` stays as a second condition so a dev server started with it set also refuses.
 *
 * Pure so the rule can be tested; `hooks.server.ts` supplies `dev` and `process.env`.
 */
export function authDevBypassEnabled(input: {
	devBuild: boolean
	env: Record<string, string | undefined>
}): boolean {
	return input.devBuild && input.env.NODE_ENV !== 'production' && input.env.AUTH_DEV_BYPASS === '1'
}
