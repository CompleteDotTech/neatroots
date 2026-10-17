import type { AnyValue, KeyValue, ResourceSpansBatch } from "../otlp/types.js";

export interface RedactionRule {
  kind: string;
  re: RegExp;
  /** The pattern's first group is a label to keep readable ("Bearer ", "postgres://user:"). */
  keepPrefix?: boolean;
}

export const BUILTIN_RULES: RedactionRule[] = [
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  {
    kind: "api_key",
    re: /\b(sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|ya29\.[A-Za-z0-9_-]{20,})\b/g,
  },
  { kind: "bearer_token", re: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi, keepPrefix: true },
  // Matches start only where the run of token characters starts (a lookbehind, not \b), so a long
  // run of "a." or "eyJ-" is scanned once instead of from every word boundary.
  { kind: "jwt", re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // The header's scheme is "Basic" (or any case after "Authorization:"). The value is base64 of
  // user:password, so it has upper and lower case letters and a digit, + or /, doesn't start with
  // a path's "/", and is a whole token: "basic /usr/lib/python3.11" and "Basic authentication1234" aren't.
  { kind: "basic_auth", re: /\b(Basic\s+)(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+][A-Za-z0-9+/]{15,}={0,2}(?![A-Za-z0-9+/_-])/g, keepPrefix: true },
  // Tied to the header, so any base64 token counts, even a short default like admin:admin. The
  // quotes may be JSON-escaped (\") when the header sits inside a string attribute.
  { kind: "basic_auth", re: /\b(authorization\\?["']?\s*[:=]\s*\\?["']?basic\s+)[A-Za-z0-9+][A-Za-z0-9+/]{3,}={0,2}(?![A-Za-z0-9+/_-])/gi, keepPrefix: true },
  // The whole value, so a longer one isn't left half visible.
  { kind: "aws_secret", re: /(aws_secret_access_key\\?["']?\s*[=:]\s*\\?["']?)[A-Za-z0-9/+]{40,}/gi, keepPrefix: true },
  // Before email, which would otherwise take "password@host" as an address (and miss it for a dotless
  // host). ? and # can't appear unencoded in userinfo, so "host:443?email=a@b.com" is a port and a query.
  { kind: "url_password", re: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/?#]+(?=@)/gi, keepPrefix: true },
  { kind: "email", re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: "phone", re: /(?<![\w.])\+?(?:\d{1,3}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w.])/g },
];

/** Credentials, as opposed to personal data: the hosted LLM always has these removed. */
export const CREDENTIAL_KINDS = ["private_key", "api_key", "bearer_token", "jwt", "basic_auth", "aws_secret", "url_password"];

export function compileRules(userPatterns: string[]): RedactionRule[] {
  const user: RedactionRule[] = [];
  for (const p of userPatterns) {
    try {
      user.push({ kind: "custom", re: new RegExp(p, "g") });
    } catch {
      /* ignore invalid user patterns; they are validated when saved */
    }
  }
  return [...BUILTIN_RULES, ...user];
}

export interface RedactionHit {
  kind: string;
  where: string;
  sample: string;
}

function mask(s: string): string {
  if (s.length <= 6) return "•".repeat(s.length);
  return s.slice(0, 3) + "•".repeat(Math.min(12, s.length - 5)) + s.slice(-2);
}

/** Opt-in work limits. The caller owns aggregate match counts; limited passes retain no samples. */
export interface RedactionLimits {
  node(depth: number): void;
  output(fragment: string, stringLength: number): void;
  match(kind: string): void;
}

function redactLimited(s: string, rules: RedactionRule[], limits: RedactionLimits): string {
  let out = s;
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    const parts: string[] = [];
    let end = 0;
    let length = 0;
    const append = (part: string) => {
      length += part.length;
      limits.output(part, length); // check BEFORE retaining a fragment or joining the output
      parts.push(part);
    };
    // String.replace(globalRegex, callback) collects matches before invoking callbacks.
    // exec consumes one at a time, so a match limit actually bounds retained work.
    let match: RegExpExecArray | null;
    while ((match = rule.re.exec(out)) !== null) {
      limits.match(rule.kind);
      append(out.slice(end, match.index));
      const prefix = rule.keepPrefix && typeof match[1] === "string" ? match[1] : "";
      append(`${prefix}[redacted:${rule.kind}]`);
      end = match.index + match[0].length;
      if (!rule.re.global) break;
      if (match[0].length === 0) {
        // AdvanceStringIndex semantics: do not loop forever on a zero-width match.
        const index = rule.re.lastIndex;
        const unicode = rule.re.unicode || rule.re.flags.includes("v");
        rule.re.lastIndex = index + (unicode && (out.codePointAt(index) ?? 0) > 0xffff ? 2 : 1);
      }
    }
    append(out.slice(end));
    out = parts.join("");
  }
  return out;
}

export function redactString(s: string, rules: RedactionRule[], where: string, hits: RedactionHit[], limits?: RedactionLimits): string {
  limits?.node(0);
  if (limits) return redactLimited(s, rules, limits);
  let out = s;
  for (const r of rules) {
    r.re.lastIndex = 0;
    out = out.replace(r.re, (m: string, ...groups: unknown[]) => {
      // Keep a captured label ("Bearer ", "postgres://user:") readable; only the secret is masked.
      const prefix = r.keepPrefix && typeof groups[0] === "string" ? (groups[0] as string) : "";
      hits.push({ kind: r.kind, where, sample: mask(m) });
      return `${prefix}[redacted:${r.kind}]`;
    });
  }
  return out;
}

function redactValue(v: AnyValue, rules: RedactionRule[], where: string, hits: RedactionHit[], limits?: RedactionLimits, depth = 0): AnyValue {
  limits?.node(depth);
  if ("stringValue" in v) return { stringValue: redactString(v.stringValue, rules, where, hits, limits) };
  if ("bytesValue" in v) {
    const bytes = Buffer.from(v.bytesValue, "base64");
    const text = bytes.toString("utf8");
    // OTLP bytes may contain arbitrary binary data. Only inspect canonical UTF-8 so decoding can
    // never replace invalid sequences or otherwise change bytes that are not actually text.
    if (!Buffer.from(text, "utf8").equals(bytes)) return v;
    const redacted = redactString(text, rules, where, hits, limits);
    return redacted === text ? v : { bytesValue: Buffer.from(redacted, "utf8").toString("base64") };
  }
  if ("arrayValue" in v) return { arrayValue: { values: v.arrayValue.values.map((x) => redactValue(x, rules, where, hits, limits, depth + 1)) } };
  if ("kvlistValue" in v) return { kvlistValue: { values: redactKvs(v.kvlistValue.values, rules, where, hits, limits, depth + 1) } };
  return v;
}

function redactKvs(kvs: KeyValue[], rules: RedactionRule[], where: string, hits: RedactionHit[], limits?: RedactionLimits, depth = 0): KeyValue[] {
  limits?.node(depth);
  return kvs.map((kv) => ({ key: kv.key, value: redactValue(kv.value, rules, limits ? "" : `${where} ${kv.key}`, hits, limits, depth + 1) }));
}

/** Returns redacted copies and detailed hits by default; limited callers own aggregate counts. */
export function redactBatches(batches: ResourceSpansBatch[], rules: RedactionRule[], limits?: RedactionLimits): { batches: ResourceSpansBatch[]; hits: RedactionHit[] } {
  const hits: RedactionHit[] = [];
  const out = batches.map((b) => ({
    resource: { ...b.resource, attributes: redactKvs(b.resource.attributes, rules, "resource", hits, limits) },
    scope: b.scope.attributes ? { ...b.scope, attributes: redactKvs(b.scope.attributes, rules, "scope", hits, limits) } : b.scope,
    spans: b.spans.map((s) => {
      // Span and event names often carry a URL or a tool argument, so they are redacted too,
      // and the hit labels use the redacted name so a preview never echoes the raw value.
      const name = redactString(s.name, rules, `span name [${s.spanId.slice(0, 6)}]`, hits, limits);
      return {
        ...s,
        name,
        attributes: redactKvs(s.attributes, rules, limits ? "" : `${name} [${s.spanId.slice(0, 6)}]`, hits, limits),
        events: s.events.map((e) => {
          const eventName = redactString(e.name, rules, limits ? "" : `${name} event name`, hits, limits);
          return { ...e, name: eventName, attributes: redactKvs(e.attributes, rules, limits ? "" : `${name} event ${eventName}`, hits, limits) };
        }),
        links: s.links.map((l) => ({ ...l, attributes: redactKvs(l.attributes, rules, limits ? "" : `${name} link`, hits, limits) })),
        status: s.status.message ? { ...s.status, message: redactString(s.status.message, rules, limits ? "" : `${name} status`, hits, limits) } : s.status,
      };
    }),
  }));
  return { batches: out, hits };
}
