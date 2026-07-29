# E2E Tests

## Quick Start

```bash
# 1. Set up environment variables
cp .env.example .env.e2e
# Edit .env.e2e with your testnet credentials

# 2. Start test database
docker run -d --name predictify-e2e-db \
  -e POSTGRES_DB=predictify_e2e \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgres:16-alpine

# 3. Run migrations
npm run db:migrate

# 4. Run E2E tests
npm run test:e2e
```

## What Gets Tested

The **Prediction Lifecycle E2E test** validates:

1. ✅ User authentication with Stellar wallet signature
2. ✅ Market creation on testnet
3. ✅ Placing predictions with real amounts
4. ✅ Market resolution with winning outcomes
5. ✅ Claiming winnings
6. ✅ Data consistency across the entire flow

## Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `E2E_TEST_SECRET_KEY` | Testnet account secret key | `SXXXXX...` |
| `PREDICTIFY_CONTRACT_ID` | Deployed contract on testnet | `CXXXXX...` |
| `DATABASE_URL` | Test database connection | `postgres://...` |
| `SOROBAN_RPC_URL` | Testnet RPC endpoint | `https://soroban-testnet.stellar.org` |

## Test Files

- `predictionLifecycle.test.ts` - Main E2E test suite
- `setup.ts` - Environment configuration and defaults

## CI/CD

E2E tests run:
- **Nightly** at 2 AM UTC (scheduled)
- **Manually** via GitHub Actions workflow_dispatch
- **On push** when E2E files change

View workflow: `.github/workflows/e2e.yml`

## Cleanup

Tests automatically clean up:
- Created markets
- Placed predictions
- Claims
- Test users

Cleanup runs in `afterAll` hook and won't fail the suite if it encounters errors.

## Troubleshooting

### Account not funded
```bash
curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"
```

### Database connection refused
```bash
docker start predictify-e2e-db
```

### Testnet timeout
- Check https://status.stellar.org/
- Increase timeout in test file
- Retry the test

## Full Documentation

See [docs/e2e-testing.md](../../docs/e2e-testing.md) for:
- Detailed setup instructions
- Architecture overview
- Best practices
- Security considerations
- Monitoring and troubleshooting

## Coverage Goals

Target minimum coverage for E2E tests:
- **Lines**: 90%
- **Functions**: 80%
- **Branches**: 80%
- **Statements**: 90%

Run with coverage:
```bash
npm run test:e2e:coverage
```
