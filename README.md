# roblox.zzzzhub.net proxy

Reverse proxy Node.js para servir `https://roblox.zzzzhub.net/` em uma única origem pública. O destino padrão já está configurado para `roblox.zzzzhub.net`, mas pode ser substituído por variáveis de ambiente.

## Execução local

```bash
npm install
npm start
```

Abra `http://localhost:3000/`. O servidor aceita `PORT`, `HOST`, `BASE_URL`, `TARGET_ORIGIN` e `PLAY_ORIGIN`.

## Deploy rápido na Vercel

O repositório inclui `vercel.json` e `api/index.js`. Importe o repositório na Vercel como um projeto Node.js; não é necessário um build frontend separado. Se o projeto usar um domínio diferente, defina `BASE_URL` para a URL pública.

A implantação na Vercel cobre requisições HTTP/HTTPS, HTML, CSS, JavaScript, cookies, redirects e o formato `/x/<URL-absoluta>`. O entrypoint exporta o servidor Node completo, incluindo o evento `upgrade` para encaminhar `ws`/`wss`. WebSockets na Vercel exigem Fluid Compute habilitado no projeto e seguem os limites de duração e cobrança das Functions.

## Esquema de proxy

```text
/x/https://assetdelivery.roblox.com/v1/asset/123
/x/wss://game.roblox.com/notifications
```

O proxy também encaminha `/games/start?placeId=...` para `https://play.roblox.com`, preservando o fluxo existente de abertura de jogos.

## Reescritas

- HTML, atributos de URL, `srcset`, estilos inline e CSS.
- JavaScript externo, incluindo URLs `https://` e `wss://` literais.
- Fetch, XHR, WebSocket, EventSource, Worker, Service Worker, `window.open` e `sendBeacon` no shim do navegador.
- `Location`, `Set-Cookie`, `Origin` e `Referer`.
- CSP, HSTS, X-Frame-Options e políticas cross-origin incompatíveis com a entrega pelo proxy.
- CORS para recursos encaminhados pelo proxy.

## Limites

O cliente 3D nativo do Roblox não é implementado pelo navegador. Cookies e armazenamento ficam no domínio do proxy. Conexões WebSocket precisam ser reconectadas pelo cliente quando atingirem o limite de duração da Function.
