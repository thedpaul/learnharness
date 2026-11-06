/**
 * Sync switches (owner, 2026-11-06). Phone sync (pair a phone with a
 * computer by QR code, sync over the Wi-Fi) is on. Google Drive sync is
 * switched OFF while it needs a Google Cloud project per user: its engine,
 * Drive client, API actions and settings flow all stay in the tree, but
 * nothing runs or shows. Flip GOOGLE_SYNC_ENABLED to bring it back.
 */
export const SYNC_ENABLED = true;
export const GOOGLE_SYNC_ENABLED = false;
