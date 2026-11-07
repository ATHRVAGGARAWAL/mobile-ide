import React, { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import type { SessionSummary } from '@mobile-ide/core';
import { errorMessage } from '../../state/api';
import { toast } from '../../state/toast';
import { Button, Sheet, T, TextField } from '../ui';

export interface RenameSheetProps {
  session: SessionSummary | null;
  onClose: () => void;
  onSubmit: (sessionId: string, title: string) => Promise<void>;
}

const MAX_TITLE = 200;

/** Rename dialog: inline validation, sending state, error kept in place so the user can retry. */
export function RenameSheet({ session, onClose, onSubmit }: RenameSheetProps) {
  const [shown, setShown] = useState<SessionSummary | null>(session);
  const [title, setTitle] = useState(session?.title ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<TextInput>(null);

  useEffect(() => {
    if (session) {
      setShown(session);
      setTitle(session.title);
      setError(null);
      setSaving(false);
      // autoFocus on a Modal is unreliable on iOS; focus once the sheet has animated in
      const timer = setTimeout(() => input.current?.focus(), 320);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [session]);

  const s = shown;
  if (!s) return null;
  const trimmed = title.trim();
  const unchanged = trimmed === s.title.trim();
  const tooLong = trimmed.length > MAX_TITLE;
  const canSave = trimmed.length > 0 && !unchanged && !tooLong && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(s.id, trimmed);
      toast.success('Renamed');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      visible={session !== null}
      onClose={saving ? () => undefined : onClose}
      dismissable={!saving}
      title="Rename session"
      subtitle={`${s.agentName} · ${s.projectName}`}
      footer={
        <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end' }}>
          <Button title="Cancel" variant="secondary" onPress={onClose} disabled={saving} />
          <Button title="Save" onPress={() => void save()} disabled={!canSave} loading={saving} icon="checkmark" />
        </View>
      }
    >
      <View style={{ paddingVertical: 8, gap: 8 }}>
        <TextField
          ref={input}
          label="Title"
          value={title}
          onChangeText={setTitle}
          placeholder="What is this session about?"
          autoCapitalize="sentences"
          autoCorrect
          returnKeyType="done"
          onSubmitEditing={() => void save()}
          maxLength={MAX_TITLE + 20}
          error={error ?? (tooLong ? `Keep it under ${MAX_TITLE} characters` : null)}
          hint={`${trimmed.length}/${MAX_TITLE}`}
          editable={!saving}
        />
        {s.title ? (
          <T variant="caption" color="textFaint" numberOfLines={1}>
            Currently “{s.title}”
          </T>
        ) : null}
      </View>
    </Sheet>
  );
}
