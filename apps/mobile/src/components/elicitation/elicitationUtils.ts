/**
 * Pure helpers for rendering elicitations (an agent's question rendered as a form, or a URL hand-off):
 * field labels, answer summaries, resolution labels, URL host extraction. No React.
 */
import type { ElicitationAction, ElicitationContent, ElicitationProperty, ElicitationRequest, ElicitationSchema, ElicitationValue } from '@mobile-ide/core';
import type { IoniconName } from '../permissions/permissionUtils';

export interface ElicitationField {
  name: string;
  prop: ElicitationProperty;
  required: boolean;
  /** what the form shows above the field */
  label: string;
}

export interface ElicitationResolved {
  action: ElicitationAction;
  content?: ElicitationContent;
}

/** `question_0` → "Question 1", `favorite_color` → "Favorite color", `apiKey` → "Api key". */
export function humanizeFieldName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b(\d+)$/, (m) => String(Number(m) + 1));
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

/**
 * The form's fields in schema order. A field without a title is labelled by its name — except when it is the only
 * untitled one (Claude Code's single AskUserQuestion: the question is the message, the field is just "your answer").
 */
export function fieldsOf(schema: ElicitationSchema): ElicitationField[] {
  const entries = Object.entries(schema.properties);
  const untitled = entries.filter(([, p]) => !p.title?.trim()).length;
  return entries.map(([name, prop]) => ({
    name,
    prop,
    required: schema.required.includes(name),
    label: prop.title?.trim() || (untitled === 1 ? 'Your answer' : humanizeFieldName(name)),
  }));
}

export function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Drop unanswered fields so an optional field the user never touched is not sent as `''`. */
export function compactAnswers(content: ElicitationContent): ElicitationContent {
  const out: ElicitationContent = {};
  for (const [k, v] of Object.entries(content)) if (!isBlank(v)) out[k] = v;
  return out;
}

export function optionsOf(prop: ElicitationProperty): { value: string; title: string; description?: string }[] {
  if (prop.type === 'array') return prop.options;
  if (prop.type === 'string') return prop.options ?? [];
  return [];
}

export function optionTitle(prop: ElicitationProperty, value: string): string {
  return optionsOf(prop).find((o) => o.value === value)?.title ?? value;
}

export function formatValue(prop: ElicitationProperty, value: ElicitationValue): string {
  if (Array.isArray(value)) return value.map((v) => optionTitle(prop, v)).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return optionTitle(prop, value);
  return String(value);
}

/** "Blue" when one field was answered; "Colour: Blue · Size: Large" otherwise; '' when nothing was. */
export function answerSummary(request: Pick<ElicitationRequest, 'schema'>, content: ElicitationContent | undefined): string {
  if (!content || !request.schema) return '';
  const answered = fieldsOf(request.schema).filter((f) => !isBlank(content[f.name]));
  const first = answered[0];
  if (!first) return '';
  const valueOf = (f: ElicitationField): string => {
    const v = content[f.name];
    return v === undefined ? '' : formatValue(f.prop, v);
  };
  if (answered.length === 1) return valueOf(first);
  return answered.map((f) => `${f.label}: ${valueOf(f)}`).join(' · ');
}

export interface ResolutionInfo {
  label: string;
  tone: 'success' | 'danger' | 'neutral';
  icon: IoniconName;
}

export function resolutionInfo(request: Pick<ElicitationRequest, 'mode' | 'schema'>, resolved: ElicitationResolved): ResolutionInfo {
  switch (resolved.action) {
    case 'accept': {
      if (request.mode === 'url') return { label: 'Link opened', tone: 'success', icon: 'checkmark-circle' };
      const summary = answerSummary(request, resolved.content);
      return { label: summary ? `Answered: ${summary}` : 'Answered', tone: 'success', icon: 'checkmark-circle' };
    }
    case 'decline':
      return { label: 'Skipped', tone: 'neutral', icon: 'play-skip-forward-outline' };
    case 'cancel':
      return { label: 'Dismissed', tone: 'danger', icon: 'close-circle' };
  }
}

export function urlHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Short subtitle for cards: "Question", "3 fields", "Link · github.com". */
export function describeElicitation(request: Pick<ElicitationRequest, 'mode' | 'schema' | 'url'>): string {
  if (request.mode === 'url') {
    const host = request.url ? urlHost(request.url) : null;
    return host ? `Link · ${host}` : 'Link';
  }
  const n = Object.keys(request.schema?.properties ?? {}).length;
  if (n === 0) return 'Confirmation';
  return n === 1 ? 'Question' : `${n} fields`;
}

export function elicitationIcon(request: Pick<ElicitationRequest, 'mode'>): IoniconName {
  return request.mode === 'url' ? 'open-outline' : 'help-circle-outline';
}
