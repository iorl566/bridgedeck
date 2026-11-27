# BridgeDeck — fr-FR store listing

Locale: `fr-FR` (package locale `fr`)

Name (from manifest, read-only): `BridgeDeck`

Short description (from manifest `_locales/fr/messages.json`, read-only):
BridgeDeck transforme votre navigateur déjà connecté en espace de travail pour votre agent IA. Daemon local + extension MV3, sans télémétrie.

## Description

BridgeDeck transforme le navigateur que vous utilisez déjà en espace de travail pour votre agent IA.

Confiez une tâche à votre agent : il travaille dans sa propre Agent Window, avec les sessions auxquelles vous êtes déjà connecté ; vous gardez la main et pouvez reprendre à tout moment.

CE QUE VOUS POUVEZ FAIRE

- Travailler là où vous êtes déjà connecté : lire des documents, chercher dans les sites intranet et aller au bout des parcours web qui exigent votre compte.
- Transformer une consigne en actions dans le navigateur : lire la structure d'une page, cliquer, saisir du texte, remplir des formulaires, choisir des options, glisser-déposer, défiler, envoyer et télécharger des fichiers, gérer les onglets.
- Garder la main : une carte de contrôle visible, une bordure bleue « respirante » autour de la page contrôlée, pause et arrêt à tout moment, et une confirmation avant que l'agent emprunte l'un de vos onglets.
- Emporter les données du web : extraire tableaux et listes en JSON ou CSV, avec les noms de colonnes et la page ou le frame d'où vient chaque valeur.
- Retrouver les preuves d'un échec : requêtes, corps de réponse, messages de console, changements de page, temps de performance et requêtes en double détectées, exportables en JSON.
- Conserver une trace rejouable : enregistrer un onglet de tâche autorisé en MP4 silencieux, puis le visionner, l'enregistrer ou le supprimer dans l'extension.
- Capturer des pages longues : défilement automatique, assemblage manuel ou zone visible seule.
- Tenir un journal : audit des opérations en option, historique des tâches et preuves, stockés en local.

CONÇU POUR LES AGENTS

Une CLI, un serveur MCP (92 outils), un plugin DeepSeek Harness (37 outils) et des SDK Node.js et Python. Tout agent qui sait lancer des commandes shell peut piloter le navigateur ; rien n'est lié à un modèle ni à un fournisseur particulier.

LOCAL ET PRIVÉ PAR DÉFAUT

- Se connecte à un daemon local sur 127.0.0.1 ; aucun service cloud et aucune télémétrie.
- L'appairage à distance est optionnel et utilise toujours WSS authentifié ; les connexions locales non appairées fonctionnent, mais affichent un avertissement d'identité.
- Captures d'écran, enregistrements, preuves de débogage et journaux d'audit restent sur votre machine.
- L'extension n'appelle jamais un fournisseur d'IA de sa propre initiative.

CONFIGURATION REQUISE

- Microsoft Edge ou un autre navigateur basé sur Chromium, version 111 ou ultérieure.
- Node.js 20 ou ultérieur pour le daemon local et la CLI.
- Le daemon tourne sous Windows, macOS et Linux. Windows a un installateur graphique ; macOS et Linux utilisent une archive tar.gz avec install.sh.

POUR COMMENCER

Installez l'extension, ouvrez le popup et vérifiez qu'il affiche « Connecté ». Le daemon démarre automatiquement au premier lancement d'une commande bridge.

Code source, guide d'installation de la CLI et documentation : https://github.com/iorl566/bridgedeck

Avis de confidentialité : https://iorl566.github.io/bridgedeck-privacy/privacy-policy.html

## Search terms

- automatisation navigateur
- agent IA
- pilotage du navigateur
- scraping web
- lecture de pages web
- serveur MCP
- extension Edge

## Notes for the listing editor

- The name and short description are read-only in Partner Center: they come from the package manifest. Change them by updating `extension/_locales/fr/messages.json` and re-uploading the package.
- Keep the section headings in capitals; the store page renders the text as plain paragraphs with line breaks.
- Counts (92 MCP tools, 37 plugin tools) are asserted by `tests/unit/mcp-tool-methods.test.mjs` and `tests/unit/dsh-tools.test.mjs`; update this file (`docs/store-listing/fr-FR.md`) if those change.
