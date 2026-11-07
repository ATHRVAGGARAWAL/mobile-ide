import { router, usePathname } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { EmptyState, Screen } from '../src/components/ui';

export default function NotFound() {
  const pathname = usePathname();
  return (
    <Screen edges={['top', 'bottom']}>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <EmptyState
          icon="compass-outline"
          title="Nothing here"
          message={`“${pathname}” isn't a screen in this app. The link may be from a newer version.`}
          action={{ title: 'Go to sessions', icon: 'home-outline', onPress: () => router.replace('/') }}
        />
      </View>
    </Screen>
  );
}
