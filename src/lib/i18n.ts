import { useEffect, useMemo, useState } from 'react'

export type LocalePreference = 'system' | 'en' | 'zh-CN'
export type ResolvedLocale = 'en' | 'zh-CN'

const LANGUAGE_KEY = 'cockpit.language'
export const LANGUAGE_CHANGED_EVENT = 'cockpit:language-changed'

const messages = {
  en: {
    'app.settings': 'Settings',
    'app.empty': 'Pick a session to see what the agent did',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.available': 'Available',
    'common.unavailable': 'Unavailable',
    'common.loading': 'Loading...',
    'common.detecting': 'Detecting...',
    'common.cliDefault': 'CLI default',
    'common.low': 'Low',
    'common.medium': 'Medium',
    'common.high': 'High',
    'common.xhigh': 'Extra high',
    'common.max': 'Max',
    'sessions.all': 'All',
    'sessions.groupChat': 'Group Chat',
    'sessions.unknownProject': 'Unknown Project',
    'sessions.today': 'Today',
    'sessions.yesterday': 'Yesterday',
    'sessions.last7Days': 'Last 7 days',
    'sessions.last30Days': 'Last 30 days',
    'sessions.older': 'Older',
    'sessions.deleteConfirm': 'Delete group chat "{{title}}"?',
    'sessions.renameGroup': 'Rename group chat',
    'sessions.deleteGroup': 'Delete group chat',
    'sessions.pin': 'Pin',
    'sessions.unpin': 'Unpin',
    'sessions.newChat': 'New Chat',
    'sessions.search': 'Search',
    'sessions.searchPlaceholder': 'Search title, project, agent, ID...',
    'sessions.loadFailed': 'Failed to load: {{error}}',
    'sessions.noMatches': 'No matches',
    'sessions.noSessions': 'No sessions yet',
    'sessions.emptyHint': 'Click "New Chat" to create a Cockpit group chat.',
    'sessions.recent': 'Recent',
    'sessions.grouping': 'Group by',
    'sessions.groupingLabel': 'Grouping mode',
    'sessions.byProject': 'Group by project',
    'sessions.byTime': 'Group by time',
    'sessions.project': 'Project',
    'sessions.time': 'Time',
    'sessions.showMore': 'Show more',
    'settings.title': 'Settings',
    'settings.subtitle': 'Local preferences and diagnostics',
    'settings.defaultModel': 'Default model',
    'settings.defaultReasoning': 'Default reasoning',
    'settings.detectionStatus': 'Detection status',
    'settings.retryDetection': 'Check again',
    'settings.detectingCli': 'Detecting {{agent}} CLI...',
    'settings.diagnosticsFailed': 'Diagnostics failed: {{error}}',
    'settings.connected': 'Connected',
    'settings.notDetected': 'Not detected',
    'settings.interface': 'Interface',
    'settings.theme': 'Theme',
    'settings.themeSystem': 'Follow system',
    'settings.themeLight': 'Light',
    'settings.themeDark': 'Dark',
    'settings.language': 'Language',
    'settings.languageSystem': 'System',
    'settings.languageEnglish': 'English',
    'settings.languageChinese': '简体中文',
    'settings.fontSize': 'Font size',
    'settings.fontSmall': 'Small',
    'settings.fontMedium': 'Standard',
    'settings.fontLarge': 'Large',
    'settings.fontXLarge': 'Larger',
    'settings.defaultFilter': 'Default filter',
    'settings.allSessions': 'All sessions',
    'settings.autoRefresh': 'Auto-refresh after opening a session',
    'settings.resetSidebar': 'Reset sidebar width',
    'settings.localData': 'Local data',
    'settings.refreshingPaths': 'Refreshing local paths...',
    'time.justNow': 'just now',
    'time.minutesAgo': '{{count}}m ago',
    'time.hoursAgo': '{{count}}h ago',
    'time.daysAgo': '{{count}}d ago',
    'time.weeksAgo': '{{count}}w ago',
    'time.monthsAgo': '{{count}}mo ago',
    'time.yearsAgo': '{{count}}y ago',
    'title.untitled': '(Untitled)',
    'jump.newTitle': 'New messages — click to view',
    'jump.new': 'New',
    'jump.toBottom': 'Back to bottom',
    'warnings.summary': 'Some events could not be parsed ({{count}})',
    'warnings.atLine': 'line {{line}} ',
    'agent.select': 'Select agent',
    'patch.emptyFile': '(empty file)',
    'tool.emptyOutput': '(empty)',
    'tool.result': 'Result',
    'tool.resultError': 'Result (error)',
    'tool.noResult': '(no result / unpaired)',
    'markdown.collapse': 'Collapse',
    'markdown.fullLength': 'Full text: {{count}} characters',
    'markdown.expandRest': 'Show remaining {{count}} characters',
    'trace.title': 'Agent execution detail and reasoning trace',
    'trace.subtitle': 'Turn: {{turn}}... · {{thinking}} reasoning steps, {{calls}} tool calls',
    'trace.close': 'Close drawer (Esc)',
    'trace.thinkingStep': 'Reasoning step #{{index}}',
    // 句中要嵌一个 <code>signature</code> 元素,拆成 pre/post 两段比在模板里塞占位符再切字符串清楚。
    'trace.encryptedReasoningPre': 'Encrypted reasoning, no plaintext — Claude only wrote a ',
    'trace.encryptedReasoningPost': ' field to the JSONL and never exposed the reasoning text to clients.',
    'trace.toolCall': 'Tool call #{{index}}',
    'trace.viewRunDetail': 'Click to view run detail',
    'trace.thinkingCount': '{{count}} reasoning steps',
    'trace.errorCount': '{{count}} errors',
    'trace.view': 'View →',
    'narrative.empty': 'No events yet',
    'narrative.you': 'You',
    'narrative.eventCount': '{{count}} events',
    'narrative.openTrace': 'Open trace drawer',
    'narrative.viewFullTrace': 'View full trace',
    'verb.runTests': 'ran tests',
    'verb.testsFailed': 'failures',
    'verb.testsPassed': 'passed',
    'verb.readWrite': 'read & edited',
    'verb.readWriteObject': 'read {{read}}, edited {{write}} files{{diff}}',
    'verb.write': 'edited',
    'verb.writeObject': '{{count}} files{{diff}}',
    'verb.analyze': 'analyzed',
    'verb.review': 'reviewed',
    'verb.fileCount': '{{count}} files',
    'verb.runCommands': 'ran commands',
    'verb.commandCount': '{{count}} commands',
    'verb.think': 'thought',
    'verb.stepCount': '{{count}} steps',
    'verb.reply': 'replied',
  },
  'zh-CN': {
    'app.settings': '设置',
    'app.empty': '选个 session,看看 agent 干了什么',
    'common.save': '保存',
    'common.cancel': '取消',
    'common.close': '关闭',
    'common.available': '可用',
    'common.unavailable': '不可用',
    'common.loading': '加载中...',
    'common.detecting': '检测中...',
    'common.cliDefault': 'CLI 默认',
    'common.low': '低',
    'common.medium': '中',
    'common.high': '高',
    'common.xhigh': '超高',
    'common.max': '极致',
    'sessions.all': '全部',
    'sessions.groupChat': '群聊',
    'sessions.unknownProject': '未知项目',
    'sessions.today': '今天',
    'sessions.yesterday': '昨天',
    'sessions.last7Days': '最近 7 天',
    'sessions.last30Days': '最近 30 天',
    'sessions.older': '更早',
    'sessions.deleteConfirm': '删除群聊“{{title}}”？',
    'sessions.renameGroup': '重命名群聊',
    'sessions.deleteGroup': '删除群聊',
    'sessions.pin': '置顶',
    'sessions.unpin': '取消置顶',
    'sessions.newChat': '新对话',
    'sessions.search': '搜索',
    'sessions.searchPlaceholder': '搜索标题、项目、agent、ID...',
    'sessions.loadFailed': '加载失败:{{error}}',
    'sessions.noMatches': '没有匹配结果',
    'sessions.noSessions': '还没有会话',
    'sessions.emptyHint': '点“新对话”创建 Cockpit 群聊。',
    'sessions.recent': '最近活跃',
    'sessions.grouping': '分组',
    'sessions.groupingLabel': '分组方式',
    'sessions.byProject': '按项目分组',
    'sessions.byTime': '按时间分组',
    'sessions.project': '项目',
    'sessions.time': '时间',
    'sessions.showMore': '展开显示',
    'settings.title': '设置',
    'settings.subtitle': '本机偏好和诊断信息',
    'settings.defaultModel': '默认模型',
    'settings.defaultReasoning': '默认推理',
    'settings.detectionStatus': '检测状态',
    'settings.retryDetection': '重新检测',
    'settings.detectingCli': '正在检测 {{agent}} CLI...',
    'settings.diagnosticsFailed': '诊断失败:{{error}}',
    'settings.connected': '已连接',
    'settings.notDetected': '未检测到',
    'settings.interface': '界面',
    'settings.theme': '主题',
    'settings.themeSystem': '跟随系统',
    'settings.themeLight': '浅色',
    'settings.themeDark': '深色',
    'settings.language': '语言',
    'settings.languageSystem': '跟随系统',
    'settings.languageEnglish': 'English',
    'settings.languageChinese': '简体中文',
    'settings.fontSize': '字体大小',
    'settings.fontSmall': '小',
    'settings.fontMedium': '标准',
    'settings.fontLarge': '大',
    'settings.fontXLarge': '更大',
    'settings.defaultFilter': '默认过滤',
    'settings.allSessions': '全部 session',
    'settings.autoRefresh': '打开 session 后自动刷新',
    'settings.resetSidebar': '重置侧栏宽度',
    'settings.localData': '本机数据',
    'settings.refreshingPaths': '正在刷新本机路径...',
    'time.justNow': '刚刚',
    'time.minutesAgo': '{{count}}分钟前',
    'time.hoursAgo': '{{count}}小时前',
    'time.daysAgo': '{{count}}天前',
    'time.weeksAgo': '{{count}}周前',
    'time.monthsAgo': '{{count}}个月前',
    'time.yearsAgo': '{{count}}年前',
    'title.untitled': '(无标题)',
    'jump.newTitle': '有新消息,点击查看',
    'jump.new': '新消息',
    'jump.toBottom': '回到底部',
    'warnings.summary': '部分事件未能解析 ({{count}})',
    'warnings.atLine': '行 {{line}} ',
    'agent.select': '选择 agent',
    'patch.emptyFile': '(空文件)',
    'tool.emptyOutput': '(空)',
    'tool.result': '结果',
    'tool.resultError': '结果(错误)',
    'tool.noResult': '(无结果 / 未配对)',
    'markdown.collapse': '收起',
    'markdown.fullLength': '完整 {{count}} 字符',
    'markdown.expandRest': '展开剩余 {{count}} 字符',
    'trace.title': 'Agent 执行细节与思维轨迹',
    'trace.subtitle': '轮次: {{turn}}... · 共 {{thinking}} 步思考, {{calls}} 次工具调用',
    'trace.close': '关闭抽屉 (Esc)',
    'trace.thinkingStep': '思考进程 #{{index}}',
    'trace.encryptedReasoningPre': '加密 reasoning,无明文 —— Claude 仅在 JSONL 里写了 ',
    'trace.encryptedReasoningPost': ',没有把推理文字暴露给客户端。',
    'trace.toolCall': '工具调用 #{{index}}',
    'trace.viewRunDetail': '点击查看运行细节',
    'trace.thinkingCount': '{{count}} 次思考',
    'trace.errorCount': '{{count}} 个错误',
    'trace.view': '查看 →',
    'narrative.empty': '还没有事件',
    'narrative.you': '你',
    'narrative.eventCount': '{{count}} 事件',
    'narrative.openTrace': '打开轨迹抽屉',
    'narrative.viewFullTrace': '查看完整轨迹',
    'verb.runTests': '跑测试',
    'verb.testsFailed': '有错',
    'verb.testsPassed': '通过',
    'verb.readWrite': '读改',
    'verb.readWriteObject': '读 {{read}},改 {{write}} 文件{{diff}}',
    'verb.write': '改',
    'verb.writeObject': '{{count}} 个文件{{diff}}',
    'verb.analyze': '分析',
    'verb.review': '查阅',
    'verb.fileCount': '{{count}} 个文件',
    'verb.runCommands': '跑命令',
    'verb.commandCount': '{{count}} 条',
    'verb.think': '思考',
    'verb.stepCount': '{{count}} 步',
    'verb.reply': '回复',
  },
} as const

export type MessageKey = keyof typeof messages.en

function interpolate(template: string, values?: Record<string, string | number>) {
  if (!values) return template
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key] ?? ''))
}

function resolveSystemLocale(): ResolvedLocale {
  const langs = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]
  return langs.some((lang) => lang.toLowerCase().startsWith('zh')) ? 'zh-CN' : 'en'
}

export function resolveLocale(preference = readLanguagePreference()): ResolvedLocale {
  return preference === 'system' ? resolveSystemLocale() : preference
}

export function readLanguagePreference(): LocalePreference {
  const value = localStorage.getItem(LANGUAGE_KEY)
  return value === 'en' || value === 'zh-CN' ? value : 'system'
}

export function applyLanguagePreference(preference = readLanguagePreference()) {
  document.documentElement.lang = resolveLocale(preference)
}

export function setLanguagePreference(preference: LocalePreference) {
  localStorage.setItem(LANGUAGE_KEY, preference)
  applyLanguagePreference(preference)
  window.dispatchEvent(new Event(LANGUAGE_CHANGED_EVENT))
}

export function translate(
  key: MessageKey,
  values?: Record<string, string | number>,
  locale: ResolvedLocale = resolveLocale(),
): string {
  return interpolate(messages[locale][key] ?? messages.en[key] ?? key, values)
}

export function useI18n() {
  const [preference, setPreference] = useState<LocalePreference>(() => readLanguagePreference())

  useEffect(() => {
    applyLanguagePreference(preference)
  }, [preference])

  useEffect(() => {
    const onChange = () => setPreference(readLanguagePreference())
    window.addEventListener(LANGUAGE_CHANGED_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(LANGUAGE_CHANGED_EVENT, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])

  const locale = resolveLocale(preference)
  const t = useMemo(
    () => (key: MessageKey, values?: Record<string, string | number>) => translate(key, values, locale),
    [locale],
  )

  return { locale, preference, setLanguagePreference, t }
}
