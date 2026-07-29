OpenAPI: Examples for /api/markets
===================================

Summary
-------

This change adds concrete `examples` to the OpenAPI spec (`openapi.yaml`) for the market endpoints under `/api/markets` that did not yet have any:

- `GET /api/markets/recommendations` — example recommended-markets list, plus a 401 unauthorized example
- `GET /api/markets/search` — example search result page, plus a 400 missing-query example
- `GET /api/markets/tags` — example tag/count list
- `PATCH /api/markets/{id}` — example request body and updated-market response, plus 400/404/409 error examples
- `GET /api/markets/{id}/prediction-count` — example count response, plus 400/404 error examples
- `GET /api/markets/featured` — example featured-markets list, plus a 400 error example

`GET /api/markets` and `GET /api/markets/{id}` already had examples from a previous change and were left as-is.

Why
---

Examples improve the developer experience for API consumers and make the Swagger UI more useful by showing realistic request/response payloads for every documented status code.

Notes for reviewers
--------------------

- The examples are purely documentation — no route behaviour or validation logic was changed.
- Error examples follow the existing `ErrorBody` / `ValidationErrorBody` shape used elsewhere in the spec (`error.code` + `error.requestId` / `error.details`).
- Run `npm run openapi:generate` after editing `src/openapi/registry.ts` to regenerate `openapi.yaml`; `npm run openapi:check` verifies the registered routes stay in sync with the app's route table.
- Tests were added at `tests/openapi.markets.examples.test.ts` to assert the generated YAML contains these examples.
