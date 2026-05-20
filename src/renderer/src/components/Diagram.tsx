import { Fragment } from 'react';

// A small, intentionally narrow visual language for AI responses.
//
// The AI returns a Diagram conforming to the schema below; this file
// turns it into the kind of calm box-and-flow layout that's easier to
// read than a wall of prose for users who think visually.
//
// Scope (v1):
//   • Groups stack vertically, with optional title + subtitle and an
//     optional caption underneath.
//   • Each group lays out as a row (nodes side by side) or a column
//     (nodes stacked, full-width).
//   • Nodes carry a label, an optional sub-label, and one of five
//     calm colors.
//   • Row groups can opt into → arrows between consecutive nodes to
//     express a sequence / flow.
//   • No nesting, no auto-routed edges, no curved arrows. To express
//     a second tier under one title, the AI emits two consecutive
//     groups — the second with no title, so they read as one block.

export type DiagramColor = 'green' | 'blue' | 'amber' | 'red' | 'neutral';

export interface DiagramNode {
  label: string;
  // Smaller secondary line under the label. Optional.
  sub?: string;
  // Defaults to 'neutral' when omitted.
  color?: DiagramColor;
}

export interface DiagramGroup {
  title?: string;
  subtitle?: string;
  layout: 'row' | 'column';
  nodes: DiagramNode[];
  // When true and layout='row', renders a → between each pair of
  // consecutive nodes. Used to express a flow (Learn → Build → Share).
  arrows?: boolean;
  // Small note rendered centred underneath the group.
  caption?: string;
}

export interface DiagramSchema {
  groups: DiagramGroup[];
}

// Tailwind class bundles per color. The tints are pulled into
// arbitrary values so they don't fight the rest of the app's palette
// — calm, low-saturation, ink-readable on tint.
const COLOR_CLASS: Record<DiagramColor, string> = {
  green: 'border-[#B6DCC5] bg-[#E8F4ED] text-[#2D6A45]',
  blue: 'border-[#C7CFE8] bg-[#EDF0FB] text-[#3D4D8C]',
  amber: 'border-[#E3C9A0] bg-[#FAEFDA] text-[#7E552A]',
  red: 'border-[#E8BFBF] bg-[#FAECEC] text-[#8E3838]',
  neutral: 'border-subtle-border bg-surface-subtle text-ink',
};

export function Diagram({ diagram }: { diagram: DiagramSchema }) {
  return (
    <div className="space-y-7 py-2">
      {diagram.groups.map((group, i) => (
        <DiagramGroupView
          key={i}
          group={group}
          // First group gets no top divider; subsequent ones get a
          // hairline so consecutive groups under one logical block
          // still read as separate.
          showDivider={i > 0}
        />
      ))}
    </div>
  );
}

function DiagramGroupView({
  group,
  showDivider,
}: {
  group: DiagramGroup;
  showDivider: boolean;
}) {
  const containerClass =
    group.layout === 'row'
      ? 'flex flex-wrap items-stretch justify-center gap-3'
      : 'flex flex-col items-stretch gap-3';
  return (
    <div
      className={`space-y-3 ${
        showDivider ? 'border-t border-hairline pt-7' : ''
      }`}
    >
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
      <div className={containerClass}>
        {group.nodes.map((node, i) => (
          <Fragment key={i}>
            <DiagramNodeView node={node} layout={group.layout} />
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
      {group.caption && (
        <p className="text-center text-[12px] text-ink-label">
          {group.caption}
        </p>
      )}
    </div>
  );
}

function DiagramNodeView({
  node,
  layout,
}: {
  node: DiagramNode;
  layout: 'row' | 'column';
}) {
  const colorClass = COLOR_CLASS[node.color ?? 'neutral'];
  // Row nodes flex evenly with a sensible minimum so a single-row
  // group doesn't collapse weird on narrow screens; column nodes go
  // full width so the layout reads as "this is one stage."
  const widthClass = layout === 'row' ? 'flex-1 min-w-[140px]' : 'w-full';
  return (
    <div
      className={`rounded-xl border-[1px] px-4 py-3 text-center ${colorClass} ${widthClass}`}
    >
      <div className="text-[13.5px] font-semibold leading-snug">
        {node.label}
      </div>
      {node.sub && (
        <div className="mt-1 text-[12px] opacity-75 leading-snug">
          {node.sub}
        </div>
      )}
    </div>
  );
}

// Reference diagram used by the preview affordance. Recreates the
// example screenshot so the visual language can be tuned before the
// backend toggle is wired.
export const SAMPLE_DIAGRAM: DiagramSchema = {
  groups: [
    {
      title: 'The non-negotiable loop',
      subtitle: 'If any piece stops, everything stalls',
      layout: 'row',
      arrows: true,
      caption: 'Always with a real business problem behind it',
      nodes: [
        { label: 'Learn', color: 'green' },
        { label: 'Build', color: 'blue' },
        { label: 'Share', color: 'red' },
      ],
    },
    {
      title: 'Every day — 2 hours minimum',
      layout: 'row',
      nodes: [
        {
          label: '1 hour learning',
          sub: 'CS50P → Udemy → Coursera',
          color: 'green',
        },
        {
          label: '1 hour building',
          sub: 'Real problems in VS Code',
          color: 'blue',
        },
      ],
    },
    {
      title: 'Every week — 3 actions, no exceptions',
      layout: 'row',
      nodes: [
        {
          label: 'Publish 1 post',
          sub: 'AI + business insight',
          color: 'red',
        },
        {
          label: 'Reach out to 1 biz',
          sub: 'Offer value, not a pitch',
          color: 'amber',
        },
        {
          label: 'Build 1 thing',
          sub: 'Tied to a use case',
          color: 'blue',
        },
      ],
    },
    {
      title: 'Every month — check the inputs, not the results',
      layout: 'column',
      nodes: [
        {
          label: 'Did I put in the hours, reach out, publish, and build?',
          color: 'green',
        },
      ],
    },
    {
      // No title → reads as a continuation of the previous group.
      layout: 'row',
      nodes: [
        {
          label: 'Yes + no revenue?',
          sub: 'Keep going. Results lag.',
          color: 'green',
        },
        {
          label: 'No to any of them?',
          sub: 'Old pattern. Fix now.',
          color: 'red',
        },
      ],
    },
  ],
};
