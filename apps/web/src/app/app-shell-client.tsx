"use client";

import { useEffect, useState } from "react";
import { AppShell, ThemeProvider, TransportProvider } from "@data-view/ui";
import { webTransport } from "@/transport/web-transport";

export function AppShellClient({ email }: { email: string }) {
  return (
    <ThemeProvider>
      <TransportProvider transport={webTransport}>
        <AppShell userArea={<UserArea email={email} />} />
      </TransportProvider>
    </ThemeProvider>
  );
}

function UserArea({ email }: { email: string }) {
  const [confirming, setConfirming] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  return (
    <>
      <button
        type="button"
        className="dv-topbar-link"
        title={email}
        onClick={() => setConfirming(true)}
        style={{
          background: "transparent",
          border: 0,
          padding: 0,
          cursor: "pointer",
          font: "inherit",
        }}
      >
        {email} · salir
      </button>
      {confirming && (
        <SignOutConfirmModal
          email={email}
          busy={signingOut}
          onCancel={() => {
            if (!signingOut) setConfirming(false);
          }}
          onConfirm={() => {
            setSigningOut(true);
            window.location.href = "/api/auth/signout";
          }}
        />
      )}
    </>
  );
}

interface SignOutConfirmModalProps {
  email: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function SignOutConfirmModal({
  email,
  busy,
  onCancel,
  onConfirm,
}: SignOutConfirmModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="dv-modal-backdrop"
      role="dialog"
      aria-modal
      aria-labelledby="dv-signout-title"
      onClick={onCancel}
    >
      <div className="dv-modal" onClick={(e) => e.stopPropagation()}>
        <h2 id="dv-signout-title">Cerrar sesión</h2>
        <p style={{ margin: "0 0 8px", fontSize: 14 }}>
          ¿Querés cerrar la sesión de <strong>{email}</strong>?
        </p>
        <div className="dv-modal-actions">
          <button
            type="button"
            className="dv-button"
            onClick={onCancel}
            disabled={busy}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="dv-button is-danger"
            onClick={onConfirm}
            disabled={busy}
            autoFocus
          >
            {busy ? "Saliendo…" : "Cerrar sesión"}
          </button>
        </div>
      </div>
    </div>
  );
}
