"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  BrainCircuit,
  Check,
  Clock3,
  Gauge,
  KeyRound,
  Moon,
  RotateCw,
  ShieldCheck,
  Sun,
  X,
  CircleAlert,
  CircleDashed,
  Play,
  Unplug,
} from "lucide-react";
import type { DashboardData, Run, RunSummary, RunStatus } from "@/lib/types";
import { MATRIX_RUN_LIMIT } from "@/lib/settings";
import { formatReasoningSummary } from "@/lib/reasoning-summary";

type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "gpt-benchmark-theme";

const statusMeta: Record<RunStatus, { label: string; className: string }> = {
  passed: { label: "通过", className: "status-passed" },
  failed: { label: "未通过", className: "status-failed" },
  error: { label: "异常", className: "status-error" },
  running: { label: "检测中", className: "status-running" },
  incomplete: { label: "生成不完整", className: "status-error" },
  cancelled: { label: "已取消", className: "status-neutral" },
  interrupted: { label: "已中断", className: "status-error" },
};

function formatTime(value: string | null, full = false) {
  if (!value) return "尚无记录";
  return new Intl.DateTimeFormat("zh-CN", full
    ? { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }
    : { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatNumber(value: number | null) {
  return value == null ? "-" : new Intl.NumberFormat("zh-CN").format(value);
}

function formatDuration(value: number | null) {
  if (value == null) return "-";
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(2)}s`;
}

function passRateClass(rate: number | null) {
  return rate == null ? "rate-unknown" : rate >= 90 ? "rate-good" : rate >= 60 ? "rate-warning" : "rate-bad";
}

function formatRate(rate: number | null) {
  return rate == null ? "-" : `${Math.floor(rate * 10) / 10}%`;
}

async function readError(response: Response) {
  const payload = await response.json().catch(() => ({}));
  return payload.error || "操作失败，请稍后重试";
}

function StatusIcon({ status }: { status: RunStatus }) {
  if (status === "cancelled") return <span aria-hidden="true">−</span>;
  if (status === "passed") return <Check size={15} strokeWidth={2.5} />;
  if (status === "failed") return <X size={15} strokeWidth={2.5} />;
  if (status === "running") return <RotateCw size={14} className="spin" />;
  if (status === "incomplete") return <CircleDashed size={15} />;
  if (status === "interrupted") return <Unplug size={15} />;
  return <CircleAlert size={15} />;
}

function relativeTime(value: string, now: number) {
  if (!now) return formatTime(value);
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

type DashboardProps = {
  initialData: DashboardData;
  embedded?: boolean;
  requestedTheme?: Theme | null;
};

export function Dashboard({ initialData, embedded = false, requestedTheme = null }: DashboardProps) {
  const [data, setData] = useState(initialData);
  const [selected, setSelected] = useState<RunSummary | null>(null);
  const [detail, setDetail] = useState<Run | null>(null);
  const [detailError, setDetailError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [triggeringGroup, setTriggeringGroup] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [limit, setLimit] = useState<number>(MATRIX_RUN_LIMIT);
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const refreshSequence = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  const [theme, setTheme] = useState<Theme>(requestedTheme ?? "light");
  const themeWasSelected = useRef(false);
  const hasDemo = useMemo(() => data.recentRuns.some((run) => run.isDemo), [data]);

  const query = `limit=${limit}`;

  const refresh = useCallback(async (silent = false) => {
    const sequence = ++refreshSequence.current;
    if (!silent) setRefreshing(true);
    try {
      const response = await fetch(`/api/dashboard?${query}`, { cache: "no-store" });
      if (response.ok) {
        const nextData: DashboardData = await response.json();
        if (sequence !== refreshSequence.current) return;
        setData(nextData);
        setRefreshError("");
        setSelected((current) => current && nextData.groups.some((group) => group.id === current.groupId) ? current : null);
      } else throw new Error("刷新失败");
    } catch {
      if (sequence === refreshSequence.current) setRefreshError("数据刷新失败，当前显示上次结果；可点击刷新重试。");
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, [query]);

  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => void refresh(true), 30_000);
    const onFocus = () => { void refresh(true); };
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  const selectedId = selected?.id;
  useEffect(() => {
    if (!selectedId) { setDetail(null); setDetailError(""); return; }
    let disposed = false;
    let busy = false;
    const controller = new AbortController();
    setDetail(null);
    setDetailError("");
    async function loadDetail() {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch(`/api/runs/${selectedId}`, { cache: "no-store", signal: controller.signal });
        if (response.status === 404) {
          if (!disposed) { setSelected(null); setDetail(null); }
          return;
        }
        if (!response.ok) throw new Error("详情读取失败");
        const run: Run = await response.json();
        if (!disposed) { setDetail(run); setSelected(run); setDetailError(""); }
      } catch {
        if (!disposed) setDetailError("详情读取失败，正在重试");
      } finally { busy = false; }
    }
    void loadDetail();
    const timer = window.setInterval(() => void loadDetail(), 2000);
    return () => { disposed = true; controller.abort(); window.clearInterval(timer); };
  }, [selectedId]);

  useEffect(() => {
    if (requestedTheme) {
      setTheme(requestedTheme);
      return;
    }

    if (embedded) return;

    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === "light" || savedTheme === "dark") {
      setTheme(savedTheme);
      return;
    }

    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const syncWithSystem = (matches: boolean) => {
      if (!themeWasSelected.current) setTheme(matches ? "dark" : "light");
    };

    syncWithSystem(colorScheme.matches);
    const handleChange = (event: MediaQueryListEvent) => syncWithSystem(event.matches);
    colorScheme.addEventListener("change", handleChange);
    return () => colorScheme.removeEventListener("change", handleChange);
  }, [embedded, requestedTheme]);

  useEffect(() => {
    if (!selected) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selected]);

  function toggleTheme() {
    themeWasSelected.current = true;
    setTheme((currentTheme) => {
      const nextTheme = currentTheme === "dark" ? "light" : "dark";
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      return nextTheme;
    });
  }

  function notify(type: "success" | "error", message: string) {
    setToast({ type, message });
    window.setTimeout(() => setToast(null), 3600);
  }

  async function triggerRun(groupId: string) {
    setTriggeringGroup(groupId);
    try {
      const response = await fetch("/api/admin/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId }),
      });
      if (!response.ok) throw new Error(await readError(response));
      notify("success", "检测已加入后台队列");
      await refresh(true);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "提交失败");
    } finally {
      setTriggeringGroup(null);
    }
  }

  return (
    <div className={`site-shell${embedded ? " embedded" : ""}`} data-theme={theme}>
      {!embedded && <header className="topbar">
        <div className="topbar-inner">
          <Link className="brand" href="/">
            <span className="brand-mark"><BrainCircuit size={20} /></span>
            <span>GPT 智商检测台</span>
          </Link>
          <div className="topbar-actions">
            <span className="live-indicator"><i /> 自动更新</span>
            <button
              className="icon-button small"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "切换到日间模式" : "切换到夜间模式"}
              title={theme === "dark" ? "切换到日间模式" : "切换到夜间模式"}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <Link className="button button-ghost button-sm" href="/admin">
              <KeyRound size={15} /> 管理
            </Link>
          </div>
        </div>
      </header>}

      <main className="page-container dashboard-page">
        <section className="page-heading">
          <div>
            <div className="eyebrow"><Activity size={14} /> PUBLIC MONITOR</div>
            <h1>模型逻辑检测</h1>
            <p>按计划持续检测模型回答，公开记录每一次结果。</p>
          </div>
          <button className="icon-button" onClick={() => void refresh()} disabled={refreshing} aria-label="刷新数据" title="刷新数据">
            <RotateCw size={17} className={refreshing ? "spin" : ""} />
          </button>
        </section>

        {hasDemo && (
          <div className="notice-bar">
            <span className="notice-dot" />
            当前展示初始化示例记录。配置 API Key 并执行首次检测后，对应分组的示例记录会自动移除。
          </div>
        )}
        {refreshError && <div className="notice-bar" role="alert">{refreshError}</div>}

        <section className="metrics-strip" aria-label="检测概况">
          <div className="metric-item">
            <span>今日通过率</span>
            <strong className={passRateClass(data.summary.passRate)}>{formatRate(data.summary.passRate)}</strong>
            <small><ShieldCheck size={13} /> 有效样本 {data.summary.validSamples}</small>
          </div>
          <div className="metric-item">
            <span>今日请求成功率</span>
            <strong className={passRateClass(data.summary.availability)}>{formatRate(data.summary.availability)}</strong>
            <small>已结束请求 {data.summary.attemptedSamples}</small>
          </div>
          <div className="metric-item">
            <span>启用分组</span>
            <strong>{data.summary.activeGroups}</strong>
            <small><Gauge size={13} /> 共 {data.groups.length} 个分组</small>
          </div>
          <div className="metric-item">
            <span>今日检测</span>
            <strong>{data.summary.checksToday}</strong>
            <small><Activity size={13} /> 今日累计检测次数</small>
          </div>
          <div className="metric-item">
            <span>最近更新</span>
            <strong className="metric-time">{formatTime(data.summary.lastCheckedAt)}</strong>
            <small><Clock3 size={13} /> 30 秒自动刷新</small>
          </div>
        </section>

        <section className="panel matrix-panel">
          <div className="panel-header matrix-header">
            <div>
              <h2>状态矩阵</h2>
              <p>从左到右、从上到下由新到旧</p>
            </div>
            <label className="record-filter"><span>记录数</span><select aria-label="记录数" className="input select" value={limit} onChange={e => setLimit(Number(e.target.value))}>{[24, 36, 48, 96].map(n => <option key={n} value={n}>最近 {n} 次</option>)}</select></label>
          </div>

          <div className="matrix-help"><span>闲时：上海时间 00:00–08:00</span><details><summary>统计口径</summary><p>通过率 = 通过 / 完整回答；请求成功率 = 完整回答 / 已结束请求。取消、中断和检测中不计入分母。</p></details></div>

          <div className="matrix-scroll">
            <div className="matrix-table">
              {data.groups.length === 0 ? (
                <div className="empty-state">暂无可展示的分组。</div>
              ) : data.groups.map((group) => {
                const latest = group.runs[0];
                return (
                <div className="matrix-row" key={group.id}>
                  <div className="group-cell">
                    <div className="group-heading">
                      <strong title={group.name}>{group.name}</strong>
                      {data.isAdmin ? (
                        <button
                          className={`status-pill latest-status latest-status-action ${latest ? statusMeta[latest.status].className : "status-neutral"}`}
                          onClick={() => void triggerRun(group.id)}
                          disabled={triggeringGroup !== null}
                          aria-label={`立即检测 ${group.name}`}
                          title={latest ? `最近检测：${formatTime(latest.createdAt, true)}；点击立即检测` : "尚无检测记录；点击立即检测"}
                        >
                          {triggeringGroup === group.id ? <RotateCw size={14} className="spin" /> : latest ? <StatusIcon status={latest.status} /> : <Play size={13} />}
                          {triggeringGroup === group.id ? "提交中" : latest ? latest.isTimeout ? "超时" : statusMeta[latest.status].label : "未检测"}
                        </button>
                      ) : (
                        <span className={`status-pill latest-status ${latest ? statusMeta[latest.status].className : "status-neutral"}`} title={latest ? `最近检测：${formatTime(latest.createdAt, true)}` : "尚无检测记录"}>
                          {latest && <StatusIcon status={latest.status} />}{latest ? latest.isTimeout ? "超时" : statusMeta[latest.status].label : "未检测"}
                        </span>
                      )}
                    </div>
                    <span className="group-model">{group.model}</span>
                    <div className="group-tags"><span>倍率 {group.multiplier}×</span>{!group.enabled && <span className="group-badge">已停用</span>}{!group.isPublic && <span className="group-badge private">仅管理员</span>}</div>
                    <span className="frequency">常规 {group.intervalMinutes} 分钟 / 闲时 {group.idleIntervalMinutes} 分钟</span>
                  </div>
                  <div className="blocks" aria-label={`${group.name} 最近检测结果`}>
                    {group.runs.map((run) => (
                      <button
                        key={run.id}
                        className={`status-block ${statusMeta[run.status].className}`}
                        onClick={() => setSelected(run)}
                        aria-label={`${run.groupName} ${formatTime(run.createdAt, true)} ${statusMeta[run.status].label}`}
                        title={`${formatTime(run.createdAt, true)} · ${statusMeta[run.status].label} · ${run.questionName} · ${run.model} · ${run.reasoningEffort}`}
                      >
                        <StatusIcon status={run.status} />
                      </button>
                    ))}
                    {group.runs.length === 0 && <span className="no-runs">尚未检测</span>}
                  </div>
                  <div className="rate-cell">
                    <div><span>答题通过率</span><strong className={passRateClass(group.passRate)}>{formatRate(group.passRate)}</strong><small>有效样本 {group.validSamples}</small></div>
                    <div><span>请求成功率</span><strong className={passRateClass(group.availability)}>{formatRate(group.availability)}</strong><small>已结束 {group.attemptedSamples}</small></div>
                  </div>
                </div>
              ); })}
            </div>
          </div>
        </section>

        <section className="panel recent-panel">
          <div className="panel-header">
            <div>
              <h2>最近检测</h2>
              <p>各分组的最新检测记录</p>
            </div>
          </div>
          <div className="run-list">
            {data.recentRuns.length === 0 ? <div className="empty-state">等待第一次检测记录。</div> : data.recentRuns.map((run) => (
              <button className="run-row" key={run.id} onClick={() => setSelected(run)}>
                <span className={`run-status-icon ${statusMeta[run.status].className}`}><StatusIcon status={run.status} /></span>
                <span className="run-primary">
                  <strong>{run.groupName}</strong>
                  <small>{run.model} · {run.reasoningEffort} · {run.questionName}</small>
                </span>
                <span className="run-result"><span className={`status-pill ${statusMeta[run.status].className}`}>{run.isTimeout ? "超时" : statusMeta[run.status].label}</span><small>{run.status === "running" ? "正在生成" : `耗时 ${formatDuration(run.latencyMs)}`}</small></span>
                <time className="run-time" dateTime={run.createdAt} title={formatTime(run.createdAt, true)}>{relativeTime(run.createdAt, now)}</time>
                <ArrowRight size={16} className="row-arrow" />
              </button>
            ))}
          </div>
        </section>
      </main>

      <footer className="footer">
        <span>GPT Benchmark</span>
        <span>本地数据 · 自动检测</span>
      </footer>

      {toast && <div className={`toast ${toast.type}`} role="status">{toast.type === "success" ? <Check size={16} /> : <CircleAlert size={16} />}{toast.message}</div>}

      {selected && (
        <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSelected(null)}>
          <aside className="detail-drawer" role="dialog" aria-modal="true" aria-label="检测详情">
            <div className="drawer-header">
              <div>
                <span className={`status-pill ${statusMeta[selected.status].className}`}>
                  <StatusIcon status={selected.status} /> {selected.isTimeout ? "超时" : statusMeta[selected.status].label}
                </span>
                <h2>{selected.groupName}</h2>
                <p>{selected.model} · {selected.questionName} · {formatTime(selected.createdAt, true)}</p>
              </div>
              <button className="icon-button" onClick={() => setSelected(null)} aria-label="关闭详情" title="关闭">
                <X size={18} />
              </button>
            </div>

            <div className="drawer-body">
              {detailError && <div className="notice-bar" role="alert">{detailError}</div>}
              {!detail && !detailError && <p role="status">正在加载详情…</p>}
              {selected.isDemo && <div className="demo-tag">示例记录</div>}
              <div className="token-grid">
                <div><span>输入 token</span><strong>{formatNumber(selected.inputTokens)}</strong></div>
                <div><span>输出 token</span><strong>{formatNumber(selected.outputTokens)}</strong></div>
                <div><span>思考 token</span><strong>{formatNumber(selected.reasoningTokens)}</strong></div>
                <div><span>首 Token</span><strong>{formatDuration(selected.firstTokenMs)}</strong></div>
                <div><span>响应耗时</span><strong>{formatDuration(selected.latencyMs)}</strong></div>
              </div>

              <div className="detail-meta-row">
                <div><span>模型</span><strong>{selected.model}</strong></div>
                <div><span>思考强度</span><strong>{selected.reasoningEffort}</strong></div>
                <div><span>调用方式</span><strong>{selected.streaming ? "流式" : "非流式"}</strong></div>
              </div>

              <section className="text-section">
                <div className="text-section-title"><span>输入</span><small>Prompt</small></div>
                <pre>{detail?.input || ""}</pre>
              </section>
              <section className="text-section">
                <div className="text-section-title"><span>思考摘要</span><small>Reasoning summary</small></div>
                <pre className={!detail?.reasoningSummary ? "muted" : ""}>
                  {detail?.reasoningSummary ? formatReasoningSummary(detail.reasoningSummary) : "上游模型未返回思考摘要"}
                </pre>
              </section>
              <section className="text-section">
                <div className="text-section-title"><span>输出</span><small>Response</small></div>
                <pre className={!detail?.output ? "muted" : ""}>{detail?.output || "暂无输出"}</pre>
              </section>
              {detail?.error && (
                <section className="error-box">
                  <strong>错误信息</strong>
                  <p>{detail.error}</p>
                </section>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
