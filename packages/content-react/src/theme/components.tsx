import {
  Children,
  isValidElement,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type { TopikComponentMap, TopikComponentProps } from "../core/components";

interface TopikRoleProps {
  __topikRole?: "choice" | "explanation";
}

function stringAttribute(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanAttribute(value: unknown): boolean {
  return value === true;
}

function numberAttribute(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function childElements(children: ReactNode): ReactElement<TopikComponentProps>[] {
  return Children.toArray(children).filter(isValidElement) as ReactElement<TopikComponentProps>[];
}

export function TopikCallout({ children, title, variant = "note" }: TopikComponentProps) {
  return (
    <aside className="topik-callout" data-variant={stringAttribute(variant) ?? "note"}>
      {title ? <p className="topik-callout__title">{stringAttribute(title)}</p> : null}
      <div className="topik-callout__body">{children}</div>
    </aside>
  );
}

export function TopikCardGrid({ children, columns }: TopikComponentProps) {
  const columnCount = numberAttribute(columns);
  const style = columnCount
    ? ({ "--topik-card-grid-columns": columnCount } as React.CSSProperties)
    : undefined;
  return (
    <div className="topik-card-grid" style={style}>
      {children}
    </div>
  );
}

export function TopikCard({ children, href, icon, title }: TopikComponentProps) {
  const content = (
    <>
      {icon ? <span className="topik-card__icon">{stringAttribute(icon)}</span> : null}
      <span className="topik-card__title">{stringAttribute(title)}</span>
      <span className="topik-card__body">{children}</span>
    </>
  );

  const target = stringAttribute(href);
  if (target) {
    return (
      <a className="topik-card" href={target}>
        {content}
      </a>
    );
  }

  return <div className="topik-card">{content}</div>;
}

export function TopikAccordion({ children, open, title }: TopikComponentProps) {
  return (
    <details className="topik-accordion" open={booleanAttribute(open)}>
      <summary className="topik-accordion__summary">{stringAttribute(title)}</summary>
      <div className="topik-accordion__body">{children}</div>
    </details>
  );
}

export function TopikTabs({ children }: TopikComponentProps) {
  const id = useId();
  const tabs = childElements(children);
  const [selected, setSelected] = useState(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectTab(index: number, focus = false) {
    setSelected(index);
    if (focus) tabRefs.current[index]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex = index;

    if (event.key === "ArrowLeft") nextIndex = index > 0 ? index - 1 : tabs.length - 1;
    else if (event.key === "ArrowRight") nextIndex = index < tabs.length - 1 ? index + 1 : 0;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;

    event.preventDefault();
    selectTab(nextIndex, true);
  }

  return (
    <div className="topik-tabs">
      <div className="topik-tabs__list" role="tablist">
        {tabs.map((tab, index) => {
          const active = index === selected;
          return (
            <button
              aria-controls={`${id}-panel-${index}`}
              aria-selected={active}
              className="topik-tabs__tab"
              id={`${id}-tab-${index}`}
              key={`${stringAttribute(tab.props.title) ?? "tab"}-${index}`}
              onClick={() => selectTab(index)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              role="tab"
              tabIndex={active ? 0 : -1}
              type="button"
            >
              {stringAttribute(tab.props.title) ?? `Tab ${index + 1}`}
            </button>
          );
        })}
      </div>
      {tabs.map((tab, index) => (
        <div
          aria-labelledby={`${id}-tab-${index}`}
          className="topik-tabs__panel"
          hidden={index !== selected}
          id={`${id}-panel-${index}`}
          key={`${stringAttribute(tab.props.title) ?? "panel"}-${index}`}
          role="tabpanel"
        >
          {tab.props.children}
        </div>
      ))}
    </div>
  );
}

export function TopikTab({ children }: TopikComponentProps) {
  return <>{children}</>;
}

export function TopikSteps({ children }: TopikComponentProps) {
  return <ol className="topik-steps">{children}</ol>;
}

export function TopikStep({ children, title }: TopikComponentProps) {
  return (
    <li className="topik-step">
      {title ? <p className="topik-step__title">{stringAttribute(title)}</p> : null}
      <div className="topik-step__body">{children}</div>
    </li>
  );
}

export function TopikFigure({ alt, caption, darkSrc, src }: TopikComponentProps) {
  const lightSource = stringAttribute(src) ?? "";
  const darkSource = stringAttribute(darkSrc);
  return (
    <figure className="topik-figure">
      <picture>
        {darkSource ? <source media="(prefers-color-scheme: dark)" srcSet={darkSource} /> : null}
        <img alt={stringAttribute(alt) ?? ""} src={lightSource} />
      </picture>
      {caption ? <figcaption>{stringAttribute(caption)}</figcaption> : null}
    </figure>
  );
}

export function TopikBadge({ children, variant = "neutral" }: TopikComponentProps) {
  return (
    <span className="topik-badge" data-variant={stringAttribute(variant) ?? "neutral"}>
      {children}
    </span>
  );
}

export function TopikQuiz({ children }: TopikComponentProps) {
  return <div className="topik-quiz">{children}</div>;
}

export function TopikQuestion({ children, type = "single-choice" }: TopikComponentProps) {
  const id = useId();
  const childrenArray = Children.toArray(children);
  const choices = childrenArray.filter(isChoiceElement);
  const explanation = childrenArray.filter(isExplanationElement);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const multiple = type === "multiple-choice";
  const answered = selected.size > 0;
  const correctIndexes = useMemo(
    () =>
      new Set(choices.flatMap((choice, index) => (choice.props.correct === true ? [index] : []))),
    [choices],
  );
  const isCorrect =
    answered &&
    selected.size === correctIndexes.size &&
    [...selected].every((index) => correctIndexes.has(index));

  function toggle(index: number) {
    setSelected((current) => {
      if (!multiple) return new Set([index]);
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <section className="topik-question" data-correct={answered ? isCorrect : undefined}>
      <div className="topik-question__choices">
        {choices.map((choice, index) => (
          <label className="topik-choice" key={index}>
            <input
              checked={selected.has(index)}
              name={id}
              onChange={() => toggle(index)}
              type={multiple ? "checkbox" : "radio"}
            />
            <span>{choice}</span>
          </label>
        ))}
      </div>
      {answered ? (
        <div className="topik-question__result">{isCorrect ? "Correct" : "Try again"}</div>
      ) : null}
      {answered && explanation.length > 0 ? explanation : null}
    </section>
  );
}

export function TopikChoice({ children }: TopikComponentProps) {
  return <>{children}</>;
}

export function TopikExplanation({ children }: TopikComponentProps) {
  return <div className="topik-explanation">{children}</div>;
}

function isChoiceElement(child: ReactNode): child is ReactElement<TopikComponentProps> {
  if (!isValidElement<TopikComponentProps & TopikRoleProps>(child)) return false;
  return (
    child.type === TopikChoice || child.props.__topikRole === "choice" || "correct" in child.props
  );
}

function isExplanationElement(child: ReactNode): child is ReactElement<TopikComponentProps> {
  if (!isValidElement<TopikComponentProps & TopikRoleProps>(child)) return false;
  return child.type === TopikExplanation || child.props.__topikRole === "explanation";
}

export const defaultTopikComponents = {
  TopikAccordion,
  TopikBadge,
  TopikCallout,
  TopikCard,
  TopikCardGrid,
  TopikChoice,
  TopikExplanation,
  TopikFigure,
  TopikQuestion,
  TopikQuiz,
  TopikStep,
  TopikSteps,
  TopikTab,
  TopikTabs,
} satisfies TopikComponentMap;

export function getDefaultTopikComponents(
  overrides: Partial<TopikComponentMap> = {},
): TopikComponentMap {
  const TopikChoiceComponent = overrides.TopikChoice ?? TopikChoice;
  const TopikExplanationComponent = overrides.TopikExplanation ?? TopikExplanation;

  return {
    ...defaultTopikComponents,
    ...overrides,
    TopikChoice: function TopikChoiceSlot(props: TopikComponentProps) {
      return <TopikChoiceComponent {...props} __topikRole="choice" />;
    },
    TopikExplanation: function TopikExplanationSlot(props: TopikComponentProps) {
      return <TopikExplanationComponent {...props} __topikRole="explanation" />;
    },
  };
}
