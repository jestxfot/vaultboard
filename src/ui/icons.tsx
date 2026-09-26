// Простые иконки панели инструментов (контурные, 20×20).
import type { JSX } from 'solid-js';

const Svg = (props: { children: JSX.Element }) => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    {props.children}
  </svg>
);

export const IconSelect = () => <Svg><path d="M5 3l10 6.5-4.5 1L8.5 15z" /></Svg>;
export const IconSticky = () => <Svg><path d="M4 4h12v8l-4 4H4z" /><path d="M12 16v-4h4" /></Svg>;
export const IconText = () => <Svg><path d="M4 5V4h12v1M10 4v12M8 16h4" /></Svg>;
export const IconShapes = () => <Svg><rect x="3" y="9" width="8" height="8" rx="1" /><circle cx="13.5" cy="6.5" r="3.5" /></Svg>;
export const IconLine = () => <Svg><path d="M4 16L16 4M11 4h5v5" /></Svg>;
export const IconFrame = () => <Svg><path d="M6 3v14M14 3v14M3 6h14M3 14h14" /></Svg>;
export const IconUndo = () => <Svg><path d="M7 5L4 8l3 3" /><path d="M4 8h8a4 4 0 010 8H9" /></Svg>;
export const IconRedo = () => <Svg><path d="M13 5l3 3-3 3" /><path d="M16 8H8a4 4 0 000 8h3" /></Svg>;
export const IconTrash = () => <Svg><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" /></Svg>;
export const IconFront = () => <Svg><rect x="7" y="7" width="9" height="9" rx="1" fill="currentColor" fill-opacity=".25" /><path d="M4 12V4h8" /></Svg>;
export const IconBack = () => <Svg><rect x="4" y="4" width="9" height="9" rx="1" fill="currentColor" fill-opacity=".25" /><path d="M16 8v8H8" /></Svg>;
export const IconStraight = () => <Svg><path d="M4 16L16 4" /></Svg>;
export const IconCurve = () => <Svg><path d="M4 16C4 8 16 12 16 4" /></Svg>;
export const IconElbow = () => <Svg><path d="M4 16h6V4h6" /></Svg>;
export const IconArrowStart = () => <Svg><path d="M16 10H4M8 6l-4 4 4 4" /></Svg>;
export const IconArrowEnd = () => <Svg><path d="M4 10h12M12 6l4 4-4 4" /></Svg>;
export const IconPhoto = () => <Svg><rect x="3" y="4" width="14" height="12" rx="1.5" /><circle cx="7.5" cy="8.5" r="1.5" /><path d="M3 14l4-4 3 3 2-2 5 5" /></Svg>;
export const IconDoc = () => <Svg><path d="M5 3h7l3 3v11H5z" /><path d="M12 3v3h3M8 10h5M8 13h5" /></Svg>;
