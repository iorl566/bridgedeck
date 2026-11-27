# BridgeDeck — pt-BR store listing

Locale: `pt-BR` (package locale `pt_BR`)

Name (from manifest, read-only): `BridgeDeck`

Short description (from manifest `_locales/pt_BR/messages.json`, read-only):
BridgeDeck transforma o navegador já conectado em um espaço de trabalho para o seu agente de IA. Daemon local + extensão MV3, sem telemetria.

## Description

O BridgeDeck transforma o navegador que você já usa em um espaço de trabalho para o seu agente de IA.

Dê uma tarefa ao agente e ele trabalha na própria Agent Window, com as sessões em que você já está conectado — e você continua no controle, podendo assumir a qualquer momento.

O QUE VOCÊ PODE FAZER

- Trabalhe onde já está conectado: leia documentos, pesquise em sistemas internos e conclua fluxos da web que exigem a sua própria conta.
- Transforme instruções em ações no navegador: leia a estrutura da página, clique, digite, preencha formulários, selecione opções, arraste, role, envie e baixe arquivos e gerencie abas.
- Continue no controle: um cartão de controle visível, uma borda azul pulsante ao redor da página controlada, pausa e parada a qualquer momento, e uma confirmação antes de o agente usar uma das suas abas.
- Leve os dados da web com você: extraia tabelas e listas como JSON ou CSV, com os nomes das colunas e a página ou frame de origem de cada valor.
- Encontre as evidências por trás de uma falha: requisições, corpos de resposta, mensagens do console, mudanças na página, tempos de desempenho e checagens de requisições duplicadas, tudo exportável como JSON.
- Guarde uma gravação do trabalho: grave uma aba de tarefa autorizada como um MP4 silencioso e depois visualize, salve ou exclua dentro da extensão.
- Capture páginas longas: rolagem automática, costura manual ou apenas a área visível.
- Mantenha um registro: auditoria de operações opcional, histórico de tarefas e evidências armazenados localmente.

FEITO PARA AGENTES

Uma CLI, um servidor MCP (92 ferramentas), um plugin do DeepSeek Harness (37 ferramentas) e SDKs para Node.js e Python. Qualquer agente que consiga executar comandos de shell pode conduzir o navegador; nada fica preso a um modelo ou fornecedor específico.

LOCAL E PRIVADO POR PADRÃO

- Conecta-se a um daemon local em 127.0.0.1; nenhum serviço na nuvem e nenhuma telemetria.
- O emparelhamento remoto é opcional e sempre usa WSS autenticado; conexões locais não emparelhadas continuam funcionando, mas mostram um aviso de identidade.
- Capturas de tela, gravações, evidências de depuração e registros de auditoria ficam na sua máquina.
- A extensão nunca chama um provedor de IA por conta própria.

REQUISITOS

- Microsoft Edge, Google Chrome ou outro navegador baseado em Chromium, versão 111 ou superior.
- Node.js 20 ou superior para o daemon local e a CLI.
- O daemon roda no Windows, macOS e Linux. O Windows tem instalador gráfico; macOS e Linux usam um arquivo tar.gz com install.sh.

COMO COMEÇAR

Instale a extensão, abra o pop-up e confirme que aparece "Conectado". O daemon inicia sozinho na primeira vez que você executa um comando bridge.

Código-fonte, guia de instalação da CLI e documentação: https://github.com/iorl566/bridgedeck

Aviso de privacidade: https://iorl566.github.io/bridgedeck-privacy/privacy-policy.html

## Search terms

- automação de navegador
- agente de IA
- controle de navegador
- raspagem de dados
- leitura de páginas
- servidor MCP
- extensão Edge

## Notes for the listing editor

- The name and short description are read-only in Partner Center: they come from the package manifest. Change them by updating `extension/_locales/pt_BR/messages.json` and re-uploading the package.
- Keep the section headings in capitals; the store page renders the text as plain paragraphs with line breaks.
- Counts (92 MCP tools, 37 plugin tools) are asserted by `tests/unit/mcp-tool-methods.test.mjs` and `tests/unit/dsh-tools.test.mjs`; update this file if those change.
