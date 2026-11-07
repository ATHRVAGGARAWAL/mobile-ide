/**
 * Two persistence backends behind one interface:
 *  - secureStorage: expo-secure-store on native, localStorage on web (token + server settings)
 *  - plainStorage:  AsyncStorage on native, localStorage on web (read markers, UI prefs)
 * Every call is guarded: a storage failure must never take the app down.
 */
import { Platform } from 'react-native';
import type { StateStorage } from 'zustand/middleware';

function webLocalStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      return (globalThis as unknown as { localStorage: Storage }).localStorage;
    }
  } catch {
    /* private mode / blocked */
  }
  return null;
}

function makeWebStorage(prefix: string): StateStorage {
  return {
    getItem: (name) => {
      try {
        return webLocalStorage()?.getItem(prefix + name) ?? null;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      try {
        webLocalStorage()?.setItem(prefix + name, value);
      } catch (err) {
        console.warn('[storage] setItem failed', err);
      }
    },
    removeItem: (name) => {
      try {
        webLocalStorage()?.removeItem(prefix + name);
      } catch {
        /* ignore */
      }
    },
  };
}

function makeSecureNativeStorage(): StateStorage {
  // Lazy require keeps the web bundle free of the native module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SecureStore = require('expo-secure-store') as typeof import('expo-secure-store');
  return {
    getItem: async (name) => {
      try {
        return await SecureStore.getItemAsync(name);
      } catch (err) {
        console.warn('[storage] secure getItem failed', err);
        return null;
      }
    },
    setItem: async (name, value) => {
      try {
        await SecureStore.setItemAsync(name, value);
      } catch (err) {
        console.warn('[storage] secure setItem failed', err);
      }
    },
    removeItem: async (name) => {
      try {
        await SecureStore.deleteItemAsync(name);
      } catch {
        /* ignore */
      }
    },
  };
}

function makePlainNativeStorage(): StateStorage {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AsyncStorage = (require('@react-native-async-storage/async-storage') as typeof import('@react-native-async-storage/async-storage')).default;
  return {
    getItem: async (name) => {
      try {
        return await AsyncStorage.getItem(name);
      } catch (err) {
        console.warn('[storage] getItem failed', err);
        return null;
      }
    },
    setItem: async (name, value) => {
      try {
        await AsyncStorage.setItem(name, value);
      } catch (err) {
        console.warn('[storage] setItem failed', err);
      }
    },
    removeItem: async (name) => {
      try {
        await AsyncStorage.removeItem(name);
      } catch {
        /* ignore */
      }
    },
  };
}

export const secureStorage: StateStorage = Platform.OS === 'web' ? makeWebStorage('mide.secure.') : makeSecureNativeStorage();
export const plainStorage: StateStorage = Platform.OS === 'web' ? makeWebStorage('mide.') : makePlainNativeStorage();
