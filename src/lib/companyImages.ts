// Shared extraction of company-image references from agent-authored markdown.
// Only `company/`-relative raster files are ever surfaced — external URLs are
// deliberately not matched (agent content rendered in the owner's browser must
// not be able to beacon out). The server's /api/blob route enforces the same
// boundary; this is the client-side half. Used by ApprovalCard + ReportReader.
const COMPANY_IMAGE_RE = /!\[[^\]]*\]\((company\/[A-Za-z0-9_\-./]+\.(?:png|jpe?g|webp))\)/g

/** Split an (already frontmatter-stripped) markdown body into displayable text and
    the referenced company image paths. Image-only lines are removed from the text —
    the markdown renderer has no image support, so they'd show as literal syntax. */
export function splitBodyImages(body: string): { body: string; images: string[] } {
  const images: string[] = []
  for (const m of body.matchAll(COMPANY_IMAGE_RE)) {
    const p = m[1]
    if (!p.includes('..') && !images.includes(p)) images.push(p)
  }
  const cleaned = body
    .split('\n')
    .filter(line => { COMPANY_IMAGE_RE.lastIndex = 0; return !COMPANY_IMAGE_RE.test(line.trim()) })
    .join('\n')
    .trim()
  return { body: cleaned, images }
}
