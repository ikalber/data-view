import { describe, expect, it } from "vitest";
import { autoLayout, nodeKey, type NodeData } from "./SchemaDiagramPane";

function node(name: string, fks: { table: string; schema?: string }[] = [], schema = "s"): NodeData {
  return {
    schema,
    name,
    columns: [{ name: "id", dataType: "int", nullable: false, isPrimaryKey: true, isUnique: false }],
    foreignKeys: fks.map((f, i) => ({
      name: `fk_${name}_${i}`,
      columns: ["id"],
      referencedSchema: f.schema ?? schema,
      referencedTable: f.table,
      referencedColumns: ["id"],
    })),
    inboundCount: 0,
  };
}

describe("autoLayout", () => {
  it("puts referencing tables to the right of what they reference", () => {
    const pos = autoLayout([node("child", [{ table: "parent" }]), node("parent")]);
    expect(pos.get(nodeKey("s", "child"))!.x).toBeGreaterThan(pos.get(nodeKey("s", "parent"))!.x);
  });

  it("follows FKs into external (other-schema) placeholder nodes", () => {
    const ext = { ...node("users", [], "auth"), external: true };
    const pos = autoLayout([node("orders", [{ table: "users", schema: "auth" }]), ext]);
    expect(pos.get(nodeKey("s", "orders"))!.x).toBeGreaterThan(pos.get(nodeKey("auth", "users"))!.x);
  });

  it("wraps hundreds of unrelated tables into a roughly wide grid", () => {
    const nodes = Array.from({ length: 300 }, (_, i) => node(`t${i}`));
    const pos = [...autoLayout(nodes).values()];
    const width = Math.max(...pos.map((p) => p.x));
    const height = Math.max(...pos.map((p) => p.y));
    expect(new Set(pos.map((p) => p.x)).size).toBeGreaterThan(5);
    expect(width / height).toBeGreaterThan(0.8);
    // No two tables share a slot.
    expect(new Set(pos.map((p) => `${p.x},${p.y}`)).size).toBe(300);
  });
});
