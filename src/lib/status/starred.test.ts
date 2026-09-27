import { describe, expect, it } from "vitest";
import { parseStarred, serializeStarred, starredFirst, toggleStarred } from "./starred";
import type { ServiceId } from "./types";
import { service } from "../../test/fixtures.ts";

describe("parseStarred", () => {
  it("keeps known service ids", () => {
    expect([...parseStarred('["claude","gcp"]')]).toEqual(["claude", "gcp"]);
  });

  it("drops unknown ids and non-strings", () => {
    expect([...parseStarred('["gcp","myspace",3,null]')]).toEqual(["gcp"]);
  });

  it("treats missing, malformed or non-array storage as no stars", () => {
    expect(parseStarred(null).size).toBe(0);
    expect(parseStarred("").size).toBe(0);
    expect(parseStarred("{not json").size).toBe(0);
    expect(parseStarred('{"gcp":true}').size).toBe(0);
  });
});

describe("serializeStarred", () => {
  it("stores in catalog order and round-trips", () => {
    const raw = serializeStarred(new Set<ServiceId>(["claude", "gcp"]));
    expect(raw).toBe('["gcp","claude"]');
    expect([...parseStarred(raw)]).toEqual(["gcp", "claude"]);
  });
});

describe("toggleStarred", () => {
  it("adds and removes without mutating the input", () => {
    const empty = new Set<ServiceId>();
    const one = toggleStarred(empty, "aws");
    expect([...one]).toEqual(["aws"]);
    expect(empty.size).toBe(0);
    expect(toggleStarred(one, "aws").size).toBe(0);
  });
});

describe("starredFirst", () => {
  const services = [service("gcp"), service("aws"), service("steam"), service("claude")];

  it("moves starred services first and keeps order within each part", () => {
    const ids = starredFirst(services, new Set<ServiceId>(["claude", "aws"])).map((item) => item.id);
    expect(ids).toEqual(["aws", "claude", "gcp", "steam"]);
  });

  it("returns the same list when nothing is starred", () => {
    expect(starredFirst(services, new Set())).toBe(services);
  });
});
