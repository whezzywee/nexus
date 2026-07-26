import { brandPalette, productBrand } from "@nexus/branding";

export { productBrand };

export const desktopTokens = {
  railWidth: 68,
  sidebarWidth: 248,
  memberPanelWidth: 242,
  compactMessageGap: 7,
  comfortableMessageGap: 12,
  accent: brandPalette.violet,
  live: brandPalette.cyan,
} as const;
