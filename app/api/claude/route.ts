import { NextRequest, NextResponse } from 'next/server'

function safeJsonParse(raw: string): unknown {
  const t = raw.trim()
  if (!t) return null
  try {
    return JSON.parse(t) as unknown
  } catch {
    return { parseError: true, rawLength: raw.length }
  }
}

export async function POST(req: NextRequest) {
  const key = process.env.ANTHROPIC_API_KEY?.trim()

  if (!key) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not set. Add it in Vercel Project Settings → Environment Variables.' },
      { status: 500 },
    )
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  const rawText = await response.text()
  const data = safeJsonParse(rawText)

  if (data === null) {
    return NextResponse.json(
      {
        error: 'Empty response from Anthropic',
        upstreamStatus: response.status,
      },
      { status: response.status || 502 },
    )
  }

  if (!response.ok) {
    return NextResponse.json(data, { status: response.status })
  }

  return NextResponse.json(data)
}
