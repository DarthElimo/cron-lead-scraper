// Einmaliges Script: eine konkrete Webseite scrapen und als Lead ins Google Sheet schreiben.
// Nutzt die Tool-Pipeline (fetchLeadContent + classifyLead) für Inhaber/High-Ticket/Leistungen.
// Ausführen:  node --env-file=.env _add-website-lead.mts "https://www.dl-mohit.de/"

import {
  fetchLeadContent,
  fetchImpressumText,
  classifyLead,
} from "./src/trigger/lead-scraper/high-ticket-classifier.ts";
import {
  getAccessToken,
  ensureHeaders,
  fetchExistingKeys,
  appendLeads,
  dedupeKey,
  SHEET_HEADERS,
} from "./src/trigger/lead-scraper/sheets-helpers.ts";

// --- Lead-Stammdaten dieser Webseite (aus Website + Impressum) --------------
const websiteUrl = process.argv[2] ?? "https://www.dl-mohit.de/";

const lead = {
  name: "Dienstleistungen Mohit",
  adresse: "Kötnerholzweg 57",
  stadt: "30451 Hannover",
  webseite: websiteUrl,
  telefon: "0511 44457966",
  email: "info@dl-mohit.de",
  bewertung: "",          // keine Google-Bewertung von der Webseite
  anzahlBewertungen: "",
  suchanfrage: "Manuell (Webseite)",
  datum: new Date().toISOString().slice(0, 10),
};

// --- Env ---------------------------------------------------------------------
const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const keyRaw = process.env.GOOGLE_PRIVATE_KEY;
const sheetId = process.env.GOOGLE_SPREADSHEET_ID;
const groqKey = process.env.GROQ_API_KEY;
if (!email) throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL ist nicht gesetzt");
if (!keyRaw) throw new Error("GOOGLE_PRIVATE_KEY ist nicht gesetzt");
if (!sheetId) throw new Error("GOOGLE_SPREADSHEET_ID ist nicht gesetzt");

// --- 1) Website scrapen + klassifizieren (Tool-Pipeline) ---------------------
console.log(`Scrape ${websiteUrl} …`);
const { servicesText, impressumText: impFromContent } = await fetchLeadContent(websiteUrl);
const impressumText = impFromContent || (await fetchImpressumText(websiteUrl));
const cls = await classifyLead(servicesText, impressumText, groqKey);
console.log(
  `Klassifikation: ${cls.label} (${cls.confidence}) | Inhaber: ${cls.owner || "—"} | Betriebsart: ${cls.businessType || "—"} | Leistungen: ${cls.services || "—"}`
);

// Inhaber-Fallback aus dem Impressum (falls die Klassifikation keinen liefert)
const inhaber = cls.owner || "Abdelkarim Mohit";

// --- 2) Zeile passend zu SHEET_HEADERS bauen ---------------------------------
const row = [
  lead.name,
  lead.adresse,
  lead.stadt,
  lead.webseite,
  lead.telefon,
  lead.email,
  lead.bewertung,
  lead.anzahlBewertungen,
  lead.suchanfrage,
  lead.datum,
  inhaber,
  cls.label,
  cls.confidence,
  cls.services,
  cls.businessType,
];
if (row.length !== SHEET_HEADERS.length) {
  throw new Error(`Spaltenanzahl passt nicht (${row.length} vs ${SHEET_HEADERS.length})`);
}

// --- 3) Ins Sheet schreiben (mit Dedupe) -------------------------------------
const token = await getAccessToken(email, keyRaw.replace(/\\n/g, "\n"));
await ensureHeaders(token, sheetId);

const existing = await fetchExistingKeys(token, sheetId);
const key = dedupeKey(lead.name, lead.adresse);
if (existing.has(key)) {
  console.log(`Lead "${lead.name}" existiert schon im Sheet — nichts geschrieben.`);
} else {
  await appendLeads(token, sheetId, [row]);
  console.log(`✅ Lead "${lead.name}" ins Sheet geschrieben.`);
}
