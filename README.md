# Serverless Inference — Visual Deep Dive

A single-page demo that narrates the **DigitalOcean Serverless Inference** request path
left-to-right while making a **real** streaming call to the API. As the request fires, each
architectural stage lights up; the page reveals which model the **Inference Router** picked
and streams the reply token-by-token.

Architecture and stages follow the
[DigitalOcean Serverless Inference Deep Dive](https://www.digitalocean.com/blog/serverless-inference-deep-dive):

```
Client → Cloudflare → Load Balancer → Traefik (DOKS) → Intelligent Inference API
       → Model Executor → Model Backend (Ray + vLLM, or provider API) → Streaming Response → Client
                                  ↳ Kafka (billing & telemetry, async)
```

Pure static — just `index.html`, `styles.css`, `app.js`. No build step, no server.

## Run

`fetch()` from a `file://` page is unreliable, so serve over HTTP:

```bash
cd serverless-inference
python3 -m http.server 8000
# open http://localhost:8000
```

The whole UI is three bare fields and a prompt — no buttons:

1. **model access key** — paste a DO model access key (stored only in your browser's `localStorage`).
2. **model** — type either a router (`router:my-router`) or a specific model id (`llama3.3-70b`).
   It's sent verbatim as the API's `model` param. If it starts with `router:`, the page reveals the
   matched task and the model the router actually picked.
3. **base url** — defaults to `https://inference.do-ai.run/v1`.

Type a prompt and press **Enter** to send. The active stage gets a bright outline; the model/task/TTFT/
token counts appear in the line under the row, and the reply streams below it.

## What's real vs. illustrative

The intermediate hops (Cloudflare, Load Balancer, Traefik) aren't individually observable from a
browser, so their progression timing is **illustrative**. Everything else is bound to **real**
signals from the API response:

| Signal | Source |
|---|---|
| Matched router task | `x-model-router-selected-route` response header |
| Selected model + backend type | `model` field in the streamed chunks |
| TTFT | time to the first streamed token |
| Streamed reply | SSE `delta.content` chunks |
| Token usage → Kafka box | final `usage` object (`stream_options.include_usage`) |

## CORS caveat

This page calls `inference.do-ai.run` **directly from the browser**. That only works if the API
returns permissive CORS headers (including exposing `x-model-router-selected-route`). If the browser
blocks the request, the fetch fails before any response and the page surfaces a "Blocked / network"
error on the Cloudflare stage — **a static page cannot bypass CORS**.

If that happens, put a tiny reverse proxy in front (serves this page and relays `/v1/*` to
`https://inference.do-ai.run/v1/*` with the key server-side) and point the **Base URL** at it.
