import { cliVersion } from "@/lib/releases";
import { isBrowserTool, TOOLS } from "@/lib/tools";
import {
  ArrowRight,
  FileStack,
  Globe,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import Link from "next/link";

const principles = [
  {
    icon: ShieldCheck,
    title: "Local by default",
    detail: "Your client files stay on your machine",
  },
  {
    icon: FileStack,
    title: "Inputs stay intact",
    detail: "Outputs never replace sources accidentally",
  },
  {
    icon: TerminalSquare,
    title: "Built to compose",
    detail: "Use the browser tools, the CLI, or focused TypeScript modules",
  },
] as const;

export default function HomePage() {
  return (
    <main className="manual-home flex-1">
      <section className="mx-auto grid w-full max-w-[1320px] gap-14 px-6 pb-24 pt-24 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.68fr)] lg:items-end lg:px-10 lg:pb-32 lg:pt-32">
        <div className="min-w-0">
          <div className="manual-kicker">
            Operations field manual · v{cliVersion()}
          </div>
          <h1 className="manual-title mt-8">
            Less busywork.
            <br />
            More <em>useful</em> work
          </h1>
          <p className="manual-intro mt-8 max-w-2xl text-lg leading-8 text-fd-muted-foreground md:text-xl">
            Local spreadsheet, database, PowerPoint, and PDF tools for
            consultants who need repeatable results, visible provenance, and no
            mystery uploads
          </p>
          <div className="manual-actions mt-9 flex flex-wrap gap-3">
            <Link
              href="/tools"
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-fd-primary px-5 py-3 text-sm font-semibold text-fd-primary-foreground shadow-[3px_3px_0_var(--color-fd-foreground)] transition-transform hover:-translate-y-0.5 sm:w-auto"
            >
              Use the tools online
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/docs"
              className="inline-flex w-full items-center justify-center rounded-lg border bg-fd-card px-5 py-3 text-sm font-semibold transition-colors hover:bg-fd-accent sm:w-auto"
            >
              Open the field manual
            </Link>
          </div>
        </div>

        <div className="manual-command min-w-0">
          <div className="manual-command__bar">
            <span>field-note.sh</span>
            <span>Node 22+ · local</span>
          </div>
          <pre aria-label="Example ConsultChimps command">
            <code>
              <span className="prompt">$</span> consultchimps sheets consolidate
              {" \\\n  "}
              {'"'}inputs/**/*.xlsx{'"'}
              {" \\\n  "}
              <span className="flag">--output</span> outputs/client-master.xlsx
              {"\n\n"}
              <span className="prompt">✓</span> sheets.consolidate completed
              {"\n"}
              {"  "}inputFiles: 14
              {"\n"}
              {"  "}inputTables: 37
              {"\n"}
              {"  "}outputRows: 8,412
            </code>
          </pre>
        </div>
      </section>

      <section className="principle-strip">
        <div className="mx-auto grid max-w-[1320px] gap-x-10 px-6 md:grid-cols-3 lg:px-10">
          {principles.map(({ icon: Icon, title, detail }) => (
            <div className="principle-strip__item" key={title}>
              <Icon className="mt-0.5 size-5 shrink-0 text-red-400" />
              <div>
                <strong>{title}</strong>
                <span>{detail}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1320px] px-6 py-24 lg:px-10 lg:py-32">
        <div className="mb-10 flex flex-col justify-between gap-5 md:flex-row md:items-end">
          <div className="min-w-0">
            <div className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-fd-primary">
              The toolkit
            </div>
            <h2 className="mt-3 max-w-2xl text-4xl font-bold tracking-[-0.05em] md:text-5xl">
              Recurring chores. One predictable interface
            </h2>
          </div>
          <p className="max-w-md text-sm leading-6 text-fd-muted-foreground">
            Every operation returns artifacts, warnings, and metrics, useful for
            humans at a terminal and automations that need structured output.
            See what shipped recently in the{" "}
            <Link className="text-fd-primary hover:underline" href="/releases">
              release history
            </Link>
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {TOOLS.map((tool, index) => {
            const { title, description, docHref, icon: Icon } = tool;
            // Only a working browser surface may light up the online link;
            // `planned` and `none` fall back to the guide (ADR 0001).
            const browserHref = isBrowserTool(tool)
              ? tool.surfaces.browser.href
              : undefined;
            return (
              <Link
                className="tool-card"
                href={browserHref ?? docHref}
                key={tool.slug}
              >
                <span className="tool-card__number">
                  Tool {String(index + 1).padStart(2, "0")}
                </span>
                <div className="tool-card__body">
                  <span className="tool-card__icon">
                    <Icon className="size-5" />
                  </span>
                  <h2>{title}</h2>
                  <p>{description}</p>
                  <span className="tool-card__link">
                    {browserHref ? (
                      <>
                        <Globe className="size-3.5" aria-hidden="true" />
                        Use it online
                      </>
                    ) : (
                      "Read the guide"
                    )}
                    <ArrowRight className="size-3.5" />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </main>
  );
}
