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

  // #region agent log
  try {
    const b = body as {
      messages?: Array<{ content?: Array<{ type?: string; source?: { media_type?: string; data?: string } }> }>
    }
    const img = b.messages?.[0]?.content?.find(c => c.type === 'image')?.source
    fetch('http://127.0.0.1:7388/ingest/460dcf57-734f-43ed-8370-64f28b2ba6fb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '730a3c' },
      body: JSON.stringify({
        sessionId: '730a3c',
        location: 'route.ts:POST',
        message: 'proxy request',
        data: {
          b64Len: img?.data?.length ?? 0,
          mediaType: img?.media_type ?? '(none)',
          hasApiKey: Boolean(key),
        },
        hypothesisId: 'A',
        timestamp: Date.now(),
        runId: 'post-fix',
      }),
    }).catch(() => {})
  } catch { /* ignore */ }
  // #endregion

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
    // #region agent log
    fetch('http://127.0.0.1:7388/ingest/460dcf57-734f-43ed-8370-64f28b2ba6fb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '730a3c' },
      body: JSON.stringify({
        sessionId: '730a3c',
        location: 'route.ts:upstream-error',
        message: 'anthropic error',
        data: {
          upstreamStatus: response.status,
          preview: rawText.slice(0, 280),
        },
        hypothesisId: 'B',
        timestamp: Date.now(),
        runId: 'post-fix',
      }),
    }).catch(() => {})
    // #endregion
    return NextResponse.json(data, { status: response.status })
  }

  return NextResponse.json(data)
}
