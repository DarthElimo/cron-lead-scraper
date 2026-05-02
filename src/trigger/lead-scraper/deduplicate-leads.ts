import { task } from "@trigger.dev/sdk/v3";
import { getAccessToken, dedupeKey } from "./sheets-helpers.js";

// ---------------------------------------------------------------------------
// Duplikat-Bereinigung — Formatierungen bleiben erhalten.
//
// Strategie: NUR die Duplikat-Zeilen gezielt löschen (deleteDimension),
// NICHT das Sheet leeren und neu schreiben. So bleiben alle Farben,
// Notizen und sonstigen Formatierungen der behaltenen Zeilen unberührt.
// Deletion von unten nach oben, damit die Zeilennummern beim Löschen
// nicht verrutschen.
// ---------------------------------------------------------------------------

async function getSheetId(token: string, spreadsheetId: string): Promise<number> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    throw new Error(`Spreadsheet-Metadaten Fehler ${res.status}: ${await res.text()}`);
  }
  const data = await res.json() as {
    sheets: Array<{ properties: { sheetId: number; title: string } }>;
  };
  // Erstes (aktives) Sheet nehmen
  return data.sheets[0].properties.sheetId;
}

async function readAllRows(token: string, spreadsheetId: string): Promise<string[][]> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A:K`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    throw new Error(`Google Sheets Lese-Fehler ${res.status}: ${await res.text()}`);
  }
  const data = await res.json() as { values?: string[][] };
  return data.values ?? [];
}

async function deleteRows(
  token: string,
  spreadsheetId: string,
  sheetId: number,
  // 0-basierte Zeilenindizes, bereits sortiert von groß nach klein
  rowIndices: number[]
): Promise<void> {
  // Sheets API erlaubt max. 1000 Requests pro batchUpdate
  const CHUNK = 1000;

  for (let i = 0; i < rowIndices.length; i += CHUNK) {
    const chunk = rowIndices.slice(i, i + CHUNK);

    const requests = chunk.map((idx) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: "ROWS",
          startIndex: idx,      // 0-basiert, inklusive
          endIndex: idx + 1,    // exklusive
        },
      },
    }));

    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      }
    );

    if (!res.ok) {
      throw new Error(`batchUpdate Fehler ${res.status}: ${await res.text()}`);
    }

    console.log(`  ${i + chunk.length}/${rowIndices.length} Duplikat-Zeilen gelöscht…`);

    if (i + CHUNK < rowIndices.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ---------------------------------------------------------------------------
// Haupttask
// ---------------------------------------------------------------------------

export const deduplicateLeads = task({
  id: "deduplicate-leads",
  run: async () => {
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
    if (!spreadsheetId) throw new Error("GOOGLE_SPREADSHEET_ID ist nicht gesetzt");

    const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    if (!serviceAccountEmail) throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL ist nicht gesetzt");

    const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;
    if (!privateKeyRaw) throw new Error("GOOGLE_PRIVATE_KEY ist nicht gesetzt");

    const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

    console.log("Google Sheets Authentifizierung…");
    const token = await getAccessToken(serviceAccountEmail, privateKey);
    console.log("Authentifizierung erfolgreich.");

    const sheetId = await getSheetId(token, spreadsheetId);
    console.log(`Sheet-ID: ${sheetId}`);

    console.log("Lese alle Zeilen aus dem Sheet…");
    const allRows = await readAllRows(token, spreadsheetId);

    if (allRows.length === 0) {
      console.log("Sheet ist leer — nichts zu bereinigen.");
      return { total: 0, unique: 0, removed: 0 };
    }

    // Zeile 0 ist der Header → Daten starten bei Index 1
    const HEADER_IDX = 0;
    const dataRows = allRows.slice(1);
    const totalRows = dataRows.length;
    console.log(`${totalRows} Datenzeilen geladen.`);

    // Duplikate finden: erste Vorkommnis behalten (kleinster Zeilenindex),
    // alle weiteren als zu löschende Zeilennummern (0-basiert) sammeln.
    const seen = new Set<string>();
    const toDelete: number[] = []; // 0-basierte Sheet-Zeilenindizes

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const name = row[0] ?? "";
      const address = row[1] ?? "";

      if (!name.trim()) continue; // leere Zeilen ignorieren

      const key = dedupeKey(name, address);

      if (seen.has(key)) {
        // +1 weil dataRows bei allRows[1] beginnt → Sheet-Zeilenindex = i + 1
        toDelete.push(i + 1);
      } else {
        seen.add(key);
      }
    }

    console.log(`Analyse: ${totalRows} Zeilen → ${totalRows - toDelete.length} eindeutig, ${toDelete.length} Duplikate gefunden.`);

    if (toDelete.length === 0) {
      console.log("Keine Duplikate gefunden — Sheet ist bereits sauber.");
      return { total: totalRows, unique: totalRows, removed: 0 };
    }

    // Von unten nach oben löschen, damit Zeilennummern nicht verrutschen
    const sortedDesc = toDelete.slice().sort((a, b) => b - a);

    console.log(`Lösche ${sortedDesc.length} Duplikat-Zeilen (Formatierungen bleiben erhalten)…`);
    await deleteRows(token, spreadsheetId, sheetId, sortedDesc);

    const unique = totalRows - toDelete.length;
    console.log(`✓ Bereinigung abgeschlossen! ${toDelete.length} Duplikate entfernt | ${unique} eindeutige Leads behalten.`);

    return {
      total: totalRows,
      unique,
      removed: toDelete.length,
    };
  },
});
