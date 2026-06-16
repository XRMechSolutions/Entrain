// Behavioral constants shared by the UI shell and the Phase-2 editor — the single
// source of truth for the non-CSS numbers in design.md §14. (Breakpoint/spacing
// values that the stylesheet also needs live as CSS custom properties in app.css;
// these are the ones JS/TS logic depends on.)

/** Single responsive breakpoint dividing the mobile / wide layouts (design §13). */
export const WIDE_BREAKPOINT_PX = 720;

/** Standard minimum accessible touch-target size. */
export const MIN_TAP_TARGET_PX = 48;

/** Diameter of the primary tap-to-play transport button. */
export const PLAY_BUTTON_DIAMETER_PX = 120;

/** How long a warning/info banner lingers before auto-dismissing (errors never do). */
export const WARNING_AUTODISMISS_MS = 6000;

/** Maximum number of stacked banners; older non-error notices beyond this are dropped. */
export const NOTICE_MAX_VISIBLE = 3;

/** Hit radius for a canvas node handle (44 px touch diameter, the tap-target rule). */
export const NODE_HIT_RADIUS_PX = 22;

/** Curve sampling resolution: one sample per N CSS pixels across a lane. */
export const CURVE_SAMPLE_PX = 2;

/** Minimum spacing between two node times so they never share a `t` (validation forbids it). */
export const MIN_NODE_DT_SEC = 0.01;

/** Max zoom-in: the editor view always spans at least this many seconds. */
export const EDITOR_MIN_VIEW_SEC = 5;
