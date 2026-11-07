import { Redirect } from 'expo-router';
import React from 'react';
import { LoadingView, Screen } from '../src/components/ui';
import { isPaired, useSettings } from '../src/state/settings';

/** Entry: paired devices land on the tabs, everyone else on the pairing screen. */
export default function Index() {
  const hydrated = useSettings((s) => s.hydrated);
  const paired = useSettings((s) => isPaired(s));
  if (!hydrated) {
    return (
      <Screen style={{ justifyContent: 'center' }}>
        <LoadingView />
      </Screen>
    );
  }
  return <Redirect href={paired ? '/(tabs)' : '/(auth)/pair'} />;
}
