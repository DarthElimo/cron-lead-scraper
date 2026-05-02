// ---------------------------------------------------------------------------
// Geschäftsführer-Extraktion aus deutschen Impressum-Seiten
// ---------------------------------------------------------------------------

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
  Accept: "text/html",
};

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&auml;/g, "ä")
    .replace(/&ouml;/g, "ö")
    .replace(/&uuml;/g, "ü")
    .replace(/&Auml;/g, "Ä")
    .replace(/&Ouml;/g, "Ö")
    .replace(/&Uuml;/g, "Ü")
    .replace(/&szlig;/g, "ß")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

// Name-Muster: 2–4 großgeschriebene Wörter (inkl. Umlaute, Bindestriche, Titel wie Dr./Prof.)
const NAME_PATTERN =
  "(?:Dr\\.|Prof\\.|Dipl\\.-[A-Za-z]+\\.)?\\s*[A-ZÄÖÜ][A-Za-zÄÖÜäöüß\\-]+" +
  "(?:\\s+(?:Dr\\.|Prof\\.)?\\s*[A-ZÄÖÜ][A-Za-zÄÖÜäöüß\\-]+){1,3}";

const OWNER_PATTERNS: RegExp[] = [
  new RegExp(
    "Gesch[äa]ftsf[üu]hrender?\\s*(?:Gesellschafter)?\\s*[:\\-–]\\s*(" + NAME_PATTERN + ")",
    "gi"
  ),
  new RegExp("Inhaber(?:in)?\\s*[:\\-–]\\s*(" + NAME_PATTERN + ")", "gi"),
  new RegExp("vertreten durch[^:\\-–\\n]{0,40}[:\\-–]\\s*(" + NAME_PATTERN + ")", "gi"),
  new RegExp("Verantwortlich(?:er|e)?[^:\\-–\\n]{0,60}[:\\-–]\\s*(" + NAME_PATTERN + ")", "gi"),
  new RegExp("CEO\\s*[:\\-–]\\s*(" + NAME_PATTERN + ")", "gi"),
  new RegExp("Gr[üu]nder(?:in)?\\s*[:\\-–]\\s*(" + NAME_PATTERN + ")", "gi"),
  new RegExp("Vorstand(?:svorsitzender)?\\s*[:\\-–]\\s*(" + NAME_PATTERN + ")", "gi"),
];

export function extractOwner(html: string): string {
  const text = stripHtml(html);
  const found: string[] = [];

  for (const pattern of OWNER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1]?.replace(/\s+/g, " ").trim();
      if (name && name.split(" ").length >= 2 && !found.includes(name)) {
        found.push(name);
      }
    }
  }

  return found.join(", ");
}

export function findImpressumLink(html: string, baseUrl: string): string | null {
  const ANCHOR_RE = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = ANCHOR_RE.exec(html)) !== null) {
    const href = match[1] ?? "";
    const text = stripHtml(match[2] ?? "").toLowerCase();
    const hrefLower = href.toLowerCase();

    if (
      hrefLower.includes("impressum") ||
      hrefLower.includes("imprint") ||
      text.includes("impressum") ||
      text.includes("imprint")
    ) {
      try {
        return new URL(href, baseUrl).toString();
      } catch {
        // malformed href — skip
      }
    }
  }

  return null;
}

export async function fetchImpressumHtml(websiteUrl: string): Promise<string | null> {
  // Attempt 1: canonical /impressum path
  try {
    const directUrl = new URL("/impressum", websiteUrl).toString();
    const res = await fetch(directUrl, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) return await res.text();
  } catch {
    // unreachable or timeout
  }

  // Attempt 2: scan homepage for impressum link
  try {
    const homeRes = await fetch(new URL("/", websiteUrl).toString(), {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(6000),
    });
    if (!homeRes.ok) return null;

    const homeHtml = await homeRes.text();
    const impressumLink = findImpressumLink(homeHtml, websiteUrl);
    if (!impressumLink) return null;

    await new Promise((r) => setTimeout(r, 300));

    const impRes = await fetch(impressumLink, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(6000),
    });
    if (impRes.ok) return await impRes.text();
  } catch {
    // unreachable or no link found
  }

  return null;
}
