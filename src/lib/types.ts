// 前端只消费 NormalizedEvent / EventEnvelope(不变量 6)。type-only 复用 server 契约,
// 编译期擦除,不把 server 运行时代码打进 bundle。
export type {
  AgentName,
  ChatAttachment,
  EventEnvelope,
  LoaderWarning,
  NormalizedEvent,
  Origin,
  SessionDetail,
  SessionSummary,
  Source,
} from '../../server/loaders/types'

export type {
  ApprovalMode,
  ApprovalRequest,
  ApprovalStatus,
  Operation,
  RunPermissions,
} from '../../server/permissions/types'
