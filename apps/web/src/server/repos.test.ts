import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The repos read these at import time / first use, so set them up before
// importing anything that touches storage.
const dir = mkdtempSync(join(tmpdir(), "dv-repos-"));
process.env.DATA_VIEW_DB_PATH = join(dir, "test.db");
process.env.DATA_VIEW_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

type Repos = {
  users: typeof import("./users-repo");
  conns: typeof import("./connections-repo");
  folders: typeof import("./folders-repo");
  tags: typeof import("./tags-repo");
  crypto: typeof import("./crypto");
};
let r: Repos;
let alice: string;
let bob: string;

beforeAll(async () => {
  r = {
    users: await import("./users-repo"),
    conns: await import("./connections-repo"),
    folders: await import("./folders-repo"),
    tags: await import("./tags-repo"),
    crypto: await import("./crypto"),
  };
  alice = (await r.users.createUser("Alice@Example.com ", "password-1")).id;
  bob = (await r.users.createUser("bob@example.com", "password-2")).id;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const base = {
  name: "Local PG",
  driver: "postgres" as const,
  host: "localhost",
  port: 5432,
  database: "postgres",
  username: "postgres",
};

describe("users-repo", () => {
  it("normalizes emails and verifies passwords", async () => {
    expect(await r.users.verifyUser("alice@example.com", "password-1")).toMatchObject({
      email: "alice@example.com",
    });
    expect(await r.users.verifyUser(" ALICE@example.com", "password-1")).not.toBeNull();
    expect(await r.users.verifyUser("alice@example.com", "nope")).toBeNull();
    await expect(r.users.createUser("ALICE@example.com", "x".repeat(8))).rejects.toThrow(
      /ya está registrado/,
    );
  });
});

describe("crypto", () => {
  it("round-trips secrets with a random IV", () => {
    const a = r.crypto.encryptSecret("s3cr3t ñ");
    const b = r.crypto.encryptSecret("s3cr3t ñ");
    expect(a).not.toBe(b);
    expect(r.crypto.decryptSecret(a)).toBe("s3cr3t ñ");
  });

  it("rejects tampered ciphertext", () => {
    const enc = r.crypto.encryptSecret("hello");
    const parts = enc.split(":");
    parts[3] = Buffer.from("HELLO").toString("base64");
    expect(() => r.crypto.decryptSecret(parts.join(":"))).toThrow();
  });
});

describe("connections-repo", () => {
  it("stores the password encrypted and never returns it publicly", () => {
    const saved = r.conns.saveConnection(alice, { ...base, password: "pw1" });
    expect(saved).not.toHaveProperty("password");
    expect(r.conns.getConnectionWithSecret(alice, saved.id)?.password).toBe("pw1");
    expect(r.conns.getConnection(bob, saved.id)).toBeNull();
    expect(r.conns.getConnectionWithSecret(bob, saved.id)).toBeNull();
  });

  it("keeps the existing password when an update sends an empty one", () => {
    const saved = r.conns.saveConnection(alice, { ...base, password: "keep-me" });
    r.conns.saveConnection(alice, { ...base, id: saved.id, name: "Renamed", password: "" });
    const again = r.conns.getConnectionWithSecret(alice, saved.id);
    expect(again?.name).toBe("Renamed");
    expect(again?.password).toBe("keep-me");
  });

  it("refuses to update another user's connection and leaves its tags alone", () => {
    const tagId = r.tags.listTags(alice)[0]!.id;
    const victim = r.conns.saveConnection(alice, { ...base, tagIds: [tagId] });
    expect(() =>
      r.conns.saveConnection(bob, { ...base, id: victim.id, name: "pwned", tagIds: [] }),
    ).toThrow();
    const after = r.conns.getConnection(alice, victim.id);
    expect(after?.name).toBe(base.name);
    expect(after?.tagIds).toEqual([tagId]);
  });

  it("drops folder/tag ids that belong to other users", () => {
    const bobFolder = r.folders.saveFolder(bob, { name: "Bob", color: "info" });
    const bobTag = r.tags.listTags(bob)[0]!.id;
    const saved = r.conns.saveConnection(alice, {
      ...base,
      folderId: bobFolder.id,
      tagIds: [bobTag],
    });
    expect(saved.folderId).toBeNull();
    expect(saved.tagIds).toEqual([]);
  });

  it("rejects invalid input", () => {
    expect(() => r.conns.saveConnection(alice, { ...base, name: "  " })).toThrow();
    expect(() =>
      r.conns.saveConnection(alice, { ...base, driver: "oracle" as never }),
    ).toThrow();
    expect(() => r.conns.saveConnection(alice, { ...base, port: 0 })).toThrow();
  });

  it("deletes only the caller's connections", () => {
    const saved = r.conns.saveConnection(alice, { ...base });
    r.conns.deleteConnection(bob, saved.id);
    expect(r.conns.getConnection(alice, saved.id)).not.toBeNull();
    r.conns.deleteConnection(alice, saved.id);
    expect(r.conns.getConnection(alice, saved.id)).toBeNull();
  });
});

describe("folders-repo", () => {
  it("un-parents connections when a folder is deleted", () => {
    const f = r.folders.saveFolder(alice, { name: "  Prod  ", color: "danger" });
    expect(f.name).toBe("Prod");
    const c = r.conns.saveConnection(alice, { ...base, folderId: f.id });
    expect(c.folderId).toBe(f.id);
    r.folders.deleteFolder(alice, f.id);
    expect(r.conns.getConnection(alice, c.id)?.folderId).toBeNull();
    expect(r.folders.listFolders(alice).some((x) => x.id === f.id)).toBe(false);
  });

  it("can't rename another user's folder", () => {
    const f = r.folders.saveFolder(alice, { name: "Mine", color: "neutral" });
    expect(() => r.folders.saveFolder(bob, { id: f.id, name: "X", color: "neutral" })).toThrow();
  });
});

describe("tags-repo", () => {
  it("seeds the system tags once and protects them from deletion", () => {
    const list = r.tags.listTags(alice);
    const system = list.filter((t) => t.kind === "system");
    expect(system.map((t) => t.name).sort()).toEqual(["Producción", "Test"]);
    expect(r.tags.listTags(alice).filter((t) => t.kind === "system")).toHaveLength(2);
    expect(() => r.tags.deleteTag(alice, system[0]!.id)).toThrow();
  });

  it("removes a deleted tag from its connections", () => {
    const tag = r.tags.saveTag(alice, { name: "temp", color: "warn" });
    const c = r.conns.saveConnection(alice, { ...base, tagIds: [tag.id] });
    r.tags.deleteTag(alice, tag.id);
    expect(r.conns.getConnection(alice, c.id)?.tagIds).toEqual([]);
  });
});
