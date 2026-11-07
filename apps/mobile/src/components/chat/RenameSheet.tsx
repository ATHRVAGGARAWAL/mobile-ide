import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Button, Sheet, TextField } from '../ui';
import { errorMessage } from '../../state/api';

export interface RenameSheetProps {
  visible: boolean;
  title: string;
  onClose: () => void;
  onSave: (title: string) => Promise<void>;
}

const MAX_TITLE = 200;

export function RenameSheet({ visible, title, onClose, onSave }: RenameSheetProps) {
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setValue(title);
      setError(null);
    }
  }, [visible, title]);

  const save = async () => {
    const next = value.trim();
    if (!next) {
      setError('Give the session a name.');
      return;
    }
    if (next === title) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Rename session"
      footer={
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button title="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} disabled={saving} />
          <Button title="Save" onPress={save} loading={saving} style={{ flex: 1 }} />
        </View>
      }
    >
      <View style={{ paddingVertical: 4 }}>
        <TextField
          value={value}
          onChangeText={(v) => {
            setValue(v);
            if (error) setError(null);
          }}
          placeholder="Session title"
          autoFocus
          autoCapitalize="sentences"
          autoCorrect
          maxLength={MAX_TITLE}
          returnKeyType="done"
          onSubmitEditing={save}
          error={error}
          hint={`${value.trim().length}/${MAX_TITLE}`}
        />
      </View>
    </Sheet>
  );
}
