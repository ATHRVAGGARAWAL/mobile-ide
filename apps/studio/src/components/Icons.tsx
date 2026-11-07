/** Inline 24-grid stroke icons (lucide-style paths), sized by `size`, coloured by `currentColor`. */
import type { SVGProps } from 'react';

type IconName =
  | 'file'
  | 'folder'
  | 'folder-open'
  | 'chevron-right'
  | 'chevron-down'
  | 'search'
  | 'terminal'
  | 'pencil'
  | 'eye'
  | 'play'
  | 'square'
  | 'check'
  | 'x'
  | 'sparkles'
  | 'send'
  | 'sun'
  | 'moon'
  | 'command'
  | 'git-branch'
  | 'alert'
  | 'refresh'
  | 'save'
  | 'panel-left'
  | 'panel-right'
  | 'crosshair'
  | 'brain'
  | 'globe'
  | 'list'
  | 'trash'
  | 'move'
  | 'hand'
  | 'link'
  | 'plus'
  | 'radio'
  | 'zap'
  | 'phone';

const PATHS: Record<IconName, string> = {
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  folder: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2',
  'folder-open':
    'M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2',
  'chevron-right': 'm9 18 6-6-6-6',
  'chevron-down': 'm6 9 6 6 6-6',
  search: 'm21 21-4.34-4.34M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14',
  terminal: 'M12 19h8M4 17l6-6-6-6',
  pencil: 'M21.17 6.83a2.83 2.83 0 0 0-4-4L4 16v4h4zM15 5l4 4',
  eye: 'M2.06 12.35a1 1 0 0 1 0-.7C3.42 8.55 7.36 5 12 5s8.58 3.55 9.94 6.65a1 1 0 0 1 0 .7C20.58 15.45 16.64 19 12 19S3.42 15.45 2.06 12.35M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  play: 'M6 4v16l14-8z',
  square: 'M5 5h14v14H5z',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  sparkles:
    'M9.9 2.8 11.3 6.6l3.8 1.4-3.8 1.4L9.9 13.2 8.5 9.4 4.7 8l3.8-1.4zM18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9zM5 15l.6 1.4L7 17l-1.4.6L5 19l-.6-1.4L3 17l1.4-.6z',
  send: 'M14.5 9.5 21 3m0 0-6.5 18-3.5-7.5L3 10z',
  sun: 'M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9',
  command: 'M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3',
  'git-branch': 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 9a9 9 0 0 1-9 9',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  save: 'M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7M7 3v4a1 1 0 0 0 1 1h7',
  'panel-left': 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 3v18',
  'panel-right': 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM15 3v18',
  crosshair: 'M12 2v4m0 12v4M2 12h4m12 0h4M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16',
  brain:
    'M12 5a3 3 0 1 0-5.99.14A4 4 0 0 0 4.5 12.5 4 4 0 0 0 6 20a3 3 0 0 0 6-1V5zM12 5a3 3 0 1 1 5.99.14A4 4 0 0 1 19.5 12.5 4 4 0 0 1 18 20a3 3 0 0 1-6-1',
  globe:
    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
  move: 'M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20',
  hand: 'M18 11V6a2 2 0 0 0-4 0v1M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  plus: 'M12 5v14M5 12h14',
  radio:
    'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4M4.9 19.1a10 10 0 0 1 0-14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M19.1 4.9a10 10 0 0 1 0 14.2',
  zap: 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z',
  phone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 18h.01',
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export type { IconName };
