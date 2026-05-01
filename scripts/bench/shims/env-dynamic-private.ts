// Shim for SvelteKit's $env/dynamic/private when running in plain bun script context.
// Loads .env via Bun's automatic dotenv handling and exposes process.env.
export const env = process.env as Record<string, string | undefined>
