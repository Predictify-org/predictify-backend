# app/ — Frontend feature modules

This directory contains self-contained frontend feature code scaffolded
alongside the backend for the Predictify / GrantFox campaign.  Each module
is ready to drop into a **Next.js 14+ (App Router)** project.

---

## task/wallet-last-used — "Last used" wallet badge

Shows a **"Last used"** badge next to the wallet provider the user most
recently connected with, making it easy to reconnect quickly on return visits.

### Files

| File | Purpose |
|------|---------|
| `state/walletPrefs.ts` | Read / write last-used provider in `localStorage` |
| `components/ConnectWalletModal.tsx` | Modal with provider list and badge |
| `state/walletPrefs.test.ts` | Unit tests for the state module (25 tests) |
| `components/ConnectWalletModal.test.tsx` | RTL component tests (23 tests) |
| `jest.config.js` | Jest config for the `app/` layer (jsdom) |
| `jest.setup.ts` | Loads `@testing-library/jest-dom` matchers |

### Usage

```tsx
// In your page or layout:
import { useState } from "react";
import { ConnectWalletModal } from "@/components/ConnectWalletModal";
import { setLastUsedProvider } from "@/state/walletPrefs";

export default function Page() {
  const [open, setOpen] = useState(false);

  async function handleConnect(providerId) {
    try {
      await connectWallet(providerId);   // your wallet connection logic
      // setLastUsedProvider is already called optimistically by the modal,
      // but you can call it here too if you prefer non-optimistic recording.
    } catch {
      // on failure you may want to clear the optimistic record:
      // clearWalletPrefs();
    } finally {
      setOpen(false);
    }
  }

  return (
    <>
      <button onClick={() => setOpen(true)}>Connect wallet</button>
      <ConnectWalletModal
        isOpen={open}
        onClose={() => setOpen(false)}
        onConnect={handleConnect}
      />
    </>
  );
}
```

### How the badge works

1. When a provider button is clicked, `setLastUsedProvider(id)` writes
   `{ lastUsedProvider: id, lastUsedAt: <ISO timestamp> }` to `localStorage`
   under the key `predictify.walletPrefs`.
2. On the next modal open, `getLastUsedProvider()` reads the stored value and
   the component renders a `<LastUsedBadge />` next to the matching provider.
3. Only one badge is ever shown — whichever provider was used most recently.

### Accessibility

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` wired to heading.
- Focus trapped inside the modal (Tab / Shift+Tab cycle).
- Escape key closes the modal and returns focus to the trigger element.
- Each provider button has a descriptive `aria-label` that includes
  `(last used)` when applicable, so screen readers announce it clearly.
- The visual badge is `aria-hidden="true"` — the semantic announcement is
  on the button's `aria-label`, not the badge text.
- All interactive elements meet the WCAG 2.1 AA 44 × 44 px touch target.

### Running the tests

```bash
# From the repo root (after npm install):
npx jest --config app/jest.config.js

# With coverage:
npx jest --config app/jest.config.js --coverage
```

### Required frontend dependencies

Add these to your Next.js project's `package.json` if they are not present:

```json
{
  "dependencies": {
    "react": "^18",
    "react-dom": "^18"
  },
  "devDependencies": {
    "@testing-library/react": "^16",
    "@testing-library/user-event": "^14",
    "@testing-library/jest-dom": "^6",
    "@types/react": "^18",
    "jest-environment-jsdom": "^29"
  }
}
```
