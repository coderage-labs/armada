import type { RoleMetadata } from '@coderage-labs/armada-shared';

export interface RoleColor {
  bg: string;
  stroke: string;
  glow: string;
  text: string;
}

const DEFAULT_COLOR: RoleColor = {
  bg: '#6b7280',
  stroke: '#9ca3af',
  glow: 'rgba(107,114,128,0.6)',
  text: 'text-gray-300',
};

/**
 * Convert a RoleMetadata hex color to the bg/stroke/glow/text format used by the UI.
 */
export function roleColorFromMeta(meta: RoleMetadata | undefined): RoleColor {
  if (!meta) return DEFAULT_COLOR;
  const hex = meta.color;
  // Parse hex to RGB for glow
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Lighten for stroke (mix with white ~30%)
  const lighten = (v: number) => Math.min(255, Math.round(v + (255 - v) * 0.3));
  const strokeHex = `#${lighten(r).toString(16).padStart(2, '0')}${lighten(g).toString(16).padStart(2, '0')}${lighten(b).toString(16).padStart(2, '0')}`;
  return {
    bg: hex,
    stroke: strokeHex,
    glow: `rgba(${r},${g},${b},0.6)`,
    text: 'text-gray-300',
  };
}

/**
 * Get tier from metadata, defaulting to 2 (leaf) if not found.
 */
export function getTierFromMeta(meta: RoleMetadata | undefined): number {
  return meta?.tier ?? 2;
}

export { DEFAULT_COLOR };
