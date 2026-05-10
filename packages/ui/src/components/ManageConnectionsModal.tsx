"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import {
  TAG_COLORS,
  type ConnectionConfig,
  type Folder,
  type Tag,
  type TagColor,
} from "@data-view/core";
import { useTransport } from "../transport-context";

interface Props {
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}

type Pane = "folders" | "tags";

export function ManageConnectionsModal({ onClose, onChanged }: Props) {
  const transport = useTransport();
  const [pane, setPane] = useState<Pane>("folders");
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Folder pane state
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [folderDraftName, setFolderDraftName] = useState("");
  const [folderDraftColor, setFolderDraftColor] = useState<TagColor>("neutral");

  // Tag pane state
  const [tagDraftName, setTagDraftName] = useState("");
  const [tagDraftColor, setTagDraftColor] = useState<TagColor>("info");

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, f, t] = await Promise.all([
        transport.listConnections(),
        transport.listFolders(),
        transport.listTags(),
      ]);
      setConnections(c);
      setFolders(f);
      setTags(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tagsById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);

  const grouped = useMemo(() => {
    const byFolder = new Map<string | null, ConnectionConfig[]>();
    byFolder.set(null, []);
    for (const f of folders) byFolder.set(f.id, []);
    for (const c of connections) {
      const key = c.folderId && byFolder.has(c.folderId) ? c.folderId : null;
      const list = byFolder.get(key) ?? [];
      list.push(c);
      byFolder.set(key, list);
    }
    return byFolder;
  }, [connections, folders]);

  const activeConnections =
    activeFolderId === undefined
      ? connections
      : grouped.get(activeFolderId ?? null) ?? [];

  async function bumpChanged() {
    await refresh();
    await onChanged();
  }

  async function handleCreateFolder() {
    const name = folderDraftName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await transport.saveFolder({
        name,
        color: folderDraftColor,
      });
      setFolderDraftName("");
      setFolderDraftColor("neutral");
      setActiveFolderId(created.id);
      await bumpChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRenameFolder(folder: Folder, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === folder.name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await transport.saveFolder({
        id: folder.id,
        name: trimmed,
        color: folder.color,
      });
      await bumpChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleFolderColor(folder: Folder, color: TagColor) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await transport.saveFolder({ id: folder.id, name: folder.name, color });
      await bumpChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteFolder(folder: Folder) {
    if (busy) return;
    if (!confirm(`Borrar carpeta "${folder.name}"? Las conexiones quedarán sin carpeta.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await transport.deleteFolder(folder.id);
      if (activeFolderId === folder.id) setActiveFolderId(null);
      await bumpChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleMoveConnection(conn: ConnectionConfig, folderId: string | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await transport.saveConnection({
        id: conn.id,
        name: conn.name,
        driver: conn.driver,
        host: conn.host,
        port: conn.port,
        database: conn.database,
        username: conn.username,
        ssl: conn.ssl,
        options: conn.options,
        folderId,
        tagIds: conn.tagIds,
      });
      await bumpChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleTag(conn: ConnectionConfig, tagId: string) {
    if (busy) return;
    const next = conn.tagIds.includes(tagId)
      ? conn.tagIds.filter((t) => t !== tagId)
      : [...conn.tagIds, tagId];
    setBusy(true);
    setError(null);
    try {
      await transport.saveConnection({
        id: conn.id,
        name: conn.name,
        driver: conn.driver,
        host: conn.host,
        port: conn.port,
        database: conn.database,
        username: conn.username,
        ssl: conn.ssl,
        options: conn.options,
        folderId: conn.folderId,
        tagIds: next,
      });
      await bumpChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateTag() {
    const name = tagDraftName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await transport.saveTag({ name, color: tagDraftColor });
      setTagDraftName("");
      setTagDraftColor("info");
      await bumpChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRenameTag(tag: Tag, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === tag.name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await transport.saveTag({ id: tag.id, name: trimmed, color: tag.color });
      await bumpChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleTagColor(tag: Tag, color: TagColor) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await transport.saveTag({ id: tag.id, name: tag.name, color });
      await bumpChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteTag(tag: Tag) {
    if (busy) return;
    if (tag.kind === "system") {
      setError("No se pueden borrar las etiquetas del sistema.");
      return;
    }
    if (!confirm(`Borrar etiqueta "${tag.name}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await transport.deleteTag(tag.id);
      await bumpChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dv-modal-backdrop" role="dialog" aria-modal>
      <div className="dv-modal dv-modal-wide">
        <div className="dv-modal-header">
          <h2>Gestionar conexiones</h2>
          <button
            className="dv-icon-button"
            onClick={onClose}
            aria-label="Cerrar"
            title="Cerrar"
          >
            ✕
          </button>
        </div>

        <div className="dv-tabbar">
          <button
            type="button"
            className={clsx("dv-tab", pane === "folders" && "is-active")}
            onClick={() => setPane("folders")}
          >
            Carpetas · {folders.length}
          </button>
          <button
            type="button"
            className={clsx("dv-tab", pane === "tags" && "is-active")}
            onClick={() => setPane("tags")}
          >
            Etiquetas · {tags.length}
          </button>
        </div>

        {error && <div className="dv-error">{error}</div>}
        {loading ? (
          <div className="dv-empty" style={{ padding: 24 }}>Cargando…</div>
        ) : pane === "folders" ? (
          <div className="dv-manage-grid">
            <aside className="dv-manage-sidepanel">
              <div className="dv-manage-section-title">Carpetas</div>
              <div className="dv-manage-folder-list">
                <FolderRow
                  active={activeFolderId === null}
                  label="Sin carpeta"
                  count={(grouped.get(null) ?? []).length}
                  color="neutral"
                  onClick={() => setActiveFolderId(null)}
                />
                {folders.map((f) => (
                  <FolderRow
                    key={f.id}
                    active={activeFolderId === f.id}
                    label={f.name}
                    color={f.color}
                    count={(grouped.get(f.id) ?? []).length}
                    onClick={() => setActiveFolderId(f.id)}
                    onRename={(name) => handleRenameFolder(f, name)}
                    onChangeColor={(c) => handleFolderColor(f, c)}
                    onDelete={() => handleDeleteFolder(f)}
                  />
                ))}
              </div>

              <div className="dv-manage-create">
                <div className="dv-manage-section-title">Nueva carpeta</div>
                <input
                  className="dv-input"
                  placeholder="Nombre"
                  value={folderDraftName}
                  onChange={(e) => setFolderDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreateFolder();
                  }}
                />
                <ColorPicker
                  value={folderDraftColor}
                  onChange={setFolderDraftColor}
                />
                <button
                  type="button"
                  className="dv-button is-primary"
                  onClick={() => void handleCreateFolder()}
                  disabled={busy || !folderDraftName.trim()}
                >
                  Crear carpeta
                </button>
              </div>
            </aside>

            <section className="dv-manage-main">
              <div className="dv-manage-section-title">
                {activeFolderId === null
                  ? `Sin carpeta · ${activeConnections.length}`
                  : `${folders.find((f) => f.id === activeFolderId)?.name ?? ""} · ${activeConnections.length}`}
              </div>
              {activeConnections.length === 0 ? (
                <div className="dv-empty" style={{ padding: 16, fontSize: 12 }}>
                  No hay conexiones acá. Movelas desde otras carpetas usando el
                  selector de cada fila.
                </div>
              ) : (
                <div className="dv-manage-conn-list">
                  {activeConnections.map((c) => (
                    <ConnectionRow
                      key={c.id}
                      connection={c}
                      folders={folders}
                      tags={tags}
                      tagsById={tagsById}
                      onMove={(folderId) => handleMoveConnection(c, folderId)}
                      onToggleTag={(tagId) => handleToggleTag(c, tagId)}
                      disabled={busy}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        ) : (
          <div className="dv-manage-grid">
            <aside className="dv-manage-sidepanel">
              <div className="dv-manage-section-title">Etiquetas</div>
              <div className="dv-manage-tag-list">
                {tags.map((t) => (
                  <TagRow
                    key={t.id}
                    tag={t}
                    onRename={(name) => handleRenameTag(t, name)}
                    onChangeColor={(c) => handleTagColor(t, c)}
                    onDelete={() => handleDeleteTag(t)}
                    disabled={busy}
                  />
                ))}
              </div>

              <div className="dv-manage-create">
                <div className="dv-manage-section-title">Nueva etiqueta</div>
                <input
                  className="dv-input"
                  placeholder="Nombre"
                  value={tagDraftName}
                  onChange={(e) => setTagDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreateTag();
                  }}
                />
                <ColorPicker value={tagDraftColor} onChange={setTagDraftColor} />
                <button
                  type="button"
                  className="dv-button is-primary"
                  onClick={() => void handleCreateTag()}
                  disabled={busy || !tagDraftName.trim()}
                >
                  Crear etiqueta
                </button>
              </div>
            </aside>

            <section className="dv-manage-main">
              <div className="dv-manage-section-title">
                Aplicar etiquetas · {connections.length} conexiones
              </div>
              {connections.length === 0 ? (
                <div className="dv-empty" style={{ padding: 16, fontSize: 12 }}>
                  Sin conexiones todavía.
                </div>
              ) : (
                <div className="dv-manage-conn-list">
                  {connections.map((c) => (
                    <ConnectionRow
                      key={c.id}
                      connection={c}
                      folders={folders}
                      tags={tags}
                      tagsById={tagsById}
                      onMove={(folderId) => handleMoveConnection(c, folderId)}
                      onToggleTag={(tagId) => handleToggleTag(c, tagId)}
                      disabled={busy}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        <div className="dv-modal-actions">
          <button className="dv-button is-primary" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

interface FolderRowProps {
  label: string;
  color: TagColor;
  count: number;
  active: boolean;
  onClick: () => void;
  onRename?: (name: string) => void;
  onChangeColor?: (color: TagColor) => void;
  onDelete?: () => void;
}

function FolderRow({
  label,
  color,
  count,
  active,
  onClick,
  onRename,
  onChangeColor,
  onDelete,
}: FolderRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);

  useEffect(() => {
    setDraft(label);
  }, [label]);

  const editable = !!onRename;

  return (
    <div
      className={clsx("dv-manage-folder-row", active && "is-active")}
      onClick={onClick}
    >
      <span className={clsx("dv-tone-dot", `is-${color}`)} aria-hidden />
      {editing && editable ? (
        <input
          className="dv-input dv-manage-inline-input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => {
            setEditing(false);
            if (draft.trim() && draft.trim() !== label) onRename?.(draft);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setEditing(false);
              if (draft.trim() && draft.trim() !== label) onRename?.(draft);
            } else if (e.key === "Escape") {
              setEditing(false);
              setDraft(label);
            }
          }}
        />
      ) : (
        <span
          className="dv-manage-folder-name"
          onDoubleClick={(e) => {
            if (!editable) return;
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {label}
        </span>
      )}
      <span className="dv-manage-folder-count">{count}</span>
      {editable && (
        <span className="dv-manage-folder-tools" onClick={(e) => e.stopPropagation()}>
          <ColorSwatch
            value={color}
            onChange={(c) => onChangeColor?.(c)}
            compact
          />
          <button
            type="button"
            className="dv-icon-button"
            title="Renombrar"
            onClick={() => setEditing(true)}
          >
            ✎
          </button>
          <button
            type="button"
            className="dv-icon-button is-danger"
            title="Borrar"
            onClick={onDelete}
          >
            ✕
          </button>
        </span>
      )}
    </div>
  );
}

interface TagRowProps {
  tag: Tag;
  disabled: boolean;
  onRename: (name: string) => void;
  onChangeColor: (color: TagColor) => void;
  onDelete: () => void;
}

function TagRow({ tag, disabled, onRename, onChangeColor, onDelete }: TagRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tag.name);

  useEffect(() => {
    setDraft(tag.name);
  }, [tag.name]);

  return (
    <div className="dv-manage-tag-row">
      <span className={clsx("dv-tag", `is-${tag.color}`)}>{tag.name}</span>
      {editing ? (
        <input
          className="dv-input dv-manage-inline-input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            if (draft.trim() && draft.trim() !== tag.name) onRename(draft);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setEditing(false);
              if (draft.trim() && draft.trim() !== tag.name) onRename(draft);
            } else if (e.key === "Escape") {
              setEditing(false);
              setDraft(tag.name);
            }
          }}
        />
      ) : (
        <span className="dv-manage-tag-name" onDoubleClick={() => setEditing(true)}>
          {tag.name}
          {tag.kind === "system" && (
            <span className="dv-manage-tag-kind">sistema</span>
          )}
        </span>
      )}
      <span className="dv-manage-folder-tools">
        <ColorSwatch value={tag.color} onChange={onChangeColor} compact />
        <button
          type="button"
          className="dv-icon-button"
          title="Renombrar"
          onClick={() => setEditing(true)}
          disabled={disabled}
        >
          ✎
        </button>
        <button
          type="button"
          className="dv-icon-button is-danger"
          title={tag.kind === "system" ? "No se puede borrar (sistema)" : "Borrar"}
          onClick={onDelete}
          disabled={disabled || tag.kind === "system"}
        >
          ✕
        </button>
      </span>
    </div>
  );
}

interface ConnectionRowProps {
  connection: ConnectionConfig;
  folders: Folder[];
  tags: Tag[];
  tagsById: Map<string, Tag>;
  disabled: boolean;
  onMove: (folderId: string | null) => void;
  onToggleTag: (tagId: string) => void;
}

function ConnectionRow({
  connection,
  folders,
  tags,
  tagsById,
  disabled,
  onMove,
  onToggleTag,
}: ConnectionRowProps) {
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  return (
    <div className="dv-manage-conn-row">
      <div className="dv-manage-conn-info">
        <div className="dv-manage-conn-name">{connection.name}</div>
        <div className="dv-manage-conn-meta">
          {connection.driver} · {connection.host}:{connection.port}/{connection.database}
        </div>
        <div className="dv-manage-conn-tags">
          {connection.tagIds.length === 0 ? (
            <span className="dv-text-mute" style={{ fontSize: 11 }}>
              sin etiquetas
            </span>
          ) : (
            connection.tagIds.map((id) => {
              const t = tagsById.get(id);
              if (!t) return null;
              return (
                <span key={id} className={clsx("dv-tag", `is-${t.color}`)}>
                  {t.name}
                </span>
              );
            })
          )}
        </div>
      </div>
      <div className="dv-manage-conn-controls">
        <label className="dv-manage-conn-label">Carpeta</label>
        <select
          className="dv-select"
          value={connection.folderId ?? ""}
          disabled={disabled}
          onChange={(e) => onMove(e.target.value ? e.target.value : null)}
        >
          <option value="">Sin carpeta</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <div className="dv-manage-tag-picker-wrap">
          <button
            type="button"
            className="dv-button is-sm"
            disabled={disabled}
            onClick={() => setTagPickerOpen((o) => !o)}
          >
            Etiquetas ▾
          </button>
          {tagPickerOpen && (
            <div className="dv-popover dv-manage-tag-picker">
              {tags.length === 0 ? (
                <div className="dv-empty" style={{ padding: 12, fontSize: 12 }}>
                  Aún no hay etiquetas.
                </div>
              ) : (
                tags.map((t) => {
                  const checked = connection.tagIds.includes(t.id);
                  return (
                    <label
                      key={t.id}
                      className={clsx(
                        "dv-popover-row dv-manage-tag-option",
                        checked && "is-active",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggleTag(t.id)}
                        disabled={disabled}
                      />
                      <span className={clsx("dv-tag", `is-${t.color}`)}>
                        {t.name}
                      </span>
                    </label>
                  );
                })
              )}
              <div
                className="dv-popover-footer"
                onClick={() => setTagPickerOpen(false)}
              >
                Cerrar
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ColorPickerProps {
  value: TagColor;
  onChange: (c: TagColor) => void;
}

function ColorPicker({ value, onChange }: ColorPickerProps) {
  return (
    <div className="dv-color-picker" role="radiogroup" aria-label="Color">
      {TAG_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c === value}
          className={clsx("dv-color-swatch", `is-${c}`, c === value && "is-active")}
          onClick={() => onChange(c)}
          title={c}
        />
      ))}
    </div>
  );
}

interface ColorSwatchProps {
  value: TagColor;
  onChange: (c: TagColor) => void;
  compact?: boolean;
}

function ColorSwatch({ value, onChange, compact }: ColorSwatchProps) {
  const [open, setOpen] = useState(false);
  return (
    <span className={clsx("dv-color-swatch-wrap", compact && "is-compact")}>
      <button
        type="button"
        className={clsx("dv-color-swatch", `is-${value}`)}
        onClick={() => setOpen((o) => !o)}
        aria-label="Cambiar color"
        title={`Color: ${value}`}
      />
      {open && (
        <span className="dv-color-swatch-popover" onMouseLeave={() => setOpen(false)}>
          {TAG_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={clsx("dv-color-swatch", `is-${c}`, c === value && "is-active")}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
              title={c}
            />
          ))}
        </span>
      )}
    </span>
  );
}
