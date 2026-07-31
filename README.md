# Serverless Inference — visual explainers

Static pages explaining DigitalOcean Serverless Inference and its Inference Router.
Plain HTML/CSS/JS — no build step, no server-side code. Every page has a dark/light toggle.

## Pages

- `index.html` — landing page: where Serverless Inference sits in the DigitalOcean AI stack
  (Droplets / Dedicated Inference / Serverless Inference). Links out to the live demo and the
  inference router diagram.
- `serverless-inference.html` — live demo. Enter a DO model access key and a model (or
  `router:<name>`), press Enter; it makes a real streaming API call and lights up each
  request-path stage as the reply streams.
- `inference-router.html` — static diagram of the Inference Router: a prompt is classified into
  a task, then routed to a model by a selection criterion, with a fallback for unmatched prompts.
  Hover a sample prompt to trace its path.
- `capacity.html` — internal sizing tool. Reads `tokenomics.csv`, which is git-ignored and not
  published, so this page does not function in the public repo.

## Run

Serve over HTTP (a `file://` page can't `fetch`):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Live demo (`serverless-inference.html`)

Three fields: model access key (kept only in your browser's `localStorage`), a model id or
`router:<name>`, and a base URL (default `https://inference.do-ai.run/v1`). Type a prompt and
press Enter.

The edge hops (Cloudflare, Load Balancer, Traefik) are shown for context; their timing is
illustrative. Everything else is bound to real API signals:

| Signal | Source |
|---|---|
| Matched router task | `x-model-router-selected-route` header |
| Selected model / backend | `model` field in streamed chunks |
| TTFT | time to first streamed token |
| Reply | SSE `delta.content` chunks |
| Token usage | final `usage` object |

**CORS:** the page calls the API directly from the browser, so it only works if the API returns
permissive CORS headers. If the request is blocked, put a small reverse proxy in front and point
the base URL at it.

Request path (per the
[DigitalOcean Serverless Inference Deep Dive](https://www.digitalocean.com/blog/serverless-inference-deep-dive)):

```
Client → Cloudflare → Load Balancer → Traefik (DOKS) → Inference API
       → Model Executor → Model Backend (Ray + vLLM, or provider API) → stream → Client
                                  ↳ Kafka (billing & telemetry, async)
```
