# E2E Testing Guide

## Overview

This document describes the End-to-End (E2E) testing infrastructure for the Predictify backend. E2E tests validate the complete prediction market lifecycle against real Stellar testnet infrastructure.

## Purpose

E2E tests ensure that:
- The complete prediction lifecycle works end-to-end
- Integration with Stellar/Soroban testnet is functional
- Database state remains consistent across operations
- Authentication and authorization work correctly
- Real-world scenarios are validated before production deployment

## Test Coverage

### Prediction Lifecycle Test (`tests/e2e/predictionLifecycle.test.ts`)

This test validates the complete user journey:

1. **Authentication**: User authenticates with Stellar wallet signature
2. **Market Creation**: A new prediction market is created on testnet
3. **Place Prediction**: User places a prediction with specific outcome and amount
4. **Market Resolution**: Market resolves with a winning outcome
5. **Claim Winnings**: User claims their winnings from the resolved market
6. **Data Consistency**: Verifies all data relationships and state transitions

Each step includes:
- Structured logging with correlation IDs
- State validation
- Error handling
- Cleanup on completion or failure

## Prerequisites

### 1. Funded Testnet Account

You need a Stellar testnet account with:
- Sufficient XLM balance for transaction fees
- Sufficient test tokens for predictions
- The secret key stored securely

**To create and fund a testnet account:**

```bash
# Generate keypair (or use Stellar Laboratory)
# Visit: https://laboratory.stellar.org/#account-creator

# Fund the account with Friendbot
curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"
```

### 2. Deployed Contract

The E2E tests require a deployed Predictify contract on testnet:
- Contract must be initialized
- Contract ID must be set in environment variables

### 3. Database

A PostgreSQL database for test data:
- Separate from production and development databases
- Automatically seeded and cleaned up by tests

### 4. Environment Variables

Create a `.env.e2e` file with the following variables:

```bash
# ── Test Account ──────────────────────────────────────────
# Stellar testnet account secret key (required)
E2E_TEST_SECRET_KEY=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# ── Stellar/Soroban ───────────────────────────────────────
STELLAR_NETWORK=testnet
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
HORIZON_URL=https://horizon-testnet.stellar.org

# Deployed contract ID on testnet (required)
PREDICTIFY_CONTRACT_ID=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# ── Database ──────────────────────────────────────────────
# Separate test database
DATABASE_URL=postgres://postgres:postgres@localhost:5432/predictify_e2e

# ── Redis ─────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379

# ── JWT ───────────────────────────────────────────────────
JWT_SECRET=e2e-test-jwt-secret-that-is-at-least-32-characters-long
JWT_ISSUER=predictify-e2e
JWT_AUDIENCE=predictify-e2e-app

# ── Application ───────────────────────────────────────────
NODE_ENV=test
PORT=3001
LOG_LEVEL=info

# Disable rate limiting for E2E tests
ANON_RATE_LIMIT_MAX=10000
CAPTCHA_THRESHOLD=0
```

## Running E2E Tests

### Local Development

```bash
# 1. Ensure test database is running
docker run -d \
  --name predictify-e2e-db \
  -e POSTGRES_DB=predictify_e2e \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgres:16-alpine

# 2. Run migrations
npm run db:migrate

# 3. Run E2E tests
npm test -- tests/e2e/predictionLifecycle.test.ts

# 4. Run with verbose output
npm test -- tests/e2e/predictionLifecycle.test.ts --verbose

# 5. Run with coverage
npm test -- tests/e2e/predictionLifecycle.test.ts --coverage
```

### CI/CD (GitHub Actions)

E2E tests run automatically:

**Nightly Schedule**: Every day at 2 AM UTC
- Validates testnet integration remains functional
- Catches issues with external dependencies
- Creates GitHub issues on failure

**Manual Trigger**: Via workflow_dispatch
- For on-demand validation
- Before major releases
- After infrastructure changes

**On Push**: When E2E test files are modified
- Immediate feedback on test changes
- Validates test refactoring

## GitHub Secrets Configuration

Configure the following secrets in your GitHub repository:

```
Settings → Secrets and variables → Actions → New repository secret
```

| Secret Name | Description | Example |
|-------------|-------------|---------|
| `E2E_TEST_SECRET_KEY` | Testnet account secret key | `SXXXXX...` |
| `TESTNET_CONTRACT_ID` | Deployed contract ID | `CXXXXX...` |
| `E2E_JWT_SECRET` | JWT secret for CI tests | `random-32-char-string` |
| `E2E_ADMIN_ADDRESS` | Admin Stellar address (optional) | `GXXXXX...` |

## Test Architecture

### Structure

```
tests/e2e/
├── setup.ts                    # E2E test environment configuration
└── predictionLifecycle.test.ts # Main lifecycle test suite
```

### Key Components

1. **Test Setup (`setup.ts`)**
   - Configures testnet environment
   - Sets default values
   - Validates required variables

2. **Lifecycle Test**
   - Uses real Stellar SDK clients
   - Interacts with actual testnet
   - Performs database operations
   - Validates API responses

3. **Cleanup**
   - Runs in `afterAll` hook
   - Deletes test data in dependency order
   - Logs cleanup operations
   - Doesn't fail suite on cleanup errors

## Best Practices

### 1. Test Isolation

Each test should:
- Use unique identifiers (timestamps)
- Not depend on other tests
- Clean up its own data
- Handle cleanup failures gracefully

### 2. Structured Logging

All operations should log:
- Operation type
- Entity IDs (marketId, userId, etc.)
- Timestamps
- Success/failure status

Example:
```typescript
logger.info({ marketId, userId, amount }, "Placing prediction");
```

### 3. Error Handling

Tests should:
- Expect specific error codes
- Validate error messages
- Handle testnet timeouts gracefully
- Retry on transient failures (when appropriate)

### 4. Assertions

Use specific assertions:
```typescript
// ✅ Good - specific
expect(market.status).toBe("resolved");
expect(claim.amount).toBeGreaterThan(prediction.amount);

// ❌ Bad - vague
expect(market).toBeTruthy();
```

### 5. Timeouts

Set appropriate timeouts for testnet operations:
```typescript
test("should resolve market", async () => {
  // Testnet can be slow
}, 120000); // 2 minutes
```

## Monitoring

### CI Artifacts

Each E2E run uploads:
- Test results
- Coverage reports
- Logs (if configured)

Retained for 30 days.

### Failure Notifications

On scheduled run failures:
- GitHub issue created automatically
- Tagged with `e2e-failure`, `bug`, `priority`
- Includes run link and commit SHA

### Metrics to Monitor

- Test execution time
- Success rate over time
- Testnet RPC latency
- Database query performance

## Troubleshooting

### Common Issues

#### 1. Test Account Insufficient Balance

**Error**: "Transaction failed: insufficient balance"

**Solution**:
```bash
# Fund the test account
curl "https://friendbot.stellar.org?addr=YOUR_TEST_PUBLIC_KEY"
```

#### 2. Contract Not Found

**Error**: "Contract CXXXXX not found"

**Solution**:
- Verify contract is deployed to testnet
- Check `PREDICTIFY_CONTRACT_ID` is correct
- Ensure contract is initialized

#### 3. Database Connection Refused

**Error**: "ECONNREFUSED ::1:5432"

**Solution**:
```bash
# Start PostgreSQL
docker start predictify-e2e-db

# Or create new instance
docker run -d --name predictify-e2e-db \
  -e POSTGRES_DB=predictify_e2e \
  -p 5432:5432 \
  postgres:16-alpine
```

#### 4. Testnet RPC Timeout

**Error**: "Timeout waiting for RPC response"

**Solution**:
- Stellar testnet may be under heavy load
- Retry the test
- Check testnet status: https://status.stellar.org/
- Consider increasing timeout values

#### 5. Authentication Failure

**Error**: "Invalid signature"

**Solution**:
- Verify `E2E_TEST_SECRET_KEY` is correct
- Ensure keypair matches the registered user
- Check nonce hasn't expired

## Extending E2E Tests

### Adding New Test Scenarios

1. **Create test file**: `tests/e2e/newScenario.test.ts`
2. **Import setup**: `import '../e2e/setup'`
3. **Follow lifecycle pattern**: authenticate → act → assert → cleanup
4. **Add to CI**: Update `.github/workflows/e2e.yml` if needed

### Example: Testing Multiple Predictions

```typescript
test("should handle multiple predictions on same market", async () => {
  const predictions = await Promise.all([
    placePrediction(marketId, "YES", "100"),
    placePrediction(marketId, "NO", "50"),
    placePrediction(marketId, "YES", "75"),
  ]);

  // Verify all predictions recorded
  expect(predictions).toHaveLength(3);
  
  // Resolve market
  await resolveMarket(marketId, "YES");
  
  // Verify winners and losers
  const winners = predictions.filter(p => p.outcome === "YES");
  const losers = predictions.filter(p => p.outcome === "NO");
  
  expect(winners.every(p => p.result === "won")).toBe(true);
  expect(losers.every(p => p.result === "lost")).toBe(true);
});
```

## Security Considerations

### Secret Management

- **Never commit secrets** to version control
- Use environment variables or secret management tools
- Rotate test account keys periodically
- Use separate keys for CI and local development

### Test Data

- E2E tests use real testnet
- Data is publicly visible on-chain
- Don't use sensitive or production data
- Clean up test data after runs

### Access Control

- Limit access to E2E secret keys
- Use GitHub Environments for additional protection
- Audit who can trigger E2E workflows
- Review workflow logs for suspicious activity

## Performance Optimization

### Parallel Execution

Where possible, run independent operations in parallel:

```typescript
// ✅ Parallel
const [market, user] = await Promise.all([
  createMarket(),
  authenticateUser(),
]);

// ❌ Sequential (slower)
const market = await createMarket();
const user = await authenticateUser();
```

### Database Optimization

- Use transactions for multi-step operations
- Batch inserts when possible
- Index frequently queried fields
- Clean up old test data

### Testnet Considerations

- Testnet can be slower than mainnet
- Rate limits may apply
- Plan for occasional downtime
- Cache static data (contract ABI, etc.)

## Maintenance

### Regular Tasks

- **Weekly**: Review E2E test results
- **Monthly**: Update dependencies
- **Quarterly**: Audit test coverage
- **Annually**: Rotate test account keys

### When to Update E2E Tests

- Contract ABI changes
- New API endpoints
- Schema migrations
- Business logic changes
- Security requirements

## Further Reading

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Supertest Documentation](https://github.com/ladjs/supertest)
- [Stellar SDK Documentation](https://stellar.github.io/js-stellar-sdk/)
- [Soroban Documentation](https://soroban.stellar.org/docs)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)

## Support

For questions or issues with E2E tests:

1. Check this documentation
2. Review existing GitHub issues
3. Check test logs and artifacts
4. Create a new issue with:
   - Test output
   - Environment details
   - Steps to reproduce
   - Expected vs actual behavior
