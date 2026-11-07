/**
 * QR pairing scanner — web/default variant. There is no in-app scanner on the web: a QR from
 * `mide pair` encodes an `https://…/pair#CODE` link, so the phone's own camera app opens it
 * directly in the browser (and this screen prefills from the URL). The native app gets a real
 * camera view from `QrScanSheet.native.tsx`; both files export the same surface.
 */
import type { PairLinkParams } from '../../lib/links';

export interface QrScanSheetProps {
  visible: boolean;
  onClose: () => void;
  /** called once with the parsed pairing link (server and/or code); the sheet closes itself */
  onScanned: (params: PairLinkParams) => void;
}

/** True when this build can open a camera and decode a pairing QR. */
export const qrScanSupported = false;

export function QrScanSheet(_props: QrScanSheetProps): null {
  return null;
}
