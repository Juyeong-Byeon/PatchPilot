import { Fragment, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ClipboardList, SearchCheck, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Artifact } from "../api.js";
import type { AdminCopy } from "../i18n.js";

interface StageMeta {
  icon: LucideIcon;
  label: (copy: AdminCopy) => string;
}

// Stage-note artifact kinds emitted by the staged gstack runner, in pipeline order.
const STAGE_META: Record<string, StageMeta> = {
  "gstack-plan": { icon: ClipboardList, label: (copy) => copy.stagePlan },
  "gstack-review": { icon: SearchCheck, label: (copy) => copy.stageReview },
  "gstack-qa": { icon: ShieldCheck, label: (copy) => copy.stageQa },
};
const STAGE_ORDER = Object.keys(STAGE_META);

export function StageNotesPanel({ notes, copy }: { notes: Artifact[]; copy: AdminCopy }) {
  const ordered = notes
    .filter((note) => note.kind && STAGE_META[note.kind])
    .sort((a, b) => STAGE_ORDER.indexOf(String(a.kind)) - STAGE_ORDER.indexOf(String(b.kind)));

  if (ordered.length === 0) return null;

  return (
    <section
      className="surface-card-soft rounded-xl border border-hairline-gray bg-linen-white"
      aria-label={copy.stageNotes}
    >
      <div className="border-b border-hairline-gray p-4">
        <strong className="text-[14px] font-semibold text-forest-ink">{copy.stageNotes}</strong>
        <p className="mt-0.5 text-[12px] leading-4 text-charcoal">{copy.stageNotesHint}</p>
      </div>
      <div className="grid gap-2 p-3">
        {ordered.map((note, index) => (
          <StageNote key={String(note.id ?? note.kind ?? index)} note={note} copy={copy} defaultOpen={index < 2} />
        ))}
      </div>
    </section>
  );
}

function StageNote({ note, copy, defaultOpen }: { note: Artifact; copy: AdminCopy; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = STAGE_META[String(note.kind)];
  const Icon = meta.icon;
  const text = typeof note.content === "string" ? note.content : safeStringify(note.content);

  return (
    <article className="overflow-hidden rounded-lg border border-hairline-gray bg-linen">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="interactive-row flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        {open ? (
          <ChevronDown aria-hidden="true" size={15} className="shrink-0 text-graphite" strokeWidth={2.2} />
        ) : (
          <ChevronRight aria-hidden="true" size={15} className="shrink-0 text-graphite" strokeWidth={2.2} />
        )}
        <Icon aria-hidden="true" size={16} className="shrink-0 text-cobalt-surface" strokeWidth={2.2} />
        <strong className="text-[13px] font-semibold text-forest-ink">{meta.label(copy)}</strong>
      </button>
      {open ? (
        <div className="markdown-note border-t border-hairline-gray bg-linen-white px-4 py-3 text-[13px] leading-5 text-true-black">
          {renderMarkdown(text)}
        </div>
      ) : null}
    </article>
  );
}

// Minimal, injection-safe markdown rendering: headings, bullet lists, and paragraphs.
// Only ever produces React text nodes — no HTML is interpreted.
function renderMarkdown(source: string): ReactNode {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: string[] = [];

  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="my-1 ml-4 list-disc space-y-0.5">
        {list.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      blocks.push(
        <p key={`h-${blocks.length}`} className="mt-2 mb-0.5 text-[13px] font-semibold text-forest-ink first:mt-0">
          {heading[2]}
        </p>,
      );
    } else if (bullet) {
      list.push(bullet[1]);
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      blocks.push(
        <p key={`p-${blocks.length}`} className="my-1 break-words">
          {line}
        </p>,
      );
    }
  }
  flushList();
  return <Fragment>{blocks}</Fragment>;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function isStageNoteArtifact(artifact: { kind?: string | null }): boolean {
  return Boolean(artifact.kind && STAGE_META[artifact.kind]);
}

export const STAGE_NOTE_KINDS = STAGE_ORDER;
