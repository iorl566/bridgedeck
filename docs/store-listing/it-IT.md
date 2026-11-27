# BridgeDeck — it-IT store listing

Locale: `it-IT` (package locale `it`)

Name (from manifest, read-only): `BridgeDeck`

Short description (from manifest `_locales/it/messages.json`, read-only):
BridgeDeck trasforma il browser già connesso in uno spazio di lavoro per il tuo agente IA. Daemon locale + estensione MV3, senza telemetria.

## Description

BridgeDeck trasforma il browser che già usi in uno spazio di lavoro per il tuo agente IA.

Assegna un compito al tuo agente: lavorerà in una propria Agent Window con le sessioni a cui hai già effettuato l'accesso, mentre tu mantieni il controllo e puoi riprendere in qualsiasi momento.

COSA PUOI FARE

- Lavorare dove hai già effettuato l'accesso: leggere documenti, cercare nei siti intranet e completare flussi web che richiedono il tuo account.
- Trasformare le istruzioni in azioni nel browser: leggere la struttura della pagina, fare clic, digitare, compilare moduli, selezionare opzioni, trascinare, scorrere, caricare e scaricare file e gestire le schede.
- Mantenere il controllo: una scheda di controllo visibile, un bordo blu «pulsante» intorno alla pagina controllata, pausa e arresto in qualsiasi momento e una richiesta di conferma prima che l'agente prenda in prestito una delle tue schede.
- Portare via i dati del web: estrai tabelle ed elenchi in JSON o CSV, con i nomi delle colonne e la pagina o il frame da cui proviene ogni valore.
- Trovare le prove di un errore: richieste, corpi delle risposte, messaggi della console, cambiamenti di pagina, tempi di prestazione e controllo delle richieste duplicate, esportabili in JSON.
- Conservare una replica del lavoro: registra una scheda di attività autorizzata come MP4 silenzioso, poi visualizzala, salvala o eliminala nell'estensione.
- Catturare pagine lunghe: scorrimento automatico, cucitura manuale o solo l'area visibile.
- Tenere un registro: audit delle operazioni opzionale, cronologia delle attività e prove, salvati in locale.

PENSATO PER GLI AGENTI

Una CLI, un server MCP (92 strumenti), un plugin DeepSeek Harness (37 strumenti) e SDK per Node.js e Python. Qualsiasi agente in grado di eseguire comandi shell può pilotare il browser; nulla è legato a un modello o a un fornitore specifico.

LOCALE E PRIVATO PER IMPOSTAZIONE PREDEFINITA

- Si connette a un daemon locale su 127.0.0.1; nessun servizio cloud e nessuna telemetria.
- L'accoppiamento remoto è opzionale e usa sempre WSS autenticato; le connessioni locali non accoppiate funzionano comunque, ma mostrano un avviso di identità.
- Screenshot, registrazioni, prove di debug e record di audit restano sul tuo computer.
- L'estensione non chiama mai un fornitore di IA di propria iniziativa.

REQUISITI

- Microsoft Edge, Google Chrome o un altro browser basato su Chromium, versione 111 o successiva.
- Node.js 20 o successivo per il daemon locale e la CLI.
- Il daemon funziona su Windows, macOS e Linux. Windows ha un installer grafico; macOS e Linux usano un archivio tar.gz con install.sh.

PER INIZIARE

Installa l'estensione, apri il popup e verifica che mostri «Connesso». Il daemon si avvia automaticamente la prima volta che esegui un comando bridge.

Codice sorgente, guida all'installazione della CLI e documentazione: https://github.com/iorl566/bridgedeck

Informativa sulla privacy: https://iorl566.github.io/bridgedeck-privacy/privacy-policy.html

## Search terms

- automazione del browser
- agente IA
- controllo del browser
- web scraping
- lettura delle pagine web
- server MCP
- estensione Edge

## Notes for the listing editor

- The name and short description are read-only in Partner Center: they come from the package manifest. Change them by updating `extension/_locales/it/messages.json` and re-uploading the package.
- Keep the section headings in capitals; the store page renders the text as plain paragraphs with line breaks.
- Counts (92 MCP tools, 37 plugin tools) are asserted by `tests/unit/mcp-tool-methods.test.mjs` and `tests/unit/dsh-tools.test.mjs`; update this file (`docs/store-listing/it-IT.md`) if those change.
