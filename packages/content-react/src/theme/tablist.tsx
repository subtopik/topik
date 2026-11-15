import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

function useRovingTabs(tabCount: number) {
  const [selectedIndex, setSelected] = useState(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = Math.max(0, Math.min(selectedIndex, tabCount - 1));

  // Persist the clamp so removed selections do not return when tabs are added.
  if (selected !== selectedIndex) setSelected(selected);

  function selectTab(index: number, focus = false) {
    setSelected(index);
    if (focus) tabRefs.current[index]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number;
    const previous = index > 0 ? index - 1 : tabCount - 1;
    const next = index < tabCount - 1 ? index + 1 : 0;
    // Arrow keys follow the visual order, which is mirrored in right-to-left layouts.
    const rightToLeft =
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      isRightToLeft(event.currentTarget);

    if (event.key === "ArrowLeft") nextIndex = rightToLeft ? next : previous;
    else if (event.key === "ArrowRight") nextIndex = rightToLeft ? previous : next;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabCount - 1;
    else return;

    event.preventDefault();
    selectTab(nextIndex, true);
  }

  return { handleKeyDown, selectTab, selected, tabRefs };
}

function isRightToLeft(element: HTMLElement): boolean {
  const direction = element.ownerDocument.defaultView?.getComputedStyle(element).direction;
  if (direction === "rtl" || direction === "ltr") return direction === "rtl";
  // Without computed styles, fall back to the dir attribute (older engines lack :dir()).
  try {
    return element.matches(":dir(rtl)");
  } catch {
    return element.closest("[dir]")?.getAttribute("dir")?.toLowerCase() === "rtl";
  }
}

export interface TopikTablistItem {
  /** Visible tab label. */
  label: string;
  icon?: string;
  panel: ReactNode;
}

export interface TopikTablistProps {
  items: TopikTablistItem[];
  /** Accessible name of the tab list. */
  label: string;
  className: string;
  listClassName: string;
  tabClassName: string;
  panelClassName: string;
  /** When set, a tab's icon renders before its label in a span with this class. */
  iconClassName?: string;
  /** Element id parts; ids read `${id}-${tabId}-${index}` and `${id}-${panelId}-${index}`. */
  tabId: string;
  panelId: string;
}

/** @internal Shared tablist markup, ARIA and keyboard behaviour for tabs and code groups. */
export function TopikTablist({
  className,
  iconClassName,
  items,
  label,
  listClassName,
  panelClassName,
  panelId,
  tabClassName,
  tabId,
}: TopikTablistProps) {
  const id = useId();
  const { handleKeyDown, selectTab, selected, tabRefs } = useRovingTabs(items.length);

  return (
    <div className={className}>
      <div aria-label={label} className={listClassName} role="tablist">
        {items.map((item, index) => {
          const active = index === selected;
          return (
            <button
              aria-controls={`${id}-${panelId}-${index}`}
              aria-selected={active}
              className={tabClassName}
              id={`${id}-${tabId}-${index}`}
              key={index}
              onClick={() => selectTab(index)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              role="tab"
              tabIndex={active ? 0 : -1}
              type="button"
            >
              {iconClassName && item.icon ? (
                <span className={iconClassName}>{item.icon}</span>
              ) : null}
              {item.label}
            </button>
          );
        })}
      </div>
      {items.map((item, index) => (
        <div
          aria-labelledby={`${id}-${tabId}-${index}`}
          className={panelClassName}
          hidden={index !== selected}
          id={`${id}-${panelId}-${index}`}
          key={index}
          role="tabpanel"
          tabIndex={0}
        >
          {item.panel}
        </div>
      ))}
    </div>
  );
}
