/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Phase 0–3.4 legacy alias. Kept so any unconverted className still
        // resolves; the visible site of bg-off-white shrinks to zero by
        // the end of Chunk 5 and the alias can be removed in Phase 3.6.
        'off-white': '#FAFAF7',

        // Phase 3.5 locked palette. Names mirror src/index.css CSS vars.
        canvas: '#F2F3F5',
        card: '#FFFFFF',
        ink: {
          DEFAULT: '#0F0F0F',
          body: '#4A4A4A',
          label: '#6A6A6A',
          hint: '#8A8A8A',
          micro: '#A8A8A8',
        },
        hairline: 'rgba(0,0,0,0.06)',
        'input-border': '#D8D8D8',
        'subtle-border': '#EAEAEC',
        'surface-subtle': '#F7F7F8',
        'surface-faint': '#FAFAFB',
        amber: '#C8A04A',
        // Step status colors (Phase 4 Chunk 2b: details panel).
        'step-done': '#10B981',         // muted calm green
        'step-failed': '#E94B4B',       // soft red leaning amber
        'step-failed-tint': '#FEF2F2',  // very subtle wash on failed rows
        'step-done-tint': '#F0FDF8',    // very subtle wash on finished blocks
      },
      fontFamily: {
        // `soft` is the existing alias — kept stable so Phase 0–3.4 className
        // usages don't break. The underlying stack is now Inter-first; the
        // system fallbacks remain in case the Google Font load fails (offline
        // dev, network blip, etc.) so the app stays legible.
        soft: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'system-ui',
          'sans-serif',
        ],
        // JetBrains Mono — for command, output, cwd, the wordmark, status
        // words, and all monospace blocks. Phase 5 visual pass: the serif
        // (Source Serif 4) was dropped entirely — it read as "blog post,"
        // not "developer tool." Everything is now sans (Inter) + mono.
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          '"SF Mono"',
          'Menlo',
          'Monaco',
          '"Cascadia Code"',
          '"Roboto Mono"',
          'Consolas',
          '"Courier New"',
          'monospace',
        ],
      },
      boxShadow: {
        // Soft elevation on the main app card. Two-layer shadow: a tight
        // 1px contact shadow plus a wide, soft lifted shadow with a
        // negative spread so it falls off gently — the card reads as
        // genuinely floating above the gradient canvas.
        card: '0 1px 3px rgba(0,0,0,0.04), 0 20px 50px -12px rgba(0,0,0,0.12)',
        // Sign-out popover.
        popover: '0 4px 16px rgba(0,0,0,0.08)',
      },
      maxWidth: {
        // Inner reading column. Generous so paragraphs occupy most of
        // the available width on standard 1080p+ windows, matching the
        // visual feel of Claude / ChatGPT chat panels. The conversation
        // is still horizontally centred — extra space falls equally on
        // either side as natural margins.
        reading: '1100px',
        'auth-form': '360px',
        // Conversation column cap. Hugs the reading width with a small
        // chrome margin.
        app: '1160px',
      },
      keyframes: {
        // Slow opacity flicker for the running-step status indicator. Calmer
        // than a spinner — reads as "still working" without being kinetic.
        // Opacity-only so the dot's amber color and 14px size stay stable.
        flicker: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.85' },
        },
        // 200ms cross-fade for the StatusIndicator phase transitions.
        // Paired keyframes: the outgoing label runs 'fade-out' while the
        // incoming label runs 'fade-in' over the same 200ms window. Both
        // layers are absolutely stacked in the indicator's relative
        // container so the words occupy the same on-screen position.
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-out': {
          from: { opacity: '1' },
          to: { opacity: '0' },
        },
        // Slow breathing glow for the Running pane's outer board. The
        // shadow's spread and tint oscillate gently so the whole pane
        // reads as "alive" — same emotional register as the running
        // status dot's flicker, but at the container scale. Drives
        // ambient presence; does not call attention.
        'pane-breath': {
          '0%, 100%': {
            boxShadow:
              '0 1px 0 rgba(255,255,255,0.9) inset, 0 0 0 0.5px rgba(0,0,0,0.04), 0 8px 24px -12px rgba(20,140,80,0.18), 0 2px 8px -4px rgba(0,0,0,0.06)',
          },
          '50%': {
            boxShadow:
              '0 1px 0 rgba(255,255,255,0.9) inset, 0 0 0 0.5px rgba(0,0,0,0.04), 0 12px 32px -10px rgba(20,140,80,0.28), 0 2px 8px -4px rgba(0,0,0,0.08)',
          },
        },
        // Mount/unmount transition for the whole pane. Eases in with a
        // slight rise + scale-up so it appears as a settled object
        // rather than popping in. The fade-out runs longer and adds a
        // gentle scale-down so the pane *dissolves* rather than blinks
        // off — the user previously read the shorter version as a pop.
        'pane-in': {
          from: { opacity: '0', transform: 'translateY(6px) scale(0.985)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'pane-out': {
          from: { opacity: '1', transform: 'translateY(0) scale(1)' },
          to: { opacity: '0', transform: 'translateY(4px) scale(0.985)' },
        },
        // Row mount — a single process row easing in when it joins the
        // list. Subtle enough not to read as motion, just "it appeared."
        'row-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        flicker: 'flicker 2.5s ease-in-out infinite',
        // ease-out lands the fade more gently than the default ease.
        // forwards keeps the final opacity locked when the animation
        // completes so the incoming label doesn't flicker back to 0.
        'fade-in': 'fade-in 200ms ease-out forwards',
        'fade-out': 'fade-out 200ms ease-out forwards',
        'pane-breath': 'pane-breath 4.5s ease-in-out infinite',
        'pane-in': 'pane-in 360ms cubic-bezier(0.22, 0.61, 0.36, 1) forwards',
        'pane-out': 'pane-out 420ms cubic-bezier(0.4, 0, 0.6, 1) forwards',
        'row-in': 'row-in 260ms ease-out forwards',
      },
    },
  },
  plugins: [],
};
