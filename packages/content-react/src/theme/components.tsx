import {
  parseTopikResourceReference,
  validateTopikBrowserHref,
  validateTopikHref,
} from "@topik/content";
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type {
  TopikColorScheme,
  TopikComponent,
  TopikComponentMap,
  TopikComponentProps,
  TopikLinkHandler,
  TopikLinkRenderer,
  TopikLinkResolver,
} from "../core/components";
import { useTopikLinkHandler, useTopikLinkRenderer, useTopikLinkResolver } from "../core/context";
import { CodeBlockView } from "./code-block";
import { TopikTablist } from "./tablist";
import type { CodePresentationEffectiveOptions } from "@topik/content";

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

function resolveSafeHref(
  target: string,
  resolveLink?: TopikLinkResolver,
  alreadyResolved = false,
): string | undefined {
  if (validateTopikHref(target).length > 0) return undefined;
  let resolvedTarget: string | undefined;
  try {
    resolvedTarget = alreadyResolved ? target : resolveLink?.(target);
  } catch {
    return undefined;
  }
  if (resolvedTarget === undefined && parseTopikResourceReference(target) === null) {
    resolvedTarget = target;
  }
  if (parseTopikResourceReference(target) !== null && /^asset:/iu.test(resolvedTarget ?? "")) {
    return undefined;
  }
  return typeof resolvedTarget === "string" && validateTopikBrowserHref(resolvedTarget).length === 0
    ? resolvedTarget
    : undefined;
}

function createLinkClickHandler(target: string, handleNavigate?: TopikLinkHandler) {
  return function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!target || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
    if (handleNavigate?.(target, event) === true) event.preventDefault();
  };
}

export function TopikCallout({ children, title, variant = "info" }: TopikComponentProps) {
  const calloutTitle = stringAttribute(title);
  const titleId = useId();

  return (
    <aside
      aria-labelledby={calloutTitle ? titleId : undefined}
      className="topik-callout not-prose"
      data-variant={stringAttribute(variant) ?? "info"}
    >
      {calloutTitle ? (
        <div className="topik-callout__title" id={titleId}>
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
  __topikResolvedHref,
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
  const target = stringAttribute(href);
  const label = stringAttribute(title);
  const heading = (
    <>
      {icon ? <span className="topik-card__icon">{stringAttribute(icon)}</span> : null}
      <span className="topik-card__title">{label?.trim() ? label : target}</span>
    </>
  );
  let navigation = heading;
  if (target) {
    const resolvedTarget = resolveSafeHref(target, linkResolver, __topikResolvedHref === true);
    if (resolvedTarget) {
      const linkProps = {
        children: heading,
        className: "topik-card__link",
        href: resolvedTarget,
        onClick: createLinkClickHandler(
          parseTopikResourceReference(target) === null ? target : resolvedTarget,
          handleNavigate,
        ),
      };
      navigation = <>{linkRenderer ? linkRenderer(linkProps) : <a {...linkProps} />}</>;
    }
  }

  return (
    <div className="topik-card">
      {navigation}
      <div className="topik-card__body">{children}</div>
    </div>
  );
}

export function TopikCodeBlock({
  children,
  content,
  payload,
  language,
  presentation,
}: TopikComponentProps) {
  const code =
    stringAttribute(content) ??
    (typeof payload === "string" ? `${payload}\n` : stringChildren(children));
  const source = stringAttribute(payload) ?? (code.endsWith("\n") ? code.slice(0, -1) : code);
  return (
    <CodeBlockView
      payload={source}
      content={code}
      language={stringAttribute(language)}
      presentation={presentation as CodePresentationEffectiveOptions | undefined}
    />
  );
}

export function TopikInlineCode({ children, content }: TopikComponentProps) {
  return <code>{stringAttribute(content) ?? children}</code>;
}

export function TopikUnderline({ children }: TopikComponentProps) {
  return <u>{children}</u>;
}

export function TopikCodeGroup({ children }: TopikComponentProps) {
  return (
    <TopikTablist
      className="topik-code-group"
      iconClassName="topik-code-group__icon"
      items={childElements(children).map((tab, index) => ({
        icon: stringAttribute(tab.props.icon),
        label: stringAttribute(tab.props.title) ?? `Code ${index + 1}`,
        panel: tab,
      }))}
      label="Code examples"
      listClassName="topik-code-group__tabs"
      panelClassName="topik-code-group__panel"
      panelId="code-panel"
      tabClassName="topik-code-group__tab"
      tabId="code-tab"
    />
  );
}

export function TopikCodeTab({ children }: TopikComponentProps) {
  return <>{children}</>;
}

/** The element a URL fragment names, decoded like browsers do for fragment navigation. */
function fragmentTarget(document: Document): Element | null {
  const hash = document.defaultView?.location.hash.slice(1);
  if (!hash) return null;
  try {
    return document.getElementById(decodeURIComponent(hash));
  } catch {
    return document.getElementById(hash);
  }
}

export function TopikAccordion({ children, id, open, title }: TopikComponentProps) {
  const initiallyOpen = booleanAttribute(open);
  const [expanded, setExpanded] = useState(initiallyOpen);
  const [authoredOpen, setAuthoredOpen] = useState(initiallyOpen);
  const ref = useRef<HTMLDetailsElement>(null);
  if (authoredOpen !== initiallyOpen) {
    setAuthoredOpen(initiallyOpen);
    setExpanded(initiallyOpen);
  }
  // A link to the accordion, or to a heading inside it, opens it. Browsers reveal only targets
  // inside a closed accordion, and not all of them do, so the fragment is checked here as well.
  useEffect(() => {
    const details = ref.current;
    const view = details?.ownerDocument.defaultView;
    if (!details || !view) return;
    const reveal = () => {
      const target = fragmentTarget(details.ownerDocument);
      if (target && details.contains(target)) setExpanded(true);
    };
    reveal();
    view.addEventListener("hashchange", reveal);
    return () => view.removeEventListener("hashchange", reveal);
  }, []);
  return (
    <details
      className="topik-accordion"
      id={stringAttribute(id)}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      open={expanded}
      ref={ref}
    >
      <summary className="topik-accordion__summary">{stringAttribute(title)}</summary>
      <div className="topik-accordion__body">{children}</div>
    </details>
  );
}

export function TopikTabs({ children }: TopikComponentProps) {
  return (
    <TopikTablist
      className="topik-tabs"
      items={childElements(children).map((tab, index) => ({
        label: stringAttribute(tab.props.title) ?? `Tab ${index + 1}`,
        panel: tab,
      }))}
      label="Tabs"
      listClassName="topik-tabs__list"
      panelClassName="topik-tabs__panel"
      panelId="panel"
      tabClassName="topik-tabs__tab"
      tabId="tab"
    />
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

function colorSchemeAttribute(value: unknown): TopikColorScheme | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}

export function TopikFigure({ alt, caption, colorScheme, darkSrc, src }: TopikComponentProps) {
  const lightSource = stringAttribute(src);
  const darkSource = stringAttribute(darkSrc);
  const explicitColorScheme = colorSchemeAttribute(colorScheme);
  const imageSource = explicitColorScheme === "dark" ? (darkSource ?? lightSource) : lightSource;
  const altText = stringAttribute(alt);
  const captionText = stringAttribute(caption);
  if (imageSource === undefined) {
    // Keep the text alternative and caption readable when the image cannot be resolved.
    if (!altText && !captionText) return null;
    return (
      <figure className="topik-figure">
        {altText ? <div className="topik-figure__fallback">{altText}</div> : null}
        {captionText ? <figcaption>{captionText}</figcaption> : null}
      </figure>
    );
  }
  return (
    <figure className="topik-figure">
      <picture>
        {explicitColorScheme === undefined && darkSource ? (
          <source media="(prefers-color-scheme: dark)" srcSet={singleImageCandidate(darkSource)} />
        ) : null}
        <img alt={altText ?? ""} src={imageSource} />
      </picture>
      {captionText ? <figcaption>{captionText}</figcaption> : null}
    </figure>
  );
}

/** srcset parses whitespace and commas as syntax, even inside an admitted single URL. */
function singleImageCandidate(source: string): string {
  return source.replace(/[\t\n\f\r ,]/g, (character) => encodeURIComponent(character));
}

export function TopikImage({ alt, src, title }: TopikComponentProps) {
  const source = stringAttribute(src);
  if (source === undefined) return null;
  return (
    <img
      alt={stringAttribute(alt) ?? ""}
      className="topik-image"
      src={source}
      title={stringAttribute(title)}
    />
  );
}

export function TopikLink({
  __topikResolvedHref,
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
  const resolvedTarget = resolveSafeHref(target, linkResolver, __topikResolvedHref === true);

  if (!resolvedTarget) return <>{children}</>;

  const linkProps = {
    children,
    href: resolvedTarget,
    onClick: createLinkClickHandler(
      parseTopikResourceReference(target) === null ? target : resolvedTarget,
      handleNavigate,
    ),
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
  const [answer, setAnswer] = useState<QuestionAnswer>(() => ({
    selected: new Set(),
    incorrectAttempts: 0,
  }));
  const { selected, incorrectAttempts } = answer;
  const multiple = type === "multiple-choice";
  const answered = selected.size > 0;
  const correctIndexes = new Set(
    choices.flatMap((choice, index) => (choice.props.correct === true ? [index] : [])),
  );
  const isCorrect = isCorrectAnswer(selected, correctIndexes);

  function toggle(index: number) {
    setAnswer((current) => {
      let next: Set<number>;
      if (!multiple) next = new Set([index]);
      else {
        next = new Set(current.selected);
        if (next.has(index)) next.delete(index);
        else next.add(index);
      }
      const incorrect = next.size > 0 && !isCorrectAnswer(next, correctIndexes);
      return {
        selected: next,
        incorrectAttempts: current.incorrectAttempts + (incorrect ? 1 : 0),
      };
    });
  }

  // Repeated wrong answers change the text so the live region announces each attempt.
  const feedback = !answered
    ? null
    : isCorrect
      ? "Correct"
      : incorrectAttempts > 1
        ? `Try again (${incorrectAttempts} incorrect attempts)`
        : "Try again";

  return (
    <section className="topik-question" data-correct={answered ? isCorrect : undefined}>
      <fieldset className="topik-question__choices">
        <legend className="topik-question__legend">
          {multiple ? "Choose all answers that apply" : "Choose one answer"}
        </legend>
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
      </fieldset>
      {/* Keep the live region mounted before its first feedback update. */}
      <div className="topik-question__result" role="status" aria-atomic="true">
        {feedback}
      </div>
      {answered && explanation.length > 0 ? explanation : null}
    </section>
  );
}

interface QuestionAnswer {
  selected: Set<number>;
  incorrectAttempts: number;
}

function isCorrectAnswer(selected: Set<number>, correctIndexes: Set<number>): boolean {
  return (
    selected.size > 0 &&
    selected.size === correctIndexes.size &&
    [...selected].every((index) => correctIndexes.has(index))
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
  return child.type === TopikChoice || hasTopikRole(child, "choice") || "correct" in child.props;
}

function isExplanationElement(child: ReactNode): child is ReactElement<TopikComponentProps> {
  if (!isValidElement<TopikComponentProps & TopikRoleProps>(child)) return false;
  return child.type === TopikExplanation || hasTopikRole(child, "explanation");
}

function hasTopikRole(child: ReactElement<TopikRoleProps>, role: "choice" | "explanation") {
  // Questions inspect their children before the slot components render.
  return (
    child.props.__topikRole === role ||
    (typeof child.type === "function" &&
      "__topikRole" in child.type &&
      child.type.__topikRole === role)
  );
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

/** @internal Rendering options that themed slots read at render time, not at map creation. */
export interface TopikSlotOptions {
  colorScheme?: TopikColorScheme;
  onNavigateLink?: TopikLinkHandler;
  renderLink?: TopikLinkRenderer;
  resolveLink?: TopikLinkResolver;
}

const TopikSlotOptionsContext = createContext<TopikSlotOptions | undefined>(undefined);

/** @internal Supplies the latest handlers to slots without changing slot component identities. */
export const TopikSlotOptionsProvider = TopikSlotOptionsContext.Provider;

type TopikSlotKind = "card" | "choice" | "explanation" | "figure" | "link";

const slotKinds = new WeakMap<TopikComponent, TopikSlotKind>();
const slotCache: Record<TopikSlotKind, WeakMap<TopikComponent, TopikComponent>> = {
  card: new WeakMap(),
  choice: new WeakMap(),
  explanation: new WeakMap(),
  figure: new WeakMap(),
  link: new WeakMap(),
};

function createSlot(kind: TopikSlotKind, Component: TopikComponent): TopikComponent {
  switch (kind) {
    case "card":
    case "link":
      return function TopikNavigationSlot(props: TopikComponentProps) {
        const options = useContext(TopikSlotOptionsContext);
        return (
          <Component
            {...props}
            onNavigateLink={options?.onNavigateLink ?? props.onNavigateLink}
            renderLink={options?.renderLink ?? props.renderLink}
            resolveLink={options?.resolveLink ?? props.resolveLink}
          />
        );
      };
    case "figure":
      return function TopikFigureSlot(props: TopikComponentProps) {
        const options = useContext(TopikSlotOptionsContext);
        return <Component {...props} colorScheme={options?.colorScheme ?? props.colorScheme} />;
      };
    case "choice":
    case "explanation":
      return Object.assign(
        function TopikRoleSlot(props: TopikComponentProps) {
          return <Component {...props} __topikRole={kind} />;
        },
        { __topikRole: kind },
      );
  }
}

/** One wrapper per component and slot, so repeated component maps never remount content. */
function slot(kind: TopikSlotKind, Component: TopikComponent): TopikComponent {
  if (slotKinds.get(Component) === kind) return Component;
  let wrapped = slotCache[kind].get(Component);
  if (!wrapped) {
    wrapped = createSlot(kind, Component);
    slotKinds.set(wrapped, kind);
    slotCache[kind].set(Component, wrapped);
  }
  return wrapped;
}

export function getDefaultTopikComponents(
  overrides: Partial<TopikComponentMap> = {},
): TopikComponentMap {
  // An explicit undefined override keeps the themed component, like the slotted ones below.
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, component]) => component !== undefined),
  ) as Partial<TopikComponentMap>;
  return {
    ...defaultTopikComponents,
    ...defined,
    TopikCard: slot("card", overrides.TopikCard ?? TopikCard),
    TopikChoice: slot("choice", overrides.TopikChoice ?? TopikChoice),
    TopikExplanation: slot("explanation", overrides.TopikExplanation ?? TopikExplanation),
    TopikFigure: slot("figure", overrides.TopikFigure ?? TopikFigure),
    TopikLink: slot("link", overrides.TopikLink ?? TopikLink),
  };
}
