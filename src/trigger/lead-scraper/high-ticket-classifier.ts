// ---------------------------------------------------------------------------
// High-Ticket-SHK-Klassifikation (Hybrid: Keyword-Scorer + Groq-LLM)
//
// Ziel: aus einer Website erkennen, ob der Betrieb hochpreisige Installations-
// SHK-Arbeiten anbietet (Bäder, Heizungstausch, Wärmepumpe, Komplettsanierung →
// €10–30k Tickets = JA) oder nur Notdienst/Reparatur/Wartung (kleine Tickets = NEIN).
//
// Komplett kostenlos: Der Keyword-Scorer entscheidet klare Fälle lokal; nur
// Grenzfälle gehen ans Groq Free Tier (Llama 3.3 70B). Fällt Groq aus, greift
// der Keyword-Score als Fallback.
// ---------------------------------------------------------------------------

import { stripHtml, fetchImpressumHtml, findImpressumLink, extractOwner } from "./owner-extractor.js";

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
  Accept: "text/html",
};

// ---------------------------------------------------------------------------
// Signal-Listen (gewichtet, alles in Kleinschreibung als Substring geprüft)
// ---------------------------------------------------------------------------

// High-Ticket → spricht für JA
const JA_SIGNALS: Array<[string, number]> = [
  ["badsanierung", 3],
  ["bad sanierung", 3],
  ["badrenovierung", 3],
  ["badgestaltung", 3],
  ["komplettbad", 3],
  ["komplettsanierung", 3],
  ["heizungsbau", 3],
  ["heizungstausch", 3],
  ["heizungserneuerung", 3],
  ["heizungsmodernisierung", 3],
  ["heizungssanierung", 3],
  ["energetische sanierung", 3],
  ["wärmepumpe", 3],
  ["waermepumpe", 3],
  ["badmodernisierung", 3],
  ["altbausanierung", 2],
  ["barrierefreies bad", 2],
  ["barrierefrei", 2],
  ["bodengleiche dusche", 2],
  ["wellnessbad", 2],
  ["badumbau", 2],
  ["fußbodenheizung", 2],
  ["fussbodenheizung", 2],
  ["solarthermie", 2],
  ["brennwert", 2],
  ["hydraulischer abgleich", 2],
  ["sanierung", 2],
  ["modernisierung", 2],
  ["badplanung", 2],
  ["traumbad", 2],
  ["neues badezimmer", 2],
  ["kfw", 1],
  ["bafa", 1],
  ["renovierung", 1],
  ["badezimmer", 1],
  ["neubau", 1],
];

// Low-Ticket → spricht für NEIN
const NEIN_SIGNALS: Array<[string, number]> = [
  ["notdienst", 3],
  ["rohrreinigung", 3],
  ["abflussreinigung", 3],
  ["kanalreinigung", 2],
  ["rohrbruch", 2],
  ["verstopfung", 2],
  ["verstopfte", 2],
  ["24 stunden", 2],
  ["24-stunden", 2],
  ["24h", 2],
  ["reparaturservice", 2],
  ["kleinreparatur", 2],
  ["ablesedienst", 2],
  ["wartungsdienst", 1],
];

// Schwellen für die rein keyword-basierte Entscheidung.
// Klar JA / klar NEIN nur, wenn EINE Seite deutlich überwiegt und die andere
// praktisch fehlt. Mischfälle (starke JA- UND NEIN-Signale) sind absichtlich
// "borderline" → das LLM entscheidet die Nuance.
const JA_STRONG = 4; // jaScore ab hier "stark"
const NEIN_STRONG = 3; // neinScore ab hier "stark"
const OTHER_SIDE_NOISE = 1; // bis hierhin gilt die Gegenseite als vernachlässigbar

// ---------------------------------------------------------------------------
// Website-Text einsammeln (Homepage + bis zu 3 Leistungs-Unterseiten)
// ---------------------------------------------------------------------------

const SERVICE_LINK_RE = /(leistung|angebot|bad|heizung|sanierung|sanitaer|sanitär)/i;
const MAX_TEXT_LENGTH = 6000;

function findServiceLinks(html: string, baseUrl: string, max: number): string[] {
  const ANCHOR_RE = /<a\s[^>]*href=["']([^"']+)["']/gi;
  const found: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = ANCHOR_RE.exec(html)) !== null && found.length < max) {
    const href = match[1] ?? "";
    if (!SERVICE_LINK_RE.test(href)) continue;
    if (/impressum|datenschutz|kontakt|mailto:|tel:|\.(pdf|jpg|png)/i.test(href)) continue;
    try {
      const abs = new URL(href, baseUrl).toString();
      if (seen.has(abs)) continue;
      // nur Seiten derselben Domain
      if (new URL(abs).hostname !== new URL(baseUrl).hostname) continue;
      seen.add(abs);
      found.push(abs);
    } catch {
      // malformed href — skip
    }
  }
  return found;
}

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "";
    return stripHtml(await res.text());
  } catch {
    return "";
  }
}

async function fetchRawHtml(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  }
}

/** Stellt sicher, dass die URL ein Schema hat (Webseiten ohne https:// werfen sonst). */
function normalizeUrl(url: string): string {
  const u = url.trim();
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/** Baut den Services-Text aus bereits geladener Homepage + bis zu 2 Unterseiten. */
async function buildServicesText(homeHtml: string, base: string): Promise<string> {
  const parts: string[] = [stripHtml(homeHtml)];
  for (const link of findServiceLinks(homeHtml, base, 2)) {
    await new Promise((r) => setTimeout(r, 250));
    const text = await fetchText(link);
    if (text) parts.push(text);
    if (parts.join(" ").length >= MAX_TEXT_LENGTH) break;
  }
  return parts.join(" \n ").slice(0, MAX_TEXT_LENGTH);
}

/** Holt den Impressum-Text einer Website (für die Inhaber-Extraktion). */
export async function fetchImpressumText(websiteUrl: string): Promise<string> {
  const html = await fetchImpressumHtml(normalizeUrl(websiteUrl));
  return html ? stripHtml(html).slice(0, 3000) : "";
}

/**
 * Holt Leistungs- und Impressum-Text einer Website in EINEM Durchgang — die
 * Homepage wird nur einmal geladen und für beides genutzt (Klassifikation +
 * Impressum-Link-Suche). Liefert leere Strings, wenn nicht erreichbar.
 */
export async function fetchLeadContent(
  websiteUrl: string
): Promise<{ servicesText: string; impressumText: string }> {
  const base = normalizeUrl(websiteUrl);
  const homeHtml = await fetchRawHtml(new URL("/", base).toString());

  if (!homeHtml) {
    // Homepage nicht erreichbar — Impressum direkt versuchen
    return { servicesText: "", impressumText: await fetchImpressumText(base) };
  }

  const servicesText = await buildServicesText(homeHtml, base);

  // Impressum: erst /impressum, sonst den Link aus der schon geladenen Homepage
  let impressumHtml = await fetchRawHtml(new URL("/impressum", base).toString());
  if (!impressumHtml) {
    const link = findImpressumLink(homeHtml, base);
    if (link) {
      await new Promise((r) => setTimeout(r, 250));
      impressumHtml = await fetchRawHtml(link);
    }
  }
  const impressumText = impressumHtml ? stripHtml(impressumHtml).slice(0, 3000) : "";

  return { servicesText, impressumText };
}

// ---------------------------------------------------------------------------
// Keyword-Scorer
// ---------------------------------------------------------------------------

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface KeywordScore {
  jaScore: number;
  neinScore: number;
  decision: "JA" | "NEIN" | "borderline";
  services: string; // erkannte High-Ticket-Leistungen, kommagetrennt
}

export function scoreKeywords(text: string): KeywordScore {
  const lower = text.toLowerCase();

  let jaScore = 0;
  const jaHits: string[] = [];
  for (const [phrase, weight] of JA_SIGNALS) {
    if (lower.includes(phrase)) {
      jaScore += weight;
      jaHits.push(titleCase(phrase));
    }
  }

  let neinScore = 0;
  for (const [phrase, weight] of NEIN_SIGNALS) {
    if (lower.includes(phrase)) neinScore += weight;
  }

  const services = [...new Set(jaHits)].join(", ");

  let decision: KeywordScore["decision"];
  if (jaScore >= JA_STRONG && neinScore <= OTHER_SIDE_NOISE) decision = "JA";
  else if (neinScore >= NEIN_STRONG && jaScore <= OTHER_SIDE_NOISE) decision = "NEIN";
  else decision = "borderline"; // Mischfall oder zu schwach → LLM entscheidet

  return { jaScore, neinScore, decision, services };
}

// ---------------------------------------------------------------------------
// Groq-LLM (nur für Grenzfälle) — OpenAI-kompatibel, native fetch
// ---------------------------------------------------------------------------

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const GROQ_SYSTEM_PROMPT = `Du analysierst deutsche SHK-Handwerksbetriebe (Sanitär/Heizung/Klima) anhand ihres Website-Texts und Impressums. Du machst DREI Dinge:

1) KLASSIFIKATION (High-Ticket?):
JA = hochpreisiger Installations-SHK: Badsanierung/-renovierung, Heizungstausch/-bau, Wärmepumpe, Komplettsanierung, energetische Sanierung — Projekte im Bereich 10.000–30.000 €.
NEIN = niedrigpreisig: reiner Notdienst, Rohr-/Abflussreinigung, kleine Reparaturen, nur Wartung — Tickets 200–800 €.
Unklar = Text lässt keine eindeutige Einordnung zu.

2) INHABER/GESCHÄFTSFÜHRER aus dem IMPRESSUM:
Gib den Namen der verantwortlichen natürlichen Person an (Inhaber, Geschäftsführer, oder die unter "Angaben gemäß § 5 TMG" / "vertreten durch" / "verantwortlich" genannte Person). NUR der Personenname (Vor- und Nachname), KEINE Firmenbezeichnung, KEINE §-Verweise, KEINE Adresse, KEINE Floskeln wie "vertreten durch". Wenn kein Personenname erkennbar ist, gib "" zurück.

3) BETRIEBSART (wie man den Betrieb am Telefon anspricht):
Ein kurzes, natürliches Label (2–5 Wörter), das sagt, WAS für ein Betrieb das konkret ist — so wie man es in einem Cold Call sagen würde. NICHT "SHK-Betrieb" (zu abstrakt), sondern das echte Gewerk, z.B. "Heizungsbauer", "Sanitär- und Heizungsbetrieb", "Wärmepumpen-Fachbetrieb", "Badsanierer / Badbauer", "Bäder und Heizung", "Klima- und Lüftungsbauer", "Sanitärinstallateur". Nimm den Schwerpunkt aus dem Website-Text. Wenn nichts Genaueres erkennbar ist, gib "SHK-Betrieb" zurück.

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt in genau diesem Format:
{"label": "JA" | "NEIN" | "Unklar", "confidence": <Zahl 0..1>, "services": [<erkannte relevante Leistungen als kurze Strings>], "owner": "<Personenname oder leerer String>", "businessType": "<kurzes Betriebsart-Label>"}`;

interface GroqResult {
  label: "JA" | "NEIN" | "Unklar";
  confidence: number;
  services: string[];
  owner: string;
  businessType: string;
}

export async function classifyWithGroq(
  servicesText: string,
  impressumText: string,
  apiKey: string
): Promise<GroqResult | null> {
  const maxAttempts = 3;
  let delayMs = 2000;

  const userContent =
    `LEISTUNGEN / WEBSITE-TEXT:\n${servicesText.slice(0, MAX_TEXT_LENGTH)}\n\n` +
    `IMPRESSUM:\n${impressumText ? impressumText.slice(0, 3000) : "(kein Impressum gefunden)"}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          temperature: 0,
          max_tokens: 400,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: GROQ_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(20000),
      });

      // Rate-Limit → warten und erneut versuchen
      if (res.status === 429 && attempt < maxAttempts) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delayMs;
        await new Promise((r) => setTimeout(r, wait));
        delayMs *= 2;
        continue;
      }

      if (!res.ok) return null;

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;

      const parsed = JSON.parse(content) as Partial<GroqResult>;
      const label =
        parsed.label === "JA" || parsed.label === "NEIN" ? parsed.label : "Unklar";
      const confidence =
        typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
          ? parsed.confidence
          : 0.6;
      const services = Array.isArray(parsed.services)
        ? parsed.services.filter((s): s is string => typeof s === "string").slice(0, 8)
        : [];
      const owner = typeof parsed.owner === "string" ? parsed.owner.trim().slice(0, 120) : "";
      const businessType =
        typeof parsed.businessType === "string" ? parsed.businessType.trim().slice(0, 80) : "";

      return { label, confidence, services, owner, businessType };
    } catch {
      // Timeout / Netzwerk / JSON-Parse → nächster Versuch oder Fallback
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs *= 2;
        continue;
      }
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Betriebsart-Fallback (Cold-Call-Sprache) — greift, wenn kein LLM verfügbar ist
// ---------------------------------------------------------------------------

// Reihenfolge = Priorität; das erste Kern-Gewerk zuerst im Label.
const TYPE_SIGNALS: Array<[RegExp, string]> = [
  [/w[äa]rmepumpe/i, "Wärmepumpe"],
  [/heizung|heizungsbau|brennwert|solarthermie|fu[sß]bodenheizung/i, "Heizung"],
  [/bad(sanierung|renovierung|gestaltung|umbau|modernisierung|planung)?|badezimmer|dusche|wellnessbad/i, "Bad"],
  [/sanit[äa]r|installat/i, "Sanitär"],
  [/klima|l[üu]ftung/i, "Klima & Lüftung"],
  [/flaschner|spengler|klempner/i, "Flaschner/Klempner"],
];

/** Leitet eine knappe Betriebsart aus dem Website-Text ab (Fallback ohne LLM). */
export function deriveBusinessType(text: string): string {
  const found: string[] = [];
  for (const [re, label] of TYPE_SIGNALS) {
    if (re.test(text) && !found.includes(label)) found.push(label);
  }
  if (found.length === 0) return "SHK-Betrieb";
  return found.slice(0, 2).join(" & ");
}

// ---------------------------------------------------------------------------
// Orchestrierung: Keyword zuerst, nur Grenzfälle ans LLM
// ---------------------------------------------------------------------------

export interface Classification {
  label: "JA" | "NEIN" | "Unklar";
  confidence: string; // z.B. "90% · Keyword" / "75% · LLM" / "—"
  services: string;
  owner: string; // via LLM aus dem Impressum extrahierter Inhaber/Geschäftsführer ("" wenn keiner)
  businessType: string; // Cold-Call-Betriebsart, z.B. "Heizungsbauer", "Badsanierer"
}

/**
 * Klassifiziert einen Lead und extrahiert den Inhaber/Geschäftsführer.
 * LLM-first: mit Groq-Key macht ein kombinierter Call Klassifikation + Inhaber.
 * Ohne Key / bei Groq-Ausfall greift der lokale Keyword-Scorer (ohne Inhaber).
 *
 * @param servicesText  via fetchLeadContent() geholter Website-Text
 * @param impressumText via fetchImpressumText() geholter Impressum-Text
 * @param apiKey  Groq-API-Key (optional)
 */
export async function classifyLead(
  servicesText: string,
  impressumText: string,
  apiKey: string | undefined
): Promise<Classification> {
  if ((!servicesText || servicesText.length < 40) && !impressumText) {
    return { label: "Unklar", confidence: "—", services: "", owner: "", businessType: "" };
  }

  // Betriebsart aus Website + Impressum ableiten (Fallback / LLM-Ergänzung)
  const typeSource = `${servicesText} ${impressumText}`;

  // LLM-first: ein Call für Klassifikation + Inhaber + Betriebsart
  if (apiKey) {
    const g = await classifyWithGroq(servicesText, impressumText, apiKey);
    if (g) {
      const kw = scoreKeywords(servicesText);
      return {
        label: g.label,
        confidence: `${Math.round(g.confidence * 100)}% · LLM`,
        services: g.services.length > 0 ? g.services.join(", ") : kw.services,
        // Inhaber: LLM bevorzugt, sonst Regex-Fallback aus dem Impressum
        owner: g.owner || extractOwner(impressumText),
        businessType: g.businessType || deriveBusinessType(typeSource),
      };
    }
  }

  // Fallback (kein Key / Groq ausgefallen): lokaler Keyword-Scorer.
  // Inhaber via Regex aus dem Impressum, Betriebsart via Keyword-Ableitung.
  // High-Ticket-Signale nicht verwerfen — lieber einen Lead zu viel prüfen.
  const kw = scoreKeywords(servicesText);
  let label: Classification["label"];
  let confidence: string;
  if (kw.decision === "JA") { label = "JA"; confidence = "90% · Keyword"; }
  else if (kw.decision === "NEIN") { label = "NEIN"; confidence = "90% · Keyword"; }
  else {
    label = kw.jaScore >= 3 ? "JA" : kw.neinScore >= 3 ? "NEIN" : "Unklar";
    confidence = "55% · Keyword (Fallback)";
  }
  return {
    label,
    confidence,
    services: kw.services,
    owner: extractOwner(impressumText),
    businessType: deriveBusinessType(typeSource),
  };
}
