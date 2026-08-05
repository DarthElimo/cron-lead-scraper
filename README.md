# AI Lead Scraper — Setup Guide

Automatischer Google Maps Lead Scraper mit E-Mail-Extraktion. Sucht Unternehmen nach Branche und Stadt und schreibt die Leads direkt in ein Google Sheet.

**Gebaut mit:** [Trigger.dev](https://trigger.dev) · [DataForSEO](https://dataforseo.com) · [Google Sheets API](https://developers.google.com/sheets/api)

---

## Was du brauchst

Bevor du anfängst, erstelle Accounts bei diesen drei Diensten:

| Dienst | Wofür | Kosten |
|---|---|---|
| [DataForSEO](https://app.dataforseo.com/register) | Google Maps Daten abrufen | $1 Startguthaben gratis |
| [Google Cloud](https://console.cloud.google.com) | Ergebnisse in Google Sheets schreiben | Kostenlos |
| [Trigger.dev](https://trigger.dev) | Automatisierung ausführen | Kostenlos |

---

## Schritt 1 — Repo herunterladen

**Option A: Als ZIP** (empfohlen für Einsteiger)
1. Oben auf dieser Seite auf den grünen **"Code"** Button klicken
2. **"Download ZIP"** wählen
3. ZIP entpacken

**Option B: Mit Git klonen**
```bash
git clone https://github.com/DarthElimo/cron-lead-scraper.git
cd cron-lead-scraper
```

---

## Schritt 2 — Node.js installieren

Falls noch nicht installiert: [nodejs.org](https://nodejs.org) → LTS Version herunterladen und installieren.

Prüfen ob es klappt:
```bash
node --version
```
Es sollte eine Versionsnummer erscheinen (z.B. `v20.11.0`).

---

## Schritt 3 — Claude Code installieren

Claude Code ist die KI-Assistenz die dir beim Setup und bei Anpassungen hilft.

```bash
npm install -g @anthropic-ai/claude-code
```

Dann starten:
```bash
claude
```

Beim ersten Start wirst du nach deinem Anthropic API Key gefragt. Den bekommst du unter [console.anthropic.com](https://console.anthropic.com).

---

## Schritt 4 — Dependencies installieren

Im Projektordner ausführen:
```bash
npm install
```

---

## Schritt 5 — API Keys besorgen

### 5a. DataForSEO (für Google Maps Daten)

1. Gehe auf [app.dataforseo.com/register](https://app.dataforseo.com/register)
2. Kostenlosen Account erstellen — du bekommst **$1 Startguthaben** (reicht für ~hunderte Leads)
3. Deine **E-Mail-Adresse** und dein **Passwort** sind gleichzeitig deine API-Zugangsdaten

### 5b. Google Sheets (für die Ausgabe)

**Service Account erstellen:**

1. Gehe auf [console.cloud.google.com](https://console.cloud.google.com)
2. Oben links: **Neues Projekt** erstellen (beliebiger Name, z.B. "Lead Scraper")
3. Im Menü: **APIs & Services → Library**
4. Nach **"Google Sheets API"** suchen → **Aktivieren**
5. Im Menü: **APIs & Services → Credentials**
6. Oben: **"+ Create Credentials" → "Service Account"**
7. Beliebigen Namen eingeben (z.B. "lead-scraper") → **"Done"**
8. Auf den erstellten Service Account klicken
9. Reiter **"Keys"** → **"Add Key" → "Create new key" → "JSON"**
10. Die JSON-Datei wird automatisch heruntergeladen — **nicht löschen!**

**Aus der JSON-Datei brauchst du:**
- `client_email` → das ist deine `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `private_key` → das ist dein `GOOGLE_PRIVATE_KEY`

**Google Sheet vorbereiten:**
1. Öffne [sheets.google.com](https://sheets.google.com) und erstelle ein neues Sheet
2. Die **Spreadsheet ID** steht in der URL: `https://docs.google.com/spreadsheets/d/`**`DIESE_ID`**`/edit`
3. Klicke im Sheet oben rechts auf **"Teilen"**
4. Trage die `client_email` aus der JSON-Datei ein
5. Berechtigungen: **"Bearbeiter"** → **"Senden"**

### 5c. Trigger.dev (für die Automatisierung)

1. Gehe auf [trigger.dev](https://trigger.dev) und erstelle einen kostenlosen Account
2. **"New Project"** erstellen (beliebiger Name)
3. Links im Menü: **Project Settings → API Keys**
4. Den **Secret Key** kopieren (beginnt mit `tr_dev_...`)

---

## Schritt 6 — .env Datei einrichten

1. Im Projektordner die Datei `.env.example` **kopieren** und in `.env` **umbenennen**
2. Die `.env` Datei öffnen und alle Werte eintragen:

```env
DATAFORSEO_LOGIN=deine-email@example.com
DATAFORSEO_PASSWORD=dein-dataforseo-passwort
GOOGLE_SERVICE_ACCOUNT_EMAIL=dein-service-account@dein-projekt.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_SPREADSHEET_ID=deine-spreadsheet-id
TRIGGER_SECRET_KEY=tr_dev_xxxxxxxxxxxxxxxxxxxx
```

> **Wichtig beim `GOOGLE_PRIVATE_KEY`:** Den Key aus der JSON-Datei kopieren und alle echten Zeilenumbrüche durch `\n` ersetzen — alles muss in einer einzigen Zeile stehen.

---

## Schritt 7 — Lokal testen

```bash
npm run dev
```

Der Trigger.dev Dev-Server startet. Im Terminal siehst du einen Link zu deinem lokalen Dashboard.

---

## Schritt 8 — Ersten Scrape ausführen

Im Trigger.dev Dashboard (oder via Claude Code) kannst du einen Test-Run starten:

```json
{
  "keyword": "Zahnarzt",
  "location": "München",
  "count": 10,
  "emailSearch": false,
  "maxReviews": 100
}
```

`maxReviews` sortiert Betriebe mit mehr Google-Bewertungen aus. Weglassen = kein Filter. Ist der Filter aktiv, sucht der Scraper automatisch tiefer, damit trotzdem die volle Anzahl Leads zusammenkommt.

Die Ergebnisse erscheinen nach wenigen Sekunden in deinem Google Sheet.

---

## Schritt 9 — In der Cloud deployen (optional)

Damit die Automatisierung auch ohne deinen Computer läuft:

1. Im Trigger.dev Dashboard: **Project Settings → Environment Variables**
2. Alle Keys aus deiner `.env` auch hier eintragen (sowohl für Staging als auch Production)
3. Dann deployen:

```bash
npm run deploy
```

---

## Features

| Feature | Beschreibung |
|---|---|
| **Single Scrape** | Eine Branche in einer Stadt scrapen |
| **Bulk Scrape** | Mehrere Branchen × mehrere Städte auf einmal |
| **E-Mail-Extraktion** | Besucht automatisch die Website und sucht nach Kontakt-E-Mails |
| **Duplikat-Prüfung** | Bereits vorhandene Leads werden übersprungen |
| **Google Sheets Output** | Alle Leads landen automatisch im Sheet |

---

## Hilfe & Anpassungen

Öffne einfach den Projektordner mit VS Code und starte Claude Code:

```bash
claude
```

Claude kennt das gesamte Projekt und hilft dir bei:
- Anpassungen (andere Sprache, anderes Land, andere Felder)
- Fehlerbehebung
- Neuen Features

---

## Struktur

```
src/trigger/lead-scraper/
  scrape-leads.ts      ← Haupt-Task: scrapen + ins Sheet schreiben
  bulk-scrape.ts       ← Orchestrator für Massen-Scraping
  sheets-helpers.ts    ← Google Sheets Hilfsfunktionen
  deduplicate-leads.ts ← Duplikate aus dem Sheet entfernen
```
