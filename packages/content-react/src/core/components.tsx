import type { ComponentPropsWithoutRef, ComponentType, MouseEvent, ReactNode } from "react";

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

export type TopikComponent = ComponentType<TopikComponentProps>;
export type TopikComponentMap = Record<TopikComponentName, TopikComponent>;
export type TopikComponentOverrides = Partial<TopikComponentMap>;
export type TopikAssetResolver = (id: string) => string;
export type TopikColorScheme = "light" | "dark";
export type TopikLinkResolver = (href: string) => string;
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
