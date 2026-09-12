import { WorkspaceTool } from "@/components/workspace-tool";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Persistent database workspace",
  description:
    "Create or open a persistent local SQLite or DuckDB database, review Excel imports, record deliveries, and export a portable copy.",
};

export default function WorkspacePage() {
  return <WorkspaceTool />;
}
