import { BROWSER_TOOL_GROUPS, isBrowserTool, TOOLS } from "@/lib/tools";
import { ArrowRight, BookOpen } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Online tools",
  description:
    "Run local document operations and manage persistent SQLite or DuckDB databases in your browser.",
};

const guideOnlyTools = TOOLS.filter((tool) => !isBrowserTool(tool));

export default function Page() {
  return (
    <main className="flex-1">
      <div className="mx-auto w-full max-w-[1100px] px-6 pb-24 pt-14 lg:px-8">
        <div className="manual-kicker">Online tools · in-browser</div>
        <h1 className="mt-6 text-4xl font-bold tracking-[-0.04em] md:text-5xl">
          Run a tool right here
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-fd-muted-foreground">
          These tools process your files locally using operation code shared
          with the ConsultChimps command line and libraries. Document tools
          produce downloads. The database workspace keeps a persistent browser
          working copy and exports a separate file. Each guide explains its
          storage, naming, and interface defaults
        </p>

        <div className="mt-10 space-y-14">
          {BROWSER_TOOL_GROUPS.map(({ category, tools }) => (
            <section
              aria-labelledby={`${category}-tools-heading`}
              key={category}
            >
              <div className="mb-5 flex items-end justify-between gap-4">
                <div>
                  <p className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-fd-primary">
                    Category
                  </p>
                  <h2
                    className="mt-2 text-2xl font-bold tracking-[-0.03em]"
                    id={`${category}-tools-heading`}
                  >
                    {category} tools
                  </h2>
                </div>
                <p className="text-sm text-fd-muted-foreground">
                  {tools.length} {tools.length === 1 ? "tool" : "tools"}
                </p>
              </div>
              <div
                className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
                data-testid={`${category.toLowerCase()}-tool-group`}
              >
                {tools.map(
                  ({ slug, title, description, surfaces, icon: Icon }) => (
                    <Link
                      className="tool-card"
                      href={surfaces.browser.href}
                      key={slug}
                    >
                      <div>
                        <span className="tool-card__icon">
                          <Icon className="size-5" />
                        </span>
                        <h3>{title}</h3>
                        <p>{description}</p>
                        <span className="tool-card__link">
                          Open the tool
                          <ArrowRight className="size-3.5" />
                        </span>
                      </div>
                    </Link>
                  ),
                )}
              </div>
            </section>
          ))}
        </div>

        {/*
          This section lists the registry entries whose browser surface does
          not work yet, so it is empty exactly when every declared operation
          runs in the browser and populated as soon as one does not. It is
          rendered only when it has rows: a heading over an empty list, above a
          paragraph promising "the rest of the kit", reads as a page that
          failed to load rather than as a complete toolkit.
        */}
        {guideOnlyTools.length > 0 ? (
          <>
            <h2 className="mt-16 text-2xl font-bold tracking-[-0.03em]">
              Not in the browser yet
            </h2>
            <p className="mt-3 max-w-2xl leading-7 text-fd-muted-foreground">
              The rest of the kit currently runs through the command line or the
              TypeScript libraries. Each guide covers installation and a worked
              example
            </p>
            <ul
              className="mt-6 grid gap-3 sm:grid-cols-2"
              data-testid="guide-only-tools"
            >
              {guideOnlyTools.map(({ slug, title, docHref, icon: Icon }) => (
                <li key={slug}>
                  <Link
                    className="inline-flex items-center gap-2.5 rounded-lg border bg-fd-card px-4 py-3 text-sm font-medium transition-colors hover:bg-fd-accent"
                    href={docHref}
                  >
                    <Icon
                      className="size-4 text-fd-primary"
                      aria-hidden="true"
                    />
                    {title}
                    <BookOpen
                      className="ml-auto size-4 text-fd-muted-foreground"
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </main>
  );
}
