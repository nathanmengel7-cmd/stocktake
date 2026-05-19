import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'

export const runtime = 'nodejs'

const MAX_EDGE_PX = 1600
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024

export async function POST(req: NextRequest) {
  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const file = formData.get('file')
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: 'Missing file field' }, { status: 400 })
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `Image too large to upload (max ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB)` },
      { status: 413 },
    )
  }

  const input = Buffer.from(await file.arrayBuffer())

  try {
    const meta = await sharp(input).metadata()
    const output = await sharp(input)
      .rotate()
      .resize(MAX_EDGE_PX, MAX_EDGE_PX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer()

    return NextResponse.json({
      base64: output.toString('base64'),
      mediaType: 'image/jpeg',
      outputBytes: output.length,
      originalWidth: meta.width ?? 0,
      originalHeight: meta.height ?? 0,
    })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { error: 'Server could not process this image', detail },
      { status: 422 },
    )
  }
}
