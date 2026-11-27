# BridgeDeck — es-ES store listing

Locale: `es-ES` (package locale `es`)

Name (from manifest, read-only): `BridgeDeck`

Short description (from manifest `_locales/es/messages.json`, read-only):
BridgeDeck convierte tu navegador ya iniciado en un espacio de trabajo para tu agente de IA. Daemon local + extensión MV3, sin telemetría.

## Description

BridgeDeck convierte el navegador que ya usas en un espacio de trabajo para tu agente de IA.

Dale una tarea a tu agente y trabajará en su propia Agent Window con las sesiones en las que ya has iniciado sesión, mientras tú mantienes el control y puedes tomar el relevo en cualquier momento.

QUÉ PUEDES HACER

- Trabajar donde ya tienes la sesión iniciada: leer documentos, buscar en sitios de intranet y completar flujos web que necesitan tu propia cuenta.
- Convertir instrucciones en acciones del navegador: leer la estructura de la página, hacer clic, escribir, rellenar formularios, seleccionar opciones, arrastrar, desplazarte, subir y descargar archivos y gestionar pestañas.
- Mantener el control: una tarjeta de control visible, un borde azul «respirante» alrededor de la página controlada, pausa y parada en cualquier momento y una confirmación antes de que el agente tome prestada una de tus pestañas.
- Llevarte los datos de la web: extrae tablas y listas en JSON o CSV, con los nombres de columna y la página o el frame del que procede cada valor.
- Encontrar las pruebas de un fallo: peticiones, cuerpos de respuesta, mensajes de consola, cambios de página, tiempos de rendimiento y comprobación de peticiones duplicadas, exportables en JSON.
- Conservar una repetición del trabajo: graba una pestaña de tarea autorizada como MP4 silencioso y luego previsualízala, guárdala o bórrala dentro de la extensión.
- Capturar páginas largas: desplazamiento automático, unión manual o solo el área visible.
- Llevar un registro: auditoría de operaciones opcional, historial de tareas y pruebas, guardados en local.

HECHO PARA AGENTES

Una CLI, un servidor MCP (92 herramientas), un plugin de DeepSeek Harness (37 herramientas) y SDK para Node.js y Python. Cualquier agente capaz de ejecutar comandos de shell puede controlar el navegador; nada depende de un modelo o un proveedor concreto.

LOCAL Y PRIVADO POR DEFECTO

- Se conecta a un daemon local en 127.0.0.1; sin servicio en la nube y sin telemetría.
- El emparejamiento remoto es opcional y siempre usa WSS autenticado; las conexiones locales sin emparejar siguen funcionando, pero muestran un aviso de identidad.
- Las capturas de pantalla, grabaciones, pruebas de depuración y registros de auditoría se quedan en tu equipo.
- La extensión nunca llama a un proveedor de IA por su cuenta.

REQUISITOS

- Microsoft Edge, Google Chrome u otro navegador basado en Chromium, versión 111 o posterior.
- Node.js 20 o posterior para el daemon local y la CLI.
- El daemon funciona en Windows, macOS y Linux. Windows tiene instalador gráfico; macOS y Linux usan un archivo tar.gz con install.sh.

PRIMEROS PASOS

Instala la extensión, abre la ventana emergente y comprueba que muestra «Conectado». El daemon se inicia automáticamente la primera vez que ejecutas un comando bridge.

Código fuente, guía de instalación de la CLI y documentación: https://github.com/iorl566/bridgedeck

Aviso de privacidad: https://iorl566.github.io/bridgedeck-privacy/privacy-policy.html

## Search terms

- automatización del navegador
- agente de IA
- control del navegador
- scraping web
- lectura de páginas web
- servidor MCP
- extensión de Edge

## Notes for the listing editor

- The name and short description are read-only in Partner Center: they come from the package manifest. Change them by updating `extension/_locales/es/messages.json` and re-uploading the package.
- Keep the section headings in capitals; the store page renders the text as plain paragraphs with line breaks.
- Counts (92 MCP tools, 37 plugin tools) are asserted by `tests/unit/mcp-tool-methods.test.mjs` and `tests/unit/dsh-tools.test.mjs`; update this file (`docs/store-listing/es-ES.md`) if those change.
