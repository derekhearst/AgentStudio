import { env } from '$env/dynamic/private'
import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'

const TRANSCRIPTION_MODEL = 'google/gemini-2.5-flash'

export const POST: RequestHandler = async ({ request }) => {
	if (!env.OPENROUTER_API_KEY) {
		throw error(500, 'OPENROUTER_API_KEY is not set')
	}

	const formData = await request.formData()
	const audioFile = formData.get('audio')

	if (!(audioFile instanceof File)) {
		throw error(400, 'Missing audio file')
	}

	if (audioFile.size > 25 * 1024 * 1024) {
		throw error(400, 'Audio file too large (max 25MB)')
	}

	const buffer = await audioFile.arrayBuffer()
	const base64 = Buffer.from(buffer).toString('base64')
	const mimeType = audioFile.type || 'audio/webm'

	const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: TRANSCRIPTION_MODEL,
			messages: [
				{
					role: 'user',
					content: [
						{
							type: 'text',
							text: 'Transcribe this audio exactly as spoken. Output ONLY the transcription, nothing else. No quotes, no labels, no explanations.',
						},
						{
							type: 'input_audio',
							input_audio: {
								data: base64,
								format: mimeType.includes('wav') ? 'wav' : mimeType.includes('mp4') ? 'mp4' : 'webm',
							},
						},
					],
				},
			],
			temperature: 0,
		}),
	})

	if (!response.ok) {
		const text = await response.text()
		console.error('Transcription API error:', response.status, text)
		throw error(502, 'Transcription failed')
	}

	const result = await response.json()
	const transcript = result.choices?.[0]?.message?.content?.trim() ?? ''

	return json({ transcript })
}
