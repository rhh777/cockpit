// 统一的细线图标(stroke=currentColor,size 由 props 控制)。
// 所有图标共享一套视觉语言:1.5px stroke、圆头圆角、24 viewBox、无填充。

type IconName =
  | 'bulb'
  | 'wrench'
  | 'folder'
  | 'search'
  | 'coin'
  | 'send'
  | 'sparkle'
  | 'close'
  | 'check'
  | 'copy'
  | 'file-text'
  | 'paperclip'
  | 'image'
  | 'arrow-up'
  | 'arrow-up-right'
  | 'claude'
  | 'codex'
  | 'clock'
  | 'chevron-right'
  | 'pin'
  | 'settings'
  | 'rotate-ccw'
  | 'users'
  | 'edit'
  | 'trash'
  | 'more-horizontal'

export function Icon({ name, size = 14, className }: { name: IconName; size?: number; className?: string }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  }
  switch (name) {
    case 'bulb':
      return (
        <svg {...common}>
          <path d="M9 18h6" />
          <path d="M10 21h4" />
          <path d="M12 3a6 6 0 0 0-4 10.5c.8.8 1.5 1.5 1.5 2.5v1h5v-1c0-1 .7-1.7 1.5-2.5A6 6 0 0 0 12 3Z" />
        </svg>
      )
    case 'wrench':
      return (
        <svg {...common}>
          <path d="M14.5 6.5a3.5 3.5 0 0 1 4.6 4.6l-9.7 9.7-4.6-4.6 9.7-9.7Z" />
          <path d="M13 8l3 3" />
        </svg>
      )
    case 'folder':
      return (
        <svg {...common}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
        </svg>
      )
    case 'search':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6" />
          <path d="m20 20-4.3-4.3" />
        </svg>
      )
    case 'coin':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M9.5 10.5h4M9.5 13.5h5M12 8v8" />
        </svg>
      )
    case 'send':
      return (
        <svg {...common}>
          <path d="M4 12 20 4l-6 16-3-7-7-1Z" />
        </svg>
      )
    case 'sparkle':
      return (
        <svg {...common}>
          <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
        </svg>
      )
    case 'close':
      return (
        <svg {...common}>
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      )
    case 'check':
      return (
        <svg {...common}>
          <path d="m5 12 5 5L20 7" />
        </svg>
      )
    case 'copy':
      return (
        <svg {...common}>
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
        </svg>
      )
    case 'file-text':
      return (
        <svg {...common}>
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
          <path d="M14 3v6h6" />
          <path d="M8 13h8M8 17h5" />
        </svg>
      )
    case 'paperclip':
      return (
        <svg {...common}>
          <path d="m21 11-8.8 8.8a5 5 0 0 1-7.1-7.1l9.2-9.2a3.4 3.4 0 0 1 4.8 4.8l-9.2 9.2a1.8 1.8 0 0 1-2.5-2.5L16 6.4" />
        </svg>
      )
    case 'image':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <circle cx="9" cy="10" r="1.5" />
          <path d="m7 17 4.5-4.5 3 3L16 14l3 3" />
        </svg>
      )
    case 'arrow-up':
      return (
        <svg {...common}>
          <path d="M12 19V5" />
          <path d="m6 11 6-6 6 6" />
        </svg>
      )
    case 'arrow-up-right':
      return (
        <svg {...common}>
          <path d="M7 17 17 7M9 7h8v8" />
        </svg>
      )
    case 'claude':
      // 八角星 — Claude/Anthropic 视觉里的 sparkle
      return (
        <svg {...common} fill="currentColor" stroke="none">
          <path d="M12 2c.3 3.4 1.3 5.3 2.8 6.6C16.3 9.9 18.3 10.7 22 12c-3.7 1.3-5.7 2.1-7.2 3.4C13.3 16.7 12.3 18.6 12 22c-.3-3.4-1.3-5.3-2.8-6.6C7.7 14.1 5.7 13.3 2 12c3.7-1.3 5.7-2.1 7.2-3.4C10.7 7.3 11.7 5.4 12 2Z" />
        </svg>
      )
    case 'codex':
      // 旋转方块 — Codex 标识感
      return (
        <svg {...common}>
          <path d="M12 3 21 12 12 21 3 12 12 3Z" />
          <path d="M12 8 16 12 12 16 8 12 12 8Z" />
        </svg>
      )
    case 'clock':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l2.5 2" />
        </svg>
      )
    case 'chevron-right':
      return (
        <svg {...common}>
          <path d="m9 6 6 6-6 6" />
        </svg>
      )
    case 'pin':
      return (
        <svg {...common}>
          <path d="M15 4l5 5-4 1-4.5 4.5.5 4.5-2 2-5-5 2-2 4.5.5L16 10l-1-6Z" />
          <path d="M9 15l-5 5" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.6-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 0 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1a2 2 0 0 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />
        </svg>
      )
    case 'rotate-ccw':
      return (
        <svg {...common}>
          <path d="M3 7v6h6" />
          <path d="M21 12a9 9 0 0 0-15.3-6.4L3 8" />
          <path d="M5 16a9 9 0 0 0 14 2" />
        </svg>
      )
    case 'users':
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3" />
          <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
          <path d="M16 11a3 3 0 1 0-.8-5.9" />
          <path d="M17 14.5a5 5 0 0 1 3.5 4.5" />
        </svg>
      )
    case 'edit':
      return (
        <svg {...common}>
          <path d="M4 20h4l10.5-10.5a2.8 2.8 0 0 0-4-4L4 16v4Z" />
          <path d="M13.5 6.5l4 4" />
        </svg>
      )
    case 'trash':
      return (
        <svg {...common}>
          <path d="M4 7h16" />
          <path d="M10 11v6M14 11v6" />
          <path d="M6 7l1 13h10l1-13" />
          <path d="M9 7V4h6v3" />
        </svg>
      )
    case 'more-horizontal':
      return (
        <svg {...common}>
          <circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      )
  }
}
