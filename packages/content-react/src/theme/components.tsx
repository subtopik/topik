import {
  Children,
  isValidElement,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type {
  TopikColorScheme,
  TopikComponentMap,
  TopikComponentProps,
  TopikLinkHandler,
  TopikLinkRenderer,
  TopikLinkResolver,
} from "../core/components";
import { useTopikLinkHandler, useTopikLinkRenderer, useTopikLinkResolver } from "../core/context";

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

function tableAlignAttribute(
  value: unknown,
): "center" | "char" | "justify" | "left" | "right" | undefined {
  if (
    value === "center" ||
    value === "char" ||
    value === "justify" ||
    value === "left" ||
    value === "right"
  ) {
    return value;
  }
  return undefined;
}

function tableTextAlignStyle(value: unknown): CSSProperties["textAlign"] | undefined {
  if (value === "center" || value === "justify" || value === "left" || value === "right") {
    return value;
  }
  return undefined;
}

function tableCellStyle(align: unknown, width?: unknown): CSSProperties | undefined {
  const textAlign = tableTextAlignStyle(align);
  const widthValue = stringAttribute(width);
  if (!textAlign && !widthValue) return undefined;
  return { textAlign, width: widthValue };
}

function stringChildren(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement<{ children?: ReactNode }>(child))
        return stringChildren(child.props.children);
      return "";
    })
    .join("");
}

function childElements(children: ReactNode): ReactElement<TopikComponentProps>[] {
  return Children.toArray(children).filter(isValidElement) as ReactElement<TopikComponentProps>[];
}

function useTopikLinkBehavior({
  onNavigateLink,
  renderLink,
  resolveLink,
}: Pick<TopikComponentProps, "onNavigateLink" | "renderLink" | "resolveLink">) {
  const contextHandler = useTopikLinkHandler();
  const contextRenderer = useTopikLinkRenderer();
  const contextResolver = useTopikLinkResolver();

  return {
    handleNavigate:
      typeof onNavigateLink === "function" ? (onNavigateLink as TopikLinkHandler) : contextHandler,
    linkRenderer:
      typeof renderLink === "function" ? (renderLink as TopikLinkRenderer) : contextRenderer,
    linkResolver:
      typeof resolveLink === "function" ? (resolveLink as TopikLinkResolver) : contextResolver,
  };
}

function createLinkClickHandler(target: string, handleNavigate?: TopikLinkHandler) {
  return function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!target || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
    if (handleNavigate?.(target, event) === true) event.preventDefault();
  };
}

function useRovingTabs(tabCount: number) {
  const [selected, setSelected] = useState(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectTab(index: number, focus = false) {
    setSelected(index);
    if (focus) tabRefs.current[index]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number;

    if (event.key === "ArrowLeft") nextIndex = index > 0 ? index - 1 : tabCount - 1;
    else if (event.key === "ArrowRight") nextIndex = index < tabCount - 1 ? index + 1 : 0;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabCount - 1;
    else return;

    event.preventDefault();
    selectTab(nextIndex, true);
  }

  return { handleKeyDown, selectTab, selected, tabRefs };
}

export function TopikCallout({ children, title, variant = "info" }: TopikComponentProps) {
  const calloutTitle = stringAttribute(title);

  return (
    <aside className="topik-callout not-prose" data-variant={stringAttribute(variant) ?? "info"}>
      {calloutTitle ? (
        <div className="topik-callout__title">
          <strong>{calloutTitle}</strong>
        </div>
      ) : null}
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

export function TopikCard({
  children,
  href,
  icon,
  onNavigateLink,
  renderLink,
  resolveLink,
  title,
}: TopikComponentProps) {
  const { handleNavigate, linkRenderer, linkResolver } = useTopikLinkBehavior({
    onNavigateLink,
    renderLink,
    resolveLink,
  });
  const content = (
    <>
      {icon ? <span className="topik-card__icon">{stringAttribute(icon)}</span> : null}
      <span className="topik-card__title">{stringAttribute(title)}</span>
      <span className="topik-card__body">{children}</span>
    </>
  );

  const target = stringAttribute(href);
  if (target) {
    const resolvedTarget = linkResolver?.(target) ?? target;

    const linkProps = {
      children: content,
      className: "topik-card",
      href: resolvedTarget,
      onClick: createLinkClickHandler(target, handleNavigate),
    };
    return <>{linkRenderer ? linkRenderer(linkProps) : <a {...linkProps} />}</>;
  }

  return <div className="topik-card">{content}</div>;
}

export function TopikCodeBlock({ children, content, language }: TopikComponentProps) {
  const code = stringAttribute(content) ?? stringChildren(children);
  const languageName = stringAttribute(language);
  return (
    <div className="topik-code-block" data-language={languageName}>
      {languageName ? <div className="topik-code-block__language">{languageName}</div> : null}
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function TopikInlineCode({ children, content }: TopikComponentProps) {
  return <code>{stringAttribute(content) ?? children}</code>;
}

export function TopikUnderline({ children }: TopikComponentProps) {
  return <u>{children}</u>;
}

export function TopikCodeGroup({ children }: TopikComponentProps) {
  const id = useId();
  const tabs = childElements(children);
  const { handleKeyDown, selectTab, selected, tabRefs } = useRovingTabs(tabs.length);

  return (
    <div className="topik-code-group">
      <div className="topik-code-group__tabs" role="tablist">
        {tabs.map((tab, index) => {
          const active = index === selected;
          const label = stringAttribute(tab.props.title) ?? `Code ${index + 1}`;
          return (
            <button
              aria-controls={`${id}-code-panel-${index}`}
              aria-selected={active}
              className="topik-code-group__tab"
              id={`${id}-code-tab-${index}`}
              key={`${label}-${index}`}
              onClick={() => selectTab(index)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              role="tab"
              tabIndex={active ? 0 : -1}
              type="button"
            >
              {stringAttribute(tab.props.icon) ? (
                <span className="topik-code-group__icon">{stringAttribute(tab.props.icon)}</span>
              ) : null}
              {label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab, index) => (
        <div
          aria-labelledby={`${id}-code-tab-${index}`}
          className="topik-code-group__panel"
          hidden={index !== selected}
          id={`${id}-code-panel-${index}`}
          key={`${stringAttribute(tab.props.title) ?? "code"}-${index}`}
          role="tabpanel"
        >
          {tab.props.children}
        </div>
      ))}
    </div>
  );
}

export function TopikCodeTab({ children }: TopikComponentProps) {
  return <>{children}</>;
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
  const { handleKeyDown, selectTab, selected, tabRefs } = useRovingTabs(tabs.length);

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

export function TopikFigure({ alt, caption, colorScheme, darkSrc, src }: TopikComponentProps) {
  const lightSource = stringAttribute(src) ?? "";
  const darkSource = stringAttribute(darkSrc);
  const explicitColorScheme = colorScheme as TopikColorScheme | undefined;
  const imageSource = explicitColorScheme === "dark" ? (darkSource ?? lightSource) : lightSource;
  return (
    <figure className="topik-figure">
      <picture>
        {explicitColorScheme === undefined && darkSource ? (
          <source media="(prefers-color-scheme: dark)" srcSet={darkSource} />
        ) : null}
        <img alt={stringAttribute(alt) ?? ""} src={imageSource} />
      </picture>
      {caption ? <figcaption>{stringAttribute(caption)}</figcaption> : null}
    </figure>
  );
}

export function TopikImage({ alt, src, title }: TopikComponentProps) {
  return (
    <img
      alt={stringAttribute(alt) ?? ""}
      className="topik-image"
      src={stringAttribute(src) ?? ""}
      title={stringAttribute(title)}
    />
  );
}

export function TopikLink({
  children,
  href,
  onNavigateLink,
  renderLink,
  resolveLink,
  title,
}: TopikComponentProps) {
  const { handleNavigate, linkRenderer, linkResolver } = useTopikLinkBehavior({
    onNavigateLink,
    renderLink,
    resolveLink,
  });
  const target = stringAttribute(href) ?? "";
  const resolvedTarget = linkResolver?.(target) ?? target;

  const linkProps = {
    children,
    href: resolvedTarget,
    onClick: createLinkClickHandler(target, handleNavigate),
    title: stringAttribute(title),
  };
  return <>{linkRenderer ? linkRenderer(linkProps) : <a {...linkProps} />}</>;
}

export function TopikMath({ content }: TopikComponentProps) {
  return (
    <pre className="topik-math" data-language="math">
      <code>{stringAttribute(content) ?? ""}</code>
    </pre>
  );
}

export function TopikMathInline({ content }: TopikComponentProps) {
  return <code className="topik-math-inline">{stringAttribute(content) ?? ""}</code>;
}

export function TopikMermaid({ content }: TopikComponentProps) {
  return (
    <pre className="topik-mermaid" data-language="mermaid">
      <code>{stringAttribute(content) ?? ""}</code>
    </pre>
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

export function TopikTable({ children }: TopikComponentProps) {
  return (
    <div className="topik-table">
      <table>{children}</table>
    </div>
  );
}

export function TopikTableRow({ children }: TopikComponentProps) {
  return <tr>{children}</tr>;
}

export function TopikTableCell({ align, children, colSpan, rowSpan }: TopikComponentProps) {
  return (
    <td
      align={tableAlignAttribute(align)}
      colSpan={numberAttribute(colSpan)}
      rowSpan={numberAttribute(rowSpan)}
      style={tableCellStyle(align)}
    >
      {children}
    </td>
  );
}

export function TopikTableHeader({
  align,
  children,
  colSpan,
  rowSpan,
  width,
}: TopikComponentProps) {
  return (
    <th
      align={tableAlignAttribute(align)}
      colSpan={numberAttribute(colSpan)}
      rowSpan={numberAttribute(rowSpan)}
      style={tableCellStyle(align, width)}
    >
      {children}
    </th>
  );
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
  TopikCodeBlock,
  TopikCodeGroup,
  TopikCodeTab,
  TopikChoice,
  TopikExplanation,
  TopikFigure,
  TopikImage,
  TopikInlineCode,
  TopikLink,
  TopikMath,
  TopikMathInline,
  TopikMermaid,
  TopikQuestion,
  TopikQuiz,
  TopikStep,
  TopikSteps,
  TopikTab,
  TopikTabs,
  TopikTable,
  TopikTableCell,
  TopikTableHeader,
  TopikTableRow,
  TopikUnderline,
} satisfies TopikComponentMap;

export function getDefaultTopikComponents(
  overrides: Partial<TopikComponentMap> = {},
  options: {
    colorScheme?: TopikColorScheme;
    onNavigateLink?: TopikLinkHandler;
    renderLink?: TopikLinkRenderer;
    resolveLink?: TopikLinkResolver;
  } = {},
): TopikComponentMap {
  const TopikCardComponent = overrides.TopikCard ?? TopikCard;
  const TopikChoiceComponent = overrides.TopikChoice ?? TopikChoice;
  const TopikExplanationComponent = overrides.TopikExplanation ?? TopikExplanation;
  const TopikFigureComponent = overrides.TopikFigure ?? TopikFigure;
  const TopikLinkComponent = overrides.TopikLink ?? TopikLink;

  return {
    ...defaultTopikComponents,
    ...overrides,
    TopikCard: function TopikCardSlot(props: TopikComponentProps) {
      return (
        <TopikCardComponent
          {...props}
          onNavigateLink={options.onNavigateLink}
          renderLink={options.renderLink}
          resolveLink={options.resolveLink}
        />
      );
    },
    TopikChoice: function TopikChoiceSlot(props: TopikComponentProps) {
      return <TopikChoiceComponent {...props} __topikRole="choice" />;
    },
    TopikExplanation: function TopikExplanationSlot(props: TopikComponentProps) {
      return <TopikExplanationComponent {...props} __topikRole="explanation" />;
    },
    TopikFigure: function TopikFigureSlot(props: TopikComponentProps) {
      return <TopikFigureComponent {...props} colorScheme={options.colorScheme} />;
    },
    TopikLink: function TopikLinkSlot(props: TopikComponentProps) {
      return (
        <TopikLinkComponent
          {...props}
          onNavigateLink={options.onNavigateLink}
          renderLink={options.renderLink}
          resolveLink={options.resolveLink}
        />
      );
    },
  };
}
