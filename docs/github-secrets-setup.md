# GitHub Secrets Setup for E2E Tests

This guide walks you through setting up the required GitHub repository secrets for E2E tests to run in CI.

## Prerequisites

- Repository admin access
- Funded Stellar testnet account
- Deployed Predictify contract on testnet

## Required Secrets

### 1. E2E_TEST_SECRET_KEY

**What**: Stellar testnet account secret key
**Format**: `S + 55 characters` (Base32 encoded)
**Example**: `SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`

**How to get**:

1. Generate a new keypair at [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=test)
2. Save the **Secret Key** (starts with 'S')
3. Fund the account:
   ```bash
   curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"
   ```
4. Verify funding at [Stellar Expert](https://stellar.expert/explorer/testnet)

**Security notes**:
- Never commit this to version control
- Use a dedicated account for CI (not your personal testnet account)
- Rotate periodically (quarterly recommended)

---

### 2. TESTNET_CONTRACT_ID

**What**: Deployed Predictify contract ID on Stellar testnet
**Format**: `C + 55 characters` (Base32 encoded)
**Example**: `CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`

**How to get**:

1. Deploy your contract to testnet:
   ```bash
   soroban contract deploy \
     --wasm target/wasm32-unknown-unknown/release/predictify.wasm \
     --network testnet \
     --source YOUR_DEPLOYER_ACCOUNT
   ```

2. Note the contract ID returned (starts with 'C')

3. Verify deployment:
   ```bash
   soroban contract info \
     --id YOUR_CONTRACT_ID \
     --network testnet
   ```

**Note**: If you redeploy the contract, update this secret.

---

### 3. E2E_JWT_SECRET

**What**: Secret key for signing JWT tokens in CI tests
**Format**: Minimum 32 characters (alphanumeric + special chars recommended)
**Example**: `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2`

**How to generate**:

```bash
# Option 1: OpenSSL (recommended)
openssl rand -hex 32

# Option 2: Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Option 3: PowerShell (Windows)
[System.Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

**Security notes**:
- Different from production JWT_SECRET
- Use strong random generation
- No need to remember or type this (machine-only)

---

### 4. E2E_ADMIN_ADDRESS (Optional)

**What**: Stellar address with admin privileges for testing admin endpoints
**Format**: `G + 55 characters` (Base32 encoded)
**Example**: `GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`

**How to get**:

Use the public key from your E2E test account or a separate admin account.

**Note**: Only needed if testing admin-specific endpoints.

---

## Adding Secrets to GitHub

### Via Web UI

1. Navigate to your repository on GitHub
2. Click **Settings** (requires admin access)
3. In the left sidebar, click **Secrets and variables** → **Actions**
4. Click **New repository secret**
5. For each secret:
   - **Name**: Enter the secret name exactly (e.g., `E2E_TEST_SECRET_KEY`)
   - **Secret**: Paste the secret value
   - Click **Add secret**

### Via GitHub CLI

```bash
# Install GitHub CLI if needed
# https://cli.github.com/

# Authenticate
gh auth login

# Add each secret
gh secret set E2E_TEST_SECRET_KEY --body "SBXXXXX..."
gh secret set TESTNET_CONTRACT_ID --body "CXXXXX..."
gh secret set E2E_JWT_SECRET --body "$(openssl rand -hex 32)"
gh secret set E2E_ADMIN_ADDRESS --body "GXXXXX..." # Optional
```

### Via GitHub API

```bash
# Set variables
REPO_OWNER="your-username"
REPO_NAME="predictify-backend"
GITHUB_TOKEN="your_personal_access_token"

# Function to add a secret
add_secret() {
  local secret_name=$1
  local secret_value=$2
  
  # Get repository public key
  response=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
    "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/actions/secrets/public-key")
  
  key_id=$(echo $response | jq -r '.key_id')
  public_key=$(echo $response | jq -r '.key')
  
  # Encrypt secret (requires sodium library)
  # ... (complex, use CLI or web UI instead)
}

# Easier: Use gh CLI or web UI
```

---

## Verifying Secrets

After adding secrets:

1. Navigate to **Settings** → **Secrets and variables** → **Actions**
2. You should see all secrets listed (values are hidden)
3. Secret names should match exactly:
   - `E2E_TEST_SECRET_KEY`
   - `TESTNET_CONTRACT_ID`
   - `E2E_JWT_SECRET`
   - `E2E_ADMIN_ADDRESS` (if added)

---

## Testing the Setup

### Manual Workflow Run

1. Go to **Actions** tab
2. Select **E2E Tests (Nightly)** workflow
3. Click **Run workflow** dropdown
4. Select branch (usually `main`)
5. Click **Run workflow** button
6. Watch the workflow execute
7. Check logs for any secret-related errors

### Common Issues

#### Secret not found

**Error**: `Error: Secret E2E_TEST_SECRET_KEY not found`

**Solution**:
- Verify secret name is exactly `E2E_TEST_SECRET_KEY` (case-sensitive)
- Ensure you have the secret added at repository level (not environment level)
- Repository must have Actions enabled

#### Invalid secret key format

**Error**: `Invalid Stellar secret key format`

**Solution**:
- Verify secret starts with 'S'
- Ensure you copied the full 56-character secret
- No extra spaces or newlines
- Must be a valid Ed25519 secret key

#### Contract not found

**Error**: `Contract CXXXXX not found on testnet`

**Solution**:
- Verify contract is deployed to testnet (not mainnet)
- Check contract ID is correct (starts with 'C')
- Ensure contract is initialized
- Visit https://stellar.expert/explorer/testnet/contract/YOUR_CONTRACT_ID

#### Account not funded

**Error**: `Account has insufficient balance`

**Solution**:
```bash
# Refund the account
curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"
```

---

## Updating Secrets

To update an existing secret:

### Via Web UI

1. Go to **Settings** → **Secrets and variables** → **Actions**
2. Click on the secret name
3. Click **Update secret**
4. Enter new value
5. Click **Update secret**

### Via GitHub CLI

```bash
# Same command as adding (overwrites)
gh secret set E2E_TEST_SECRET_KEY --body "NEW_SECRET_VALUE"
```

---

## Secret Rotation

Recommended schedule:

- **E2E_TEST_SECRET_KEY**: Quarterly (every 3 months)
- **TESTNET_CONTRACT_ID**: On contract redeployment only
- **E2E_JWT_SECRET**: Annually (every 12 months)
- **E2E_ADMIN_ADDRESS**: When admin account changes

### Rotation Process

1. Generate new secret value
2. Update in GitHub secrets
3. Verify workflow still passes
4. Document rotation in team log

---

## Security Best Practices

### ✅ DO

- Use dedicated accounts for CI (not personal)
- Generate strong random secrets
- Rotate secrets regularly
- Use separate secrets for different environments
- Review secret access logs periodically
- Remove unused secrets

### ❌ DON'T

- Commit secrets to code
- Share secrets via chat/email
- Use production secrets in CI
- Use weak or guessable secrets
- Give everyone admin access
- Log secret values

---

## Troubleshooting

### Secrets not available in workflow

**Check**:
1. Secrets are at repository level, not environment
2. Workflow has correct repository access
3. No typos in secret names in workflow file

### Can't see secret value

**Expected**: GitHub never displays secret values after creation
**Solution**: If you need to verify, delete and re-create the secret

### Workflow fails but secrets seem correct

**Debug steps**:
1. Check workflow logs for specific error
2. Verify secret format (use correct prefixes: S, C, G)
3. Test secrets locally (never commit!)
4. Verify external services (testnet status, contract deployment)

---

## Getting Help

If you encounter issues:

1. Check workflow logs in **Actions** tab
2. Review this documentation
3. Check [docs/e2e-testing.md](e2e-testing.md) troubleshooting section
4. Verify Stellar testnet status: https://status.stellar.org/
5. Create an issue with:
   - Workflow run link
   - Error message (redact secrets!)
   - Steps taken
   - Environment details

---

## Quick Reference

```bash
# Generate testnet account
# Visit: https://laboratory.stellar.org/#account-creator

# Fund testnet account
curl "https://friendbot.stellar.org?addr=PUBLIC_KEY"

# Generate JWT secret
openssl rand -hex 32

# Add secrets via CLI
gh secret set E2E_TEST_SECRET_KEY --body "SXXX..."
gh secret set TESTNET_CONTRACT_ID --body "CXXX..."
gh secret set E2E_JWT_SECRET --body "$(openssl rand -hex 32)"

# List secrets
gh secret list

# Trigger E2E workflow
gh workflow run e2e.yml
```

---

## Additional Resources

- [GitHub Encrypted Secrets Documentation](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
- [Stellar Testnet Guide](https://developers.stellar.org/docs/learn/fundamentals/networks)
- [Soroban CLI Documentation](https://soroban.stellar.org/docs/reference/soroban-cli)
- [GitHub CLI Secrets Commands](https://cli.github.com/manual/gh_secret)
