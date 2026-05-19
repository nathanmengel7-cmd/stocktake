'use client'

import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from 'react'
import {
  type ScanMode,
  SCAN_MODES,
  SCAN_MODE_LABELS,
  SCAN_MODE_STORAGE_KEY,
  isScanMode,
  buildClaudeRequestParts,
} from '@/lib/stocktake-prompts'

type Confidence = 'High' | 'Medium' | 'Low'

interface StockItem {
  product_name: string
  /** Manufacturer or brand visible on the pack; use unknown if unreadable. */
  brand: string
  /** Weight/volume from label if legible, else Small/Medium/Large vs other items in the shot. */
  size: string
  count: number
  category: string
  description: string
  confidence: Confidence
  shelf: string
  source: string
  /** Matches `QueueItem.id` so rows stay tied to the preview image. */
  queueId: string
}

type QueueStatus = 'pending' | 'scanning' | 'done' | 'error'

interface QueueItem {
  id: string
  file: File
  url: string
  status: QueueStatus
  /** Set when status is error (for UI + debug). */
  errorDetail?: string
}

// #region agent log
function agentLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
) {
  fetch('http://127.0.0.1:7388/ingest/460dcf57-734f-43ed-8370-64f28b2ba6fb', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '730a3c' },
    body: JSON.stringify({
      sessionId: '730a3c',
      location,
      message,
      data,
      hypothesisId,
      timestamp: Date.now(),
      runId: 'pre-fix',
    }),
  }).catch(() => {})
}
// #endregion

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function confClass(c: string) {
  if (c === 'High') return 'bg-green-100 text-green-800'
  if (c === 'Medium') return 'bg-amber-100 text-amber-800'
  return 'bg-red-100 text-red-800'
}

/** One analysed photo: flags + whether the user confirmed the rows match the shelf. */
interface PhotoSession {
  queueId: string
  source: string
  flags: string[]
  approved: boolean
  scanMode: ScanMode
}

function photoSectionDomId(queueId: string) {
  return `photo-${queueId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

function isSessionBodyExpanded(session: PhotoSession, expandedMap: Record<string, boolean | undefined>) {
  const v = expandedMap[session.queueId]
  if (v !== undefined) return v
  return !session.approved
}

type LightboxState = null | { url: string; title: string }

export default function StocktakePage() {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [items, setItems] = useState<StockItem[]>([])
  const [sessions, setSessions] = useState<PhotoSession[]>([])
  /** When set, overrides default: expanded while pending, collapsed when approved. */
  const [bodyExpandedByQueueId, setBodyExpandedByQueueId] = useState<Record<string, boolean | undefined>>({})
  const [running, setRunning] = useState(false)
  const [drag, setDrag] = useState(false)
  const [lightbox, setLightbox] = useState<LightboxState>(null)

  const closeLightbox = useCallback(() => setLightbox(null), [])

  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox, closeLightbox])

  useEffect(() => {
    if (!lightbox) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [lightbox])

  const [scanMode, setScanMode] = useState<ScanMode>('general')

  useLayoutEffect(() => {
    try {
      const raw = localStorage.getItem(SCAN_MODE_STORAGE_KEY)
      if (isScanMode(raw)) setScanMode(raw)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(SCAN_MODE_STORAGE_KEY, scanMode)
    } catch {
      /* ignore */
    }
  }, [scanMode])

  const sessionsRef = useRef(sessions)
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  const addFiles = useCallback((files: FileList | null) => {
    if (!files) return
    const newItems: QueueItem[] = []
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      newItems.push({ id: `${Date.now()}-${Math.random()}`, file, url: URL.createObjectURL(file), status: 'pending' })
    }
    setQueue(prev => [...prev, ...newItems])
  }, [])

  const statPhotos = queue.filter(q => q.status === 'done').length
  const statItems = items.length
  const statUnits = items.reduce((s, i) => s + (Number(i.count) || 0), 0)
  const statFlags = sessions.reduce((n, s) => n + s.flags.length, 0)

  async function runAnalysis() {
    const pending = queue.filter(q => q.status === 'pending')
    if (!pending.length) return
    setRunning(true)
    const modeSnapshot = scanMode

    for (const qi of pending) {
      setQueue(prev => prev.map(q => q.id === qi.id ? { ...q, status: 'scanning', errorDetail: undefined } : q))
      try {
        // #region agent log
        agentLog('page.tsx:runAnalysis:start', 'scan start', {
          queueId: qi.id,
          fileName: qi.file.name,
          fileSize: qi.file.size,
          fileType: qi.file.type || '(empty)',
        }, 'A')
        // #endregion
        const b64 = await fileToBase64(qi.file)
        const mime = qi.file.type || 'image/jpeg'
        const { system, userText, max_tokens } = buildClaudeRequestParts(modeSnapshot)
        const requestBody = JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens,
          system,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
              { type: 'text', text: userText }
            ]
          }]
        })
        // #region agent log
        agentLog('page.tsx:runAnalysis:pre-fetch', 'payload built', {
          queueId: qi.id,
          b64Len: b64.length,
          payloadBytes: requestBody.length,
          mime,
        }, 'A')
        // #endregion

        const res = await fetch('/api/claude', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
        })

        const rawBody = await res.text()
        // #region agent log
        agentLog('page.tsx:runAnalysis:post-fetch', 'api response', {
          queueId: qi.id,
          httpStatus: res.status,
          ok: res.ok,
          rawBodyLen: rawBody.length,
          bodyPreview: rawBody.slice(0, 280),
        }, 'B')
        // #endregion

        let data: Record<string, unknown>
        try {
          data = rawBody.trim() ? (JSON.parse(rawBody) as Record<string, unknown>) : {}
        } catch {
          // #region agent log
          agentLog('page.tsx:runAnalysis:json-parse-fail', 'non-json api body', {
            queueId: qi.id,
            httpStatus: res.status,
            rawBodyLen: rawBody.length,
          }, 'E')
          // #endregion
          throw new Error(`/api/claude returned non-JSON (HTTP ${res.status}).`)
        }

        if (!res.ok) {
          const errObj = data.error as { message?: string } | undefined
          const msg =
            (typeof data.error === 'string' ? data.error : errObj?.message) ||
            (typeof data.message === 'string' ? data.message : null) ||
            `Stocktake API error (HTTP ${res.status})`
          // #region agent log
          agentLog('page.tsx:runAnalysis:api-error', 'api not ok', {
            queueId: qi.id,
            httpStatus: res.status,
            msg,
          }, 'B')
          // #endregion
          throw new Error(msg)
        }

        const content = data.content as Array<{ type: string; text?: string }> | undefined
        const text = content?.find(b => b.type === 'text')?.text || ''
        const clean = text.replace(/```json|```/g, '').trim()
        // #region agent log
        agentLog('page.tsx:runAnalysis:pre-model-json', 'claude text received', {
          queueId: qi.id,
          textLen: clean.length,
          textPreview: clean.slice(0, 120),
        }, 'D')
        // #endregion
        const parsed = JSON.parse(clean)
        const photoFlags = (parsed.flags || []).filter(Boolean) as string[]

        setQueue(prev => prev.map(q => q.id === qi.id ? { ...q, status: 'done' } : q))
        setSessions(prev => [...prev, {
          queueId: qi.id,
          source: qi.file.name,
          flags: photoFlags,
          approved: false,
          scanMode: modeSnapshot,
        }])
        setBodyExpandedByQueueId(prev => ({ ...prev, [qi.id]: true }))
        setItems(prev => [...prev, ...(parsed.items || []).map((i: Partial<StockItem>) => {
          const b = typeof i.brand === 'string' ? i.brand.trim() : ''
          const sz = typeof i.size === 'string' ? i.size.trim() : ''
          return { ...i, brand: b || 'unknown', size: sz, source: qi.file.name, queueId: qi.id } as StockItem
        })])
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e)
        console.error(e)
        // #region agent log
        agentLog('page.tsx:runAnalysis:catch', 'scan failed', {
          queueId: qi.id,
          errMsg,
          errName: e instanceof Error ? e.name : 'unknown',
        }, 'ALL')
        // #endregion
        setQueue(prev => prev.map(q => q.id === qi.id ? { ...q, status: 'error', errorDetail: errMsg } : q))
      }
    }

    setRunning(false)
  }

  function invalidateSessionApproval(queueId: string) {
    setSessions(prev => prev.map(s => s.queueId === queueId && s.approved ? { ...s, approved: false } : s))
    setBodyExpandedByQueueId(prev => {
      const next = { ...prev }
      delete next[queueId]
      return next
    })
  }

  function approvePhoto(queueId: string) {
    setSessions(prev => prev.map(s => s.queueId === queueId ? { ...s, approved: true } : s))
    setBodyExpandedByQueueId(prev => ({ ...prev, [queueId]: false }))
  }

  function undoApproval(queueId: string) {
    setSessions(prev => prev.map(s => s.queueId === queueId ? { ...s, approved: false } : s))
    setBodyExpandedByQueueId(prev => {
      const next = { ...prev }
      delete next[queueId]
      return next
    })
  }

  function toggleBodyExpanded(session: PhotoSession) {
    setBodyExpandedByQueueId(prev => {
      const cur = isSessionBodyExpanded(session, prev)
      return { ...prev, [session.queueId]: !cur }
    })
  }

  function expandAllPending() {
    setBodyExpandedByQueueId(prev => {
      const next = { ...prev }
      for (const s of sessionsRef.current) {
        if (!s.approved) next[s.queueId] = true
      }
      return next
    })
  }

  function collapseAllApproved() {
    setBodyExpandedByQueueId(prev => {
      const next = { ...prev }
      for (const s of sessionsRef.current) {
        if (s.approved) next[s.queueId] = false
      }
      return next
    })
  }

  function updateItem(index: number, field: keyof StockItem, value: string | number) {
    let qid: string | undefined
    setItems(prev => {
      qid = prev[index]?.queueId
      return prev.map((item, i) => i === index ? { ...item, [field]: value } : item)
    })
    if (qid) invalidateSessionApproval(qid)
  }

  function removeItem(index: number) {
    let qid: string | undefined
    setItems(prev => {
      qid = prev[index]?.queueId
      return prev.filter((_, j) => j !== index)
    })
    if (qid) invalidateSessionApproval(qid)
  }

  function duplicateItem(index: number) {
    let qid: string | undefined
    setItems(prev => {
      const source = prev[index]
      if (!source) return prev
      qid = source.queueId
      const next = [...prev]
      next.splice(index + 1, 0, { ...source })
      return next
    })
    if (qid) {
      invalidateSessionApproval(qid)
      setBodyExpandedByQueueId(prev => ({ ...prev, [qid!]: true }))
    }
  }

  function addManualRow(queueId: string) {
    const session = sessions.find(s => s.queueId === queueId)
    const q = queue.find(x => x.id === queueId)
    const sourceName = session?.source ?? q?.file.name ?? ''
    setItems(prev => [
      ...prev,
      {
        product_name: '',
        brand: 'unknown',
        size: '',
        count: 1,
        category: '',
        description: 'Added manually',
        confidence: 'Low',
        shelf: '',
        source: sourceName,
        queueId,
      },
    ])
    invalidateSessionApproval(queueId)
    setBodyExpandedByQueueId(prev => ({ ...prev, [queueId]: true }))
  }

  /** Remove one photo from the queue and all inventory rows / session tied to it. */
  function removePhotoAndData(queueId: string) {
    const qEntry = queue.find(q => q.id === queueId)
    if (!qEntry) return
    const hasRowsOrSession =
      sessions.some(s => s.queueId === queueId) || items.some(i => i.queueId === queueId)
    const msg = hasRowsOrSession
      ? 'Remove this photo and all inventory lines for it? This cannot be undone.'
      : 'Remove this photo from the queue?'
    if (!window.confirm(msg)) return

    const urlToClose = qEntry.url
    URL.revokeObjectURL(urlToClose)
    setLightbox(lb => (lb?.url === urlToClose ? null : lb))
    setQueue(prev => prev.filter(q => q.id !== queueId))
    setItems(prev => prev.filter(i => i.queueId !== queueId))
    setSessions(prev => prev.filter(s => s.queueId !== queueId))
    setBodyExpandedByQueueId(prev => {
      const next = { ...prev }
      delete next[queueId]
      return next
    })
  }

  function exportDraftCSV() {
    const headers = ['Product name', 'Brand', 'Size', 'Count', 'Category', 'Description', 'Shelf', 'Confidence', 'Source photo', 'Scan mode']
    const rows = items.map(i => {
      const session = sessions.find(s => s.queueId === i.queueId)
      const modeLabel = session ? SCAN_MODE_LABELS[session.scanMode] : ''
      return [i.product_name, i.brand || 'unknown', i.size || '', i.count, i.category, i.description, i.shelf || '', i.confidence || '', i.source || '', modeLabel]
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
    })
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `stocktake_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  function exportConfirmedCSV() {
    const approvedIds = new Set(sessions.filter(s => s.approved).map(s => s.queueId))
    const rowsData = items.filter(i => approvedIds.has(i.queueId))
    const headers = ['Product name', 'Brand', 'Size', 'Count', 'Category', 'Description', 'Shelf', 'Confidence', 'Source photo', 'Confirmed', 'Scan mode']
    const rows = rowsData.map(i => {
      const session = sessions.find(s => s.queueId === i.queueId)
      const modeLabel = session ? SCAN_MODE_LABELS[session.scanMode] : ''
      return [i.product_name, i.brand || 'unknown', i.size || '', i.count, i.category, i.description, i.shelf || '', i.confidence || '', i.source || '', 'yes', modeLabel]
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
    })
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `stocktake_confirmed_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  function clearAll() {
    setQueue(prev => {
      for (const q of prev) URL.revokeObjectURL(q.url)
      return []
    })
    setItems([])
    setSessions([])
    setBodyExpandedByQueueId({})
  }

  function scrollToPhotoSession(queueId: string) {
    document.getElementById(photoSectionDomId(queueId))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const statusLabel: Record<QueueStatus, string> = {
    pending: 'Pending',
    scanning: 'Scanning…',
    done: 'Done',
    error: 'Error',
  }

  const statusStyle: Record<QueueStatus, string> = {
    pending: 'bg-gray-100 text-gray-600',
    scanning: 'bg-blue-100 text-blue-700',
    done: 'bg-green-100 text-green-700',
    error: 'bg-red-100 text-red-700',
  }

  const doneCount = queue.filter(q => q.status === 'done' || q.status === 'error').length
  const progressPct = queue.length > 0 ? Math.round((doneCount / queue.length) * 100) : 0
  const hasPending = queue.some(q => q.status === 'pending')

  const flatIndicesByQueueId = useMemo(() => {
    const m = new Map<string, number[]>()
    items.forEach((it, idx) => {
      const arr = m.get(it.queueId) ?? []
      arr.push(idx)
      m.set(it.queueId, arr)
    })
    return m
  }, [items])

  const approvedSessionCount = useMemo(() => sessions.filter(s => s.approved).length, [sessions])
  const allSessionsApproved = sessions.length > 0 && approvedSessionCount === sessions.length

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-6">
      <div className="max-w-6xl mx-auto">

        {/* Header */}
        <div className="flex items-baseline justify-between mb-8">
          <div>
            <h1 className="text-xl font-medium text-gray-900">Stocktake</h1>
            <p className="text-sm text-gray-500 mt-0.5">Steenberg Veterinary Clinic</p>
          </div>
          {queue.length > 0 && (
            <button onClick={clearAll} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-white transition-colors">
              Clear all
            </button>
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-3 mb-8">
          {[
            { label: 'Photos', value: statPhotos },
            { label: 'Items found', value: statItems },
            { label: 'Total units', value: statUnits },
            { label: 'Flags', value: statFlags },
          ].map(s => (
            <div key={s.label} className="bg-white border border-gray-100 rounded-xl p-4">
              <div className="text-xs text-gray-400 mb-1">{s.label}</div>
              <div className="text-2xl font-medium text-gray-900">{s.value}</div>
            </div>
          ))}
        </div>

        {/* Upload zone */}
        <div
          onClick={() => document.getElementById('file-input')?.click()}
          onDragOver={e => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files) }}
          className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors mb-6 ${drag ? 'border-gray-400 bg-gray-50' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'}`}
        >
          <div className="text-4xl mb-3">📷</div>
          <p className="text-sm text-gray-500">Click to upload shelf photos, or drag and drop</p>
          <p className="text-xs text-gray-400 mt-1">PNG, JPG, WEBP — multiple files supported</p>
        </div>
        <input id="file-input" type="file" accept="image/*" multiple className="hidden" onChange={e => addFiles(e.target.files)} />

        {/* Queue */}
        {queue.length > 0 && (
          <div className="mb-6">
            <div className="flex justify-between text-xs text-gray-400 mb-2">
              <span>Photos queued</span>
              <span>{doneCount}/{queue.length}</span>
            </div>
            <div className="flex flex-col gap-2 mb-2">
              {queue.map(q => (
                <div key={q.id} className="flex items-center gap-3 bg-white border border-gray-100 rounded-lg px-3 py-2">
                  <button
                    type="button"
                    className="flex-shrink-0 p-0 border-0 bg-transparent rounded cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2"
                    aria-label={`View full image: ${q.file.name}`}
                    onClick={() => setLightbox({ url: q.url, title: q.file.name })}
                  >
                    <img src={q.url} alt="" className="w-9 h-9 rounded object-cover pointer-events-none" />
                  </button>
                  <span className="text-sm text-gray-700 flex-1 truncate">{q.file.name}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full max-w-[45%] truncate ${statusStyle[q.status]}`}
                    title={q.errorDetail || statusLabel[q.status]}
                  >
                    {q.status === 'error' && q.errorDetail ? q.errorDetail : statusLabel[q.status]}
                  </span>
                  <button
                    type="button"
                    disabled={q.status === 'scanning' || running}
                    onClick={() => removePhotoAndData(q.id)}
                    className="flex-shrink-0 text-xs text-red-600 hover:bg-red-50 rounded-lg px-2 py-1 border border-red-100 disabled:opacity-40 disabled:cursor-not-allowed"
                    title={q.status === 'scanning' ? 'Wait until scan finishes' : 'Remove this photo and its data'}
                  >
                    Remove photo
                  </button>
                </div>
              ))}
            </div>
            <div className="h-0.5 bg-gray-100 rounded overflow-hidden">
              <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        )}

        {queue.length > 0 && (
          <div className="mb-4 rounded-xl border border-gray-100 bg-white px-4 py-3">
            <label htmlFor="scan-mode" className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
              Scan mode
            </label>
            <select
              id="scan-mode"
              value={scanMode}
              disabled={running}
              onChange={e => setScanMode(e.target.value as ScanMode)}
              className="w-full sm:max-w-md text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {SCAN_MODES.map(m => (
                <option key={m} value={m}>{SCAN_MODE_LABELS[m]}</option>
              ))}
            </select>
            <p className="text-xs text-gray-400 mt-2">
              Each pending photo in this run uses the mode selected when you click Analyse photos. Change mode between runs for different product types.
            </p>
          </div>
        )}

        {/* Analyse button */}
        <button
          onClick={runAnalysis}
          disabled={!hasPending || running}
          className="w-full py-2.5 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors mb-8 flex items-center justify-center gap-2"
        >
          {running ? (
            <>
              <span className="inline-block w-4 h-4 border-2 border-gray-200 border-t-gray-500 rounded-full animate-spin" />
              Scanning…
            </>
          ) : (
            '🔍 Analyse photos'
          )}
        </button>

        {/* Results */}
        {sessions.length > 0 && (
          <div className="mb-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between mb-3">
              <div>
                <h2 className="text-base font-medium text-gray-900">Inventory results</h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  Approved {approvedSessionCount} of {sessions.length} photo{sessions.length === 1 ? '' : 's'}
                  {allSessionsApproved ? ' — ready for confirmed export' : ' — approve each photo when it matches the shelf'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={exportConfirmedCSV}
                  disabled={!allSessionsApproved}
                  className="flex items-center gap-1.5 text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title={allSessionsApproved ? '' : 'Approve every photo below first'}
                >
                  ↓ Download confirmed CSV
                </button>
                <button
                  type="button"
                  onClick={exportDraftCSV}
                  className="flex items-center gap-1.5 text-sm border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors text-gray-600"
                  title="Includes all rows, including from photos not yet approved. Not for import until all photos are approved."
                >
                  Export draft (all rows)
                </button>
                <button
                  type="button"
                  onClick={() => { setItems([]); setSessions([]); setBodyExpandedByQueueId({}) }}
                  className="flex items-center gap-1.5 text-sm border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors text-gray-500"
                >
                  Clear results
                </button>
              </div>
            </div>

            {sessions.length > 1 && (
              <div className="flex flex-wrap gap-2 mb-3 text-xs">
                <button type="button" onClick={expandAllPending} className="text-gray-600 hover:text-gray-900 underline decoration-dotted">
                  Expand all pending
                </button>
                <span className="text-gray-300">|</span>
                <button type="button" onClick={collapseAllApproved} className="text-gray-600 hover:text-gray-900 underline decoration-dotted">
                  Collapse all confirmed
                </button>
              </div>
            )}

            <div className="mb-4 rounded-xl border border-gray-100 bg-white p-2 max-h-36 overflow-y-auto sticky top-2 z-10 shadow-sm">
              <p className="text-xs text-gray-400 px-1 mb-1.5">Jump to photo</p>
              <div className="flex flex-wrap gap-1.5">
                {sessions.map(s => (
                  <button
                    key={s.queueId}
                    type="button"
                    onClick={() => scrollToPhotoSession(s.queueId)}
                    className={`text-xs px-2 py-1 rounded-lg border max-w-[160px] truncate transition-colors ${s.approved ? 'border-green-200 bg-green-50 text-green-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}
                    title={s.source}
                  >
                    {s.approved ? '✓ ' : ''}{s.source}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-6">
              {sessions.map(session => {
                const preview = queue.find(q => q.id === session.queueId)
                const flatIdxs = flatIndicesByQueueId.get(session.queueId) ?? []
                const expanded = isSessionBodyExpanded(session, bodyExpandedByQueueId)
                const panelId = `session-panel-${photoSectionDomId(session.queueId)}`
                const rowCount = flatIdxs.length
                return (
                  <div
                    key={session.queueId}
                    id={photoSectionDomId(session.queueId)}
                    className={`border rounded-xl overflow-hidden bg-white ${session.approved ? 'border-green-200' : 'border-gray-100'}`}
                  >
                    <div className="flex flex-wrap items-center gap-2 sm:gap-3 px-3 py-2.5 border-b border-gray-100 bg-gray-50/90">
                      <button
                        type="button"
                        className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                        aria-expanded={expanded}
                        aria-controls={panelId}
                        onClick={() => toggleBodyExpanded(session)}
                        title={expanded ? 'Collapse' : 'Expand'}
                      >
                        <span aria-hidden className="text-sm">{expanded ? '▼' : '▶'}</span>
                      </button>
                      {preview ? (
                        <button
                          type="button"
                          className="flex-shrink-0 p-0 border border-gray-200 rounded bg-white cursor-pointer hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2"
                          aria-label={`View full image: ${session.source}`}
                          onClick={() => setLightbox({ url: preview.url, title: session.source })}
                        >
                          <img src={preview.url} alt="" className="w-11 h-11 rounded object-cover pointer-events-none" />
                        </button>
                      ) : (
                        <div className="w-11 h-11 rounded bg-gray-100 border border-gray-200 flex-shrink-0" aria-hidden />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-400 uppercase tracking-wide">Source photo</p>
                        <p className="text-sm font-medium text-gray-900 truncate" title={session.source}>{session.source}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {rowCount} line{rowCount === 1 ? '' : 's'}
                          {session.flags.length > 0 ? ` · ${session.flags.length} flag${session.flags.length === 1 ? '' : 's'}` : ''}
                          {' · '}
                          <span className="text-gray-600">Scan:</span>{' '}
                          <span className="font-medium text-gray-700">{SCAN_MODE_LABELS[session.scanMode]}</span>
                        </p>
                      </div>
                      <span className={`flex-shrink-0 text-xs px-2 py-0.5 rounded-full ${session.approved ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-900'}`}>
                        {session.approved ? 'Confirmed' : 'Needs review'}
                      </span>
                      {session.approved ? (
                        <button
                          type="button"
                          onClick={() => undoApproval(session.queueId)}
                          className="flex-shrink-0 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 hover:bg-white text-gray-600"
                        >
                          Undo approval
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => approvePhoto(session.queueId)}
                          className="flex-shrink-0 text-xs font-medium border border-green-300 bg-green-50 text-green-900 rounded-lg px-2.5 py-1.5 hover:bg-green-100"
                        >
                          Approve photo
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={running}
                        onClick={() => addManualRow(session.queueId)}
                        className="flex-shrink-0 text-xs font-medium border border-gray-200 rounded-lg px-2.5 py-1.5 hover:bg-white text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Add a manual line if the scan missed an item"
                      >
                        Add row
                      </button>
                      <button
                        type="button"
                        disabled={running}
                        onClick={() => removePhotoAndData(session.queueId)}
                        className="flex-shrink-0 text-xs text-red-600 hover:bg-red-50 rounded-lg px-2.5 py-1.5 border border-red-100 disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Remove this photo from the queue and delete all lines for it"
                      >
                        Delete photo and rows
                      </button>
                    </div>

                    {expanded && (
                      <div id={panelId} className="border-t border-gray-50">
                        {rowCount === 0 && (
                          <div className="px-4 py-3 bg-white space-y-3">
                            <p className="text-sm text-gray-500">
                              No line items detected for this photo. Approve if the shelf is empty or the scan missed stock; otherwise edit the queue and re-run analysis.
                            </p>
                            <button
                              type="button"
                              disabled={running}
                              onClick={() => addManualRow(session.queueId)}
                              className="text-sm font-medium border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-800 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                              + Add row
                            </button>
                          </div>
                        )}
                        {rowCount > 0 && (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm min-w-[800px]">
                              <thead>
                                <tr className="bg-gray-50 text-xs text-gray-400 font-medium">
                                  <th className="text-left px-3 py-2.5 w-[17%]">Product name</th>
                                  <th className="text-left px-3 py-2.5 w-[10%]">Brand</th>
                                  <th className="text-left px-3 py-2.5 w-[10%]">Size</th>
                                  <th className="text-left px-3 py-2.5 w-[7%]">Count</th>
                                  <th className="text-left px-3 py-2.5 w-[9%]">Category</th>
                                  <th className="text-left px-3 py-2.5 w-[19%]">Description</th>
                                  <th className="text-left px-3 py-2.5 w-[7%]">Shelf</th>
                                  <th className="text-left px-3 py-2.5 w-[11%]">Confidence</th>
                                  <th className="text-right px-3 py-2.5 w-36 whitespace-nowrap" scope="col"><span className="sr-only">Row actions</span></th>
                                </tr>
                              </thead>
                              <tbody>
                                {flatIdxs.map(flatIdx => {
                                  const item = items[flatIdx]
                                  return (
                                    <tr key={flatIdx} className="border-t border-gray-50 hover:bg-gray-50/50">
                                      <td className="px-3 py-2"><input className="w-full bg-transparent text-gray-800 text-sm focus:outline-none" value={esc(item.product_name)} onChange={e => updateItem(flatIdx, 'product_name', e.target.value)} /></td>
                                      <td className="px-3 py-2"><input className="w-full bg-transparent text-gray-800 text-sm focus:outline-none" value={esc(item.brand || 'unknown')} onChange={e => updateItem(flatIdx, 'brand', e.target.value)} /></td>
                                      <td className="px-3 py-2"><input className="w-full bg-transparent text-gray-800 text-sm focus:outline-none" value={esc(item.size)} onChange={e => updateItem(flatIdx, 'size', e.target.value)} /></td>
                                      <td className="px-3 py-2"><input type="number" className="w-12 bg-transparent text-gray-800 text-sm focus:outline-none" value={item.count} onChange={e => updateItem(flatIdx, 'count', Number(e.target.value))} /></td>
                                      <td className="px-3 py-2"><input className="w-full bg-transparent text-gray-800 text-sm focus:outline-none" value={esc(item.category)} onChange={e => updateItem(flatIdx, 'category', e.target.value)} /></td>
                                      <td className="px-3 py-2"><input className="w-full bg-transparent text-gray-800 text-sm focus:outline-none" value={esc(item.description)} onChange={e => updateItem(flatIdx, 'description', e.target.value)} /></td>
                                      <td className="px-3 py-2"><input className="w-full bg-transparent text-gray-800 text-sm focus:outline-none" value={esc(item.shelf)} onChange={e => updateItem(flatIdx, 'shelf', e.target.value)} /></td>
                                      <td className="px-3 py-2"><span className={`text-xs px-2 py-0.5 rounded-full ${confClass(item.confidence)}`}>{item.confidence || '—'}</span></td>
                                      <td className="px-2 py-2 text-right align-middle">
                                        <div className="inline-flex items-center justify-end gap-1">
                                          <button
                                            type="button"
                                            onClick={() => duplicateItem(flatIdx)}
                                            className="text-xs text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg px-2 py-1 border border-transparent hover:border-gray-200 transition-colors"
                                            title="Copy this row so you can edit minor differences"
                                            aria-label="Duplicate this row"
                                          >
                                            Duplicate
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => removeItem(flatIdx)}
                                            className="text-xs text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-lg px-2 py-1 border border-transparent hover:border-red-100 transition-colors"
                                            aria-label="Delete this row"
                                          >
                                            Remove
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                            <div className="flex items-center px-3 py-2 border-t border-gray-100 bg-gray-50/50">
                              <button
                                type="button"
                                disabled={running}
                                onClick={() => addManualRow(session.queueId)}
                                className="text-sm font-medium border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-800 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                              >
                                + Add row
                              </button>
                            </div>
                          </div>
                        )}
                        {session.flags.length > 0 && (
                          <div className="px-4 py-3 bg-amber-50/90 border-t border-amber-100">
                            <p className="text-xs font-medium text-amber-800 mb-1.5">Flags for this photo — verify manually</p>
                            <ul className="space-y-1">
                              {session.flags.map((f, fi) => (
                                <li key={fi} className="text-xs text-amber-900 flex gap-2"><span>–</span>{f}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Empty state */}
        {sessions.length === 0 && queue.length === 0 && (
          <div className="text-center py-16 text-gray-300 text-sm">
            Upload photos and click analyse to begin
          </div>
        )}

        {lightbox && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="lightbox-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={closeLightbox}
          >
            <div
              className="relative flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-xl"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
                <h3 id="lightbox-title" className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">
                  {lightbox.title}
                </h3>
                <button
                  type="button"
                  onClick={closeLightbox}
                  className="flex-shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
              <div className="flex max-h-[calc(90vh-4rem)] justify-center overflow-auto bg-gray-50 p-4">
                <img
                  src={lightbox.url}
                  alt=""
                  className="max-h-[85vh] max-w-full object-contain"
                />
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
