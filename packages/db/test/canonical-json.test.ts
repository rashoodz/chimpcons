import { expect, test } from "vitest";

import { canonicalJson } from "../src/internal/json.js";

test("canonical JSON follows omission and array-null semantics before sorting keys", () => {
  const items: unknown[] = [undefined];
  items.length = 2;
  items.push({ z: 2, a: undefined, b: 1 });
  const value = {
    z: undefined,
    b: items,
    a: { z: undefined, b: "kept", a: null },
  };
  const encoded = canonicalJson(value);
  expect(encoded).toBe(
    '{"a":{"a":null,"b":"kept"},"b":[null,null,{"b":1,"z":2}]}',
  );
  expect(JSON.parse(encoded)).toEqual(JSON.parse(JSON.stringify(value)));
  expect(canonicalJson({ z: undefined, a: 1 })).toBe(canonicalJson({ a: 1 }));
});

test("canonical JSON preserves serialized values and treats prototype keys as data", () => {
  expect(
    canonicalJson({
      time: new Date("2024-01-01T00:00:00Z"),
      number: Number.NaN,
      data: JSON.parse('{"__proto__":{"z":1,"a":2}}'),
    }),
  ).toBe(
    '{"data":{"__proto__":{"a":2,"z":1}},"number":null,"time":"2024-01-01T00:00:00.000Z"}',
  );
});

test("canonical JSON rejects values that cannot produce a JSON document", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  for (const value of [undefined, 1n, cyclic]) {
    expect(() => canonicalJson(value)).toThrowError(
      expect.objectContaining({ code: "DB_INVALID_JSON_VALUE" }),
    );
  }
});
