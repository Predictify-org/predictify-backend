OpenAPI: Examples for /api/users
================================

Summary
-------

This change adds concrete `examples` to the OpenAPI spec (`openapi.yaml`) for the user-facing endpoints under `/api/users`:

- `GET /api/users/me` — example authenticated profile
- `GET /api/users/{address}/predictions` — example paginated predictions page
- `GET /api/users/{stellarAddress}/profile` — example public profile
- `POST /api/users/{addr}/follow` and `DELETE /api/users/{addr}/follow` — example follow/unfollow responses

Why
---

Examples improve the developer experience for API consumers and make the Swagger UI more useful by showing realistic response payloads.

Notes for reviewers
------------------

- The examples are purely documentation — no behaviour or validation logic was changed.
- Tests were added at `tests/openapi.users.examples.test.ts` to assert the YAML contains these examples.
