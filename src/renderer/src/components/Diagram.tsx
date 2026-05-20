import { Fragment, type CSSProperties } from 'react';
import type {
  DiagramColor,
  DiagramGroup,
  DiagramGroupKind,
  DiagramNode,
  DiagramSchema,
} from '@shared/types';

// A small visual language for AI responses.
//
// Each group picks one "kind" — default, stat, numbered, callout,
// milestone — which decides the per-node treatment. The kinds give
// the diagram visual variety without losing the calm aesthetic: same
// gradient + glow palette across all of them, just different layout,
// scale, and tag glyphs.
//
// One-kind-per-group is the rule: never mix card styles inside a
// single group; that breaks the section's read.
//
// All nullable fields come in as `null` from the backend. The
// renderer treats null and absent the same.

export function Diagram({ diagram }: { diagram: DiagramSchema }) {
  return (
    <div className="space-y-7 py-2">
      {diagram.groups.map((group, i) => (
        <DiagramGroupView key={i} group={group} showDivider={i > 0} />
      ))}
    </div>
  );
}

// ── Per-color visual --------------------------------------------------------

// Gradient + glow per color, shared across all kinds so the diagram
// reads as one piece. Inline style because the multi-stop gradient +
// layered shadows don't fit cleanly into Tailwind arbitrary values.
interface ColorVisual {
  textClass: string;
  // Border-left color used by callout kind. Hex so we can apply it via
  // inline style alongside the gradient.
  accentHex: string;
  // Solid dot color used by milestone kind.
  dotHex: string;
  style: CSSProperties;
}

const COLOR_VISUAL: Record<DiagramColor, ColorVisual> = {
  green: {
    textClass: 'text-[#1F5A38]',
    accentHex: '#56A375',
    dotHex: '#3F8E5E',
    style: {
      background:
        'linear-gradient(135deg, #F4FBF6 0%, #E5F3EB 55%, #D7EBDE 100%)',
      boxShadow: [
        '0 1px 0 rgba(255,255,255,0.65) inset',
        '0 0 0 0.5px rgba(120,180,140,0.28)',
        '0 8px 22px -8px rgba(80,160,110,0.28)',
      ].join(', '),
    },
  },
  blue: {
    textClass: 'text-[#36458A]',
    accentHex: '#6675B8',
    dotHex: '#4D5BA2',
    style: {
      background:
        'linear-gradient(135deg, #F5F7FE 0%, #E7ECFA 55%, #DAE0F5 100%)',
      boxShadow: [
        '0 1px 0 rgba(255,255,255,0.65) inset',
        '0 0 0 0.5px rgba(110,130,210,0.25)',
        '0 8px 22px -8px rgba(90,110,200,0.25)',
      ].join(', '),
    },
  },
  amber: {
    textClass: 'text-[#6E4A20]',
    accentHex: '#C8945A',
    dotHex: '#B07C42',
    style: {
      background:
        'linear-gradient(135deg, #FEF8EA 0%, #FAEDD2 55%, #F5E0B7 100%)',
      boxShadow: [
        '0 1px 0 rgba(255,255,255,0.7) inset',
        '0 0 0 0.5px rgba(190,150,80,0.28)',
        '0 8px 22px -8px rgba(200,150,80,0.28)',
      ].join(', '),
    },
  },
  red: {
    textClass: 'text-[#7C2F2F]',
    accentHex: '#C57272',
    dotHex: '#B25656',
    style: {
      background:
        'linear-gradient(135deg, #FCF1F1 0%, #F7DEDE 55%, #F1CACA 100%)',
      boxShadow: [
        '0 1px 0 rgba(255,255,255,0.65) inset',
        '0 0 0 0.5px rgba(200,120,120,0.28)',
        '0 8px 22px -8px rgba(200,110,110,0.28)',
      ].join(', '),
    },
  },
  neutral: {
    textClass: 'text-ink',
    accentHex: '#9CA3AF',
    dotHex: '#6B7280',
    style: {
      background:
        'linear-gradient(135deg, #FBFBFC 0%, #F3F4F6 55%, #ECEDF0 100%)',
      boxShadow: [
        '0 1px 0 rgba(255,255,255,0.7) inset',
        '0 0 0 0.5px rgba(0,0,0,0.08)',
        '0 8px 22px -8px rgba(60,60,80,0.12)',
      ].join(', '),
    },
  },
};

function visualFor(color: DiagramColor | null): ColorVisual {
  return COLOR_VISUAL[color ?? 'neutral'];
}

// ── Group dispatcher --------------------------------------------------------

function DiagramGroupView({
  group,
  showDivider,
}: {
  group: DiagramGroup;
  showDivider: boolean;
}) {
  const kind: DiagramGroupKind = group.kind ?? 'default';
  const wrapperClass = showDivider ? 'pt-7 border-t border-hairline' : '';
  const inner = (() => {
    switch (kind) {
      case 'stat':
        return <StatGroupBody group={group} />;
      case 'numbered':
        return <NumberedGroupBody group={group} />;
      case 'callout':
        return <CalloutGroupBody group={group} />;
      case 'milestone':
        return <MilestoneGroupBody group={group} />;
      case 'default':
      default:
        return <DefaultGroupBody group={group} />;
    }
  })();

  // Callout owns its own pretitle (rendered inside the callout box),
  // so skip the external GroupHeader for it.
  const showExternalHeader = kind !== 'callout';

  return (
    <div className={wrapperClass}>
      {showExternalHeader && <GroupHeader group={group} />}
      {inner}
      {group.caption && (
        <p className="mt-3 text-center text-[12px] text-ink-label">
          {group.caption}
        </p>
      )}
    </div>
  );
}

// ── Group header (pretitle + title + subtitle) -----------------------------

function GroupHeader({ group }: { group: DiagramGroup }) {
  const hasHeader = group.pretitle || group.title || group.subtitle;
  if (!hasHeader) return null;
  return (
    <div className="mb-3">
      {group.pretitle && (
        <div className="mb-2 flex items-center gap-3">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-micro">
            {group.pretitle}
          </span>
          <span className="flex-1 border-t border-hairline" />
        </div>
      )}
      {(group.title || group.subtitle) && (
        <div className="text-center">
          {group.title && (
            <h3 className="text-[14.5px] font-semibold text-ink">
              {group.title}
            </h3>
          )}
          {group.subtitle && (
            <p className="mt-0.5 text-[12.5px] text-ink-label">
              {group.subtitle}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Default group ----------------------------------------------------------

function DefaultGroupBody({ group }: { group: DiagramGroup }) {
  const containerClass =
    group.layout === 'row'
      ? 'flex flex-wrap items-stretch justify-center gap-3'
      : 'flex flex-col items-stretch gap-3';
  return (
    <div className={containerClass}>
      {group.nodes.map((node, i) => (
        <Fragment key={i}>
          <DefaultCard node={node} layout={group.layout} />
          {group.arrows &&
            group.layout === 'row' &&
            i < group.nodes.length - 1 && (
              <span
                className="self-center text-[16px] text-ink-hint"
                aria-hidden="true"
              >
                →
              </span>
            )}
        </Fragment>
      ))}
    </div>
  );
}

function DefaultCard({
  node,
  layout,
}: {
  node: DiagramNode;
  layout: 'row' | 'column';
}) {
  const visual = visualFor(node.color);
  const widthClass = layout === 'row' ? 'flex-1 min-w-[140px]' : 'w-full';
  // Nodes with a tag read better left-aligned (the tag sits up at the
  // top corner). Untagged nodes stay centered like the original cards.
  const alignClass = node.tag ? 'text-left' : 'text-center';
  return (
    <div
      className={`rounded-2xl px-4 py-3 ${visual.textClass} ${widthClass} ${alignClass}`}
      style={visual.style}
    >
      {node.tag && <Tagline text={node.tag} />}
      <div className="text-[13.5px] font-semibold leading-snug">
        {node.label}
      </div>
      {node.sub && (
        <div className="mt-1 text-[12px] leading-snug opacity-80">
          {node.sub}
        </div>
      )}
    </div>
  );
}

// ── Stat group --------------------------------------------------------------

function StatGroupBody({ group }: { group: DiagramGroup }) {
  const containerClass =
    group.layout === 'column'
      ? 'flex flex-col items-stretch gap-3'
      : 'flex flex-wrap items-stretch gap-3';
  return (
    <div className={containerClass}>
      {group.nodes.map((node, i) => (
        <StatCard key={i} node={node} layout={group.layout} />
      ))}
    </div>
  );
}

function StatCard({
  node,
  layout,
}: {
  node: DiagramNode;
  layout: 'row' | 'column';
}) {
  const visual = visualFor(node.color);
  const widthClass = layout === 'row' ? 'flex-1 min-w-[160px]' : 'w-full';
  return (
    <div
      className={`rounded-2xl px-5 py-5 text-left ${visual.textClass} ${widthClass}`}
      style={visual.style}
    >
      <div className="text-[34px] font-bold leading-none">{node.label}</div>
      {node.sub && (
        <div className="mt-2 text-[14px] font-semibold opacity-95">
          {node.sub}
        </div>
      )}
      {node.body && (
        <div className="mt-1.5 text-[11.5px] opacity-65 leading-snug">
          {node.body}
        </div>
      )}
    </div>
  );
}

// ── Numbered group ---------------------------------------------------------

function NumberedGroupBody({ group }: { group: DiagramGroup }) {
  const containerClass =
    group.layout === 'column'
      ? 'flex flex-col items-stretch gap-3'
      : 'flex flex-wrap items-stretch gap-3';
  return (
    <div className={containerClass}>
      {group.nodes.map((node, i) => (
        <NumberedCard
          key={i}
          node={node}
          index={i + 1}
          layout={group.layout}
        />
      ))}
    </div>
  );
}

function NumberedCard({
  node,
  index,
  layout,
}: {
  node: DiagramNode;
  index: number;
  layout: 'row' | 'column';
}) {
  const visual = visualFor(node.color);
  const widthClass = layout === 'row' ? 'flex-1 min-w-[140px]' : 'w-full';
  const indexLabel = String(index).padStart(2, '0');
  return (
    <div
      className={`rounded-2xl px-4 py-4 text-center ${visual.textClass} ${widthClass}`}
      style={visual.style}
    >
      <div className="font-mono text-[22px] font-bold leading-none opacity-90">
        {indexLabel}
      </div>
      <div className="mt-2 text-[13.5px] font-semibold leading-snug">
        {node.label}
      </div>
      {node.sub && (
        <div className="mt-1 text-[12px] leading-snug opacity-75">
          {node.sub}
        </div>
      )}
    </div>
  );
}

// ── Callout group ----------------------------------------------------------

function CalloutGroupBody({ group }: { group: DiagramGroup }) {
  // Callouts are typically one block; if the AI provides multiple
  // nodes they stack vertically inside one bordered container.
  return (
    <div className="space-y-3">
      {group.nodes.map((node, i) => (
        <CalloutCard key={i} node={node} pretitle={i === 0 ? group.pretitle : null} />
      ))}
    </div>
  );
}

function CalloutCard({
  node,
  pretitle,
}: {
  node: DiagramNode;
  pretitle: string | null;
}) {
  const visual = visualFor(node.color);
  return (
    <div
      className={`rounded-xl px-5 py-4 ${visual.textClass}`}
      style={{
        ...visual.style,
        borderLeft: `4px solid ${visual.accentHex}`,
      }}
    >
      {pretitle && (
        <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-micro">
          {pretitle}
        </div>
      )}
      <div className="text-[14px] leading-relaxed text-ink">{node.label}</div>
    </div>
  );
}

// ── Milestone group --------------------------------------------------------

function MilestoneGroupBody({ group }: { group: DiagramGroup }) {
  // Milestones always render as a horizontal track. The connecting
  // line spans from the first dot's center to the last dot's center —
  // with N flex-1 columns, that's 50/N percent in from each side.
  const n = group.nodes.length;
  const lineOffset = n > 1 ? `${50 / n}%` : '50%';
  return (
    <div className="relative px-2 py-3">
      <div
        className="absolute top-[24px] border-t border-subtle-border"
        style={{ left: lineOffset, right: lineOffset }}
        aria-hidden="true"
      />
      <div className="relative flex items-start">
        {group.nodes.map((node, i) => (
          <MilestoneStop key={i} node={node} />
        ))}
      </div>
    </div>
  );
}

function MilestoneStop({ node }: { node: DiagramNode }) {
  const visual = visualFor(node.color);
  return (
    <div className="flex flex-1 flex-col items-center px-2 text-center">
      <div className="h-3 text-[9.5px] uppercase tracking-[0.1em] text-ink-micro">
        {node.tag ?? ''}
      </div>
      <div
        className="mt-2 h-2.5 w-2.5 rounded-full"
        style={{ background: visual.dotHex }}
        aria-hidden="true"
      />
      <div className="mt-2.5 text-[12.5px] font-semibold text-ink leading-snug">
        {node.label}
      </div>
      {node.sub && (
        <div className="mt-0.5 text-[11.5px] text-ink-label leading-snug">
          {node.sub}
        </div>
      )}
    </div>
  );
}

// ── Shared small bits ------------------------------------------------------

function Tagline({ text }: { text: string }) {
  return (
    <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] opacity-75">
      {text}
    </div>
  );
}

// ── Sample diagram (kept exported for ad-hoc dev preview) ------------------

export const SAMPLE_DIAGRAM: DiagramSchema = {
  groups: [
    {
      pretitle: 'THE RULE THAT BREAKS THE PATTERN',
      title: null,
      subtitle: null,
      layout: 'column',
      kind: 'callout',
      arrows: null,
      caption: null,
      nodes: [
        {
          tag: null,
          label:
            "Never learn without building. Never build without sharing. Never share without reaching out. It's a loop, not a sequence.",
          sub: null,
          body: null,
          color: 'amber',
        },
      ],
    },
    {
      pretitle: 'EVERY DAY — 2 HOURS MINIMUM',
      title: null,
      subtitle: null,
      layout: 'row',
      kind: 'stat',
      arrows: null,
      caption: null,
      nodes: [
        {
          tag: null,
          label: '1 hr',
          sub: 'Learning',
          body: 'CS50P → Udemy → Coursera',
          color: 'green',
        },
        {
          tag: null,
          label: '1 hr',
          sub: 'Building',
          body: 'Real problems in VS Code',
          color: 'blue',
        },
      ],
    },
    {
      pretitle: 'EVERY WEEK — 3 ACTIONS, NO EXCEPTIONS',
      title: null,
      subtitle: null,
      layout: 'row',
      kind: 'numbered',
      arrows: null,
      caption: null,
      nodes: [
        {
          tag: null,
          label: 'Publish',
          sub: '1 post about AI + business',
          body: null,
          color: 'red',
        },
        {
          tag: null,
          label: 'Reach out',
          sub: '1 new business',
          body: null,
          color: 'amber',
        },
        {
          tag: null,
          label: 'Build',
          sub: '1 thing tied to a use case',
          body: null,
          color: 'blue',
        },
      ],
    },
    {
      pretitle: 'EVERY MONTH — CHECK INPUTS, NOT RESULTS',
      title: null,
      subtitle: null,
      layout: 'column',
      kind: 'default',
      arrows: null,
      caption: null,
      nodes: [
        {
          tag: null,
          label: 'Did I put in the hours, reach out, publish, and build?',
          sub: null,
          body: null,
          color: 'neutral',
        },
      ],
    },
    {
      pretitle: null,
      title: null,
      subtitle: null,
      layout: 'row',
      kind: 'default',
      arrows: null,
      caption: null,
      nodes: [
        {
          tag: '✓ Yes + no revenue yet',
          label: 'Keep going.',
          sub: 'Results lag 60–90 days behind actions.',
          body: null,
          color: 'green',
        },
        {
          tag: '✗ No to any of them',
          label: 'Old pattern creeping in.',
          sub: 'Course correct immediately.',
          body: null,
          color: 'red',
        },
      ],
    },
    {
      pretitle: 'THE BUILD PROGRESSION',
      title: null,
      subtitle: null,
      layout: 'row',
      kind: 'milestone',
      arrows: null,
      caption: null,
      nodes: [
        {
          tag: 'No 1–2',
          label: 'Practice scripts',
          sub: 'Learn by solving',
          body: null,
          color: 'green',
        },
        {
          tag: 'No 3–4',
          label: 'Demos + audits',
          sub: 'Build proof',
          body: null,
          color: 'blue',
        },
        {
          tag: 'No 5+',
          label: 'Real clients',
          sub: 'Get paid',
          body: null,
          color: 'red',
        },
      ],
    },
  ],
};

// Re-exported for callers that previously imported these shapes from
// this module directly. They now live in @shared/types.
export type { DiagramSchema, DiagramNode, DiagramGroup, DiagramColor } from '@shared/types';
