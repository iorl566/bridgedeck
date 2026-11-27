# BridgeDeck — pt-PT store listing

Locale: `pt-PT` (package locale `pt_PT`)

Name (from manifest, read-only): `BridgeDeck`

Short description (from manifest `_locales/pt_PT/messages.json`, read-only):
BridgeDeck transforma o navegador já ligado num espaço de trabalho para o seu agente de IA. Daemon local + extensão MV3, sem telemetria.

## Description

O BridgeDeck transforma o navegador que já utiliza num espaço de trabalho para o seu agente de IA.

O agente recebe a tarefa e executa-a na sua própria Agent Window, com as sessões em que já tem sessão iniciada — e o utilizador mantém o controlo, podendo assumir a qualquer momento.

O QUE PODE FAZER

- Trabalhar onde já tem sessão iniciada: ler documentos, pesquisar em sites da intranet e concluir fluxos web que exigem a sua própria conta.
- Transformar instruções em ações no navegador: ler a estrutura da página, clicar, escrever, preencher formulários, selecionar opções, arrastar, deslocar, carregar e transferir ficheiros e gerir separadores.
- Manter o controlo: um cartão de controlo visível, uma moldura azul pulsante à volta da página controlada, pausa e paragem a qualquer momento, e um pedido de confirmação antes de o agente utilizar um dos seus separadores.
- Levar os dados da web consigo: extrair tabelas e listas em JSON ou CSV, com os nomes das colunas e a página ou frame de origem de cada valor.
- Encontrar as provas por trás de uma falha: pedidos, corpos de resposta, mensagens da consola, alterações na página, tempos de desempenho e verificações de pedidos duplicados, tudo exportável em JSON.
- Guardar uma gravação do trabalho: gravar um separador de tarefa autorizado em MP4 silencioso e, depois, pré-visualizar, guardar ou eliminar dentro da extensão.
- Capturar páginas longas: deslocamento automático, junção manual ou apenas a área visível.
- Manter um registo: auditoria de operações opcional, histórico de tarefas e provas guardados localmente.

FEITO PARA AGENTES

Uma CLI, um servidor MCP (92 ferramentas), um plugin do DeepSeek Harness (37 ferramentas) e SDKs para Node.js e Python. Qualquer agente que consiga executar comandos de shell pode conduzir o navegador; nada está dependente de um modelo ou fornecedor específico.

LOCAL E PRIVADO POR OMISSÃO

- Liga-se a um daemon local em 127.0.0.1; sem serviço na nuvem e sem telemetria.
- O emparelhamento remoto é opcional e usa sempre WSS autenticado; as ligações locais não emparelhadas continuam a funcionar, mas mostram um aviso de identidade.
- Capturas de ecrã, gravações, provas de depuração e registos de auditoria ficam na sua máquina.
- A extensão nunca contacta um fornecedor de IA por iniciativa própria.

REQUISITOS

- Microsoft Edge, Google Chrome ou outro navegador baseado em Chromium, versão 111 ou posterior.
- Node.js 20 ou posterior para o daemon local e a CLI.
- O daemon funciona em Windows, macOS e Linux. O Windows tem instalador gráfico; o macOS e o Linux usam um ficheiro tar.gz com install.sh.

PRIMEIROS PASSOS

Instale a extensão, abra a janela pop-up e confirme que mostra "Ligado". O daemon arranca automaticamente na primeira vez que executa um comando bridge.

Código-fonte, guia de instalação da CLI e documentação: https://github.com/iorl566/bridgedeck

Aviso de privacidade: https://iorl566.github.io/bridgedeck-privacy/privacy-policy.html

## Search terms

- automatização de navegador
- agente de IA
- controlo do navegador
- extração de dados web
- leitura de páginas
- servidor MCP
- extensão Edge

## Notes for the listing editor

- The name and short description are read-only in Partner Center: they come from the package manifest. Change them by updating `extension/_locales/pt_PT/messages.json` and re-uploading the package.
- Keep the section headings in capitals; the store page renders the text as plain paragraphs with line breaks.
- Counts (92 MCP tools, 37 plugin tools) are asserted by `tests/unit/mcp-tool-methods.test.mjs` and `tests/unit/dsh-tools.test.mjs`; update this file if those change.
