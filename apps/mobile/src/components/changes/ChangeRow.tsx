import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/ThemeProvider';
import { PathText } from '../files/PathText';
import { truncatePathMiddle } from '../files/pathFormat';
import { T, Tap } from '../ui';
import { toneColors, type ChangeItem } from './statusModel';

/** One changed path: status letter badge, middle-truncated path (dir muted, name bold), rename origin, chevron. */
export function ChangeRow({ item, onPress }: { item: ChangeItem; onPress: () => void }) {
  const t = useTheme();
  const col = toneColors(item.tone, t);
  const renamedFrom = item.entry.renamedFrom;
  const from = renamedFrom ? truncatePathMiddle(renamedFrom, 40) : null;
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.label} ${item.entry.path}. Show diff`}
      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14, minHeight: 72, gap: 12 }}
      testID={`change-${item.area}-${item.entry.path}`}
    >
      <View style={{ width: 34, height: 36, borderRadius: 10, backgroundColor: col.bg, alignItems: 'center', justifyContent: 'center' }}>
        <T style={{ color: col.fg, fontWeight: '700', fontSize: 13, fontFamily: t.font.mono }}>{item.code}</T>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <PathText path={item.entry.path} variant="mono" emphasizeBase accessibilityLabel={item.entry.path} />
        <T variant="caption" color="textMuted" numberOfLines={1} style={{ marginTop: 2 }}>
          {from ? `${item.label} from ${from.dir}${from.base}` : item.label}
        </T>
      </View>
      <Ionicons name="chevron-forward" size={18} color={t.colors.textFaint} />
    </Tap>
  );
}
