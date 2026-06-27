/**
 * ConnectWalletModal.test.tsx
 *
 * Component tests for app/components/ConnectWalletModal.tsx
 *
 * Uses React Testing Library (RTL) with jsdom.  No real browser is required.
 *
 * Coverage areas
 * ──────────────
 *  Rendering
 *   1.  Nothing is rendered when isOpen=false
 *   2.  Dialog is rendered when isOpen=true
 *   3.  All six provider buttons are rendered
 *   4.  No "Last used" badge is shown when storage is empty
 *   5.  "Last used" badge appears on the last-used provider
 *   6.  Badge is on exactly ONE provider even when multiple are in storage
 *   7.  Badge moves when the last-used provider changes
 *   8.  "Connected" checkmark is visible for connectedId
 *
 *  Interaction
 *   9.  Clicking a provider calls onConnect with the correct id
 *   10. Clicking a provider records it as last-used in storage
 *   11. Clicking the ✕ close button calls onClose
 *   12. Clicking the backdrop calls onClose
 *   13. Clicking inside the dialog does NOT call onClose
 *   14. Pressing Escape calls onClose
 *   15. Tab key traps focus inside the dialog
 *   16. Shift+Tab key traps focus inside the dialog (wraps to last)
 *
 *  Accessibility
 *   17. Dialog has role="dialog" and aria-modal="true"
 *   18. Dialog is labelled by the heading (aria-labelledby)
 *   19. Each provider button has an aria-label
 *   20. Last-used provider button aria-label contains "(last used)"
 *   21. Close button has an accessible aria-label
 *   22. Backdrop is aria-hidden (not part of reading order)
 *   23. "Last used" badge is aria-hidden (decorative)
 */

import React from "react";
import {
  render,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectWalletModal } from "./ConnectWalletModal";
import {
  createMemoryStorage,
  setLastUsedProvider,
  type StorageLike,
} from "../state/walletPrefs";

// ── Helpers ────────────────────────────────────────────────────────────────

interface RenderOpts {
  isOpen?: boolean;
  onClose?: jest.Mock;
  onConnect?: jest.Mock;
  connectedId?: string;
  storage?: StorageLike;
}

function renderModal(opts: RenderOpts = {}) {
  const {
    isOpen = true,
    onClose = jest.fn(),
    onConnect = jest.fn(),
    connectedId,
    storage = createMemoryStorage(),
  } = opts;

  const result = render(
    <ConnectWalletModal
      isOpen={isOpen}
      onClose={onClose}
      onConnect={onConnect as never}
      connectedId={connectedId as never}
      storage={storage}
    />,
  );

  return { ...result, onClose, onConnect, storage };
}

// ── 1–8: Rendering ────────────────────────────────────────────────────────

describe("ConnectWalletModal – rendering", () => {
  it("renders nothing when isOpen=false", () => {
    renderModal({ isOpen: false });
    expect(screen.queryByTestId("connect-wallet-modal")).not.toBeInTheDocument();
  });

  it("renders the dialog when isOpen=true", () => {
    renderModal();
    expect(screen.getByTestId("connect-wallet-modal")).toBeInTheDocument();
    expect(screen.getByText("Connect wallet")).toBeInTheDocument();
  });

  it("renders buttons for all six providers", () => {
    renderModal();
    const providers = [
      "freighter",
      "albedo",
      "xbull",
      "rabet",
      "lobstr",
      "walletconnect",
    ];
    for (const id of providers) {
      expect(screen.getByTestId(`provider-button-${id}`)).toBeInTheDocument();
    }
  });

  it("shows no Last used badge when storage is empty", () => {
    renderModal({ storage: createMemoryStorage() });
    expect(screen.queryByTestId("last-used-badge")).not.toBeInTheDocument();
  });

  it("shows the Last used badge on the last-used provider", () => {
    const storage = createMemoryStorage();
    setLastUsedProvider("freighter", storage);

    renderModal({ storage });

    const badge = screen.getByTestId("last-used-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("Last used");

    // Badge should be inside the freighter button
    const freighterBtn = screen.getByTestId("provider-button-freighter");
    expect(within(freighterBtn).getByTestId("last-used-badge")).toBeInTheDocument();
  });

  it("shows the badge on exactly one provider", () => {
    const storage = createMemoryStorage();
    setLastUsedProvider("albedo", storage);

    renderModal({ storage });

    expect(screen.getAllByTestId("last-used-badge")).toHaveLength(1);
  });

  it("badge moves when the last-used provider changes between renders", () => {
    const storage = createMemoryStorage();
    setLastUsedProvider("freighter", storage);

    const { rerender } = renderModal({ storage });

    // Badge on freighter initially
    expect(
      within(screen.getByTestId("provider-button-freighter")).queryByTestId(
        "last-used-badge",
      ),
    ).toBeInTheDocument();

    // Update storage to lobstr and re-render
    setLastUsedProvider("lobstr", storage);
    rerender(
      <ConnectWalletModal
        isOpen={true}
        onClose={jest.fn()}
        onConnect={jest.fn()}
        storage={storage}
      />,
    );

    expect(
      within(screen.getByTestId("provider-button-lobstr")).queryByTestId(
        "last-used-badge",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("provider-button-freighter")).queryByTestId(
        "last-used-badge",
      ),
    ).not.toBeInTheDocument();
  });

  it("shows the connected checkmark for connectedId", () => {
    renderModal({ connectedId: "xbull" as never });
    const xbullBtn = screen.getByTestId("provider-button-xbull");
    // The connected button has an aria-label containing "(connected)"
    expect(xbullBtn).toHaveAttribute("aria-label", expect.stringContaining("(connected)"));
  });
});

// ── 9–16: Interaction ────────────────────────────────────────────────────

describe("ConnectWalletModal – interaction", () => {
  it("calls onConnect with the provider id when a button is clicked", async () => {
    const user = userEvent.setup();
    const { onConnect } = renderModal();

    await user.click(screen.getByTestId("provider-button-freighter"));

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledWith("freighter");
  });

  it("records the provider in storage when clicked (optimistic)", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    renderModal({ storage });

    await user.click(screen.getByTestId("provider-button-albedo"));

    const { getLastUsedProvider } = await import("../state/walletPrefs");
    expect(getLastUsedProvider(storage)).toBe("albedo");
  });

  it("calls onClose when the ✕ button is clicked", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.click(screen.getByRole("button", { name: /close connect wallet/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the backdrop is clicked", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByTestId("modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onClose when clicking inside the dialog", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByTestId("connect-wallet-modal"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when Escape is pressed", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(screen.getByTestId("connect-wallet-modal"), {
      key: "Escape",
      code: "Escape",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tab key wraps focus from last to first focusable element", () => {
    renderModal();
    const dialog = screen.getByTestId("connect-wallet-modal");
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled])',
    );
    const last = focusable[focusable.length - 1];
    last.focus();

    fireEvent.keyDown(dialog, { key: "Tab", code: "Tab", shiftKey: false });

    expect(document.activeElement).toBe(focusable[0]);
  });

  it("Shift+Tab wraps focus from first to last focusable element", () => {
    renderModal();
    const dialog = screen.getByTestId("connect-wallet-modal");
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled])',
    );
    focusable[0].focus();

    fireEvent.keyDown(dialog, { key: "Tab", code: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
  });
});

// ── 17–23: Accessibility ────────────────────────────────────────────────

describe("ConnectWalletModal – accessibility", () => {
  it("dialog has role=\"dialog\" and aria-modal=\"true\"", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("dialog is labelled by the heading", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).not.toBeNull();
    const heading = document.getElementById(labelId!);
    expect(heading).toHaveTextContent("Connect wallet");
  });

  it("each provider button has a non-empty aria-label", () => {
    renderModal();
    const providers = [
      "freighter", "albedo", "xbull", "rabet", "lobstr", "walletconnect",
    ];
    for (const id of providers) {
      const btn = screen.getByTestId(`provider-button-${id}`);
      expect(btn.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("last-used provider button aria-label contains \"(last used)\"", () => {
    const storage = createMemoryStorage();
    setLastUsedProvider("rabet", storage);
    renderModal({ storage });

    const btn = screen.getByTestId("provider-button-rabet");
    expect(btn.getAttribute("aria-label")).toContain("(last used)");
  });

  it("non-last-used buttons do NOT have \"(last used)\" in aria-label", () => {
    const storage = createMemoryStorage();
    setLastUsedProvider("rabet", storage);
    renderModal({ storage });

    const freighterBtn = screen.getByTestId("provider-button-freighter");
    expect(freighterBtn.getAttribute("aria-label")).not.toContain("(last used)");
  });

  it("close button has an accessible aria-label", () => {
    renderModal();
    expect(
      screen.getByRole("button", { name: /close connect wallet/i }),
    ).toBeInTheDocument();
  });

  it("backdrop is aria-hidden", () => {
    renderModal();
    expect(screen.getByTestId("modal-backdrop")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("Last used badge is aria-hidden (decorative)", () => {
    const storage = createMemoryStorage();
    setLastUsedProvider("walletconnect", storage);
    renderModal({ storage });

    const badge = screen.getByTestId("last-used-badge");
    expect(badge).toHaveAttribute("aria-hidden", "true");
  });
});
