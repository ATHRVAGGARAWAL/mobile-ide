import { View } from 'react-native';
import type { GitLogEntry } from '@mobile-ide/core';
import { relativeTime } from '../../lib/format';
import { useTheme } from '../../theme/ThemeProvider';
import { T, Tap } from '../ui';
import { commitDateMs } from './statusModel';

export function CommitRow({ commit, now, onPress }: { commit: GitLogEntry; now: number; onPress?: () => void }) {
  const t = useTheme();
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Commit ${commit.shortHash}: ${commit.subject}. Copy hash`}
      style={{ flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 16, paddingVertical: 16, gap: 12, minHeight: 76 }}
    >
      <View
        style={{
          paddingHorizontal: 7,
          height: 22,
          borderRadius: 6,
          backgroundColor: t.colors.surfaceAlt,
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 1,
        }}
      >
        <T variant="monoSmall" color="textMuted">
          {commit.shortHash}
        </T>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T variant="bodySmall" weight="500" numberOfLines={2}>
          {commit.subject}
        </T>
        <T variant="caption" color="textMuted" numberOfLines={1} style={{ marginTop: 2 }}>
          {commit.author} · {relativeTime(commitDateMs(commit.date), now)}
        </T>
      </View>
    </Tap>
  );
}
