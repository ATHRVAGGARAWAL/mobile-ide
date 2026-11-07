/**
 * Renders an elicitation form from its (normalized JSON-schema) fields: single-select as chips or option rows,
 * multi-select as checkable rows, free text / numbers as text fields, booleans as toggles. Validation messages come
 * from the caller (core's `validateElicitationContent`), so the daemon and the phone agree on what is acceptable.
 */
import React, { useMemo, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ElicitationContent, ElicitationProperty, ElicitationSchema, ElicitationValue } from '@mobile-ide/core';
import { useTheme } from '../../theme/ThemeProvider';
import { Tap } from '../ui/Tap';
import { T } from '../ui/Text';
import { TextField } from '../ui/TextField';
import { fieldsOf, optionsOf, type ElicitationField } from './elicitationUtils';

export interface ElicitationFormProps {
  schema: ElicitationSchema;
  value: ElicitationContent;
  /** field name → problem, shown under the field */
  errors: Record<string, string>;
  onChange: (name: string, value: ElicitationValue | undefined) => void;
  disabled?: boolean;
}

/** Chips when every option is short and undescribed; rows (with descriptions) otherwise. */
const CHIP_MAX_OPTIONS = 6;
const CHIP_MAX_TITLE = 24;

export function ElicitationForm({ schema, value, errors, onChange, disabled }: ElicitationFormProps) {
  const fields = useMemo(() => fieldsOf(schema), [schema]);
  return (
    <View style={styles.form}>
      {schema.title ? <T variant="subheading">{schema.title}</T> : null}
      {schema.description ? (
        <T variant="bodySmall" color="textMuted">
          {schema.description}
        </T>
      ) : null}
      {fields.map((f) => (
        <Field
          key={f.name}
          field={f}
          value={value[f.name]}
          error={errors[f.name]}
          disabled={disabled}
          onChange={(v) => onChange(f.name, v)}
        />
      ))}
    </View>
  );
}

interface FieldProps {
  field: ElicitationField;
  value: ElicitationValue | undefined;
  error: string | undefined;
  disabled: boolean | undefined;
  onChange: (value: ElicitationValue | undefined) => void;
}

function Field({ field, value, error, disabled, onChange }: FieldProps) {
  const { prop } = field;
  switch (prop.type) {
    case 'boolean':
      return <BooleanField field={field} value={value} error={error} disabled={disabled} onChange={onChange} />;
    case 'number':
    case 'integer':
      return <NumberField field={field} value={value} error={error} disabled={disabled} onChange={onChange} />;
    case 'array':
      return <SelectField field={field} value={value} error={error} disabled={disabled} onChange={onChange} multi />;
    case 'string':
      if (prop.options?.length) return <SelectField field={field} value={value} error={error} disabled={disabled} onChange={onChange} />;
      return <TextFieldInput field={field} value={value} error={error} disabled={disabled} onChange={onChange} />;
  }
}

function FieldHeader({ field }: { field: ElicitationField }) {
  const t = useTheme();
  return (
    <View style={{ gap: 2 }}>
      <T variant="label">
        {field.label}
        {field.required ? (
          <T variant="caption" color="textFaint">
            {' '}
            · Required
          </T>
        ) : null}
      </T>
      {field.prop.description ? (
        <T variant="bodySmall" color="textMuted">
          {field.prop.description}
        </T>
      ) : null}
    </View>
  );
}

function FieldError({ error }: { error: string | undefined }) {
  if (!error) return null;
  return (
    <T variant="caption" color="danger">
      {error}
    </T>
  );
}

function labelWithMarker(field: ElicitationField): string {
  return field.required ? `${field.label} *` : field.label;
}

function TextFieldInput({ field, value, error, disabled, onChange }: FieldProps) {
  const prop = field.prop.type === 'string' ? field.prop : null;
  const format = prop?.format;
  const multiline = !format && (prop?.maxLength === undefined || prop.maxLength > 80);
  return (
    <TextField
      label={labelWithMarker(field)}
      hint={field.prop.description ?? undefined}
      error={error ?? null}
      value={typeof value === 'string' ? value : ''}
      onChangeText={(text) => onChange(text)}
      editable={!disabled}
      multiline={multiline}
      numberOfLines={multiline ? 3 : 1}
      maxLength={prop?.maxLength}
      autoCapitalize={format ? 'none' : 'sentences'}
      autoCorrect={!format}
      keyboardType={format === 'email' ? 'email-address' : format === 'uri' ? 'url' : 'default'}
      placeholder={format === 'date' ? 'YYYY-MM-DD' : format === 'date-time' ? 'YYYY-MM-DDTHH:MM' : undefined}
      style={multiline ? { minHeight: 84, textAlignVertical: 'top' } : undefined}
    />
  );
}

function NumberField({ field, value, error, disabled, onChange }: FieldProps) {
  // The draft keeps intermediate input ("1.", "-") that is not yet a number; the parsed value goes to the form.
  const [draft, setDraft] = useState(typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '');
  const integer = field.prop.type === 'integer';
  const prop = field.prop.type === 'number' || field.prop.type === 'integer' ? field.prop : null;
  const bounds =
    prop && (prop.minimum !== undefined || prop.maximum !== undefined) ? `${prop.minimum ?? '…'} – ${prop.maximum ?? '…'}` : undefined;
  return (
    <TextField
      label={labelWithMarker(field)}
      hint={field.prop.description ?? bounds}
      error={error ?? null}
      value={draft}
      editable={!disabled}
      keyboardType={integer ? 'numeric' : 'decimal-pad'}
      placeholder={bounds}
      onChangeText={(text) => {
        setDraft(text);
        const trimmed = text.trim();
        if (!trimmed) {
          onChange(undefined);
          return;
        }
        const n = Number(trimmed);
        // a non-number stays a string so the validator can say "Must be a number"
        onChange(Number.isFinite(n) ? n : trimmed);
      }}
    />
  );
}

function BooleanField({ field, value, error, disabled, onChange }: FieldProps) {
  const t = useTheme();
  const on = value === true;
  return (
    <View style={{ gap: 4 }}>
      <View style={[styles.switchRow, { backgroundColor: t.colors.surface, borderColor: t.colors.border, borderRadius: t.radius.md }]}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T variant="body">
            {field.label}
            {field.required ? <T style={{ color: t.colors.danger }}> *</T> : null}
          </T>
          {field.prop.description ? (
            <T variant="bodySmall" color="textMuted">
              {field.prop.description}
            </T>
          ) : null}
        </View>
        <Switch
          value={on}
          onValueChange={(v) => onChange(v)}
          disabled={disabled}
          trackColor={{ true: t.colors.accent, false: t.colors.borderStrong }}
          thumbColor={t.dark ? t.colors.text : '#ffffff'}
          accessibilityLabel={field.label}
        />
      </View>
      <FieldError error={error} />
    </View>
  );
}

function SelectField({ field, value, error, disabled, onChange, multi }: FieldProps & { multi?: boolean }) {
  const t = useTheme();
  const c = t.colors;
  const options = optionsOf(field.prop);
  const selected = new Set<string>(multi ? (Array.isArray(value) ? value : []) : typeof value === 'string' ? [value] : []);
  const chips = options.length <= CHIP_MAX_OPTIONS && options.every((o) => !o.description && o.title.length <= CHIP_MAX_TITLE);

  const toggle = (optionValue: string) => {
    if (disabled) return;
    if (multi) {
      const next = selected.has(optionValue) ? [...selected].filter((v) => v !== optionValue) : [...selected, optionValue];
      onChange(next);
    } else {
      // tapping the chosen option again clears it, so an optional question can be left unanswered
      onChange(selected.has(optionValue) ? undefined : optionValue);
    }
  };

  return (
    <View style={{ gap: 8 }}>
      <FieldHeader field={field} />
      {options.length === 0 ? (
        <T variant="caption" color="textFaint">
          The agent offered no options for this field.
        </T>
      ) : chips ? (
        <View style={styles.chips}>
          {options.map((o) => (
            <Tap
              key={o.value}
              onPress={() => toggle(o.value)}
              disabled={disabled}
              accessibilityRole={multi ? 'checkbox' : 'radio'}
              accessibilityLabel={o.title}
              accessibilityState={{ checked: selected.has(o.value), disabled: !!disabled }}
              style={[
                styles.choice,
                {
                  borderRadius: t.radius.md,
                  borderColor: selected.has(o.value) ? c.accent : c.border,
                  backgroundColor: selected.has(o.value) ? c.accentSoft : c.surface,
                  opacity: disabled ? 0.6 : 1,
                },
              ]}
            >
              {selected.has(o.value) ? <Ionicons name="checkmark" size={17} color={c.accent} /> : null}
              <T variant="bodySmall" weight={selected.has(o.value) ? '600' : '400'} color={selected.has(o.value) ? 'accent' : 'text'}>
                {o.title}
              </T>
            </Tap>
          ))}
        </View>
      ) : (
        <View style={[styles.optionList, { borderColor: c.border, borderRadius: t.radius.md, backgroundColor: c.surface }]}>
          {options.map((o, i) => {
            const on = selected.has(o.value);
            return (
              <Tap
                key={o.value}
                onPress={() => toggle(o.value)}
                disabled={disabled}
                accessibilityRole={multi ? 'checkbox' : 'radio'}
                accessibilityState={{ checked: on, disabled: !!disabled }}
                accessibilityLabel={o.description ? `${o.title}. ${o.description}` : o.title}
                style={[
                  styles.optionRow,
                  i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border } : null,
                  on ? { backgroundColor: c.accentSoft } : null,
                ]}
              >
                <Ionicons
                  name={multi ? (on ? 'checkbox' : 'square-outline') : on ? 'radio-button-on' : 'radio-button-off'}
                  size={20}
                  color={on ? c.accent : c.textFaint}
                  style={{ marginTop: 1 }}
                />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <T variant="body" weight={on ? '600' : '400'}>
                    {o.title}
                  </T>
                  {o.description ? (
                    <T variant="bodySmall" color="textMuted">
                      {o.description}
                    </T>
                  ) : null}
                </View>
              </Tap>
            );
          })}
        </View>
      )}
      <FieldError error={error} />
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 24 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 10, minHeight: 44, borderWidth: 1 },
  optionList: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  optionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 12, paddingVertical: 11, minHeight: 44 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 48,
  },
});
