import { describe, expect, it } from "vitest";

import type { WorkspaceImportFile } from "./workspace-protocol";
import {
  workspaceSourceDescription,
  workspaceSourceFileName,
  workspaceSourceKey,
} from "./workspace-source";

function source(id: string): WorkspaceImportFile {
  return {
    id,
    file: new File(["contents"], "report | final.xlsx"),
    role: "  source | role  ",
    revision: "  iteration | 2  ",
  };
}

describe("workspace source keys", () => {
  it("round-trips delimiter-rich visible provenance", () => {
    const key = workspaceSourceKey(source("first"), 0);

    expect(workspaceSourceFileName(key)).toBe("report | final.xlsx");
    expect(workspaceSourceDescription(key)).toBe(
      "report | final.xlsx | role=source | role | revision=iteration | 2",
    );
  });

  it("uses the input ID to distinguish otherwise identical sources", () => {
    expect(workspaceSourceKey(source("first"), 0)).not.toBe(
      workspaceSourceKey(source("second"), 0),
    );
  });

  it("sorts equal visible labels by input position before opaque IDs", () => {
    const later = workspaceSourceKey(source("00000000-0000"), 10);
    const earlier = workspaceSourceKey(source("ffffffff-ffff"), 2);

    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it("keeps legacy source labels readable", () => {
    const legacy = "report.xlsx | role=inventory | revision=Iteration 1";

    expect(workspaceSourceFileName(legacy)).toBe("report.xlsx");
    expect(workspaceSourceDescription(legacy)).toBe(legacy);
  });

  it("reads source keys written before ordinals were added", () => {
    const metadata = encodeURIComponent(
      JSON.stringify({
        version: 1,
        id: "legacy-id",
        fileName: "legacy | report.xlsx",
        role: "inventory",
        revision: "Iteration 1",
      }),
    );
    const key = `legacy label | workspace-input=${metadata}`;

    expect(workspaceSourceFileName(key)).toBe("legacy | report.xlsx");
    expect(workspaceSourceDescription(key)).toBe(
      "legacy | report.xlsx | role=inventory | revision=Iteration 1",
    );
  });
});
