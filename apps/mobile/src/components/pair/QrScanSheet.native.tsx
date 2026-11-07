/**
 * QR pairing scanner — native variant (iOS/Android). Full-screen camera with a viewfinder;
 * decodes the QR that `mide pair` prints (`https://<host>/pair#CODE` or `mobileide://pair?…`).
 *
 * `expo-camera` is loaded defensively: a dev client built before the module was added must not
 * crash the pairing screen — it just loses the Scan button (`qrScanSupported` false).
 */
import { Ionicons } from '@expo/vector-icons';
import type * as ExpoCamera from 'expo-camera';
import * as Linking from 'expo-linking';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { haptic } from '../../lib/haptics';
import { parsePairLink, type PairLinkParams } from '../../lib/links';
import { useTheme } from '../../theme/ThemeProvider';
import { Button, T } from '../ui';

export interface QrScanSheetProps {
  visible: boolean;
  onClose: () => void;
  /** called once with the parsed pairing link (server and/or code); the sheet closes itself */
  onScanned: (params: PairLinkParams) => void;
}

type CameraModule = typeof ExpoCamera;

const camera: CameraModule | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-camera') as CameraModule;
  } catch (err) {
    console.warn('[pair] expo-camera unavailable in this build; QR scanning disabled', err);
    return null;
  }
})();

/** True when this build can open a camera and decode a pairing QR. */
export const qrScanSupported: boolean = camera !== null;

type Permission = 'unknown' | 'granted' | 'denied' | 'blocked';

const FRAME = 240;

export function QrScanSheet({ visible, onClose, onScanned }: QrScanSheetProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [permission, setPermission] = useState<Permission>('unknown');
  const [torch, setTorch] = useState(false);
  const [ready, setReady] = useState(false);
  const [mountError, setMountError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const handled = useRef(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ask for camera access every time the sheet opens (cheap when already granted).
  useEffect(() => {
    if (!visible || !camera) return;
    handled.current = false;
    setReady(false);
    setMountError(null);
    setHint(null);
    setTorch(false);
    let cancelled = false;
    (async () => {
      try {
        let res = await camera.Camera.getCameraPermissionsAsync();
        if (!res.granted && res.canAskAgain) res = await camera.Camera.requestCameraPermissionsAsync();
        if (cancelled) return;
        setPermission(res.granted ? 'granted' : res.canAskAgain ? 'denied' : 'blocked');
      } catch (err) {
        console.warn('[pair] camera permission check failed', err);
        if (!cancelled) setPermission('denied');
      }
    })();
    return () => {
      cancelled = true;
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, [visible]);

  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => {
      setHint(null);
      handled.current = false;
    }, 1800);
  }, []);

  const onBarcode = useCallback(
    (result: ExpoCamera.BarcodeScanningResult) => {
      if (handled.current) return;
      handled.current = true;
      const parsed = parsePairLink(result.data);
      if (!parsed.code && !parsed.server) {
        void haptic.warning();
        showHint("That QR isn't a Mobile IDE pairing code. Scan the one printed by `mide pair`.");
        return;
      }
      void haptic.success();
      onScanned(parsed);
      onClose();
    },
    [onClose, onScanned, showHint],
  );

  const retryPermission = async () => {
    if (!camera) return;
    setPermission('unknown');
    try {
      const res = await camera.Camera.requestCameraPermissionsAsync();
      setPermission(res.granted ? 'granted' : res.canAskAgain ? 'denied' : 'blocked');
    } catch {
      setPermission('denied');
    }
  };

  if (!camera) return null;
  const CameraView = camera.CameraView;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.root, { backgroundColor: '#000' }]}>
        {permission === 'granted' ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            active={visible}
            enableTorch={torch}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onBarcode}
            onCameraReady={() => setReady(true)}
            onMountError={(e) => setMountError(e.message || 'The camera could not start.')}
          />
        ) : null}

        {/* dimmed frame around the viewfinder */}
        {permission === 'granted' && !mountError ? <Viewfinder ready={ready} accent={t.colors.accent} /> : null}

        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close scanner"
            hitSlop={8}
            style={({ pressed }) => [styles.roundButton, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Ionicons name="close" size={22} color="#fff" />
          </Pressable>
          <T style={styles.title}>Connect with a QR code</T>
          {permission === 'granted' ? (
            <Pressable
              onPress={() => setTorch((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel={torch ? 'Turn torch off' : 'Turn torch on'}
              accessibilityState={{ selected: torch }}
              hitSlop={8}
              style={({ pressed }) => [
                styles.roundButton,
                torch ? { backgroundColor: 'rgba(255,255,255,0.9)' } : null,
                { opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Ionicons name={torch ? 'flashlight' : 'flashlight-outline'} size={20} color={torch ? '#000' : '#fff'} />
            </Pressable>
          ) : (
            <View style={styles.roundButton} />
          )}
        </View>

        <View style={[styles.bottom, { paddingBottom: insets.bottom + 20 }]}>
          {permission === 'unknown' ? (
            <View style={styles.center}>
              <ActivityIndicator color="#fff" />
              <T style={styles.caption}>Waiting for camera access…</T>
            </View>
          ) : permission === 'granted' ? (
            mountError ? (
              <Card>
                <T style={styles.cardTitle}>Camera unavailable</T>
                <T style={styles.cardBody}>{mountError}</T>
                <Button title="Type the code instead" variant="secondary" onPress={onClose} full />
              </Card>
            ) : (
              <T style={[styles.caption, hint ? { color: t.colors.accent } : null]} align="center">
                {hint ?? 'Point the camera at the QR code that `mide pair` printed. It fills in the server and code for you.'}
              </T>
            )
          ) : (
            <Card>
              <T style={styles.cardTitle}>{permission === 'blocked' ? 'Camera access is off' : 'Camera access needed'}</T>
              <T style={styles.cardBody}>
                {permission === 'blocked'
                  ? 'Allow the camera for Mobile IDE in the system Settings, or type the code from `mide pair` instead.'
                  : 'The scanner needs the camera to read the pairing QR. You can always type the code instead.'}
              </T>
              <View style={{ gap: 8 }}>
                {permission === 'blocked' ? (
                  <Button title="Open Settings" icon="settings-outline" onPress={() => void Linking.openSettings().catch(() => {})} full />
                ) : (
                  <Button title="Allow camera" icon="camera-outline" onPress={() => void retryPermission()} full />
                )}
                <Button title="Type the code instead" variant="secondary" onPress={onClose} full />
              </View>
            </Card>
          )}
        </View>
      </View>
    </Modal>
  );
}

function Viewfinder({ ready, accent }: { ready: boolean; accent: string }) {
  const corner = (style: object) => <View style={[styles.corner, { borderColor: ready ? accent : '#fff' }, style]} />;
  return (
    <View pointerEvents="none" style={styles.finderWrap}>
      <View style={styles.finder}>
        {corner({ top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 14 })}
        {corner({ top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 14 })}
        {corner({ bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 14 })}
        {corner({ bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 14 })}
      </View>
    </View>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 12 },
  title: { flex: 1, color: '#fff', fontSize: 17, fontWeight: '600', textAlign: 'center' },
  roundButton: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  finderWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  finder: { width: FRAME, height: FRAME },
  corner: { position: 'absolute', width: 36, height: 36 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 24, alignItems: 'center' },
  center: { alignItems: 'center', gap: 10 },
  caption: { color: 'rgba(255,255,255,0.85)', fontSize: 14, lineHeight: 20, maxWidth: 340 },
  card: { width: '100%', maxWidth: 420, backgroundColor: 'rgba(26,28,25,0.96)', borderRadius: 16, padding: 18, gap: 10 },
  cardTitle: { color: '#fff', fontSize: 17, fontWeight: '600' },
  cardBody: { color: 'rgba(255,255,255,0.8)', fontSize: 14, lineHeight: 20, marginBottom: 6 },
});
