import type { ComponentType, ReactNode } from "react";

export const topikComponentNames = [
  "TopikAccordion",
  "TopikBadge",
  "TopikCallout",
  "TopikCard",
  "TopikCardGrid",
  "TopikChoice",
  "TopikExplanation",
  "TopikFigure",
  "TopikQuestion",
  "TopikQuiz",
  "TopikStep",
  "TopikSteps",
  "TopikTab",
  "TopikTabs",
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

function MissingTopikComponent({ children }: TopikComponentProps) {
  return <>{children}</>;
}

const fallbackTopikComponents = {
  TopikAccordion: MissingTopikComponent,
  TopikBadge: MissingTopikComponent,
  TopikCallout: MissingTopikComponent,
  TopikCard: MissingTopikComponent,
  TopikCardGrid: MissingTopikComponent,
  TopikChoice: MissingTopikComponent,
  TopikExplanation: MissingTopikComponent,
  TopikFigure: MissingTopikComponent,
  TopikQuestion: MissingTopikComponent,
  TopikQuiz: MissingTopikComponent,
  TopikStep: MissingTopikComponent,
  TopikSteps: MissingTopikComponent,
  TopikTab: MissingTopikComponent,
  TopikTabs: MissingTopikComponent,
} satisfies TopikComponentMap;

export function getTopikComponents(overrides: TopikComponentOverrides = {}): TopikComponentMap {
  return {
    TopikAccordion: overrides.TopikAccordion ?? fallbackTopikComponents.TopikAccordion,
    TopikBadge: overrides.TopikBadge ?? fallbackTopikComponents.TopikBadge,
    TopikCallout: overrides.TopikCallout ?? fallbackTopikComponents.TopikCallout,
    TopikCard: overrides.TopikCard ?? fallbackTopikComponents.TopikCard,
    TopikCardGrid: overrides.TopikCardGrid ?? fallbackTopikComponents.TopikCardGrid,
    TopikChoice: overrides.TopikChoice ?? fallbackTopikComponents.TopikChoice,
    TopikExplanation: overrides.TopikExplanation ?? fallbackTopikComponents.TopikExplanation,
    TopikFigure: overrides.TopikFigure ?? fallbackTopikComponents.TopikFigure,
    TopikQuestion: overrides.TopikQuestion ?? fallbackTopikComponents.TopikQuestion,
    TopikQuiz: overrides.TopikQuiz ?? fallbackTopikComponents.TopikQuiz,
    TopikStep: overrides.TopikStep ?? fallbackTopikComponents.TopikStep,
    TopikSteps: overrides.TopikSteps ?? fallbackTopikComponents.TopikSteps,
    TopikTab: overrides.TopikTab ?? fallbackTopikComponents.TopikTab,
    TopikTabs: overrides.TopikTabs ?? fallbackTopikComponents.TopikTabs,
  };
}
