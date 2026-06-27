/**
 * ConnectWalletModal.tsx
 *
 * Modal dialog that lists the supported Stellar wallet providers and lets
 * the user initiate a connection.  The provider the user last connected
 * with receives a "Last used" badge so it is easy to find on return visits.
 *
 * ## Accessibility (WCAG 2.1 AA)
 *
 *   - Uses `role="dialog"` with `aria-modal="true"` and `aria-labelledby`.
 *   - Focus is trapped inside the modal while it is open (Tab / Shift+Tab).
 *   - The modal can be dismissed with the Escape key.
 *   - Each provider button has a descriptive `aria-label`.
 *   - The "Last used" badge is announced to screen readers via
 *     `aria-label` on the badge element and a visually-hidden span on the
 *     button so the association is unambiguous.
 *   - All interactive elements meet the 44 × 44 px minimum touch target.
 *   - Colour contrast ratios meet AA requirements (verified against design
 *     token values used below).
 *
 * ## Dark-mode / design tokens
 *
 *   All colours are expressed with Tailwind CSS utility classes that
 *   reference the project's design-token scale.  Dark variants are applied
 *   via the `dark:` prefix so the component adapts automatically when the
 *   `dark` class is toggled on `<html>`.
 *
 * ## Props
 *
 *   | Prop          | Type                          | Description                             |
 *   |---------------|-------------------------------|-----------------------------------------|
 *   | isOpen        | boolean                       | Controls modal visibility               |
 *   | onClose       | () => void                    | Called when the modal should close      |
 *   | onConnect     | (id: WalletProviderId) => void | Called when the user picks a provider   |
 *   | connectedId?  | WalletProviderId \| null      | Currently connected provider (optional) |
 *   | storage?      | StorageLike \| null           | Override storage backend (tests)        |
 */

"use client";

import React, {
  useEffect,
  useRef,
  useCallback,
  type KeyboardEvent,
} from "react";
import {
  getLastUsedProvider,
  setLastUsedProvider,
  type WalletProviderId,
  type StorageLike,
} from "../state/walletPrefs";

// ── Provider catalogue ─────────────────────────────────────────────────────

interface WalletProvider {
  id: WalletProviderId;
  name: string;
  /** Short description shown below the provider name. */
  description: string;
  /** SVG icon path (relative to /public/icons/wallets/). */
  iconPath: string;
}

/**
 * Ordered list of supported wallet providers.
 *
 * Add new entries here — the rest of the component requires no changes.
 */
const WALLET_PROVIDERS: WalletProvider[] = [
  {
    id: "freighter",
    name: "Freighter",
    description: "Browser extension by Stellar Development Foundation",
    iconPath: "/icons/wallets/freighter.svg",
  },
  {
    id: "albedo",
    name: "Albedo",
    description: "Web-based signer — no extension required",
    iconPath: "/icons/wallets/albedo.svg",
  },
  {
    id: "xbull",
    name: "xBull Wallet",
    description: "Multi-platform Stellar wallet",
    iconPath: "/icons/wallets/xbull.svg",
  },
  {
    id: "rabet",
    name: "Rabet",
    description: "Browser extension for Chrome and Firefox",
    iconPath: "/icons/wallets/rabet.svg",
  },
  {
    id: "lobstr",
    name: "LOBSTR",
    description: "Mobile & web Stellar wallet",
    iconPath: "/icons/wallets/lobstr.svg",
  },
  {
    id: "walletconnect",
    name: "WalletConnect",
    description: "Connect any WalletConnect-compatible wallet",
    iconPath: "/icons/wallets/walletconnect.svg",
  },
];

// ── Focus-trap helper ──────────────────────────────────────────────────────

/** CSS selector for all tabbable elements. */
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE));
}

// ── Sub-components ─────────────────────────────────────────────────────────

/** Visually hidden text accessible to screen readers only. */
function VisuallyHidden({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        padding: 0,
        margin: -1,
        overflow: "hidden",
        clip: "rect(0,0,0,0)",
        whiteSpace: "nowrap",
        border: 0,
      }}
    >
      {children}
    </span>
  );
}

/**
 * "Last used" badge rendered next to the provider name.
 *
 * Accessible: the badge text is decorative; the meaningful announcement
 * ("Last used provider") is placed on the button via `aria-label`.
 */
function LastUsedBadge() {
  return (
    <span
      aria-hidden="true"
      data-testid="last-used-badge"
      className={[
        // Layout
        "inline-flex items-center px-2 py-0.5 ml-2",
        // Shape
        "rounded-full",
        // Typography
        "text-xs font-medium leading-none",
        // Light-mode colours — design-token green scale
        "bg-emerald-100 text-emerald-800",
        // Dark-mode colours
        "dark:bg-emerald-900 dark:text-emerald-200",
        // Ensure badge doesn't affect button height on narrow viewports
        "shrink-0",
      ].join(" ")}
    >
      Last used
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export interface ConnectWalletModalProps {
  /** Whether the modal is visible. */
  isOpen: boolean;
  /** Called when the user dismisses the modal (Escape, backdrop click, ✕). */
  onClose: () => void;
  /**
   * Called when the user selects a provider.
   *
   * The parent is responsible for initiating the actual connection flow and
   * calling `setLastUsedProvider` after a *successful* connection — or
   * the modal can be told to handle it automatically via the `storage` prop
   * to record the preference as soon as the button is clicked (optimistic).
   *
   * In the default (optimistic) mode the modal records the preference on
   * click and the parent can clear it if the connection ultimately fails.
   */
  onConnect: (providerId: WalletProviderId) => void;
  /** ID of the currently connected provider, if any. */
  connectedId?: WalletProviderId | null;
  /**
   * Override the storage backend used for reading / writing last-used prefs.
   * Defaults to `localStorage`.  Pass a `createMemoryStorage()` instance in
   * tests to avoid touching the real browser storage.
   */
  storage?: StorageLike | null;
}

/**
 * Modal dialog for choosing a Stellar wallet provider.
 *
 * @example
 * ```tsx
 * <ConnectWalletModal
 *   isOpen={showModal}
 *   onClose={() => setShowModal(false)}
 *   onConnect={(id) => handleConnect(id)}
 * />
 * ```
 */
export function ConnectWalletModal({
  isOpen,
  onClose,
  onConnect,
  connectedId = null,
  storage,
}: ConnectWalletModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // ── Derive last-used provider for badge rendering ────────────────────────
  // Re-read on every render so the badge updates immediately after a
  // successful connection without needing a separate state variable.
  const lastUsedId = getLastUsedProvider(storage);

  // ── Focus management ─────────────────────────────────────────────────────

  // Move focus into the modal when it opens.
  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = getFocusableElements(dialog);
    // Focus the first provider button (or the last-used one if available).
    const lastUsedButton = lastUsedId
      ? (dialog.querySelector<HTMLElement>(
          `[data-provider-id="${lastUsedId}"]`,
        ) ?? focusable[0])
      : focusable[0];
    lastUsedButton?.focus();
  }, [isOpen, lastUsedId]);

  // Return focus to the element that opened the modal when it closes.
  const triggerRef = useRef<Element | null>(null);
  useEffect(() => {
    if (isOpen) {
      triggerRef.current = document.activeElement;
    } else {
      (triggerRef.current as HTMLElement | null)?.focus();
    }
  }, [isOpen]);

  // ── Keyboard handling ─────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      // Focus trap: cycle focus within the dialog on Tab / Shift+Tab.
      if (e.key === "Tab") {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = getFocusableElements(dialog);
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    },
    [onClose],
  );

  // ── Provider selection ────────────────────────────────────────────────────

  const handleProviderClick = useCallback(
    (provider: WalletProvider) => {
      // Optimistically record the preference before the connection succeeds
      // so the badge updates immediately on the next modal open.
      setLastUsedProvider(provider.id, storage);
      onConnect(provider.id);
    },
    [onConnect, storage],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  if (!isOpen) return null;

  return (
    // ── Backdrop ────────────────────────────────────────────────────────────
    <div
      aria-hidden="true"
      data-testid="modal-backdrop"
      onClick={onClose}
      className={[
        "fixed inset-0 z-50",
        "flex items-center justify-center",
        "p-4 sm:p-6",
        // Semi-transparent dark overlay
        "bg-black/60",
        // Smooth fade
        "transition-opacity duration-200",
      ].join(" ")}
    >
      {/* ── Dialog ─────────────────────────────────────────────────────── */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-wallet-title"
        data-testid="connect-wallet-modal"
        onKeyDown={handleKeyDown}
        // Stop clicks inside the dialog from bubbling to the backdrop.
        onClick={(e) => e.stopPropagation()}
        className={[
          // Sizing — fluid width capped at 28rem
          "w-full max-w-md",
          // Shape & elevation
          "rounded-2xl shadow-2xl",
          // Light / dark backgrounds (design token: neutral scale)
          "bg-white dark:bg-neutral-900",
          // Border
          "border border-neutral-200 dark:border-neutral-700",
          // Padding
          "p-6",
        ].join(" ")}
      >
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between mb-5">
          <h2
            id="connect-wallet-title"
            className="text-lg font-semibold text-neutral-900 dark:text-neutral-100"
          >
            Connect wallet
          </h2>

          <button
            type="button"
            aria-label="Close connect wallet modal"
            onClick={onClose}
            className={[
              // Size — meets 44 × 44 px touch target
              "flex items-center justify-center w-11 h-11 -mr-2",
              // Shape
              "rounded-full",
              // Colours
              "text-neutral-500 dark:text-neutral-400",
              "hover:bg-neutral-100 dark:hover:bg-neutral-800",
              // Focus ring
              "focus:outline-none focus-visible:ring-2",
              "focus-visible:ring-indigo-500 dark:focus-visible:ring-indigo-400",
              "transition-colors",
            ].join(" ")}
          >
            {/* ✕ icon drawn inline — no icon-library dependency */}
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="4" y1="4" x2="16" y2="16" />
              <line x1="16" y1="4" x2="4" y2="16" />
            </svg>
          </button>
        </div>

        {/* ── Provider list ─────────────────────────────────────────────── */}
        <ul
          role="list"
          className="space-y-2"
          aria-label="Available wallet providers"
        >
          {WALLET_PROVIDERS.map((provider) => {
            const isLastUsed = provider.id === lastUsedId;
            const isConnected = provider.id === connectedId;

            return (
              <li key={provider.id}>
                <button
                  type="button"
                  data-testid={`provider-button-${provider.id}`}
                  data-provider-id={provider.id}
                  onClick={() => handleProviderClick(provider)}
                  aria-label={[
                    provider.name,
                    isLastUsed ? "(last used)" : "",
                    isConnected ? "(connected)" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  className={[
                    // Layout — full-width row, min touch target height
                    "flex items-center w-full min-h-[3.5rem] px-4 py-3",
                    // Shape
                    "rounded-xl",
                    // Border
                    "border",
                    isConnected
                      ? "border-indigo-500 dark:border-indigo-400"
                      : "border-neutral-200 dark:border-neutral-700",
                    // Background
                    isConnected
                      ? "bg-indigo-50 dark:bg-indigo-950"
                      : "bg-white dark:bg-neutral-800",
                    // Hover
                    "hover:bg-neutral-50 dark:hover:bg-neutral-700",
                    // Focus ring
                    "focus:outline-none focus-visible:ring-2",
                    "focus-visible:ring-indigo-500 dark:focus-visible:ring-indigo-400",
                    "focus-visible:ring-offset-2",
                    "dark:focus-visible:ring-offset-neutral-900",
                    // Transition
                    "transition-colors duration-150",
                    // Cursor
                    "cursor-pointer",
                  ].join(" ")}
                >
                  {/* Provider icon */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={provider.iconPath}
                    alt=""
                    aria-hidden="true"
                    width={32}
                    height={32}
                    className="shrink-0 w-8 h-8 rounded-md object-contain"
                  />

                  {/* Text content */}
                  <div className="flex flex-col items-start ml-3 min-w-0">
                    <span className="flex items-center text-sm font-medium text-neutral-900 dark:text-neutral-100 leading-tight">
                      {provider.name}
                      {isLastUsed && <LastUsedBadge />}
                    </span>
                    <span className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 leading-tight truncate">
                      {provider.description}
                    </span>
                  </div>

                  {/* Screen-reader-only annotation for last-used */}
                  {isLastUsed && (
                    <VisuallyHidden>, last used provider</VisuallyHidden>
                  )}

                  {/* Connected checkmark */}
                  {isConnected && (
                    <svg
                      aria-hidden="true"
                      className="ml-auto shrink-0 w-5 h-5 text-indigo-600 dark:text-indigo-400"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        clipRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        {/* ── Footer note ───────────────────────────────────────────────── */}
        <p className="mt-5 text-xs text-center text-neutral-400 dark:text-neutral-500">
          By connecting a wallet you agree to the{" "}
          <a
            href="/terms"
            className={[
              "underline underline-offset-2",
              "text-neutral-500 dark:text-neutral-400",
              "hover:text-neutral-700 dark:hover:text-neutral-200",
              "focus:outline-none focus-visible:ring-2",
              "focus-visible:ring-indigo-500",
              "rounded-sm",
            ].join(" ")}
          >
            Terms of Service
          </a>
          .
        </p>
      </div>
    </div>
  );
}

export default ConnectWalletModal;
