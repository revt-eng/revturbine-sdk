/**
 * Annotated DOM capture (plan 144 TASK-15 / REQ-14, REQ-23).
 *
 * `annotated` mode ONLY — hand-authored `data-rt-event` / `data-rt-ref` /
 * `data-rt-prop-*` attributes. There is no `mapped` (selector-based) or
 * `discovery` (auto) capture: those read arbitrary page content and are out of
 * scope.
 *
 * PRIVACY INVARIANTS (REQ-14) — the collection layer NEVER reads:
 *   - element text / `innerText` / `textContent`
 *   - input `.value` / `name` / `label`
 *   - `href` / URLs
 *   - CSS selectors or the element path
 *   - arbitrary attributes
 * Only allowlisted `data-rt-prop-*` values are collected, capped in count and
 * length, then handed to the caller which passes them through the existing PII
 * redactor. Password / file / hidden / payment-autocomplete controls are always
 * excluded, and a `data-rt-no-capture` ancestor opts an element and its whole
 * subtree out.
 */

const DATA_EVENT = 'data-rt-event';
const DATA_REF = 'data-rt-ref';
const DATA_NO_CAPTURE = 'data-rt-no-capture';
const DATA_PROP_PREFIX = 'data-rt-prop-';

const DEFAULT_MAX_PROPS = 24;
const DEFAULT_MAX_VALUE_LEN = 256;

// Input controls whose mere capture risks leaking a secret — excluded regardless
// of annotation (REQ-14 / AC-16). Payment + password autocomplete tokens too.
const SENSITIVE_INPUT_TYPES = new Set(['password', 'file', 'hidden']);
const SENSITIVE_AUTOCOMPLETE = /(^|\s)(cc-|current-password|new-password|one-time-code)/;

/** A resolved capture: the annotated element plus its declared event. */
interface Resolved {
  el: HTMLElement;
  event: string;
}

function isSensitiveControl(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input') return false;
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  if (SENSITIVE_INPUT_TYPES.has(type)) return true;
  const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();
  return SENSITIVE_AUTOCOMPLETE.test(autocomplete);
}

/**
 * Walk from the event target up to (not past) the root. Returns the nearest
 * `data-rt-event` element — unless ANY element on that path carries
 * `data-rt-no-capture` (subtree opt-out) or the annotated element is a sensitive
 * control, in which case nothing is captured.
 */
function resolveTarget(start: Element, root: Element | Document): Resolved | null {
  const stop = root instanceof Document ? root.documentElement.parentElement : root.parentElement;
  let el: Element | null = start;
  let found: Resolved | null = null;
  while (el && el !== stop) {
    if (el instanceof HTMLElement) {
      if (el.hasAttribute(DATA_NO_CAPTURE)) return null; // opted out — kills the whole subtree
      if (!found) {
        const event = el.getAttribute(DATA_EVENT);
        if (event) {
          if (isSensitiveControl(el)) return null; // never capture a sensitive control
          found = { el, event };
        }
      }
    }
    el = el.parentElement;
  }
  return found;
}

/**
 * Collect ONLY `data-rt-prop-*` values (capped) and `data-rt-ref`. This is the
 * complete set of what leaves the DOM — never text, values, hrefs, or selectors.
 */
function collectProps(el: HTMLElement, maxProps: number, maxValueLen: number): Record<string, string> {
  const props: Record<string, string> = {};
  let count = 0;
  for (const attr of Array.from(el.attributes)) {
    if (count >= maxProps) break;
    if (!attr.name.startsWith(DATA_PROP_PREFIX)) continue;
    const key = attr.name.slice(DATA_PROP_PREFIX.length);
    if (!key) continue;
    props[key] = String(attr.value).slice(0, maxValueLen);
    count += 1;
  }
  const ref = el.getAttribute(DATA_REF);
  if (ref) props.ref = ref.slice(0, maxValueLen);
  return props;
}

/** Options for {@link installAnnotatedCapture}. */
export interface AnnotatedCaptureOptions {
  /** DOM events to delegate. One listener is attached per event. Default `['click']`. */
  events?: string[];
  /** Max `data-rt-prop-*` values collected per element. Default 24. */
  maxProps?: number;
  /** Max length of each collected value. Default 256. */
  maxValueLen?: number;
}

/**
 * Install one delegated listener per supported event at `root` (plan 144
 * TASK-15). On a matching interaction it emits the element's `data-rt-event` with
 * its allowlisted `data-rt-prop-*` / `data-rt-ref` values — nothing else. Returns
 * a cleanup function that removes every listener.
 *
 * @param root - the provider root (a DOM element or document)
 * @param emit - receives `(eventName, props)`; the caller must pass `props`
 *   through the SDK's redactor (e.g. `sdk.capture`)
 * @param options - events + caps
 */
export function installAnnotatedCapture(
  root: Element | Document,
  emit: (eventName: string, props: Record<string, string>) => void,
  options: AnnotatedCaptureOptions = {},
): () => void {
  const events = options.events ?? ['click'];
  const maxProps = options.maxProps ?? DEFAULT_MAX_PROPS;
  const maxValueLen = options.maxValueLen ?? DEFAULT_MAX_VALUE_LEN;

  const handler = (e: Event): void => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const resolved = resolveTarget(target, root);
    if (!resolved) return;
    emit(resolved.event, collectProps(resolved.el, maxProps, maxValueLen));
  };

  // Capture phase so a stopPropagation on the target can't hide the interaction.
  for (const evt of events) root.addEventListener(evt, handler, true);
  return () => {
    for (const evt of events) root.removeEventListener(evt, handler, true);
  };
}
