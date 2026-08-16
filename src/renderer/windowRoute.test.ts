import { describe, expect, it } from "vitest";

import { selectWindowRoute } from "./windowRoute";

describe("selectWindowRoute", () => {
  it("selects the floating renderer explicitly", () => {
    expect(selectWindowRoute("?window=floating")).toBe("floating");
  });

  it("selects the sidebar renderer explicitly", () => {
    expect(selectWindowRoute("?window=sidebar")).toBe("sidebar");
  });

  it("selects the peek renderer explicitly", () => {
    expect(selectWindowRoute("?window=peek")).toBe("peek");
  });

  it.each(["", "?window=main", "?window=unknown"])(
    "falls back to the main renderer for %j",
    (search) => {
      expect(selectWindowRoute(search)).toBe("main");
    },
  );
});
