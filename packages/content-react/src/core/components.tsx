import type { ComponentPropsWithoutRef, ComponentType, MouseEvent, ReactNode } from "react";
import type { CodePresentationEffectiveOptions, TopikGeneratedAssetName } from "@topik/content";

export const topikComponentNames = [
  "TopikAccordion",
  "TopikBadge",
  "TopikCallout",
  "TopikCard",
  "TopikCardGrid",
  "TopikCodeBlock",
  "TopikCodeGroup",
  "TopikCodeTab",
  "TopikChoice",
  "TopikExplanation",
  "TopikFigure",
  "TopikFootnote",
  "TopikFootnoteReference",
  "TopikFootnotes",
  "TopikImage",
  "TopikInlineCode",
  "TopikLink",
  "TopikMath",
  "TopikMathInline",
  "TopikMermaid",
  "TopikQuestion",
  "TopikQuiz",
  "TopikStep",
  "TopikSteps",
  "TopikTab",
  "TopikTabs",
  "TopikTable",
  "TopikTableCell",
  "TopikTableHeader",
  "TopikTableRow",
  "TopikUnderline",
] as const;

export type TopikComponentName = (typeof topikComponentNames)[number];

export interface TopikComponentProps {
  children?: ReactNode;
  [attribute: string]: unknown;
}

/** Reader text is authoritative: content is payload plus the canonical separator LF. */
export interface TopikCodeBlockProps extends TopikComponentProps {
  payload?: string;
  content?: string;
  language?: string;
  presentation?: CodePresentationEffectiveOptions;
}

export type TopikComponent = ComponentType<TopikComponentProps>;
export type TopikComponentMap = Record<TopikComponentName, TopikComponent>;
export type TopikComponentOverrides = Partial<TopikComponentMap>;
export type TopikColorScheme = "light" | "dark";
export type TopikAssetResolver = (name: TopikGeneratedAssetName) => string | undefined;
/** Resolve a content link to a browser URL; return undefined for an unknown resource. */
export type TopikLinkResolver = (href: string) => string | undefined;
export type TopikLinkRenderProps = Omit<ComponentPropsWithoutRef<"a">, "href"> & {
  href: string;
};
export type TopikLinkRenderer = (props: TopikLinkRenderProps) => ReactNode;
export type TopikLinkHandler = (
  href: string,
  event: MouseEvent<HTMLAnchorElement>,
) => boolean | void;

function MissingTopikComponent({ children }: TopikComponentProps) {
  return <>{children}</>;
}

/** @internal Shared by the plain and themed footnotes: numbers and anchors come from the tree. */
export function footnoteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** @internal Only generated `fn:` and `fnref:` anchors become same-page links. */
export function footnoteAnchor(value: unknown): string | undefined {
  return typeof value === "string" && /^fn(?:ref)?:\d+(?::\d+)?$/u.test(value) ? value : undefined;
}

/** @internal Back-links from a footnote to each of its references. */
export function footnoteBackrefs(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(footnoteAnchor).filter((anchor): anchor is string => anchor !== undefined)
    : [];
}

/** Footnotes stay readable without a theme: a superscript link and an ordered list. */
function PlainTopikFootnoteReference({ id, number, target }: TopikComponentProps) {
  const value = footnoteNumber(number);
  const anchor = footnoteAnchor(target);
  if (value === undefined) return null;
  return (
    <sup>
      <a aria-label={`Footnote ${value}`} href={anchor && `#${anchor}`} id={footnoteAnchor(id)}>
        {value}
      </a>
    </sup>
  );
}

function PlainTopikFootnotes({ children }: TopikComponentProps) {
  return (
    <section aria-label="Footnotes">
      <ol>{children}</ol>
    </section>
  );
}

function PlainTopikFootnote({ backrefs, children, id, number }: TopikComponentProps) {
  const value = footnoteNumber(number);
  const links = footnoteBackrefs(backrefs);
  return (
    <li id={footnoteAnchor(id)}>
      {children}
      {links.map((anchor, index) => (
        <a
          key={anchor}
          aria-label={`Back to reference ${value ?? ""}${links.length > 1 ? `, ${index + 1}` : ""}`}
          href={`#${anchor}`}
        >
          ↩
        </a>
      ))}
    </li>
  );
}

const fallbackTopikComponents = {
  TopikAccordion: MissingTopikComponent,
  TopikBadge: MissingTopikComponent,
  TopikCallout: MissingTopikComponent,
  TopikCard: MissingTopikComponent,
  TopikCardGrid: MissingTopikComponent,
  TopikCodeBlock: MissingTopikComponent,
  TopikCodeGroup: MissingTopikComponent,
  TopikCodeTab: MissingTopikComponent,
  TopikChoice: MissingTopikComponent,
  TopikExplanation: MissingTopikComponent,
  TopikFigure: MissingTopikComponent,
  TopikFootnote: PlainTopikFootnote,
  TopikFootnoteReference: PlainTopikFootnoteReference,
  TopikFootnotes: PlainTopikFootnotes,
  TopikImage: MissingTopikComponent,
  TopikInlineCode: MissingTopikComponent,
  TopikLink: MissingTopikComponent,
  TopikMath: MissingTopikComponent,
  TopikMathInline: MissingTopikComponent,
  TopikMermaid: MissingTopikComponent,
  TopikQuestion: MissingTopikComponent,
  TopikQuiz: MissingTopikComponent,
  TopikStep: MissingTopikComponent,
  TopikSteps: MissingTopikComponent,
  TopikTab: MissingTopikComponent,
  TopikTabs: MissingTopikComponent,
  TopikTable: MissingTopikComponent,
  TopikTableCell: MissingTopikComponent,
  TopikTableHeader: MissingTopikComponent,
  TopikTableRow: MissingTopikComponent,
  TopikUnderline: MissingTopikComponent,
} satisfies TopikComponentMap;

/** @internal Merge override maps in order; an explicit `undefined` keeps the earlier component. */
export function mergeTopikComponentOverrides(
  ...maps: (TopikComponentOverrides | undefined)[]
): TopikComponentOverrides {
  const merged: Record<string, TopikComponent> = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [name, component] of Object.entries(map)) {
      if (component !== undefined) merged[name] = component;
    }
  }
  return merged;
}

export function getTopikComponents(overrides: TopikComponentOverrides = {}): TopikComponentMap {
  return {
    TopikAccordion: overrides.TopikAccordion ?? fallbackTopikComponents.TopikAccordion,
    TopikBadge: overrides.TopikBadge ?? fallbackTopikComponents.TopikBadge,
    TopikCallout: overrides.TopikCallout ?? fallbackTopikComponents.TopikCallout,
    TopikCard: overrides.TopikCard ?? fallbackTopikComponents.TopikCard,
    TopikCardGrid: overrides.TopikCardGrid ?? fallbackTopikComponents.TopikCardGrid,
    TopikCodeBlock: overrides.TopikCodeBlock ?? fallbackTopikComponents.TopikCodeBlock,
    TopikCodeGroup: overrides.TopikCodeGroup ?? fallbackTopikComponents.TopikCodeGroup,
    TopikCodeTab: overrides.TopikCodeTab ?? fallbackTopikComponents.TopikCodeTab,
    TopikChoice: overrides.TopikChoice ?? fallbackTopikComponents.TopikChoice,
    TopikExplanation: overrides.TopikExplanation ?? fallbackTopikComponents.TopikExplanation,
    TopikFigure: overrides.TopikFigure ?? fallbackTopikComponents.TopikFigure,
    TopikFootnote: overrides.TopikFootnote ?? fallbackTopikComponents.TopikFootnote,
    TopikFootnoteReference:
      overrides.TopikFootnoteReference ?? fallbackTopikComponents.TopikFootnoteReference,
    TopikFootnotes: overrides.TopikFootnotes ?? fallbackTopikComponents.TopikFootnotes,
    TopikImage: overrides.TopikImage ?? fallbackTopikComponents.TopikImage,
    TopikInlineCode: overrides.TopikInlineCode ?? fallbackTopikComponents.TopikInlineCode,
    TopikLink: overrides.TopikLink ?? fallbackTopikComponents.TopikLink,
    TopikMath: overrides.TopikMath ?? fallbackTopikComponents.TopikMath,
    TopikMathInline: overrides.TopikMathInline ?? fallbackTopikComponents.TopikMathInline,
    TopikMermaid: overrides.TopikMermaid ?? fallbackTopikComponents.TopikMermaid,
    TopikQuestion: overrides.TopikQuestion ?? fallbackTopikComponents.TopikQuestion,
    TopikQuiz: overrides.TopikQuiz ?? fallbackTopikComponents.TopikQuiz,
    TopikStep: overrides.TopikStep ?? fallbackTopikComponents.TopikStep,
    TopikSteps: overrides.TopikSteps ?? fallbackTopikComponents.TopikSteps,
    TopikTab: overrides.TopikTab ?? fallbackTopikComponents.TopikTab,
    TopikTabs: overrides.TopikTabs ?? fallbackTopikComponents.TopikTabs,
    TopikTable: overrides.TopikTable ?? fallbackTopikComponents.TopikTable,
    TopikTableCell: overrides.TopikTableCell ?? fallbackTopikComponents.TopikTableCell,
    TopikTableHeader: overrides.TopikTableHeader ?? fallbackTopikComponents.TopikTableHeader,
    TopikTableRow: overrides.TopikTableRow ?? fallbackTopikComponents.TopikTableRow,
    TopikUnderline: overrides.TopikUnderline ?? fallbackTopikComponents.TopikUnderline,
  };
}
