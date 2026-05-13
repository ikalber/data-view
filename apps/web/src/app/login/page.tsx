"use client";

import { useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import { ThemeProvider, ThemeSwitcher } from "@data-view/ui";

function LoginInner() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") {
        const r = await fetch("/api/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => null);
          throw new Error(body?.error ?? "Error al registrarse");
        }
      }
      const res = await signIn("credentials", { email, password, redirect: false });
      if (res?.error) throw new Error("Credenciales inválidas");
      window.location.href = "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dv-login">
      <div className="dv-login-marketing">
        <div className="dv-brand">
          <span className="dv-brand-mark" aria-hidden />
          <span>Data View</span>
        </div>

        <h1 className="dv-login-headline">
          Tus bases de datos,<br />
          <em>tranquilas</em> al alcance.
        </h1>
        <p className="dv-login-blurb">
          Un workspace limpio y enfocado para navegar esquemas, editar filas y
          ejecutar SQL — sin ruido visual.
        </p>

        <div className="dv-login-foot">
          <span>v0.1.9</span>
          <span style={{ width: 1, height: 10, background: "var(--dv-border)" }} />
          <span>postgres · mysql · sqlserver</span>
        </div>
      </div>

      <div className="dv-login-form-wrap">
        <div
          style={{
            position: "absolute",
            top: 24,
            right: 24,
          }}
        >
          <ThemeSwitcher />
        </div>

        <form onSubmit={onSubmit} className="dv-login-form">
          <h2>{mode === "login" ? "Ingresar" : "Crear cuenta"}</h2>
          <div className="dv-login-tabs">
            <button
              type="button"
              className={`dv-login-tab ${mode === "login" ? "is-active" : ""}`}
              onClick={() => setMode("login")}
            >
              Ingresar
            </button>
            <button
              type="button"
              className={`dv-login-tab ${mode === "signup" ? "is-active" : ""}`}
              onClick={() => setMode("signup")}
            >
              Registrarme
            </button>
          </div>

          <div className="dv-login-field">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              className="dv-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="dv-login-field">
            <label htmlFor="login-password">Contraseña</label>
            <input
              id="login-password"
              className="dv-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && <div className="dv-error">{error}</div>}

          <div className="dv-login-actions">
            <button type="submit" className="dv-button is-primary" disabled={busy}>
              {busy ? "..." : mode === "login" ? "Ingresar" : "Crear cuenta"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <ThemeProvider>
      <LoginInner />
    </ThemeProvider>
  );
}
