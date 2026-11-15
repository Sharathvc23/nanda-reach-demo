/**
 * A small port of the corroboration kernel (sm-resolver): several independent sources answer the
 * same question about one subject; their answers are compared field by field; the result is a
 * verdict and typed findings. No voting, no quorum: any pairwise disagreement on a decisive
 * field is divergence, fewer than two decisive sources is insufficient.
 *
 * Finding kinds follow draft-chandra-agent-registry-corroboration: omission, endpoint, key,
 * digest, agent_equivocation, source_equivocation, stale_description, plus `target` for the
 * delivery mailbox this demo adds.
 */
export type Status = "ok" | "unreachable" | "not_found" | "invalid";
export type ClaimValue = string | number | boolean | null;

export interface SourceView {
  /** Short source name, e.g. "nanda-index". */
  source: string;
  status: Status;
  /** Field -> value. A null value does not participate in comparison. */
  claims: Record<string, ClaimValue>;
  /** Where the answer came from, for the trace. */
  detail?: string;
  /** Milliseconds the fetch took. */
  ms?: number;
}

export type FindingKind = "omission" | "endpoint" | "key" | "digest" | "agent_equivocation" | "source_equivocation" | "stale_description" | "target";
export type Verdict = "AGREE" | "DIVERGENT" | "INSUFFICIENT";

export interface Finding {
  kind: FindingKind;
  field?: string;
  sources: string[];
  detail: string;
}

export interface CorroborationReport {
  subject: string;
  verdict: Verdict;
  findings: Finding[];
  /** Field -> source -> value, for the table. */
  claims: Record<string, Record<string, ClaimValue>>;
  sources: SourceView[];
  checked_at: string;
}

/** Which finding a disagreement on a field is. Unknown fields are source equivocation. */
const KIND_BY_FIELD: Record<string, FindingKind> = {
  card_url: "endpoint",
  locator: "agent_equivocation",
  client_id: "key",
  signature: "key",
  signer: "key",
  card_digest: "digest",
  inbox: "target",
  version: "stale_description",
};

export interface CorroborateOptions {
  /** Sources that must answer; a not_found or unreachable one is an omission. */
  required?: string[];
  /** Fields that count toward "decisive"; default: every field two or more sources claim. */
  decisive?: string[];
}

export function corroborate(subject: string, views: SourceView[], opts: CorroborateOptions = {}): CorroborationReport {
  const findings: Finding[] = [];
  const claims: Record<string, Record<string, ClaimValue>> = {};

  for (const req of opts.required ?? []) {
    const v = views.find((x) => x.source === req);
    if (!v || v.status === "not_found") findings.push({ kind: "omission", sources: [req], detail: `${req} has no record of ${subject}` });
    else if (v.status === "invalid") findings.push({ kind: "source_equivocation", sources: [req], detail: v.detail ?? `${req} answered with something that does not parse` });
  }

  // Only sources that answered take part in comparison. Unreachable is not disagreement.
  const answering = views.filter((v) => v.status === "ok");
  for (const v of answering) {
    for (const [field, value] of Object.entries(v.claims)) {
      if (value === null || value === undefined) continue;
      (claims[field] ??= {})[v.source] = value;
    }
  }

  let decisiveFields = 0;
  for (const [field, bySource] of Object.entries(claims)) {
    const entries = Object.entries(bySource);
    if (entries.length < 2) continue;
    if (opts.decisive && !opts.decisive.includes(field)) continue;
    decisiveFields += 1;
    const distinct = new Map<string, string[]>();
    for (const [source, value] of entries) {
      const key = JSON.stringify(value);
      distinct.set(key, [...(distinct.get(key) ?? []), source]);
    }
    if (distinct.size > 1) {
      const kind = KIND_BY_FIELD[field] ?? "source_equivocation";
      const parts = [...distinct.entries()].map(([val, srcs]) => `${srcs.join("+")} say ${val}`);
      findings.push({ kind, field, sources: entries.map(([s]) => s), detail: `${field}: ${parts.join(" but ")}` });
    }
  }

  const verdict: Verdict = findings.length ? "DIVERGENT" : decisiveFields >= 1 && answering.length >= 2 ? "AGREE" : "INSUFFICIENT";
  return { subject, verdict, findings, claims, sources: views, checked_at: new Date().toISOString() };
}

/** One line per source and the verdict, for a trace. */
export function describeReport(r: CorroborationReport): string[] {
  const lines = r.sources.map((s) => `  ${s.source}: ${s.status}${s.ms !== undefined ? ` ${s.ms}ms` : ""}${s.detail ? ` · ${s.detail}` : ""}`);
  lines.push(`Corroboration: ${r.verdict}${r.findings.length ? ` · ${r.findings.map((f) => `${f.kind}${f.field ? `(${f.field})` : ""}`).join(", ")}` : ` · ${r.sources.filter((s) => s.status === "ok").length} sources agree`}`);
  for (const f of r.findings) lines.push(`  finding ${f.kind}: ${f.detail}`);
  return lines;
}
