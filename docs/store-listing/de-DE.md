# BridgeDeck — de-DE store listing

Locale: `de-DE` (package locale `de`)

Name (from manifest, read-only): `BridgeDeck`

Short description (from manifest `_locales/de/messages.json`, read-only):
BridgeDeck macht aus deinem bereits angemeldeten Browser einen Arbeitsbereich für deinen KI-Agenten. Lokaler Daemon + MV3-Erweiterung, keine Telemetrie.

## Description

BridgeDeck macht aus dem Browser, den du ohnehin schon nutzt, einen Arbeitsbereich für deinen KI-Agenten.

Gib deinem Agenten eine Aufgabe – er arbeitet in seinem eigenen Agent Window mit den Sitzungen, in denen du bereits angemeldet bist. Du behältst die Kontrolle und kannst jederzeit übernehmen.

WAS DU TUN KANNST

- Arbeiten, wo du bereits angemeldet bist: Dokumente lesen, Intranetseiten durchsuchen und Web-Abläufe abschließen, die dein eigenes Konto brauchen.
- Anweisungen in Browseraktionen umsetzen: Seitenstruktur lesen, klicken, tippen, Formulare ausfüllen, Optionen auswählen, ziehen, scrollen, Dateien hoch- und herunterladen sowie Tabs verwalten.
- Die Kontrolle behalten: eine sichtbare Steuerkarte, ein blauer, atmender Rahmen um die gesteuerte Seite, Pause und Stopp jederzeit – und eine Rückfrage, bevor der Agent einen deiner Tabs übernimmt.
- Webdaten mitnehmen: Tabellen und Listen als JSON oder CSV exportieren, mit Spaltennamen und der Seite bzw. dem Frame, aus dem jeder Wert stammt.
- Belege für einen Fehlschlag finden: Requests, Response-Bodies, Konsolenmeldungen, Seitenänderungen, Performance-Zeiten und Prüfungen auf doppelte Requests – exportierbar als JSON.
- Die Arbeit nachvollziehbar aufbewahren: einen freigegebenen Aufgaben-Tab als stille MP4 aufzeichnen und die Aufnahme in der Erweiterung ansehen, speichern oder löschen.
- Lange Seiten erfassen: automatisches Scrollen, manuelles Zusammensetzen oder nur der sichtbare Bereich.
- Ein Protokoll führen: optionales Ablauf-Audit, Aufgabenverlauf und Belege – lokal gespeichert.

FÜR AGENTEN GEBAUT

Eine CLI, ein MCP-Server (92 Tools), ein DeepSeek-Harness-Plugin (37 Tools) sowie SDKs für Node.js und Python. Jeder Agent, der Shell-Befehle ausführen kann, kann den Browser steuern; nichts ist an ein bestimmtes Modell oder einen Anbieter gebunden.

LOKAL UND PRIVAT ALS STANDARD

- Verbindet sich mit einem lokalen Daemon auf 127.0.0.1; kein Cloud-Dienst und keine Telemetrie.
- Remote-Pairing ist optional und nutzt immer authentifiziertes WSS; nicht gepaarte lokale Verbindungen funktionieren weiterhin, zeigen aber einen Identitätshinweis.
- Screenshots, Aufzeichnungen, Debug-Belege und Audit-Einträge bleiben auf deinem Rechner.
- Die Erweiterung ruft niemals von sich aus einen KI-Anbieter auf.

VORAUSSETZUNGEN

- Microsoft Edge oder ein anderer Chromium-basierter Browser, Version 111 oder neuer.
- Node.js 20 oder neuer für den lokalen Daemon und die CLI.
- Der Daemon läuft unter Windows, macOS und Linux. Für Windows gibt es einen grafischen Installer; macOS und Linux nutzen ein tar.gz-Archiv mit install.sh.

ERSTE SCHRITTE

Installiere die Erweiterung, öffne das Popup und prüfe, ob dort „Verbunden“ steht. Der Daemon startet automatisch, wenn du zum ersten Mal einen Bridge-Befehl ausführst.

Quellcode, Installationsanleitung für die CLI und Dokumentation: https://github.com/iorl566/bridgedeck

Datenschutzhinweis: https://iorl566.github.io/bridgedeck-privacy/privacy-policy.html

## Search terms

- Browser-Automatisierung
- KI-Agent
- Browser steuern
- Web Scraping
- Webseiten auslesen
- MCP-Server
- Edge-Erweiterung

## Notes for the listing editor

- The name and short description are read-only in Partner Center: they come from the package manifest. Change them by updating `extension/_locales/de/messages.json` and re-uploading the package.
- Keep the section headings in capitals; the store page renders the text as plain paragraphs with line breaks.
- Counts (92 MCP tools, 37 plugin tools) are asserted by `tests/unit/mcp-tool-methods.test.mjs` and `tests/unit/dsh-tools.test.mjs`; update this file (`docs/store-listing/de-DE.md`) if those change.
