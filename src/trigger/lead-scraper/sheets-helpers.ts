import { createSign } from "crypto";

// ---------------------------------------------------------------------------
// Google Sheets Auth
// ---------------------------------------------------------------------------

function createJwt(email: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    })
  ).toString("base64url");

  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, "base64url");

  return `${header}.${payload}.${signature}`;
}

export async function getAccessToken(email: string, privateKey: string): Promise<string> {
  const jwt = createJwt(email, privateKey);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    throw new Error(`Google Auth Fehler ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as { access_token: string };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Duplikat-Erkennung
// ---------------------------------------------------------------------------

export function dedupeKey(name: string, address: string): string {
  return `${name.toLowerCase().trim()}|${address.toLowerCase().trim()}`;
}

export async function fetchExistingKeys(token: string, spreadsheetId: string): Promise<Set<string>> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A:B`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json() as { values?: string[][] };
  const keys = new Set<string>();
  for (const row of data.values ?? []) {
    if (row[0]) keys.add(dedupeKey(row[0], row[1] ?? ""));
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Schreiben in Google Sheets
// ---------------------------------------------------------------------------

export const SHEET_HEADERS = [
  "Name", "Adresse", "Stadt", "Webseite", "Telefon",
  "E-Mail", "Bewertung ★", "Anz. Bewertungen", "Suchanfrage", "Datum",
  "Geschäftsführer",
];

export async function ensureHeaders(token: string, spreadsheetId: string): Promise<void> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:K1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json() as { values?: string[][] };

  const currentHeaders = data.values?.[0] ?? [];
  if (currentHeaders.length < SHEET_HEADERS.length) {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:K1?valueInputOption=RAW`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [SHEET_HEADERS] }),
      }
    );
    if (currentHeaders.length === 0) {
      console.log("Spaltenüberschriften angelegt.");
    } else {
      console.log(`Spaltenüberschriften aktualisiert (${currentHeaders.length} → ${SHEET_HEADERS.length} Spalten).`);
    }
  }
}

export async function appendLeads(
  token: string,
  spreadsheetId: string,
  rows: string[][]
): Promise<void> {
  const maxAttempts = 5;
  let delayMs = 60_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A:K:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: rows }),
      }
    );

    if (res.ok) return;

    if (res.status === 429 && attempt < maxAttempts) {
      console.log(`Google Sheets Schreib-Limit erreicht (429). Warte ${delayMs / 1000}s, dann Versuch ${attempt + 1}/${maxAttempts}…`);
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 1.5, 300_000);
      continue;
    }

    throw new Error(`Google Sheets Fehler ${res.status}: ${await res.text()}`);
  }
}
