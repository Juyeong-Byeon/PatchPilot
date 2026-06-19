export type Locale = "ko" | "en";

export const localeNames: Record<Locale, string> = {
  ko: "한국어",
  en: "English"
};

export const adminCopy = {
  ko: {
    documentTitle: "티켓-PR 운영 관리자",
    appEyebrow: "관리자 콘솔",
    appTitle: "티켓-PR 운영",
    tokenLabel: "관리자 인증키",
    tokenPlaceholder: "인증키를 입력하세요",
    apply: "적용",
    refresh: "새로고침",
    ready: "준비됨",
    enterToken: "관리자 인증키를 입력하면 작업을 불러옵니다.",
    tokenRequired: "관리자 인증키를 입력하세요.",
    tokenInvalid: "관리자 인증키가 올바르지 않습니다.",
    apiUnavailable: "관리자 API에 연결할 수 없습니다. 서버 연결 상태를 확인하세요.",
    totalJobs: "전체 작업",
    runningJobs: "실행 중",
    failedJobs: "실패",
    completedJobs: "완료",
    loadedJobs: (count: number) => `작업 ${count}개를 불러왔습니다.`,
    refreshFailed: "작업 새로고침 실패",
    retryQueued: (attempt: number) => `${attempt}번째 시도로 재실행을 예약했습니다.`,
    cancelRequested: (phase: string) => `취소 요청됨: ${phase}`,
    jobs: "작업",
    loading: "불러오는 중",
    filterJobsLabel: "작업 필터",
    filterJobsPlaceholder: "작업, 저장소, 브랜치 검색",
    jobsSubtitle: "목록에서는 핵심 상태만 보고, 상세에서 실행 흐름을 확인합니다.",
    backToJobs: "목록",
    tableUpdated: "시각",
    tableJob: "작업",
    tableOutcome: "결과",
    tablePhase: "단계",
    tableRepo: "저장소",
    tableBranch: "브랜치",
    tableRuntime: "실행 시간",
    tableLastEvent: "최근 이벤트",
    tablePr: "PR",
    tableAction: "동작",
    openJobDetail: "상세",
    openPr: "열기",
    noJobMatches: "현재 필터와 일치하는 작업이 없습니다.",
    jobDetail: "작업 상세",
    loadingDetail: "작업 상세를 불러오는 중입니다.",
    selectJob: "검토할 작업을 선택하세요.",
    retry: "재시도",
    retrying: "재시도 중",
    cancel: "취소",
    cancelling: "취소 중",
    repository: "저장소",
    target: "대상",
    workBranch: "작업 브랜치",
    priority: "우선순위",
    attempt: "시도",
    updated: "업데이트",
    failureSummary: "실패 요약",
    failure: "실패",
    nextAction: "다음 조치",
    artifacts: "아티팩트",
    inlineContent: "인라인 콘텐츠",
    noArtifacts: "기록된 아티팩트가 없습니다.",
    stepGraph: "처리 단계 그래프",
    stepGraphSummary: "GitHub Actions처럼 작업 흐름을 단계별 노드로 확인합니다.",
    stepWaitingForSignal: "아직 기록된 신호가 없습니다.",
    stepSkipped: "건너뜀",
    runTimeline: "실행 타임라인",
    traceFlow: "실행 흐름",
    traceFlowSummary: "단계별 span으로 병목과 실패 지점을 확인합니다.",
    traceColumnIndex: "#",
    traceColumnStage: "단계",
    traceColumnStatus: "상태",
    traceColumnService: "서비스",
    traceColumnEvents: "이벤트",
    traceColumnDuration: "시간",
    service: "서비스",
    eventLog: "이벤트 로그",
    spanFailurePoint: "실패 지점",
    spanActive: "진행 중",
    spanComplete: "완료",
    spanPending: "대기",
    spanEvents: (count: number) => `${count} 이벤트`,
    spanNoEvents: "이벤트 없음",
    noEvents: "기록된 이벤트가 없습니다.",
    sourceSystem: "시스템",
    logs: "로그",
    correlatedLogs: "연결된 로그",
    clear: "해제",
    logDefaultStream: "로그",
    redacted: "마스킹됨",
    allSources: "전체 소스",
    filterLogsLabel: "로그 소스 필터",
    searchLogsLabel: "로그 검색",
    searchLogsPlaceholder: "로그 검색",
    copy: "복사",
    download: "다운로드",
    noLogs: "기록된 로그가 없습니다.",
    unknown: "알 수 없음",
    empty: "-"
  },
  en: {
    documentTitle: "Ticket-to-PR Operations",
    appEyebrow: "Admin Console",
    appTitle: "Ticket-to-PR Operations",
    tokenLabel: "Admin Access Key",
    tokenPlaceholder: "Enter access key",
    apply: "Apply",
    refresh: "Refresh",
    ready: "Ready",
    enterToken: "Enter the admin access key to load jobs.",
    tokenRequired: "Enter the admin access key.",
    tokenInvalid: "The admin access key is not valid.",
    apiUnavailable: "Cannot connect to the admin API. Check the server connection.",
    totalJobs: "Total Jobs",
    runningJobs: "Running",
    failedJobs: "Failed",
    completedJobs: "Completed",
    loadedJobs: (count: number) => `Loaded ${count} job${count === 1 ? "" : "s"}.`,
    refreshFailed: "Job refresh failed",
    retryQueued: (attempt: number) => `Retry queued as attempt ${attempt}.`,
    cancelRequested: (phase: string) => `Cancel requested: ${phase}`,
    jobs: "Jobs",
    loading: "Loading",
    filterJobsLabel: "Filter jobs",
    filterJobsPlaceholder: "Filter job, repo, branch",
    jobsSubtitle: "Review core job status here, then open detail for runtime flow.",
    backToJobs: "Jobs",
    tableUpdated: "Time",
    tableJob: "Job",
    tableOutcome: "Outcome",
    tablePhase: "Phase",
    tableRepo: "Repo",
    tableBranch: "Branch",
    tableRuntime: "Runtime",
    tableLastEvent: "Last Event",
    tablePr: "PR",
    tableAction: "Action",
    openJobDetail: "Detail",
    openPr: "Open",
    noJobMatches: "No jobs match the current filter.",
    jobDetail: "Job Detail",
    loadingDetail: "Loading job detail...",
    selectJob: "Select a job to inspect runtime state.",
    retry: "Retry",
    retrying: "Retrying",
    cancel: "Cancel",
    cancelling: "Cancelling",
    repository: "Repository",
    target: "Target",
    workBranch: "Work Branch",
    priority: "Priority",
    attempt: "Attempt",
    updated: "Updated",
    failureSummary: "Failure Summary",
    failure: "Failure",
    nextAction: "Next Action",
    artifacts: "Artifacts",
    inlineContent: "inline content",
    noArtifacts: "No artifacts recorded.",
    stepGraph: "Step Graph",
    stepGraphSummary: "Review the run as GitHub Actions-style step nodes.",
    stepWaitingForSignal: "No signal recorded yet.",
    stepSkipped: "Skipped",
    runTimeline: "Run Timeline",
    traceFlow: "Trace Flow",
    traceFlowSummary: "Inspect bottlenecks and failure points as phase spans.",
    traceColumnIndex: "#",
    traceColumnStage: "Stage",
    traceColumnStatus: "Status",
    traceColumnService: "Service",
    traceColumnEvents: "Events",
    traceColumnDuration: "Duration",
    service: "Service",
    eventLog: "Event Log",
    spanFailurePoint: "Failure point",
    spanActive: "Running",
    spanComplete: "Complete",
    spanPending: "Waiting",
    spanEvents: (count: number) => `${count} event${count === 1 ? "" : "s"}`,
    spanNoEvents: "No events",
    noEvents: "No events recorded.",
    sourceSystem: "system",
    logs: "Logs",
    correlatedLogs: "Correlated Logs",
    clear: "Clear",
    logDefaultStream: "log",
    redacted: "redacted",
    allSources: "All sources",
    filterLogsLabel: "Filter logs by source",
    searchLogsLabel: "Search logs",
    searchLogsPlaceholder: "Search logs",
    copy: "Copy",
    download: "Download",
    noLogs: "No logs recorded.",
    unknown: "Unknown",
    empty: "-"
  }
} as const;

const stateLabels: Record<Locale, Record<string, string>> = {
  ko: {
    Queued: "대기",
    Planning: "계획",
    Implementing: "구현",
    PolicyChecking: "정책 검사",
    Publishing: "게시",
    Completed: "완료",
    Failed: "실패",
    CancelRequested: "취소 요청",
    Cancelled: "취소됨",
    CancelFailed: "취소 실패",
    NeedsReview: "검토 필요",
    Running: "실행 중",
    FailedInternal: "내부 실패",
    FailedActionable: "조치 필요 실패"
  },
  en: {}
};

export type AdminCopy = (typeof adminCopy)[Locale];

export function getInitialLocale(): Locale {
  try {
    const stored = window.localStorage.getItem("ADMIN_LOCALE");
    return stored === "en" || stored === "ko" ? stored : "ko";
  } catch {
    return "ko";
  }
}

export function storeLocale(locale: Locale): void {
  try {
    window.localStorage.setItem("ADMIN_LOCALE", locale);
  } catch {
    // The in-memory locale state is still usable when storage is blocked.
  }
}

export function translateState(value: unknown, locale: Locale): string {
  if (value === null || value === undefined || value === "") return adminCopy[locale].empty;
  const text = String(value);
  return stateLabels[locale][text] ?? text;
}

const eventTypeLabels: Record<Locale, Record<string, string>> = {
  ko: {
    "job.enqueued": "작업 대기열 등록",
    "worker.started": "작업자 시작",
    "worker.completed": "작업자 완료",
    "worker.failed": "작업자 실패",
    "worker.error": "작업자 오류",
    "worker.cancelled": "작업자 취소",
    "policy.blocked": "정책 차단",
    "job.retry_enqueue_failed": "재시도 대기열 실패"
  },
  en: {}
};

export function translateEventType(value: unknown, locale: Locale): string {
  if (value === null || value === undefined || value === "") return "event";
  const text = String(value);
  return eventTypeLabels[locale][text] ?? text;
}
