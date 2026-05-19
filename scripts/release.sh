#!/usr/bin/env bash
#
# release.sh — bump version en todos los manifiestos, commitear, taggear y pushear.
#
# Uso:
#   ./scripts/release.sh <version> [--no-push] [--allow-dirty]
#
# Ejemplos:
#   ./scripts/release.sh 0.2.0
#   ./scripts/release.sh 0.2.0 --no-push
#
# Lugares actualizados:
#   - package.json (root)
#   - apps/web/package.json
#   - apps/desktop/package.json
#   - packages/core/package.json
#   - packages/ui/package.json
#   - apps/desktop/src-tauri/Cargo.toml
#   - apps/desktop/src-tauri/tauri.conf.json
#   - apps/desktop/src-tauri/Cargo.lock  (entry data-view-desktop)
#
# Luego: git add, commit "chore: release vX.Y.Z", tag vX.Y.Z, push origin <branch> + tag.

set -euo pipefail

# ---------- args ----------
if [[ $# -lt 1 ]]; then
    echo "uso: $0 <version> [--no-push] [--allow-dirty]" >&2
    exit 1
fi

NEW_VERSION="$1"
shift || true

DO_PUSH=1
ALLOW_DIRTY=0
for arg in "$@"; do
    case "$arg" in
        --no-push)     DO_PUSH=0 ;;
        --allow-dirty) ALLOW_DIRTY=1 ;;
        *) echo "flag desconocida: $arg" >&2; exit 1 ;;
    esac
done

# valida semver básico (X.Y.Z con sufijo opcional -algo)
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    echo "version inválida: '$NEW_VERSION' (esperado X.Y.Z o X.Y.Z-pre)" >&2
    exit 1
fi

TAG="v${NEW_VERSION}"

# ---------- ubicarse en raíz del repo ----------
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# archivos que el script modifica (también la lista usada para `git add`)
TRACKED_FILES=(
    "package.json"
    "apps/web/package.json"
    "apps/desktop/package.json"
    "packages/core/package.json"
    "packages/ui/package.json"
    "apps/desktop/src-tauri/tauri.conf.json"
    "apps/desktop/src-tauri/Cargo.toml"
    "apps/desktop/src-tauri/Cargo.lock"
)

# ---------- chequeos previos ----------
# sólo bloqueamos si alguno de los archivos que vamos a tocar tiene cambios
# pendientes — el resto del working tree (submódulos, untracked, etc.) se ignora.
if [[ $ALLOW_DIRTY -eq 0 ]]; then
    DIRTY="$(git status --porcelain -- "${TRACKED_FILES[@]}")"
    if [[ -n "$DIRTY" ]]; then
        echo "los siguientes archivos a modificar ya tienen cambios pendientes:" >&2
        echo "$DIRTY" >&2
        echo "commiteá/stasheá esos cambios o usá --allow-dirty." >&2
        exit 1
    fi
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo "el tag $TAG ya existe." >&2
    exit 1
fi

CURRENT_VERSION="$(node -p "require('./package.json').version")"
echo "→ bump $CURRENT_VERSION  ➜  $NEW_VERSION (tag $TAG)"

# ---------- helpers ----------
bump_pkg_json() {
    local file="$1"
    node -e "
        const fs = require('fs');
        const p = '$file';
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        j.version = '$NEW_VERSION';
        fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
    "
    echo "  ✓ $file"
}

bump_tauri_conf() {
    local file="$1"
    node -e "
        const fs = require('fs');
        const p = '$file';
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        j.version = '$NEW_VERSION';
        fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
    "
    echo "  ✓ $file"
}

bump_cargo_toml() {
    # cambia la PRIMERA línea 'version = "..."' (la del [package])
    local file="$1"
    awk -v new="$NEW_VERSION" '
        !done && /^version[[:space:]]*=[[:space:]]*"[^"]+"/ {
            sub(/"[^"]+"/, "\"" new "\"")
            done = 1
        }
        { print }
    ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
    echo "  ✓ $file"
}

bump_cargo_lock() {
    # actualiza la 'version' del bloque cuyo name = "data-view-desktop"
    local file="$1"
    awk -v new="$NEW_VERSION" '
        /^name = "data-view-desktop"$/ { hit = 1; print; next }
        hit && /^version = "[^"]+"$/ {
            sub(/"[^"]+"/, "\"" new "\"")
            hit = 0
        }
        { print }
    ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
    echo "  ✓ $file"
}

# ---------- aplicar bumps ----------
echo "actualizando manifiestos…"
bump_pkg_json   "package.json"
bump_pkg_json   "apps/web/package.json"
bump_pkg_json   "apps/desktop/package.json"
bump_pkg_json   "packages/core/package.json"
bump_pkg_json   "packages/ui/package.json"
bump_tauri_conf "apps/desktop/src-tauri/tauri.conf.json"
bump_cargo_toml "apps/desktop/src-tauri/Cargo.toml"
bump_cargo_lock "apps/desktop/src-tauri/Cargo.lock"

# ---------- commit + tag ----------
git add -- "${TRACKED_FILES[@]}"

if git diff --cached --quiet; then
    echo "no hay cambios para commitear (¿las versiones ya estaban en $NEW_VERSION?)" >&2
    exit 1
fi

git commit -m "chore: release ${TAG}"
git tag -a "$TAG" -m "Release ${TAG}"

echo "✓ commit y tag $TAG creados localmente."

# ---------- push ----------
if [[ $DO_PUSH -eq 1 ]]; then
    BRANCH="$(git symbolic-ref --short HEAD)"
    echo "→ pushing $BRANCH y $TAG a origin…"
    git push origin "$BRANCH"
    git push origin "$TAG"
    echo "✓ push completo."
else
    echo "ℹ --no-push: no se pusheó. para hacerlo manualmente:"
    echo "    git push origin \$(git symbolic-ref --short HEAD) && git push origin $TAG"
fi
