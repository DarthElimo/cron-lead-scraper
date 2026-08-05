# Referenz — High-Ticket-SHK-Lead-Filter für Angebotsnachverfolgung

*Diese Datei bündelt alles, was dieser Scraper aus dem AIOS-Projekt "Angebotsnachverfolgung" braucht, um gezielt die richtigen Leads zu liefern. Quelle: AIOS (`/Users/elimo/AutoRise AI/AIOS/`). Stand: 2026-06-22. Die genaue Umsetzung (Pipeline, Interface-Mechanik) wird HIER im Projekt geplant — diese Datei liefert nur Kontext + Constraints.*

---

## Worum es geht

AutoRise AIs neues Hauptoffer ist **Angebotsnachverfolgung** (Performance-basiert: abkühlende Angebote von SHK-Betrieben werden per KI-Sequenz reaktiviert, der Betrieb zahlt nur bei zurückgeholtem Auftrag). Das Offer funktioniert **nur für hochpreisige Installations-SHK** — bei kleinen Tickets lohnt sich Performance-Pricing nicht.

**Ziel für diesen Scraper:** Eine im Interface (`scraper-ui.html`) aktivierbare **Option, die gezielt High-Ticket-SHK-Leads** sucht und/oder die bestehende Lead-Liste danach filtert. So wird aus der generischen SHK-Liste eine saubere Cold-Call-Liste, die zum Offer passt.

---

## Der Ziel-Lead (ICP)

**JA — das ist der Lead:**
- Hochpreisiger **Installations-SHK**: Bäder, Heizungstausch, Sanierung, Wärmepumpe, Komplettsanierung
- Typische Angebotswerte **€10.000–30.000**

**NEIN — raus:**
- Notdienst / Reparatur / Rohrreinigung / reine Wartung (Tickets €200–800, zu klein für Performance-Pricing)

---

## Klassifikations-Signale (für den Filter)

**Hauptsignal = Website-Leistungen** (reicht, bestätigt):

| Label | Erkannte Leistungen |
|---|---|
| **High-Ticket = JA** | Badsanierung · Heizungsbau · Heizungstausch · Wärmepumpe · Komplettsanierung |
| **High-Ticket = NEIN** | Notdienst · Rohrreinigung · kleine Reparaturen · nur Wartung |

**Sekundärsignale (optional fürs Scoring):**
- Google-Maps-Kategorie
- Projekt-Fotos auf der Website (Großprojekte)
- Reviews, die Großprojekte erwähnen → im Sheet schon vorhanden als Spalten **`Bewertung ★`** + **`Anz. Bewertungen`**
- Meisterbetrieb / Innungsmitgliedschaft

---

## Enrichment-Pipeline (Konzept)

**Input:** bestehende Lead-Zeilen im Google Sheet. Aktuelle Spalten (`SHEET_HEADERS` in `src/trigger/lead-scraper/sheets-helpers.ts`):
> `Name · Adresse · Stadt · Webseite · Telefon · E-Mail · Bewertung ★ · Anz. Bewertungen · Suchanfrage · Datum · Geschäftsführer · High-Ticket? · Confidence · Erkannte Leistungen · Betriebsart`
>
> `Betriebsart` = Cold-Call-Bezeichnung des Betriebs (z.B. "Heizungsbauer", "Wärmepumpen-Fachbetrieb", "Badsanierer") — vom LLM gesetzt, Keyword-Fallback ohne LLM.

**Schritte:**
1. Pro Lead die **`Webseite`** scrapen (native `fetch` wie im restlichen Projekt, oder ein Scrape-Dienst).
2. **KI (Claude API) klassifiziert** anhand der Leistungen → Label `High-Ticket ja/nein` + `Confidence` + `erkannte Leistungen`.
3. Ergebnis **zurück ins Sheet** als neue Spalten, z.B. `High-Ticket?` · `Confidence` · `Erkannte Leistungen`.
4. Gefilterte Ansicht/Liste = nur `High-Ticket = JA` → das ist die Akquise-Liste fürs Offer.

**Bausteine (alle vorhanden):** Google Sheets ist im Projekt schon angebunden · native `fetch` für Website-Scrape · Claude API für die Klassifikation · DataForSEO liefert beim Scrape bereits Maps-Kategorie/Reviews.

**Aufwand:** klein — ein Enrichment-Step an die bestehende Scraper-Pipeline angehängt (eigener trigger.dev-Task, der über die Sheet-Zeilen läuft).

---

## Interface-Option (der eigentliche Wunsch)

Im `scraper-ui.html` eine Option ergänzen, die zwei Dinge bündelt:
1. **Gezielter Scrape:** SHK-relevante Such-Keywords statt generisch — z.B. *Heizungsbau · Badsanierung · Wärmepumpe Installateur · Sanitär Installation · Komplettsanierung* (statt nur "Sanitär" / "SHK").
2. **Enrichment-Filter:** die gescrapten Leads durch die Klassifikation oben laufen lassen und nur `High-Ticket = JA` behalten/markieren.

→ Genaue UI- und Ablauf-Mechanik wird hier im Projekt geplant.

---

## Warum das zählt (Kontext)

- Angebotsnachverfolgung ist **near-revenue** und **Performance-basiert** — eine saubere High-Ticket-Liste entscheidet direkt über die Akquise-Conversion.
- Lead-Enrichment ist klein, unabhängig und **entblockt die Akquise**, während der große Tool-Bau (Sequenz-Engine/Dashboard) im AIOS läuft.
- Pilot-Cap aktuell **3 Betriebe** gleichzeitig — Qualität der Liste > Menge.

---

## Tiefere Quellen im AIOS (anderes Repo, absolute Pfade)

- **Lead-Enrichment-Spec:** `/Users/elimo/AutoRise AI/AIOS/projects/internal/angebots-reaktivierung/tool-bau-backlog.md` (#1)
- **Offer (Zielkunde §1, USP §1b):** `…/projects/internal/angebots-reaktivierung/OFFER.md`
- **Prozess-Mapping (gesamte Delivery-Kette):** `…/projects/internal/angebots-reaktivierung/prozess-mapping.md`
- **Research (SHK, Einwände, Wettbewerb):** `…/references/research/shk-angebots-nachfass-research.md`
- **Projekt-Hub/INDEX:** `…/projects/internal/angebots-reaktivierung/angebotsnachverfolgung-INDEX.md`
