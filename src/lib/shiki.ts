// 共享 shiki 高亮器:全 app 一个实例,语言按需懒加载,避免每个 <CodeBlock> 都重建一个 wasm。
// 参考 shiki v1 文档 getSingletonHighlighter。
import { getSingletonHighlighter, type Highlighter } from 'shiki'

// 预热常用语言:第一次出现这些 lang 不必再走异步 loadLanguage。
// 其它 lang 在 highlight() 第一次遇到时按需加载;失败就退回纯文本。
const PRELOAD_LANGS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'bash',
  'shell',
  'python',
  'rust',
  'go',
  'sql',
  'yaml',
  'toml',
  'html',
  'css',
  'md',
  'diff',
] as const

// 同时载入亮 / 暗两套主题,前端按 prefers-color-scheme 选 class。
const THEMES = ['github-light', 'github-dark'] as const

let highlighterPromise: Promise<Highlighter> | null = null

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = getSingletonHighlighter({
      themes: [...THEMES],
      langs: [...PRELOAD_LANGS],
    })
  }
  return highlighterPromise
}

// shiki 用的语言别名:把 markdown 围栏里常见的别名映射回 shiki 认识的 id,
// 命中不了就返回原值让 shiki 自己抛错(我们外层 catch 后会退回纯文本)。
const LANG_ALIAS: Record<string, string> = {
  sh: 'bash',
  zsh: 'bash',
  console: 'bash',
  shellscript: 'bash',
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  rs: 'rust',
  yml: 'yaml',
  text: 'txt',
  plaintext: 'txt',
}

const loadedLangs = new Set<string>([...PRELOAD_LANGS])

export async function highlightToHtml(code: string, lang: string | undefined): Promise<string | null> {
  const hl = await getHighlighter()
  const resolved = lang ? (LANG_ALIAS[lang] ?? lang).toLowerCase() : ''
  if (!resolved || resolved === 'txt') return null // 不高亮纯文本,省一次 DOM 替换

  try {
    if (!loadedLangs.has(resolved)) {
      // shiki 的 loadLanguage 接受内置语言 id;不存在就 throw,我们捕获后退回纯文本。
      await hl.loadLanguage(resolved as Parameters<Highlighter['loadLanguage']>[0])
      loadedLangs.add(resolved)
    }
    return hl.codeToHtml(code, {
      lang: resolved,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false, // 同时输出两套 CSS 变量,前端按主题切换
    })
  } catch {
    return null
  }
}
