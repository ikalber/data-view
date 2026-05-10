# Data View

Visor de bases de datos al estilo Beekeeper Studio. Un solo monorepo, dos targets:

- **`apps/web`** — Next.js 15 + Auth.js. Pensado para hostear en un dominio. Login multiusuario; cada usuario ve solo sus propias conexiones, con contraseñas cifradas en reposo (AES-256-GCM).
- **`apps/desktop`** — Tauri v2 + Rust. Genera un `.msi` / `.exe` para Windows (también `.dmg` para macOS y `.deb`/`.AppImage` para Linux). Login opcional; las conexiones se guardan en el directorio de configuración del usuario.

Ambas comparten:
- **`packages/core`** — tipos TS y la interfaz `Transport` (la abstracción que hace que la UI no sepa si está hablando con un endpoint HTTP o con un comando Tauri).
- **`packages/ui`** — componentes React (lista de conexiones, árbol de schemas/tablas, editor SQL, tabla de resultados).

Bases de datos soportadas en esta versión: **PostgreSQL · MySQL/MariaDB · SQL Server**.

---

## Estructura

```
data-view/
├── apps/
│   ├── web/            # Next.js 15 + Auth.js + drivers TS (pg, mysql2, mssql)
│   └── desktop/        # Tauri v2 + Rust (tokio-postgres, mysql_async, tiberius)
├── packages/
│   ├── core/           # Tipos TS + interfaz Transport
│   └── ui/             # Componentes React compartidos
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## Cómo encajan las dos versiones

```
┌──────────────────────────┐    ┌──────────────────────────┐
│   apps/web (Next.js)     │    │  apps/desktop (Tauri)    │
│                          │    │                          │
│   AppShell ◀── @data-view/ui  ──▶  AppShell              │
│       │                  │    │       │                  │
│   WebTransport           │    │   TauriTransport         │
│   fetch('/api/...')      │    │   invoke('...')          │
│       │                  │    │       │                  │
│   Next.js route handlers │    │   Tauri commands (Rust)  │
│   pg / mysql2 / mssql    │    │   tokio-postgres /       │
│   Auth.js + SQLite users │    │   mysql_async / tiberius │
└──────────────────────────┘    └──────────────────────────┘
```

La UI es la misma. Lo único que cambia es el `Transport` que se inyecta.

---

## Requisitos

- **Node 20+** y **pnpm 11+** (`npm i -g pnpm`)
- Para compilar el desktop: **Rust 1.77+** (`rustup`) y las dependencias de Tauri:
  - **Windows**: WebView2 (incluido en Windows 11). Para compilar desde Linux usá `cargo-xwin` o construí en CI con `windows-latest`.
  - **Linux** (dev local): `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev`
  - **macOS**: Xcode Command Line Tools.

Documentación oficial de prerequisitos: <https://v2.tauri.app/start/prerequisites/>

## Setup

```bash
pnpm install
```

---

## Versión web

```bash
cp apps/web/.env.example apps/web/.env.local
# Generá los dos secrets:
echo "AUTH_SECRET=$(openssl rand -base64 32)" >> apps/web/.env.local
echo "DATA_VIEW_MASTER_KEY=$(openssl rand -base64 32)" >> apps/web/.env.local

pnpm dev:web
# → http://localhost:3000
```

Primer usuario: clic en "Registrarme". Después podés deshabilitar el alta seteando
`ALLOW_SIGNUP=false`.

### Persistencia

- Usuarios y conexiones viven en SQLite local (`apps/web/data/local.db` por default).
- Las contraseñas de las DBs se cifran con AES-256-GCM usando `DATA_VIEW_MASTER_KEY`.
- Cada usuario solo ve sus propias conexiones; las queries van a la base destino con la cuenta de cada usuario.

### Deploy

Cualquier host de Next.js sirve (Vercel, Render, Railway, fly.io, VPS). Tené en cuenta:

- `better-sqlite3` es nativo. Si tu host no permite módulos nativos, reemplazá por Postgres como store usando los mismos repos.
- `AUTH_SECRET` y `DATA_VIEW_MASTER_KEY` son **obligatorios** en prod. Si rotás la master key, las contraseñas guardadas dejan de poder descifrarse.

---

## Versión desktop

```bash
pnpm dev:desktop      # arranca Vite + abre la ventana Tauri
pnpm build:desktop    # genera bundles en apps/desktop/src-tauri/target/release/bundle/
```

### Generar el `.msi` / `.exe` para Windows

- **Desde Windows** (recomendado): instalá Rust + Visual Studio Build Tools + WebView2 y corré `pnpm build:desktop`. El instalador queda en `apps/desktop/src-tauri/target/release/bundle/msi/` y `bundle/nsis/`.
- **Desde Linux/macOS** (cross-compile): instalá `cargo-xwin` (`cargo install cargo-xwin`) y agregá un target Rust para Windows (`rustup target add x86_64-pc-windows-msvc`); después `pnpm tauri build --target x86_64-pc-windows-msvc`.
- **Vía GitHub Actions**: usá la matriz oficial de Tauri (workflow ejemplo en <https://v2.tauri.app/distribute/pipelines/github/>).

### Persistencia

- Las conexiones se guardan en JSON dentro de `%APPDATA%/data-view/connections.json` (Windows), `~/Library/Application Support/data-view/` (macOS) o `~/.config/data-view/` (Linux).
- Las contraseñas se cifran con AES-256-GCM usando una clave derivada por Argon2id de un secreto local (rotable a futuro vía master password — el módulo `crypto.rs` está listo para extender).

### Login opcional

Esta versión todavía no fuerza login local. Si más adelante querés agregar un master password para desbloquear el archivo, el módulo `crypto.rs` ya tiene la base; alcanza con cambiar la fuente del secreto por una passphrase ingresada al inicio.

---

## Comandos útiles

```bash
pnpm typecheck         # tsc --noEmit en todos los paquetes
pnpm dev:web           # Next.js en modo dev
pnpm dev:desktop       # Vite (sin Tauri); para abrir la ventana usá pnpm tauri:dev
pnpm --filter @data-view/desktop tauri:dev     # arranca también el binario Rust
pnpm build:web
pnpm build:desktop
```

## Roadmap corto

- [ ] Edición inline de filas (UPDATE/DELETE con confirmación)
- [ ] Soporte SSL/TLS completo en el driver Postgres del desktop
- [ ] Master password opcional para el desktop
- [ ] OAuth (Google/GitHub) para la web
- [ ] Export a CSV / JSON desde la grilla
- [ ] Historial de queries por conexión
