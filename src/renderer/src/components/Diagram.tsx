import { Fragment, type CSSProperties } from 'react';
import type {
  DiagramColor,
  DiagramGroup,
  DiagramNode,
  DiagramSchema,
} from '@shared/types';

// A small, intentionally narrow visual language for AI responses.
//
// The AI returns a DiagramSchema (defined in shared/types) and this
// file turns it into the kind of calm box-and-flow layout that's
// easier to read than a wall of prose for users who think visually.
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
//
// Nullable fields (sub, color, title, subtitle, arrows, caption) come
// in as `null` from the backend; the renderer falls back to neutral
// styling / absence when null.

// Per-color visual: a diagonal soft gradient (light at the top-left,
// slightly deeper at the bottom-right), an ambient outer glow in the
// same hue, a faint inner highlight along the top edge for that
// glassy refraction feel, and an ethereal low-opacity border. The
// text uses a deeper shade for readable contrast on the tint.
interface ColorVisual {
  textClass: string;
  // Inline style so the multi-stop gradient + layered shadows can be
  // expressed without a Tailwind arbitrary-value class soup. The text
  // colour stays in textClass because hover/state variants might pile
  // on later.
  style: CSSProperties;
}

const COLOR_VISUAL: Record<DiagramColor, ColorVisual> = {
  green: {
    textClass: 'text-[#1F5A38]',
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
  const visual = COLOR_VISUAL[node.color ?? 'neutral'];
  // Row nodes flex evenly with a sensible minimum so a single-row
  // group doesn't collapse weird on narrow screens; column nodes go
  // full width so the layout reads as "this is one stage."
  const widthClass = layout === 'row' ? 'flex-1 min-w-[140px]' : 'w-full';
  return (
    <div
      className={`rounded-2xl px-4 py-3 text-center ${visual.textClass} ${widthClass}`}
      style={visual.style}
    >
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

// Reference diagram used by the preview affordance. Recreates the
// example screenshot so the visual language can be tuned before the
// backend toggle is wired. Explicit nulls match the wire shape the
// backend will emit.
export const SAMPLE_DIAGRAM: DiagramSchema = {
  groups: [
    {
      title: 'The non-negotiable loop',
      subtitle: 'If any piece stops, everything stalls',
      layout: 'row',
      arrows: true,
      caption: 'Always with a real business problem behind it',
      nodes: [
        { label: 'Learn', sub: null, color: 'green' },
        { label: 'Build', sub: null, color: 'blue' },
        { label: 'Share', sub: null, color: 'red' },
      ],
    },
    {
      title: 'Every day — 2 hours minimum',
      subtitle: null,
      layout: 'row',
      arrows: null,
      caption: null,
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
      subtitle: null,
      layout: 'row',
      arrows: null,
      caption: null,
      nodes: [
        { label: 'Publish 1 post', sub: 'AI + business insight', color: 'red' },
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
      subtitle: null,
      layout: 'column',
      arrows: null,
      caption: null,
      nodes: [
        {
          label: 'Did I put in the hours, reach out, publish, and build?',
          sub: null,
          color: 'green',
        },
      ],
    },
    {
      // No title → reads as a continuation of the previous group.
      title: null,
      subtitle: null,
      layout: 'row',
      arrows: null,
      caption: null,
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
