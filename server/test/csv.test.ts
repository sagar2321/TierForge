import { describe, expect, it } from "vitest";
import { parseStoresCsv } from "../src/domain/csv.js";

const header = "store_id,store_name,address,city,state,country";

describe("parseStoresCsv", () => {
  it("parses a valid file (header order and case insensitive, BOM tolerated)", () => {
    const r = parseStoresCsv(`\uFEFFCountry,store_id,store_name,address,city,state\nIndia,ST1,Shop,1 Rd,Pune,MH\n`, 10);
    expect(r).toEqual({
      ok: true,
      rows: [{ store_id: "ST1", store_name: "Shop", address: "1 Rd", city: "Pune", state: "MH", country: "India" }],
    });
  });

  it("reports missing and unexpected columns", () => {
    const r = parseStoresCsv("store_id,name,address,city,state,country\nST1,a,b,c,d,e", 10);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]).toMatch(/Missing.*store_name/);
      expect(r.errors[1]).toMatch(/Unexpected.*name/);
    }
  });

  it("rejects empty files and header-only files", () => {
    expect(parseStoresCsv("", 10).ok).toBe(false);
    expect(parseStoresCsv(header, 10).ok).toBe(false);
  });

  it("rejects duplicate store ids with line numbers", () => {
    const r = parseStoresCsv(`${header}\nST1,a,b,c,d,e\nST1,a,b,c,d,e`, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/Line 3: duplicate store_id "ST1" \(first seen on line 2\)/);
  });

  it("rejects rows with empty required values or wrong column count", () => {
    const r = parseStoresCsv(`${header}\n,a,b,c,d,e\nST2,a,b`, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(2);
  });

  it("enforces the row limit", () => {
    expect(parseStoresCsv(`${header}\nST1,a,b,c,d,e\nST2,a,b,c,d,e`, 1).ok).toBe(false);
  });
});
