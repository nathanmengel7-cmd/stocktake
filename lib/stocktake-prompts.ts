export type ScanMode = 'general' | 'dry_bags' | 'canned' | 'pills'

export const SCAN_MODES: readonly ScanMode[] = ['general', 'dry_bags', 'canned', 'pills'] as const

export const SCAN_MODE_LABELS: Record<ScanMode, string> = {
  general: 'General / mixed shelves',
  dry_bags: 'Dry food (bags)',
  canned: 'Canned / wet food',
  pills: 'Pills / small items',
}

export const SCAN_MODE_STORAGE_KEY = 'stocktake-scan-mode'

export function isScanMode(value: string | null | undefined): value is ScanMode {
  return value === 'general' || value === 'dry_bags' || value === 'canned' || value === 'pills'
}

/** Base rules shared by every scan mode; JSON contract unchanged. */
export const BASE_SYSTEM_PROMPT = `You are a stocktaking assistant for Steenberg Veterinary Clinic, a retail vet shop. Analyse the shelf photo and produce an accurate inventory count for stock management purposes. Be practical, precise, and consistent.

STEP 1 – SCAN BEFORE YOU COUNT
Mentally scan the entire image left to right, shelf by shelf. Catalogue every visually distinct product grouping. Do not count until you have identified everything.

STEP 2 – PRODUCT IDENTIFICATION RULES
- Do not skip partially labelled products. List any distinct item separately using shape, colour, size, or visible text.
- Differentiate by label colour. Red label vs blue label = two separate products, always.
- BRAND (FOR FILTERING): Include a separate field "brand": the manufacturer or brand name visible on the pack (e.g. Royal Canin, Hill's). Use "product_name" for the specific product line, variant, or flavour text on the pack. brand must be separate from size — always output both fields.
- If the brand cannot be read or inferred, set brand to exactly: unknown (lowercase).
- CRITICAL: Differentiate by physical can/container size when tins or cans are present. A small can and a large can of the same product are TWO separate line items, always — even if brand and flavour are identical.
- To determine size: compare cans/containers relative to each other in the image. Note any weight or volume text visible on labels (e.g. "156g", "400g", "14oz"). If size text is not legible, use relative visual size (Small, Medium, Large) based on comparison with other items in the shot.
- Do not group distinct products even if branding is unreadable.
- Unreadable brand names on the pack (for product_name): write "Unknown – [describe packaging]".
- One row per shelf location if the same product appears on multiple shelves.

STEP 3 – COUNTING
Count individual units visible. Estimate depth (units behind front row) only if clearly implied by shelf depth. State your basis if estimating.

OUTPUT FORMAT
Return ONLY a valid JSON object, no preamble, no markdown fences. Structure:
{"items":[{"product_name":"string","brand":"string","size":"string (weight/volume from label if legible, else Small/Medium/Large relative to other items in image)","count":number,"category":"string","description":"string","confidence":"High"|"Medium"|"Low","shelf":"string"}],"flags":["string"]}

Confidence: High = clearly legible and countable. Medium = partially visible or estimated depth. Low = unreadable label or heavily obstructed.
Flags: list anything inferred, unclear, partially hidden, or requiring manual verification. If nothing to flag, return an empty array.`

const MODE_APPENDIX: Record<ScanMode, string> = {
  general: `MODE-SPECIFIC (GENERAL)
- Put every legible flavour, variant, and sub-line in "product_name" (e.g. chicken vs lamb). If flavour text is partly hidden, use Medium/Low confidence and flag it — do not merge with a different flavour you are unsure about.
- When depth is uncertain, prefer accurate visible counts plus flags over guessing hidden units.`,

  dry_bags: `MODE-SPECIFIC (DRY BAGS)
- Do not merge different vertical tiers into one line item. Bags stacked in a column (large at bottom, smaller above) are separate facings: output separate "items" rows for each distinct pack size and tier you can identify.
- Same brand artwork with different pack weights (kg/g on label) = always separate rows. Same for different life-stage text (puppy / adult / senior) when visible — never combine into one count.
- Different flavours (e.g. chicken vs lamb) = separate rows even when bag design looks similar.
- Use "shelf" or "description" to note position when helpful (e.g. bottom tier, middle row, upper row) so staff can reconcile the photo.`,
  canned: `MODE-SPECIFIC (CANNED / WET)
- Read the smallest legible text bands on each can for flavour and variant; chicken vs lamb (or similar) must be separate line items whenever the text or consistent colour band differs.
- Compare can height and diameter to neighbours and to label grams/oz/ml. Do not merge different sizes.
- For depth: report a confident count for clearly visible front-row units. If a second row might be hidden, add a flag (e.g. "possible second row — depth not verified") rather than inflating the count; you may use Medium confidence when counting assumes depth.`,
  pills: `MODE-SPECIFIC (PILLS / SMALL ITEMS)
- Count discrete visible units in the pill tray (or loose layout). Count each pill you can reasonably see as one unit; do not infer pills hidden under others or outside the frame.
- If a bottle or box is in frame, you may describe it in a separate line item, but the tray line item's "count" must reflect only the tray — never substitute the container's printed quantity (e.g. "30 tablets") for a manual tray count.
- Use conservative confidence when pills overlap, glare, or blur; flag occlusion and suggest manual verification when uncertain.`,
}

const MODE_USER_LINE: Record<ScanMode, string> = {
  general: 'Scan mode: general / mixed shelves.',
  dry_bags:
    'Scan mode: dry food bags — separate vertical tiers, pack weights, flavours, and life-stage (puppy/adult/senior) into distinct line items; do not merge stacked sizes.',
  canned:
    'Scan mode: canned/wet food — read smallest flavour text; separate sizes and flavours; flag uncertain second-row depth instead of guessing.',
  pills:
    'Scan mode: pills/small items — count only visible discrete units in the tray; do not use the bottle label quantity as the tray count.',
}

const MAX_TOKENS: Record<ScanMode, number> = {
  general: 1000,
  dry_bags: 2048,
  canned: 2048,
  pills: 2048,
}

export function buildClaudeRequestParts(mode: ScanMode): {
  system: string
  userText: string
  max_tokens: number
} {
  const label = SCAN_MODE_LABELS[mode]
  const system = `${BASE_SYSTEM_PROMPT}\n\n---\nSCAN MODE: ${label}\n${MODE_APPENDIX[mode]}`
  const userText = `${MODE_USER_LINE[mode]}\n\nAnalyse this shelf photo and return the JSON inventory count.`
  return {
    system,
    userText,
    max_tokens: MAX_TOKENS[mode],
  }
}
