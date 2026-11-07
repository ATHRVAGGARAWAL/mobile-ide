import * as Clipboard from 'expo-clipboard';

export async function copyText(text: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
    return true;
  } catch (err) {
    console.warn('[clipboard] copy failed', err);
    return false;
  }
}
