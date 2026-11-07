/**
 * Permissions UI contract (see docs/WORKSPLIT.md, M4):
 *  - PermissionCard({ request, resolved?, sessionTitle?, onPress, compact? })
 *  - PermissionSheet({ request | null, onClose }) — answers via useSessions.respondPermission
 */
export { PermissionCard, type PermissionCardProps } from './PermissionCard';
export { PermissionSheet, type PermissionSheetProps } from './PermissionSheet';
export * from './permissionUtils';
