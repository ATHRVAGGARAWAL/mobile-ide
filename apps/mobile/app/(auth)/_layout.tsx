import { Stack } from 'expo-router';
import React from 'react';
import { useTheme } from '../../src/theme/ThemeProvider';

export default function AuthLayout() {
  const t = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.colors.bg } }} />;
}
