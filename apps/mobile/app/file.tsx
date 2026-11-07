/** File viewer route: /file?root=<project root>&path=<relative path>[&line=N]. */
import React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { FileViewer } from '../src/components/files';
import { EmptyState, Screen } from '../src/components/ui';
import { basename } from '../src/lib/format';

function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s ? s : undefined;
}

function parseLine(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export default function FileScreen() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const root = one(params.root);
  const path = one(params.path);
  const line = parseLine(one(params.line));

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/files');
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false, title: path ? basename(path) : 'File' }} />
      <Screen edges={['top']}>
        {root && path ? (
          <FileViewer key={`${root}:${path}`} root={root} path={path} line={line} onBack={goBack} />
        ) : (
          <EmptyState
            icon="document-outline"
            title="No file selected"
            message="Open a file from the Files tab, a search result, or a tool card."
            action={{ title: 'Browse files', onPress: () => router.replace('/(tabs)/files'), icon: 'folder-open-outline' }}
          />
        )}
      </Screen>
    </>
  );
}
