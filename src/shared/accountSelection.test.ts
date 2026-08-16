import { describe, expect, it } from "vitest";

import {
  isSelectableAccountId,
  resolveSelectedAccountIds,
  toggleSelectedAccountId,
} from "./accountSelection";

const IDS = ["outlook-1", "gmail-1", "outlook-2"] as const;

describe("account selection", () => {
  it("ignores connector configuration placeholders", () => {
    expect(isSelectableAccountId("outlook-1")).toBe(true);
    expect(isSelectableAccountId("outlook-configuration")).toBe(false);
    expect(isSelectableAccountId("gmail-configuration")).toBe(false);
  });

  it("treats an empty selection as every selectable account", () => {
    expect(resolveSelectedAccountIds(IDS, [])).toEqual([...IDS]);
    expect(
      resolveSelectedAccountIds(
        [...IDS, "outlook-configuration"],
        undefined,
      ),
    ).toEqual([...IDS]);
  });

  it("keeps only ids that still exist", () => {
    expect(
      resolveSelectedAccountIds(IDS, ["gmail-1", "removed", "outlook-2"]),
    ).toEqual(["gmail-1", "outlook-2"]);
  });

  it("toggles accounts without allowing an empty selection", () => {
    expect(toggleSelectedAccountId(IDS, [], "gmail-1")).toEqual([
      "outlook-1",
      "outlook-2",
    ]);
    expect(
      toggleSelectedAccountId(IDS, ["gmail-1"], "outlook-2"),
    ).toEqual(["gmail-1", "outlook-2"]);
    expect(toggleSelectedAccountId(IDS, ["gmail-1"], "gmail-1")).toEqual([
      "gmail-1",
    ]);
  });
});
